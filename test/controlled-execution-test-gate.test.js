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
