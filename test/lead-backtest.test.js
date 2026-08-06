var test = require("node:test");
var assert = require("node:assert");
var backtest = require("../lib/lead-backtest");

test("prIssueNumber extracts from branch convention", function () {
  assert.strictEqual(backtest.prIssueNumber({ headRefName: "fix/2296-remove-old-flows" }), 2296);
  assert.strictEqual(backtest.prIssueNumber({ headRefName: "feat/101" }), 101);
});

test("prIssueNumber falls back to title reference", function () {
  assert.strictEqual(backtest.prIssueNumber({ headRefName: "some-branch", title: "fix(#2208): keep state" }), 2208);
  assert.strictEqual(backtest.prIssueNumber({ headRefName: "chore/deps", title: "no ref here" }), null);
});

test("joinGroundTruth pairs issues and prefers the largest PR", function () {
  var issues = [{ number: 10, title: "A" }, { number: 11, title: "B" }];
  var prs = [
    { headRefName: "fix/10-first", additions: 5, deletions: 0 },
    { headRefName: "fix/10-followup", additions: 300, deletions: 40 },
    { headRefName: "fix/99-unrelated", additions: 1, deletions: 0 },
  ];
  var pairs = backtest.joinGroundTruth(issues, prs);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].issue.number, 10);
  assert.strictEqual(pairs[0].pr.additions, 300);
});

test("effortBucket boundaries", function () {
  assert.strictEqual(backtest.effortBucket({ changedFiles: 1, additions: 9, deletions: 0 }), "small");
  assert.strictEqual(backtest.effortBucket({ changedFiles: 2, additions: 30, deletions: 30 }), "small");
  assert.strictEqual(backtest.effortBucket({ changedFiles: 5, additions: 200, deletions: 50 }), "medium");
  assert.strictEqual(backtest.effortBucket({ changedFiles: 20, additions: 500, deletions: 500 }), "large");
  assert.strictEqual(backtest.effortBucket({ changedFiles: 3, additions: 700, deletions: 0 }), "large");
});

test("compareRouting verdicts over/under/aligned", function () {
  var pairs = [
    { issue: { number: 1, title: "small tweak" }, pr: { changedFiles: 1, additions: 5, deletions: 1 } },
    { issue: { number: 2, title: "big rework" }, pr: { changedFiles: 30, additions: 2000, deletions: 900 } },
  ];
  var classifyFn = function () { return { taskClass: "implementation", risk: "low", effort: "small" }; };
  var tiers = { 1: 4, 2: 1 };
  var routeFn = function () { return null; };
  var rows = backtest.compareRouting(pairs, classifyFn, function () {
    routeFn.calls = (routeFn.calls || 0) + 1;
    return { tier: tiers[routeFn.calls === 1 ? 1 : 2] };
  });
  assert.strictEqual(rows[0].verdict, "over");   // t4 for a small fix
  assert.strictEqual(rows[1].verdict, "under");  // t1 for a large fix
});

test("compareRouting flags unroutable", function () {
  var pairs = [{ issue: { number: 1, title: "x" }, pr: { changedFiles: 1, additions: 1, deletions: 0 } }];
  var rows = backtest.compareRouting(pairs,
    function () { return { taskClass: "implementation", risk: "low" }; },
    function () { return null; });
  assert.strictEqual(rows[0].verdict, "unroutable");
});

test("composeBacktestReport aggregates and computes alignment pct", function () {
  var rows = [
    { verdict: "aligned" }, { verdict: "aligned" }, { verdict: "over" }, { verdict: "under" },
  ];
  var report = backtest.composeBacktestReport(rows, { at: 123, repo: "o/r" });
  assert.strictEqual(report.type, "backtest_report");
  assert.strictEqual(report.total, 4);
  assert.strictEqual(report.aligned, 2);
  assert.strictEqual(report.alignmentPct, 50);
  assert.strictEqual(report.at, 123);
});

test("formatBacktestReport is printable and carries the summary", function () {
  var report = backtest.composeBacktestReport([
    { verdict: "aligned", number: 7, predictedTier: 2, taskClass: "debugging", risk: "low", bucket: "medium", files: 3, lines: 80, title: "Some bug" },
  ], { at: 1, repo: "o/r" });
  var text = backtest.formatBacktestReport(report);
  assert.ok(text.indexOf("alignment 100%") !== -1);
  assert.ok(text.indexOf("#7 [aligned] t2") !== -1);
});

// --- scripts/lead-backtest.js CLI ---------------------------------------------
// The runner is a real caller of lead-backlog's source resolution. When the
// first-file-wins extractor was removed, this script still called it and died
// with "githubSourcesFromTaskConfigs is not a function" before it could reach
// its own error handling. These drive the actual script end to end, in a real
// git repo, so a removed or renamed export can never break it unnoticed again.
var childProcess = require("node:child_process");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var SCRIPT = path.join(__dirname, "..", "scripts", "lead-backtest.js");

function makeProject(originUrl, recipe) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-backtest-"));
  childProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
  if (originUrl) childProcess.execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
  var tasksDir = path.join(dir, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  var configPath = path.join(tasksDir, "assigned-to-me.json");
  fs.writeFileSync(configPath, JSON.stringify(recipe));
  return { dir: dir, configPath: configPath };
}

function runScript(configPath) {
  var result = childProcess.spawnSync(process.execPath, [SCRIPT, configPath], { encoding: "utf8", timeout: 30000 });
  return { status: result.status, stderr: String(result.stderr || "") };
}

function assertNoCrash(stderr) {
  assert.ok(stderr.indexOf("is not a function") === -1, "must not crash on a missing export: " + stderr);
  assert.ok(stderr.indexOf("TypeError") === -1, "must not throw a TypeError: " + stderr);
}

test("lead-backtest CLI fails closed when the project does not own the repo", function () {
  // The exact misplaced-launcher shape: a project whose origin is its own repo
  // carrying a recipe that points at somebody else's.
  var project = makeProject("https://github.com/bojanx100/clay.git", {
    id: "assigned-to-me",
    source: { provider: "github", kind: "issue", repo: "trialview/v2" },
  });
  var run = runScript(project.configPath);
  assertNoCrash(run.stderr);
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /unresolved repository ownership/);
  assert.match(run.stderr, /unowned_repository_source/);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test("lead-backtest CLI reports a config with no github issue source", function () {
  var project = makeProject("https://github.com/bojanx100/clay.git", {
    id: "sentry-fix",
    source: { provider: "sentry", kind: "findings" },
  });
  var run = runScript(project.configPath);
  assertNoCrash(run.stderr);
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /no github issue source/);
  fs.rmSync(project.dir, { recursive: true, force: true });
});
