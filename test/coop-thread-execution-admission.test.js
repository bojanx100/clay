var test = require("node:test");
var assert = require("node:assert/strict");

var lifecycle = require("../lib/coop-thread-lifecycle");

test("ordinary discussion and project mentions do not admit typed execution", function () {
  assert.equal(lifecycle.explicitImplementationDecision("What is happening with the Clay sidebar?"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Discuss the approach for the Clay project"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Could this be a useful follow-up?"), null);
});

test("explicit owner implementation decisions are recognized separately from theme classification", function () {
  assert.deepEqual(lifecycle.explicitImplementationDecision("Build this in Clay"), {
    intent: "build", projectName: "Clay",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("Please fix this in webapp"), {
    intent: "fix", projectName: "webapp",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("Hand this to the Clay project"), {
    intent: "hand_off", projectName: "Clay",
  });
});
