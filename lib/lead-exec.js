// Per-repo gh credentials wrapper for the Lead backlog collector.
//
// Why this exists (observed 2026-08-02): with gh multi-account, a repo can be
// invisible to the globally-active account (e.g. trialview/v2 is invisible to
// bojanx100). The Lead scans several repos owned by different accounts in one
// tick, so it cannot rely on whichever account happens to be active — and it
// must NOT run `gh auth switch`, because other sessions depend on the global
// account staying put.
//
// This module produces an `execFn` suitable for injection into
// lead-backlog.collectGithubIssues. Given a sourceSpec that carries an optional
// `ghAccount`, the returned execFn resolves a token via
// `gh auth token --user <account>` and injects it as GH_TOKEN in the child's
// env for THAT invocation only. It never mutates the global gh account.
//
// Security contract:
//   - The token is passed via the child env only, never in argv (so it can
//     never appear in a "Command failed: gh ..." error message).
//   - The token value is never logged, thrown, or otherwise surfaced. Only the
//     resolution ERROR (which by construction never contains the token) is
//     surfaced, so a failed lookup is observable without leaking secrets.
//   - Missing account, or a failed/empty token lookup, degrades to a plain
//     exec against the active account — the same per-source degradation
//     contract collectGithubIssues already honours (one bad repo never kills
//     the tick).
//
// Purity/testability: the child_process.execFile used for both the token
// lookup and the gh invocation is injectable (opts.execFile), so tests drive a
// fake gh with no real credentials. The log sink (opts.log) is injectable too,
// so tests can assert what was surfaced.

var childProcess = require("child_process");

var GH_ISSUE_MAX_BUFFER = 20 * 1024 * 1024; // gh issue bodies can be large
var TOKEN_TIMEOUT_MS = 10000;
var GH_TIMEOUT_MS = 60000;

// Redact anything that looks like a gh token, as a defense-in-depth belt over
// the "never log the token" braces: even if a future edit accidentally routes
// the token near a log line, this strips it. gh tokens are gh[pousr]_<base62>.
function redactTokens(text) {
  return String(text == null ? "" : text).replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "***");
}

// Resolve a token for `account` via `gh auth token --user <account>`.
// cb(err, token). On any failure, err is set and token is "". The token is the
// child's STDOUT here, so it is never placed in argv and never logged.
function resolveTokenDefault(execFile, account, cb) {
  execFile("gh", ["auth", "token", "--user", account], {
    encoding: "utf8",
    timeout: TOKEN_TIMEOUT_MS,
  }, function (err, stdout) {
    if (err) return cb(err, "");
    var token = String(stdout || "").trim();
    if (!token) return cb(new Error("gh auth token returned no token for account " + account), "");
    cb(null, token);
  });
}

// Run `<cmd> <args>` with the given env (or process.env when env is null).
// Adapts execFile's (err, stdout, stderr) to collectGithubIssues' (err, stdout).
function runGhDefault(execFile, cmd, args, env, cb) {
  execFile(cmd || "gh", args, {
    encoding: "utf8",
    maxBuffer: GH_ISSUE_MAX_BUFFER,
    timeout: GH_TIMEOUT_MS,
    env: env || process.env,
  }, function (err, stdout) {
    cb(err, stdout);
  });
}

// createGhExecFn(sourceSpec, opts) -> execFn(cmd, args, cb)
//   sourceSpec: the same spec handed to collectGithubIssues; only its optional
//     `ghAccount` field is read here (bounded on purpose — no git-accounts
//     lookup, no global state).
//   opts.execFile: child_process.execFile override (tests inject a fake gh).
//   opts.log: function(message) sink for the degradation warning; defaults to
//     console.error. It only ever receives redacted, token-free text.
//   opts.resolveToken / opts.runGh: finer-grained overrides for tests; default
//     to the execFile-backed implementations above.
function createGhExecFn(sourceSpec, opts) {
  opts = opts || {};
  var execFile = opts.execFile || childProcess.execFile;
  var log = opts.log || function (message) { console.error(message); };
  var resolveToken = opts.resolveToken || function (account, cb) { resolveTokenDefault(execFile, account, cb); };
  var runGh = opts.runGh || function (cmd, args, env, cb) { runGhDefault(execFile, cmd, args, env, cb); };

  var account = sourceSpec && sourceSpec.ghAccount ? String(sourceSpec.ghAccount) : "";
  var repo = sourceSpec && sourceSpec.repo ? String(sourceSpec.repo) : "";
  var resolved = false;
  var resolvedToken = "";

  return function execFn(cmd, args, cb) {
    // No pinned account -> plain exec against whatever account is active.
    if (!account) return runGh(cmd, args, null, cb);

    if (resolved) {
      return runGh(cmd, args, resolvedToken ? Object.assign({}, process.env, { GH_TOKEN: resolvedToken }) : null, cb);
    }

    resolveToken(account, function (tokenErr, token) {
      resolved = true;
      resolvedToken = tokenErr || !token ? "" : token;
      if (tokenErr || !token) {
        // Degrade to the active account, but make the failure observable. The
        // token never existed here, and we redact defensively regardless.
        var reason = tokenErr && tokenErr.message ? tokenErr.message : "no token";
        log("[lead-exec] gh auth token --user " + account + " failed for repo " +
          (repo || "?") + "; degrading to active account: " + redactTokens(reason));
        return runGh(cmd, args, null, cb);
      }
      // Token goes in env ONLY — never in args, never in a log line.
      var env = Object.assign({}, process.env, { GH_TOKEN: resolvedToken });
      runGh(cmd, args, env, cb);
    });
  };
}

module.exports = {
  createGhExecFn: createGhExecFn,
  redactTokens: redactTokens,
};
