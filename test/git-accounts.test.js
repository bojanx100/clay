var test = require("node:test");
var assert = require("node:assert");

function loadGitAccounts() {
  delete require.cache[require.resolve("../lib/git-accounts")];
  var gitAccounts = require("../lib/git-accounts");
  gitAccounts._test.reset();
  return gitAccounts;
}

function installStatusHooks(gitAccounts, state) {
  gitAccounts._test.setHooks({
    now: function () { return state.now; },
    existsSync: function () { return true; },
    log: function () {},
    execSync: function (cmd) {
      if (cmd.indexOf("command -v gh") !== -1) return "/usr/bin/gh\n";
      if (cmd.indexOf("auth status") !== -1) {
        state.statusCalls++;
        return state.statusText;
      }
      throw new Error("unexpected execSync: " + cmd);
    },
    execFile: function (cmd, args, opts, cb) {
      state.asyncCalls++;
      cb(null, state.asyncStdout || "", state.asyncStderr || "");
    },
  });
}

test("parseAccounts handles old stderr and new stdout gh auth status formats", function () {
  var gitAccounts = loadGitAccounts();
  var text = [
    "github.com",
    "  X Failed to log in to github.com account stale-user (keyring)",
    "  - Logged in to github.com account old-user (/Users/me/.config/gh/hosts.yml)",
    "  - Logged in to github.com account new-user (/Users/me/.config/gh/hosts.yml)",
    "  - Logged in to github.com account old-user (/Users/me/.config/gh/hosts.yml)",
  ].join("\n");

  assert.deepStrictEqual(gitAccounts._test.parseAccounts(text), ["stale-user", "old-user", "new-user"]);
});

test("listGitHubAccounts honors the cache TTL", function () {
  var gitAccounts = loadGitAccounts();
  var state = {
    now: 1000,
    statusCalls: 0,
    asyncCalls: 0,
    statusText: "github.com\n  - Logged in to github.com account cache-user (/tmp/hosts.yml)\n",
  };
  installStatusHooks(gitAccounts, state);

  assert.deepStrictEqual(gitAccounts.listGitHubAccounts(), ["cache-user"]);
  assert.deepStrictEqual(gitAccounts.listGitHubAccounts(), ["cache-user"]);
  assert.strictEqual(state.statusCalls, 1);

  state.now += 60001;
  state.statusText = "github.com\n  - Logged in to github.com account refreshed-user (/tmp/hosts.yml)\n";
  assert.deepStrictEqual(gitAccounts.listGitHubAccounts(), ["refreshed-user"]);
  assert.strictEqual(state.statusCalls, 2);
});

test("sync and async account listing share the cache", async function () {
  var gitAccounts = loadGitAccounts();
  var state = {
    now: 1000,
    statusCalls: 0,
    asyncCalls: 0,
    statusText: "github.com\n  - Logged in to github.com account sync-user (/tmp/hosts.yml)\n",
    asyncStdout: "github.com\n  - Logged in to github.com account async-user (/tmp/hosts.yml)\n",
  };
  installStatusHooks(gitAccounts, state);

  assert.deepStrictEqual(gitAccounts.listGitHubAccounts(), ["sync-user"]);
  assert.deepStrictEqual(await gitAccounts.listGitHubAccountsAsync(), ["sync-user"]);
  assert.strictEqual(state.statusCalls, 1);
  assert.strictEqual(state.asyncCalls, 0);

  gitAccounts._test.reset();
  state.now = 2000;
  state.statusCalls = 0;
  state.asyncCalls = 0;
  installStatusHooks(gitAccounts, state);

  assert.deepStrictEqual(await gitAccounts.listGitHubAccountsAsync(), ["async-user"]);
  assert.deepStrictEqual(gitAccounts.listGitHubAccounts(), ["async-user"]);
  assert.strictEqual(state.asyncCalls, 1);
  assert.strictEqual(state.statusCalls, 0);
});

test("ghStatusText returns partial timeout output instead of throwing", function () {
  var gitAccounts = loadGitAccounts();
  gitAccounts._test.setHooks({
    existsSync: function () { return true; },
    log: function () {},
    execSync: function (cmd) {
      if (cmd.indexOf("command -v gh") !== -1) return "/usr/bin/gh\n";
      if (cmd.indexOf("auth status") !== -1) {
        var err = new Error("timed out");
        err.stdout = "github.com\n  - Logged in to github.com account stdout-user (/tmp/hosts.yml)\n";
        err.stderr = "  - Logged in to github.com account stderr-user (/tmp/hosts.yml)\n";
        throw err;
      }
      throw new Error("unexpected execSync: " + cmd);
    },
  });

  var text = gitAccounts._test.ghStatusText();
  assert.ok(text.indexOf("stdout-user") !== -1);
  assert.ok(text.indexOf("stderr-user") !== -1);
  assert.deepStrictEqual(gitAccounts._test.parseAccounts(text), ["stdout-user", "stderr-user"]);
});
