// Delivers verified project-coordinator completion through the same durable
// cross-project transport used by direct leaves. The Lead binding is closed by
// the destination router, never by mutating its file from the target project.
var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var sessionExecutionBinding = require("./portfolio-execution-bindings").sessionExecutionBinding;
var controlRole = require("./coop-control-role");

function acceptancePayload(value) {
  if (!value || value.status === "pending") {
    return value ? { status: "pending", source: String(value.source || "") } : undefined;
  }
  return {
    status: "accepted",
    at: value.at,
    by: String(value.by || ""),
    source: String(value.source || ""),
    phrase: String(value.phrase || ""),
    withdrawnAt: value.withdrawnAt == null ? null : value.withdrawnAt,
  };
}

function localPendingOwnerAcceptance(metadata) {
  var acceptance = metadata && metadata.ownerAcceptance;
  return !!(metadata && metadata.ownerAcceptanceRequired === true && acceptance &&
    acceptance.status === "pending" && acceptance.source === "project_local_instructions");
}

// A peer review delivers evidence. It is not implementation acceptance, but it
// still needs the coordinator's full completion envelope and its exact typed
// binding before it can close the review's own lifecycle.
function isCoordinatorVerifiedReadOnlyReview(session, completion) {
  var metadata = sessionExecutionBinding(session);
  var role = controlRole.forSession(session, null, metadata);
  return !!(metadata && metadata.mode === "project_coordinator" &&
    metadata.reviewOnly === true && controlRole.isPeer(role) &&
    localPendingOwnerAcceptance(metadata) && completion && completion.status === "completed" &&
    Number.isInteger(completion.completionRevision) && completion.completionRevision > 0 &&
    String(completion.graphDigest || "").trim() && String(completion.summary || "").trim() &&
    String(completion.verification || "").trim() &&
    String(completion.integrationVerification || "").trim() &&
    /^no\b/i.test(String(completion.escalationRequired || "").trim()) &&
    typeof completion.completedAt === "number" && Number.isFinite(completion.completedAt) &&
    completion.portfolioTaskId === metadata.portfolioTaskId &&
    Number(completion.bindingRevision) === Number(metadata.bindingRevision));
}

function completedCoopExecution(session) {
  var execution = session && session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
  if (!execution || !session.coopControlledBy) return false;
  if (execution.mode === "direct_leaf") return execution.status === "completed";
  var completion = session.orchestrationProjectCompletion;
  return execution.mode === "project_coordinator" && completion &&
    completion.status === "completed" && /^no\b/i.test(String(completion.escalationRequired || "").trim());
}

// Terminalization never archives a visible worker; only explicit owner cleanup may do so.
function archiveCompletedCoopSession(sm, session, options) {
  if (!sm || !completedCoopExecution(session) || !options || options.explicit !== true || session.hidden) return false;
  if (typeof sm.hideSessionForActiveClients === "function") sm.hideSessionForActiveClients(session.localId);
  else if (typeof sm.hideSession === "function") sm.hideSession(session.localId);
  else {
    session.hidden = true;
    if (typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
  }
  return true;
}

function deliverTerminal(sm, crossProject, session, details) {
  var metadata = sessionExecutionBinding(session);
  var input = details || {};
  if (!metadata || metadata.mode !== "project_coordinator" ||
      metadata.status !== input.terminalStatus || !metadata.source || !crossProject ||
      typeof crossProject.createEnvelope !== "function" ||
      typeof crossProject.deliverEnvelope !== "function") return null;
  var ownerAttention = input.terminalStatus === "needs_input";
  var resultKey = ownerAttention ? "ownerAcceptanceAttentionResultEventId" :
    "projectCompletionResultEventId";
  var deliveryKey = ownerAttention ? "ownerAcceptanceAttentionDeliveryEventId" :
    "projectCompletionDeliveryEventId";
  if (!metadata[resultKey]) metadata[resultKey] = "project-coordinator-" + crypto.randomUUID();
  if (!metadata[deliveryKey]) {
    metadata[deliveryKey] = (ownerAttention ? "project-owner-attention-v1-" :
      "project-terminal-v1-") + metadata[resultKey];
  }
  var source = projectIdentity.sessionRef({
    projectId: sm && typeof sm.getProjectId === "function" ? sm.getProjectId() : null,
  }, session);
  if (!source) return null;
  if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
  var envelope = crossProject.createEnvelope({
    eventId: metadata[deliveryKey],
    source: source,
    destination: metadata.source,
    bindingRevision: metadata.bindingRevision,
    payload: {
      type: "portfolio_execution_completed",
      executionMode: "project_coordinator",
      portfolioTaskId: metadata.portfolioTaskId,
      bindingRevision: metadata.bindingRevision,
      completedAt: metadata.completedAt || input.completedAt || metadata.updatedAt || Date.now(),
      resultEventId: metadata[resultKey],
      terminalStatus: input.terminalStatus,
      ownerNotification: input.ownerNotification === true,
      controlRole: input.controlRole || undefined,
      reviewOnly: input.reviewOnly === true,
      ownerAcceptanceRequired: input.ownerAcceptanceRequired === true,
      visualCanaryUnavailable: input.visualCanaryUnavailable === true,
      ownerAcceptance: acceptancePayload(input.ownerAcceptance),
      implementationCompletedAt: input.implementationCompletedAt || undefined,
      implementationCompletionRevision: input.implementationCompletionRevision || undefined,
      implementationGraphDigest: input.implementationGraphDigest || undefined,
      resultSummary: String(input.summary || "Project execution finished.").slice(0, 60000),
      text: String(input.summary || "Project execution finished.").slice(0, 60000),
    },
  });
  // The target has already made its terminal result durable. Close the exact
  // Lead binding through its validated router before placing the notification
  // on the inbox. An exhausted inbox must not strand a completed coordinator
  // or consume Lead capacity. The durable delivery is still attempted below:
  // owner-facing attention keeps its retryable notification path, while a
  // normal completed coordinator can safely report success once the binding is
  // terminal in the authoritative store.
  var terminalized = null;
  if (typeof crossProject.completeProjectCoordinatorExecution === "function") {
    terminalized = crossProject.completeProjectCoordinatorExecution(envelope);
  }
  var delivered = crossProject.deliverEnvelope(envelope);
  if (terminalized && terminalized.ok && input.ownerNotification !== true) {
    return {
      ok: true,
      terminalized: true,
      duplicate: !!terminalized.duplicate,
      deliveryError: !delivered || delivered.ok !== true,
    };
  }
  return delivered;
}

function deliverProjectCompletion(sm, crossProject, session, completion) {
  if (!completion || completion.status !== "completed") return null;
  var metadata = sessionExecutionBinding(session);
  var reviewDelivery = isCoordinatorVerifiedReadOnlyReview(session, completion);
  var role = reviewDelivery ? controlRole.forSession(session, null, metadata) : "";
  return deliverTerminal(sm, crossProject, session, {
    terminalStatus: "completed",
    completedAt: completion.completedAt,
    summary: completion.summary || "Verified project completion.",
    ownerNotification: false,
    controlRole: role || undefined,
    reviewOnly: reviewDelivery,
    ownerAcceptanceRequired: !reviewDelivery && metadata && metadata.ownerAcceptanceRequired === true,
    ownerAcceptance: reviewDelivery ? undefined : metadata && metadata.ownerAcceptance,
    implementationCompletedAt: metadata && metadata.implementationCompletedAt,
    implementationCompletionRevision: metadata && metadata.implementationCompletionRevision,
    implementationGraphDigest: metadata && metadata.implementationGraphDigest,
  });
}

function deliverProjectAttention(sm, crossProject, session, summary, options) {
  var metadata = sessionExecutionBinding(session);
  var role = controlRole.forSession(session, null, metadata);
  var visualCanaryUnavailable = !!(options && options.visualCanaryUnavailable);
  if (!metadata || metadata.status !== "needs_input") return null;
  return deliverTerminal(sm, crossProject, session, {
    terminalStatus: "needs_input",
    completedAt: metadata.updatedAt,
    summary: summary || "Read-only verification returned actionable attention.",
    ownerNotification: true,
    controlRole: role,
    reviewOnly: metadata.reviewOnly === true || controlRole.isPeer(role),
    visualCanaryUnavailable: visualCanaryUnavailable,
    ownerAcceptanceRequired: metadata.ownerAcceptanceRequired === true,
    ownerAcceptance: metadata.ownerAcceptance,
    implementationCompletedAt: metadata.implementationCompletedAt,
    implementationCompletionRevision: metadata.implementationCompletionRevision,
    implementationGraphDigest: metadata.implementationGraphDigest,
  });
}

function deliverProjectFailure(sm, crossProject, session, summary) {
  var metadata = sessionExecutionBinding(session);
  return deliverTerminal(sm, crossProject, session, {
    terminalStatus: "failed",
    completedAt: metadata && metadata.updatedAt,
    summary: summary || "Project execution requires canonical-Coop reconciliation.",
    ownerNotification: true,
  });
}

module.exports = {
  deliverProjectAttention: deliverProjectAttention,
  deliverProjectCompletion: deliverProjectCompletion,
  deliverProjectFailure: deliverProjectFailure,
  archiveCompletedCoopSession: archiveCompletedCoopSession,
  isCoordinatorVerifiedReadOnlyReview: isCoordinatorVerifiedReadOnlyReview,
};
