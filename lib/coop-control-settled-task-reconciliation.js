// Admission predicate for repairing the Lead-side projection of a settled
// implementation that still awaits its separate owner-acceptance decision.
var projectIdentity = require("./project-identity");
var acceptanceEvents = require("./coop-owner-acceptance-events");

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

function matchingCompletion(binding, completion) {
  if (!binding || !completion || completion.status !== "completed") return false;
  if (completion.revokedAt != null || completion.portfolioTaskId !== binding.portfolioTaskId) {
    return false;
  }
  if (Number(completion.bindingRevision) !== Number(binding.bindingRevision)) return false;
  if (completion.integrationVerification !== "yes" || completion.escalationRequired !== "no") {
    return false;
  }
  if (Number(completion.completedAt) !== Number(binding.implementationCompletedAt)) return false;
  if (Number(completion.completionRevision) !== Number(binding.implementationCompletionRevision)) {
    return false;
  }
  return String(completion.graphDigest || "") === String(binding.implementationGraphDigest || "");
}

function verifiedImplementation(binding, session, metadata) {
  var completion = session && session.orchestrationProjectCompletion;
  return !!(session && session.isProcessing !== true &&
    matchingMetadata(binding, metadata) && matchingCompletion(binding, completion));
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
