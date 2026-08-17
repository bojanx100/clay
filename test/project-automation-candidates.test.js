var test = require("node:test");
var assert = require("node:assert");

var candidates = require("../lib/project-automation-candidates");

test("completionEligibility fails closed and only permits an explicitly armed bounce", function () {
  var noState = {
    hasEntry: function () { return false; },
    shouldRelaunch: function () { return false; },
  };
  assert.deepStrictEqual(candidates.completionEligibility(noState, "o/r#1"), {
    ok: true, eligible: true, reason: "not_previously_launched",
  });

  var completed = {
    hasEntry: function () { return true; },
    shouldRelaunch: function () { return false; },
  };
  assert.deepStrictEqual(candidates.completionEligibility(completed, "o/r#1"), {
    ok: true, eligible: false, reason: "already_completed_or_in_flight",
  });

  var bounced = {
    hasEntry: function () { return true; },
    shouldRelaunch: function () { return true; },
  };
  assert.deepStrictEqual(candidates.completionEligibility(bounced, "o/r#1"), {
    ok: true, eligible: true, reason: "relaunch_armed",
  });
  assert.deepStrictEqual(candidates.completionEligibility(null, "o/r#1"), {
    ok: false, eligible: false, reason: "completion_state_unresolvable",
  });
});
