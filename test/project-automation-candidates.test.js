var test = require("node:test");
var assert = require("node:assert");

var candidates = require("../lib/project-automation-candidates");

var WEBAPP_REF = { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" };

function webappCandidate() {
  return {
    source: "github",
    project: "webapp",
    projectRef: WEBAPP_REF,
    itemKey: "trialview/v2#2517",
  };
}

function binding(revision, status) {
  return {
    portfolioTaskId: "portfolio-webapp-2517",
    bindingRevision: revision,
    idempotencyKey: "staff-portfolio-webapp-2517-r" + revision,
    targetProject: WEBAPP_REF,
    mode: "project_coordinator",
    status: status,
    coordinator: {
      projectId: WEBAPP_REF.projectId,
      sessionStorageId: "webapp-2517-r" + revision,
    },
    createdAt: 1787000000000 + revision,
    updatedAt: 1787000001000 + revision,
  };
}

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

test("live Webapp #2517 shape is blocked by its completed typed binding without issue state", function () {
  var noStateEntry = {
    hasEntry: function (itemKey) { return false; },
    shouldRelaunch: function () { return false; },
  };
  assert.deepStrictEqual(candidates.completionEligibility(noStateEntry, webappCandidate(), [
    binding(1, "completed"),
  ]), {
    ok: true, eligible: false, reason: "already_completed_or_in_flight",
  });
});

test("explicit project relaunch state outranks historical binding completion", function () {
  var bounced = {
    hasEntry: function (itemKey) { return itemKey === "trialview/v2#2517"; },
    shouldRelaunch: function (itemKey) { return itemKey === "trialview/v2#2517"; },
  };
  assert.deepStrictEqual(candidates.completionEligibility(bounced, webappCandidate(), [
    binding(1, "completed"),
  ]), {
    ok: true, eligible: true, reason: "relaunch_armed",
  });
});

test("latest typed binding revision wins and non-completing terminal states do not suppress", function () {
  var noStateEntry = {
    hasEntry: function () { return false; },
    shouldRelaunch: function () { return false; },
  };
  ["failed", "dismissed", "unrouted", "superseded"].forEach(function (status) {
    assert.deepStrictEqual(candidates.completionEligibility(noStateEntry, webappCandidate(), [
      binding(1, "completed"),
      binding(2, status),
    ]), {
      ok: true, eligible: true, reason: "not_previously_launched",
    }, status + " latest binding must leave the candidate eligible");
  });
  assert.deepStrictEqual(candidates.completionEligibility(noStateEntry, webappCandidate(), [
    binding(1, "superseded"),
    binding(2, "active"),
  ]), {
    ok: true, eligible: false, reason: "already_completed_or_in_flight",
  });
});
