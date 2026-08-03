// Tests for the per-repo gh credentials wrapper (lib/lead-exec).
//
// SECURITY: no real credentials are used. A fake gh (via an injected execFile)
// stands in for the binary. The fake auth-token call returns a sentinel token
// string; every test asserts that sentinel NEVER leaks into argv, thrown
// errors, or the log sink — it may only appear inside the child env.
var test = require("node:test");
var assert = require("node:assert");

var leadExec = require("../lib/lead-exec");
var backlog = require("../lib/lead-backlog");

var FAKE_TOKEN = "ghp_FAKETOKENvalue0000000000000000000000";

// Build a fake execFile that records every invocation and dispatches on args[0].
// - `gh auth token --user <acct>`  -> resolves the fake token (unless failAuth)
// - anything else (issue list)     -> returns issuesJson, capturing the env
function makeFakeExecFile(options) {
  options = options || {};
  var calls = [];
  var fake = function (file, args, execOpts, cb) {
    calls.push({ file: file, args: args.slice(), env: execOpts && execOpts.env });
    if (args[0] === "auth" && args[1] === "token") {
      if (options.failAuth) return cb(new Error("no accounts matched account for user"), "");
      if (options.emptyAuth) return cb(null, "\n");
      return cb(null, FAKE_TOKEN + "\n");
    }
    // issue-list path
    if (options.listError) return cb(options.listError, "");
    return cb(null, options.issuesJson != null ? options.issuesJson : "[]");
  };
  return { fake: fake, calls: calls };
}

var GH_FIXTURE = JSON.stringify([
  { number: 7, title: "Invisible-repo issue", body: "", labels: [], state: "OPEN", updatedAt: "2026-08-01T10:00:00Z", url: "https://x/7" },
]);

// (1) A sourceSpec WITH ghAccount injects GH_TOKEN in env and NOT in argv.
test("ghAccount injects GH_TOKEN in env, never in argv", function (t, done) {
  var f = makeFakeExecFile({ issuesJson: GH_FIXTURE });
  var logged = [];
  var spec = { repo: "trialview/v2", ghAccount: "bojantv", filters: {} };
  var execFn = leadExec.createGhExecFn(spec, { execFile: f.fake, log: function (m) { logged.push(m); } });

  backlog.collectGithubIssues(execFn, spec, "trialview", function (err, items) {
    assert.strictEqual(err, null);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, "trialview#7");

    // Two gh calls: token lookup, then issue list.
    assert.strictEqual(f.calls.length, 2);
    var authCall = f.calls[0];
    var listCall = f.calls[1];
    assert.deepStrictEqual(authCall.args, ["auth", "token", "--user", "bojantv"]);

    // Token present in the issue-list env...
    assert.strictEqual(listCall.env.GH_TOKEN, FAKE_TOKEN);
    // ...and ABSENT from argv (both calls) and from the log sink.
    assert.ok(listCall.args.indexOf(FAKE_TOKEN) === -1, "token must not be in issue-list argv");
    assert.ok(JSON.stringify(f.calls.map(function (c) { return c.args; })).indexOf(FAKE_TOKEN) === -1, "token must not appear in any argv");
    assert.ok(logged.join("\n").indexOf(FAKE_TOKEN) === -1, "token must not be logged");
    done();
  });
});

// (2) A sourceSpec WITHOUT ghAccount uses plain exec, unchanged: no token
// lookup happens and env is inherited (no GH_TOKEN override injected).
test("no ghAccount uses plain exec, no token lookup, no GH_TOKEN override", function (t, done) {
  var f = makeFakeExecFile({ issuesJson: GH_FIXTURE });
  var logged = [];
  var spec = { repo: "bojantv/clay", filters: {} };
  var execFn = leadExec.createGhExecFn(spec, { execFile: f.fake, log: function (m) { logged.push(m); } });

  backlog.collectGithubIssues(execFn, spec, "clay", function (err, items) {
    assert.strictEqual(err, null);
    assert.strictEqual(items.length, 1);
    // Exactly one call — the issue list. No `gh auth token` invocation at all.
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].args[0], "issue");
    // Plain exec inherits process.env verbatim — no injected GH_TOKEN override.
    assert.strictEqual(f.calls[0].env, process.env);
    assert.strictEqual(f.calls[0].env.GH_TOKEN, process.env.GH_TOKEN);
    assert.strictEqual(logged.length, 0);
    done();
  });
});

// (3) Token resolution failure degrades to plain exec: the error is surfaced
// (logged) but no token value appears anywhere, and the plain exec still runs.
test("auth failure degrades to plain exec, surfaces error, leaks no token", function (t, done) {
  var f = makeFakeExecFile({ failAuth: true, issuesJson: GH_FIXTURE });
  var logged = [];
  var spec = { repo: "trialview/v2", ghAccount: "ghost-account", filters: {} };
  var execFn = leadExec.createGhExecFn(spec, { execFile: f.fake, log: function (m) { logged.push(m); } });

  backlog.collectGithubIssues(execFn, spec, "trialview", function (err, items) {
    // Plain exec still ran and returned results (repo happened to be visible).
    assert.strictEqual(err, null);
    assert.strictEqual(items.length, 1);
    // Two calls: the failed auth lookup, then the degraded plain issue list.
    assert.strictEqual(f.calls.length, 2);
    // The issue-list call had NO GH_TOKEN override (degraded to active account).
    assert.strictEqual(f.calls[1].env, process.env);
    assert.strictEqual(f.calls[1].env.GH_TOKEN, process.env.GH_TOKEN);
    // The failure was surfaced observably...
    var logText = logged.join("\n");
    assert.ok(/gh auth token/.test(logText), "resolution failure must be surfaced");
    assert.ok(/ghost-account/.test(logText), "surfaced error names the account");
    // ...with no token value anywhere (it never existed here).
    assert.ok(logText.indexOf(FAKE_TOKEN) === -1, "no token in log");
    done();
  });
});

// (3b) Empty token (auth succeeds but returns nothing) also degrades.
test("empty token degrades to plain exec", function (t, done) {
  var f = makeFakeExecFile({ emptyAuth: true, issuesJson: GH_FIXTURE });
  var logged = [];
  var spec = { repo: "trialview/v2", ghAccount: "bojantv", filters: {} };
  var execFn = leadExec.createGhExecFn(spec, { execFile: f.fake, log: function (m) { logged.push(m); } });

  backlog.collectGithubIssues(execFn, spec, "trialview", function (err, items) {
    assert.strictEqual(err, null);
    assert.strictEqual(f.calls.length, 2);
    assert.strictEqual(f.calls[1].env, process.env, "no GH_TOKEN override on empty token");
    assert.ok(/degrading to active account/.test(logged.join("\n")));
    done();
  });
});

// Degradation contract preserved: with a pinned account, a gh failure on the
// issue-list call still yields (err, []) — one bad repo never kills the tick,
// and no token appears in the surfaced error.
test("pinned account + gh list failure yields (err, []) with no token leak", function (t, done) {
  var listErr = new Error("Command failed: gh issue list --repo trialview/v2 ...");
  var f = makeFakeExecFile({ listError: listErr });
  var logged = [];
  var spec = { repo: "trialview/v2", ghAccount: "bojantv", filters: {} };
  var execFn = leadExec.createGhExecFn(spec, { execFile: f.fake, log: function (m) { logged.push(m); } });

  backlog.collectGithubIssues(execFn, spec, "trialview", function (err, items) {
    assert.ok(err);
    assert.deepStrictEqual(items, []);
    // Token was injected in env for the attempt, but the surfaced error is argv
    // only and carries no token.
    assert.strictEqual(f.calls[1].env.GH_TOKEN, FAKE_TOKEN);
    assert.ok(String(err.message).indexOf(FAKE_TOKEN) === -1, "error message carries no token");
    done();
  });
});

// redactTokens strips gh token shapes defensively.
test("redactTokens masks gh token shapes", function () {
  assert.strictEqual(leadExec.redactTokens("leak " + FAKE_TOKEN + " end"), "leak *** end");
  assert.strictEqual(leadExec.redactTokens("gho_" + "A".repeat(36)), "***");
  assert.strictEqual(leadExec.redactTokens(null), "");
  assert.strictEqual(leadExec.redactTokens("nothing here"), "nothing here");
});
