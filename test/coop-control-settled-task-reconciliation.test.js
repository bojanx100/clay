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
});
