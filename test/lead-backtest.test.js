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
