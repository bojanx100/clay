var test = require("node:test");
var assert = require("node:assert/strict");
var settled = require("../lib/coop-control-settled-task-reconciliation");

function fixture() {
  var binding = {
    portfolioTaskId: "settled-task", bindingRevision: 3,
    idempotencyKey: "settled-task-r3", mode: "project_coordinator",
    status: "completed", completionEventId: "completed-event",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    ownerAcceptanceRequired: true,
    ownerAcceptance: { status: "pending", source: "project_local_instructions" },
    implementationCompletedAt: 300,
    implementationCompletionRevision: 2,
    implementationGraphDigest: "verified-graph",
  };
  var metadata = {
    portfolioTaskId: binding.portfolioTaskId, bindingRevision: binding.bindingRevision,
    idempotencyKey: binding.idempotencyKey, mode: binding.mode, status: "failed",
    targetProject: binding.targetProject,
    projectCompletionDeliveryEventId: binding.completionEventId,
  };
  var session = {
    isProcessing: false,
    orchestrationProjectCompletion: {
      status: "completed", portfolioTaskId: binding.portfolioTaskId,
      bindingRevision: binding.bindingRevision, completedAt: 300,
      completionRevision: 2, graphDigest: "verified-graph",
      integrationVerification: "yes", escalationRequired: "no", revokedAt: null,
    },
  };
  return { binding: binding, metadata: metadata, session: session };
}

function legacyGraphWitness(value, suffix) {
  var witness = "x".repeat(256);
  var graphDigest = witness + suffix;
  value.binding.implementationGraphDigest = witness;
  value.session.orchestrationProjectCompletion.graphDigest = graphDigest;
  value.session.orchestrationEvents = [{
    type: "project_completed", at: value.binding.implementationCompletedAt,
    data: {
      portfolioTaskId: value.binding.portfolioTaskId,
      bindingRevision: value.binding.bindingRevision,
      completionRevision: value.session.orchestrationProjectCompletion.completionRevision,
      graphDigest: graphDigest, integrationVerification: "yes", escalationRequired: "no",
    },
  }];
  return graphDigest;
}

test("settled parent reconciliation accepts only the exact verified unanswered delivery", function () {
  var value = fixture();
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), true);

  value = fixture();
  value.session.isProcessing = true;
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "an active provider is never projected as settled");

  value = fixture();
  value.metadata.idempotencyKey = "wrong-receipt";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a wrong session receipt cannot select the parent task");

  value = fixture();
  value.metadata.bindingRevision = 4;
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a wrong binding revision cannot select the parent task");

  value = fixture();
  value.binding.completionEventId = "";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a delivery without its exact completion receipt stays untouched");

  value = fixture();
  value.metadata.projectCompletionDeliveryEventId = "different-completion-receipt";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a mismatched historical completion receipt stays untouched");

  value = fixture();
  value.session.orchestrationProjectCompletion.integrationVerification = "no";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "unverified implementation cannot become an owner-acceptance projection");

  value = fixture();
  value.metadata.portfolioTaskId = "another-settled-task";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a wrong task identity cannot select the parent task");

  value = fixture();
  value.metadata.targetProject = { projectId: "another-project" };
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a wrong target project cannot select the parent task");

  value = fixture();
  delete value.session.orchestrationProjectCompletion;
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a missing implementation completion cannot reconcile the parent task");

  value = fixture();
  value.binding.ownerAcceptanceDecisionEventId = "owner-decision";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "an answered owner decision remains untouched");

  value = fixture();
  value.binding.ownerAcceptanceEvents = [{
    schema: "clay.owner_acceptance_event", version: 1,
    type: "owner_acceptance_pending", at: 301,
  }];
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "genuine owner-acceptance evidence is never overwritten");

  value = fixture();
  legacyGraphWitness(value, ":later-historical-events");
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), true,
    "the persisted legacy graph witness admits only its exact extended completion");
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), true,
    "repeating the pure admission predicate does not create another reconciliation");
  assert.equal(value.session.orchestrationEvents.length, 1,
    "repeating admission leaves the append-only evidence unchanged");

  value = fixture();
  legacyGraphWitness(value, ":later-historical-events");
  value.session.orchestrationEvents = [];
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a legacy graph witness without its append-only completion event stays untouched");

  value = fixture();
  legacyGraphWitness(value, ":later-historical-events");
  value.session.orchestrationEvents[0].type = "project_completion_revoked";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a non-completion event cannot witness a legacy graph");

  value = fixture();
  legacyGraphWitness(value, ":later-historical-events");
  value.session.orchestrationEvents[0].data.portfolioTaskId = "another-settled-task";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a legacy event for another task cannot reconcile the parent task");

  value = fixture();
  legacyGraphWitness(value, ":later-historical-events");
  value.session.orchestrationEvents[0].data.graphDigest = "forged-completion";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a forged append-only graph cannot extend a legacy witness");

  value = fixture();
  legacyGraphWitness(value, ":later-historical-events");
  value.session.orchestrationEvents[0].at++;
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), true,
    "an independently recorded completion-event timestamp preserves the exact witness");

  value = fixture();
  legacyGraphWitness(value, ":later-historical-events");
  value.session.orchestrationEvents[0].at--;
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a completion witness recorded before its completion cannot reconcile the parent task");

  value = fixture();
  legacyGraphWitness(value, ":later-historical-events");
  value.session.orchestrationEvents[0].at = Infinity;
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a non-finite completion-event timestamp cannot reconcile the parent task");

  value = fixture();
  legacyGraphWitness(value, ":later-historical-events");
  value.binding.implementationCompletedAt = Infinity;
  value.session.orchestrationProjectCompletion.completedAt = Infinity;
  value.session.orchestrationEvents[0].at = Infinity;
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "non-finite implementation timestamps cannot reconcile the parent task");

  value = fixture();
  legacyGraphWitness(value, ":recorded-completion");
  value.session.orchestrationProjectCompletion.graphDigest =
    value.binding.implementationGraphDigest.slice(0, 255) + "y:later-historical-events";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "a mismatched legacy graph witness cannot reconcile the parent task");

  value = fixture();
  legacyGraphWitness(value, ":recorded-completion");
  value.session.orchestrationProjectCompletion.graphDigest =
    value.binding.implementationGraphDigest + ":altered-completion";
  assert.equal(settled.canReconcile(value.binding, value.session, value.metadata), false,
    "an altered legacy graph suffix cannot reconcile the parent task");
});
