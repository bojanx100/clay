// Tests for the Lead structural metrics module (Phase 2 done-gate values).
var test = require("node:test");
var assert = require("node:assert");

var metrics = require("../lib/lead-metrics");
var standup = require("../lib/lead-standup");

// --- Coverage ratchet ---------------------------------------------------------

test("first run freezes the baseline at the measured level", function () {
  var d = metrics.evaluateCoverage(37.78, null);
  assert.strictEqual(d.pass, true);
  assert.strictEqual(d.ratcheted, true);
  assert.strictEqual(d.baseline, 37.78);
  assert.strictEqual(d.nextBaseline, 37.78);
});

test("meeting the baseline exactly passes without ratcheting", function () {
  var d = metrics.evaluateCoverage(37.78, 37.78);
  assert.strictEqual(d.pass, true);
  assert.strictEqual(d.ratcheted, false);
  assert.strictEqual(d.nextBaseline, 37.78);
});

test("exceeding the baseline passes and ratchets it up", function () {
  var d = metrics.evaluateCoverage(41.2, 37.78);
  assert.strictEqual(d.pass, true);
  assert.strictEqual(d.ratcheted, true);
  assert.strictEqual(d.nextBaseline, 41.2);
});

test("dropping below the baseline fails and never lowers it", function () {
  var d = metrics.evaluateCoverage(35.0, 37.78);
  assert.strictEqual(d.pass, false);
  assert.strictEqual(d.ratcheted, false);
  assert.strictEqual(d.nextBaseline, 37.78);
});

test("float noise within epsilon does not fail the gate", function () {
  var d = metrics.evaluateCoverage(37.779, 37.78);
  assert.strictEqual(d.pass, true);
});

// --- Complexity ceiling ---------------------------------------------------------

function eslintResult(file, complexityLines) {
  var messages = [];
  for (var i = 0; i < complexityLines.length; i++) {
    messages.push({ ruleId: "complexity", line: complexityLines[i], message: "Function has a complexity of 20. Maximum allowed is 15." });
  }
  return { filePath: file, messages: messages };
}

test("clean changed files pass the complexity gate", function () {
  var d = metrics.evaluateComplexity([{ filePath: "lib/a.js", messages: [] }], ["lib/a.js"]);
  assert.strictEqual(d.pass, true);
  assert.strictEqual(d.changedFiles, 1);
  assert.strictEqual(d.violations.length, 0);
  assert.strictEqual(d.ceiling, metrics.COMPLEXITY_CEILING);
});

test("complexity violations fail the gate with file and line", function () {
  var d = metrics.evaluateComplexity([eslintResult("lib/b.js", [12, 90])], ["lib/b.js"]);
  assert.strictEqual(d.pass, false);
  assert.strictEqual(d.violations.length, 2);
  assert.strictEqual(d.violations[0].file, "lib/b.js");
  assert.strictEqual(d.violations[0].line, 12);
});

test("non-complexity eslint messages are ignored", function () {
  var d = metrics.evaluateComplexity([
    { filePath: "lib/c.js", messages: [{ ruleId: "no-unused-vars", line: 3, message: "x" }] },
  ], ["lib/c.js"]);
  assert.strictEqual(d.pass, true);
});

test("no changed files passes vacuously", function () {
  var d = metrics.evaluateComplexity([], []);
  assert.strictEqual(d.pass, true);
  assert.strictEqual(d.changedFiles, 0);
});

// --- Report composition ----------------------------------------------------------

test("report is green only when both gates pass", function () {
  var green = metrics.composeReport({
    project: "clay", now: 1785800000000,
    coverage: metrics.evaluateCoverage(38, 37.78),
    complexity: metrics.evaluateComplexity([], []),
  });
  assert.strictEqual(green.type, "metrics_report");
  assert.strictEqual(green.pass, true);
  assert.strictEqual(green.mutation, null);

  var red = metrics.composeReport({
    project: "clay", now: 1785800000000,
    coverage: metrics.evaluateCoverage(30, 37.78),
    complexity: metrics.evaluateComplexity([], []),
  });
  assert.strictEqual(red.pass, false);
});

test("formatReportLine states verdict, ratchet and ceiling", function () {
  var report = metrics.composeReport({
    project: "clay", now: 0,
    coverage: metrics.evaluateCoverage(41.2, 37.78),
    complexity: metrics.evaluateComplexity([], ["lib/a.js", "lib/b.js"]),
  });
  var line = metrics.formatReportLine(report);
  assert.ok(/GREEN/.test(line));
  assert.ok(/ratcheted to 41.2%/.test(line));
  assert.ok(/2 changed file\(s\)/.test(line));

  var redLine = metrics.formatReportLine(metrics.composeReport({
    project: "clay", now: 0,
    coverage: metrics.evaluateCoverage(30, 37.78),
    complexity: metrics.evaluateComplexity([eslintResult("lib/b.js", [7])], ["lib/b.js"]),
  }));
  assert.ok(/RED/.test(redLine));
  assert.ok(/BELOW baseline 37.78%/.test(redLine));
  assert.ok(/1 violation\(s\)/.test(redLine));
});

// --- Standup consumption -----------------------------------------------------------

test("standup Health shows the latest metrics_report", function () {
  var report = metrics.composeReport({
    project: "clay", now: 1785800000000,
    coverage: metrics.evaluateCoverage(38, 37.78),
    complexity: metrics.evaluateComplexity([], []),
  });
  var out = standup.composeStandup({
    now: 1785800000000,
    events: [report],
    canaries: { recoveryEvents: 0, wsHandlerErrors: 0 },
  });
  assert.ok(/metrics GREEN/.test(out.text));
});

test("standup says aloud when no metrics report exists", function () {
  var out = standup.composeStandup({ now: 0, events: [], canaries: null });
  assert.ok(/no structural metrics report/.test(out.text));
});

test("standup flags a red suite at metrics time", function () {
  var report = metrics.composeReport({
    project: "clay", now: 0,
    coverage: metrics.evaluateCoverage(38, 37.78),
    complexity: metrics.evaluateComplexity([], []),
  });
  report.suiteFailed = true;
  report.pass = false;
  var out = standup.composeStandup({ now: 0, events: [report], canaries: null });
  assert.ok(/SUITE RED at metrics time/.test(out.text));
});
