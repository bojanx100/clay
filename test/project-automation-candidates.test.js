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

// --- Naming the refusal (2026-09-04) --------------------------------------------
//
// Every rejection in normalize() used to collapse into "invalid_candidate",
// which asserts the CALLER sent a malformed candidate. The gate passes an
// explicit `qualificationReceipt: null` for any non-issue recipe, because
// receiptFor can only build a receipt for an issue — a deliberate "there is no
// receipt for this recipe kind", not a malformed one.
//
// Live effect: the pr-review recipe logged "could not hand candidate ... to Coop
// (invalid_candidate)" 16 times per tick, and two separate investigations went
// looking for a corrupt candidate that never existed. Absent evidence and
// malformed evidence are different failures and must say so.
test("an absent qualification receipt is refused by name, not as a malformed candidate", function () {
  var store = candidates.createCandidateStore({
    file: "/tmp/clay-candidates-reason-" + process.pid + ".json",
    now: function () { return 1; },
  });
  var base = {
    candidateKey: "launch:trialview/v2#2819",
    itemKey: "trialview/v2#2819",
    itemClass: "pr_review",
    admission: "owner_approval",
    projectRef: WEBAPP_REF,
  };

  assert.strictEqual(store.upsert(Object.assign({}, base,
    { qualificationReceipt: null })).reason, "qualification_receipt_required");
  assert.strictEqual(store.upsert(Object.assign({}, base,
    { qualificationReceipt: undefined })).reason, "qualification_receipt_required");

  // A receipt that WAS supplied but does not verify is a different failure.
  assert.strictEqual(store.upsert(Object.assign({}, base,
    { qualificationReceipt: { schema: "nope" } })).reason, "qualification_receipt_malformed");

  // A genuinely malformed candidate still reports as one.
  assert.strictEqual(store.upsert({
    candidateKey: "k", itemKey: "i", projectRef: { projectId: "not-a-ref" },
  }).reason, "invalid_candidate");

  // Either way it stays fail-closed: none of them are persisted.
  assert.strictEqual(store.list().length, 0);
});
