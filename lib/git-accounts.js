// git-accounts.js — per-project GitHub account pinning.
//
// Lists the GitHub accounts logged into the `gh` CLI and pins a project's git
// credentials to a chosen account via a repo-local credential helper. The
// helper runs `gh auth token --user <account>`, so git always authenticates as
// that account regardless of which account `gh` has globally active. Clearing
// the pin lets the repo fall back to the global default.

var { execFile, execFileSync, execSync } = require("child_process");
var fs = require("fs");
var path = require("path");
var _execFile = execFile;
var _execFileSync = execFileSync;
var _execSync = execSync;
var _existsSync = fs.existsSync;
var _now = function () { return Date.now(); };
var _log = function (msg) { console.log(msg); };

// `gh auth status` validates tokens against api.github.com — real network I/O.
// Cache the parsed account list briefly so repeat opens of the account picker
// don't re-block, and bound every call with a timeout so a hung network can
// never wedge the daemon.
var GH_STATUS_TIMEOUT = 10000;
var ACCOUNTS_TTL = 60 * 1000;
var _accountsCache = { at: 0, accounts: null };

var GH_HOST = "github.com";
var HELPER_KEY = "credential.https://" + GH_HOST + ".helper";

// Resolve the gh binary's absolute path. A daemon launched without the user's
// shell profile may have a PATH that omits Homebrew, so `gh` on bare PATH can
// fail; probe common locations as a fallback. Cached after first success.
var _ghBin = null;
function ghBin() {
  if (_ghBin) return _ghBin;
  var candidates = [];
  try {
    var found = _execSync("command -v gh 2>/dev/null", { encoding: "utf8" }).trim();
    if (found) candidates.push(found);
  } catch (e) {}
  var home = process.env.HOME || "";
  candidates.push(
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
    home ? path.join(home, ".local", "bin", "gh") : ""
  );
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c && _existsSync(c)) { _ghBin = c; return _ghBin; }
  }
  _ghBin = "gh"; // last resort: rely on PATH
  return _ghBin;
}

// `gh auth status` writes to stderr on older gh and stdout on newer; merge both
// via the shell (full binary path, so PATH gaps don't matter).
function ghStatusText() {
  try {
    return _execSync('"' + ghBin() + '" auth status 2>&1', { encoding: "utf8", timeout: GH_STATUS_TIMEOUT });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

function parseAccounts(text) {
  var accounts = [];
  var re = /account ([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (accounts.indexOf(m[1]) === -1) accounts.push(m[1]);
  }
  return accounts;
}

function cacheAccounts(accounts) {
  _accountsCache = { at: _now(), accounts: accounts };
  _log("[git-accounts] listGitHubAccounts -> " + accounts.length + " account(s)" +
    (accounts.length ? ": " + accounts.join(", ") : " (gh path=" + ghBin() + ")"));
  return accounts;
}

function cachedAccounts() {
  if (_accountsCache.accounts && (_now() - _accountsCache.at) < ACCOUNTS_TTL) {
    return _accountsCache.accounts;
  }
  return null;
}

function listGitHubAccounts() {
  var cached = cachedAccounts();
  if (cached) return cached;
  return cacheAccounts(parseAccounts(ghStatusText()));
}

// Async variant for event-loop callers (WS handlers, daemon relay): the
// network-bound `gh auth status` runs in a child process without blocking.
function listGitHubAccountsAsync() {
  var cached = cachedAccounts();
  if (cached) return Promise.resolve(cached);
  return new Promise(function (resolve) {
    _execFile(ghBin(), ["auth", "status"], { encoding: "utf8", timeout: GH_STATUS_TIMEOUT }, function (err, stdout, stderr) {
      var text = (stdout || "") + (stderr || "");
      resolve(cacheAccounts(parseAccounts(text)));
    });
  });
}

function helperValue(account) {
  // Repo-local credential helper: always authenticate as <account> via a gh
  // token, independent of the globally-active gh account.
  return '!f() { test "$1" = get && printf "username=' + account +
    '\\npassword=%s\\n" "$(gh auth token --user ' + account + ')"; }; f';
}

function isGitRepo(projectPath) {
  try {
    _execFileSync("git", ["-C", projectPath, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

// Pin (account set) or clear (account falsy) the project's repo-local helper.
function applyProjectGitAccount(projectPath, account) {
  if (!projectPath) return { ok: false, error: "Missing project path" };
  if (!isGitRepo(projectPath)) return { ok: false, error: "Not a git repository" };
  try {
    // Always clear any existing local helper for this host first.
    try {
      _execFileSync("git", ["-C", projectPath, "config", "--local", "--unset-all", HELPER_KEY], { stdio: "ignore" });
    } catch (e) {}
    if (account) {
      // Empty sentinel resets inherited (global/system) helpers, then pin.
      _execFileSync("git", ["-C", projectPath, "config", "--local", "--add", HELPER_KEY, ""], { stdio: "ignore" });
      _execFileSync("git", ["-C", projectPath, "config", "--local", "--add", HELPER_KEY, helperValue(account)], { stdio: "ignore" });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Best-effort read of the account currently pinned in the repo-local helper.
function getProjectGitAccount(projectPath) {
  if (!projectPath || !isGitRepo(projectPath)) return null;
  try {
    var out = _execFileSync(
      "git",
      ["-C", projectPath, "config", "--local", "--get-all", HELPER_KEY],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    var m = /gh auth token --user ([A-Za-z0-9-]+)/.exec(out);
    if (m) return m[1];
  } catch (e) {}
  return null;
}

// The account git would ACTUALLY authenticate as for this repo right now —
// the repo-local pin if set, otherwise whatever the global default resolves to.
function resolveProjectGitAccount(projectPath) {
  if (!projectPath || !isGitRepo(projectPath)) return null;
  try {
    var out = _execFileSync(
      "git",
      ["-C", projectPath, "credential", "fill"],
      { input: "protocol=https\nhost=" + GH_HOST + "\n\n", encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 5000 }
    );
    var m = /^username=(.+)$/m.exec(out);
    if (m) return m[1].trim();
  } catch (e) {}
  return null;
}

function _resetForTest() {
  _accountsCache = { at: 0, accounts: null };
  _ghBin = null;
  _execFile = execFile;
  _execFileSync = execFileSync;
  _execSync = execSync;
  _existsSync = fs.existsSync;
  _now = function () { return Date.now(); };
  _log = function (msg) { console.log(msg); };
}

function _setTestHooks(hooks) {
  hooks = hooks || {};
  if (hooks.execFile) _execFile = hooks.execFile;
  if (hooks.execFileSync) _execFileSync = hooks.execFileSync;
  if (hooks.execSync) _execSync = hooks.execSync;
  if (hooks.existsSync) _existsSync = hooks.existsSync;
  if (hooks.now) _now = hooks.now;
  if (hooks.log) _log = hooks.log;
}

module.exports = {
  listGitHubAccounts: listGitHubAccounts,
  listGitHubAccountsAsync: listGitHubAccountsAsync,
  applyProjectGitAccount: applyProjectGitAccount,
  getProjectGitAccount: getProjectGitAccount,
  resolveProjectGitAccount: resolveProjectGitAccount,
  isGitRepo: isGitRepo,
  _test: {
    parseAccounts: parseAccounts,
    ghStatusText: ghStatusText,
    reset: _resetForTest,
    setHooks: _setTestHooks,
  },
};
