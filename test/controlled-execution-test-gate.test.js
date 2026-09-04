"use strict";

var test = require("node:test");
var assert = require("node:assert");
var path = require("node:path");

var runner = require("../scripts/run-tests.js");
var { COOP_CONTROL_ENVIRONMENT } = require("../lib/config");

function controlFlagNames() {
  return Object.keys(COOP_CONTROL_ENVIRONMENT).map(function (key) {
    return COOP_CONTROL_ENVIRONMENT[key];
  });
}

// The default pass must stay hermetic: a developer shell with the control flags
// set must not change what the gate reports.
test("the default pass strips every Coop control flag", function () {
  var source = { PATH: "/usr/bin" };
  var names = controlFlagNames();
  for (var i = 0; i < names.length; i++) source[names[i]] = "1";

  var environment = runner.isolatedTestEnvironment(source, "/tmp/clay-test-home");

  for (var j = 0; j < names.length; j++) {
    assert.equal(environment[names[j]], undefined, names[j] + " must be stripped");
  }
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.CLAY_HOME, "/tmp/clay-test-home");
});

// Regression: the controlled path was invisible to `npm test` because the only
// pass ran with control stripped. The controlled pass must enable every flag.
test("the controlled pass enables every Coop control flag", function () {
  var environment = runner.controlledTestEnvironment({ PATH: "/usr/bin" }, "/tmp/clay-test-home");

  var names = controlFlagNames();
  assert.ok(names.length > 0, "there must be control flags to enable");
  for (var i = 0; i < names.length; i++) {
    assert.equal(environment[names[i]], "1", names[i] + " must be enabled");
  }
  assert.equal(environment.CLAY_HOME, "/tmp/clay-test-home");
});

test("control-plane suites are selected into the controlled pass", function () {
  var covered = [
    "test/project-task-orchestrator.test.js",
    "test/project-task-orchestrator-external-delegation.test.js",
    "test/coop-thread-execution-admission.test.js",
    "test/automation-candidate-admission.test.js",
    "test/coop-control-review-blockers.test.js",
    "test/portfolio-execution-bindings.test.js",
  ];
  for (var i = 0; i < covered.length; i++) {
    assert.equal(runner.isControlledSuite(covered[i]), true, covered[i] + " must be covered");
  }
});

test("unrelated suites stay out of the controlled pass", function () {
  var skipped = ["test/lazy-session-history.test.js", "test/dev-watcher-takeover.test.js"];
  for (var i = 0; i < skipped.length; i++) {
    assert.equal(runner.isControlledSuite(skipped[i]), false, skipped[i] + " must be skipped");
  }
});

// This suite asserts the default-off gate itself, so running it with the flags
// on would fail for reasons that say nothing about controlled execution.
test("the default-off gate suite is excluded from the controlled pass", function () {
  assert.equal(runner.isControlledSuite("test/coop-control-store.test.js"), false);
  assert.equal(runner.isControlledSuite(path.join("test", "coop-control-store.test.js")), false);
});

function fileResult(file, tests, pass, fail, overrides) {
  return Object.assign({
    file: file,
    status: fail > 0 ? 1 : 0,
    signal: null,
    error: null,
    summary: { tests: tests, pass: pass, fail: fail },
    output: "",
  }, overrides || {});
}

test("per-file results are summed into one exact total", function () {
  var files = ["test/a.test.js", "test/b.test.js"];
  var accounting = runner.accountForResults(files, [
    fileResult(files[0], 3, 3, 0),
    fileResult(files[1], 4, 4, 0),
  ]);

  assert.deepEqual(accounting.totals, { files: 2, tests: 7, pass: 7, fail: 0 });
  assert.equal(accounting.failed.length, 0);
  assert.equal(accounting.missing.length, 0);
});

// Regression: the gate used to check a magic EXPECTED_MIN_TESTS floor, which
// could not tell a file that vanished from a file that simply shrank. Every
// launched file must report a parseable summary or the run is not accounted for.
test("a file that reports no summary is named as missing", function () {
  var files = ["test/a.test.js", "test/gone.test.js"];
  var accounting = runner.accountForResults(files, [
    fileResult(files[0], 3, 3, 0),
    fileResult(files[1], 0, 0, 0, { summary: null, status: 0 }),
  ]);

  assert.equal(accounting.missing.length, 1);
  assert.equal(accounting.missing[0].file, "test/gone.test.js");
  assert.match(accounting.missing[0].reason, /without a test summary/);
  // The lost file must not be silently absorbed into a green total.
  assert.equal(accounting.totals.tests, 3);
});

test("a file that never completed at all is named as missing", function () {
  var files = ["test/a.test.js", "test/never-ran.test.js"];
  var accounting = runner.accountForResults(files, [fileResult(files[0], 1, 1, 0)]);

  assert.equal(accounting.missing.length, 1);
  assert.equal(accounting.missing[0].file, "test/never-ran.test.js");
  assert.equal(accounting.missing[0].reason, "never completed");
});

test("a killed file is reported as missing with its signal", function () {
  var files = ["test/killed.test.js"];
  var accounting = runner.accountForResults(files, [
    fileResult(files[0], 0, 0, 0, { summary: null, status: 1, signal: "SIGKILL" }),
  ]);

  assert.equal(accounting.missing.length, 1);
  assert.equal(accounting.missing[0].reason, "killed by SIGKILL");
});

test("a file that reported failures is collected as failed, not missing", function () {
  var files = ["test/red.test.js"];
  var accounting = runner.accountForResults(files, [fileResult(files[0], 5, 3, 2)]);

  assert.equal(accounting.missing.length, 0);
  assert.equal(accounting.failed.length, 1);
  assert.equal(accounting.failed[0].file, "test/red.test.js");
  assert.deepEqual(accounting.totals, { files: 1, tests: 5, pass: 3, fail: 2 });
});

// A non-zero exit with a clean summary still means the file did not pass, so it
// must not be reported green just because no assertion failed.
test("a file that exits non-zero with no failing test is still failed", function () {
  var files = ["test/dirty-exit.test.js"];
  var accounting = runner.accountForResults(files, [
    fileResult(files[0], 2, 2, 0, { status: 7 }),
  ]);

  assert.equal(accounting.failed.length, 1);
  assert.equal(accounting.failed[0].status, 7);
});

test("the TAP summary parser reads tests, pass and fail", function () {
  var os = require("node:os");
  var fs = require("node:fs");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-tap-parse-"));
  var summaryPath = path.join(dir, "summary.tap");
  try {
    fs.writeFileSync(summaryPath, "TAP version 13\n1..1\nok 1 - x\n# tests 9\n# pass 8\n# fail 1\n");
    assert.deepEqual(runner.parseTapSummary(summaryPath), { tests: 9, pass: 8, fail: 1 });

    fs.writeFileSync(summaryPath, "TAP version 13\n1..1\nok 1 - x\n");
    assert.equal(runner.parseTapSummary(summaryPath), null, "a truncated report has no total");

    assert.equal(runner.parseTapSummary(path.join(dir, "absent.tap")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("test concurrency is bounded and at least one", function () {
  assert.ok(runner.testConcurrency() >= 1);
  assert.equal(Number.isInteger(runner.testConcurrency()), true);
});
