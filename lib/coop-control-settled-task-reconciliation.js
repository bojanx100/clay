// Admission predicate for repairing the Lead-side projection of a settled
// implementation that still awaits its separate owner-acceptance decision.
var projectIdentity = require("./project-identity");
var acceptanceEvents = require("./coop-owner-acceptance-events");
var LEGACY_GRAPH_WITNESS_LIMIT = 256;

function sameProject(left, right) {
  var a = projectIdentity.normalizeProjectRef(left);
  var b = projectIdentity.normalizeProjectRef(right);
  return !!(a && b && a.projectId === b.projectId);
}

function pendingLocalAcceptance(binding) {
  var acceptance = binding && binding.ownerAcceptance;
  return !!(binding && binding.mode === "project_coordinator" &&
    binding.status === "completed" && binding.ownerAcceptanceRequired === true &&
    acceptance && acceptance.status === "pending" &&
    acceptance.source === "project_local_instructions" &&
    !binding.ownerAcceptanceDecisionEventId &&
    acceptanceEvents.normalizeEvents(binding.ownerAcceptanceEvents).length === 0);
}

function matchingMetadata(binding, metadata) {
  if (!binding || !metadata) return false;
  if (metadata.portfolioTaskId !== binding.portfolioTaskId) return false;
  if (Number(metadata.bindingRevision) !== Number(binding.bindingRevision)) return false;
  if (metadata.idempotencyKey !== binding.idempotencyKey) return false;
  if (metadata.mode !== "project_coordinator") return false;
  if (metadata.status !== "completed" && metadata.status !== "failed" &&
      metadata.status !== "needs_input") return false;
  return sameProject(metadata.targetProject, binding.targetProject);
}

function finiteTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function matchingProjectCompletionEvent(binding, session, completion) {
  var events = session && session.orchestrationEvents;
  if (!Array.isArray(events)) return false;
  return events.some(function (event) {
    var data = event && event.data;
    return !!(event && event.type === "project_completed" && data &&
      finiteTimestamp(event.at) && event.at >= completion.completedAt &&
      data.portfolioTaskId === binding.portfolioTaskId &&
      Number(data.bindingRevision) === Number(binding.bindingRevision) &&
      Number(data.completionRevision) === Number(completion.completionRevision) &&
      String(data.graphDigest || "") === String(completion.graphDigest || "") &&
      data.integrationVerification === "yes" && data.escalationRequired === "no");
  });
}

function matchingGraphWitness(binding, session, completion) {
  var expected = String(binding && binding.implementationGraphDigest || "");
  var actual = String(completion && completion.graphDigest || "");
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  // Historical bindings persist this field at the store's 256-character
  // limit. Its exact prefix remains a witness only when the append-only
  // project-completed event preserves the completed session's full graph;
  // all delivery and completion identities are still checked by the caller.
  return expected.length === LEGACY_GRAPH_WITNESS_LIMIT &&
    actual.length > expected.length && actual.indexOf(expected) === 0 &&
    matchingProjectCompletionEvent(binding, session, completion);
}

function matchingCompletion(binding, session, completion) {
  if (!binding || !completion || completion.status !== "completed") return false;
  if (completion.revokedAt != null || completion.portfolioTaskId !== binding.portfolioTaskId) {
    return false;
  }
  if (Number(completion.bindingRevision) !== Number(binding.bindingRevision)) return false;
  if (completion.integrationVerification !== "yes" || completion.escalationRequired !== "no") {
    return false;
  }
  if (!finiteTimestamp(completion.completedAt) ||
      !finiteTimestamp(binding.implementationCompletedAt) ||
      completion.completedAt !== binding.implementationCompletedAt) return false;
  if (Number(completion.completionRevision) !== Number(binding.implementationCompletionRevision)) {
    return false;
  }
  return matchingGraphWitness(binding, session, completion);
}

function verifiedImplementation(binding, session, metadata) {
  var completion = session && session.orchestrationProjectCompletion;
  return !!(session && session.isProcessing !== true &&
    matchingMetadata(binding, metadata) && matchingCompletion(binding, session, completion));
}

function matchingDeliveryReceipt(binding, metadata) {
  return !!(binding && metadata &&
    typeof binding.completionEventId === "string" && binding.completionEventId &&
    binding.completionEventId === metadata.projectCompletionDeliveryEventId);
}

function canReconcile(binding, session, metadata) {
  return !!(pendingLocalAcceptance(binding) &&
    matchingDeliveryReceipt(binding, metadata) &&
    verifiedImplementation(binding, session, metadata));
}

module.exports = { canReconcile: canReconcile };
