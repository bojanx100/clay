// Exact evidence checks for a completed read-only review whose controlled
// incarnation was already terminalized as needs_input before startup recovery.
// This records a session-local disposition only; it never rewrites control
// execution history or grants a new runtime capability.

var acceptanceEvents = require("./coop-owner-acceptance-events");
var controlRole = require("./coop-control-role");

var SCHEMA = "clay.settled_read_only_review_reconciliation";
var VERSION = 1;

function sameRef(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId;
}

function localPendingReview(session, metadata) {
  var acceptance = metadata && metadata.ownerAcceptance;
  return !!(session && metadata && metadata.mode === "project_coordinator" &&
    metadata.reviewOnly === true && controlRole.isPeer(controlRole.forSession(session, null, metadata)) &&
    metadata.ownerAcceptanceRequired === true && acceptance && acceptance.status === "pending" &&
    acceptance.source === "project_local_instructions" && !metadata.ownerAcceptanceDecisionEventId &&
    acceptanceEvents.normalizeEvents(metadata.ownerAcceptanceEvents).length === 0);
}

function completionMatches(session, metadata) {
  var completion = session && session.orchestrationProjectCompletion;
  var fields = ["graphDigest", "summary", "verification", "integrationVerification"];
  if (!completion || completion.status !== "completed" ||
      !Number.isInteger(completion.completionRevision) || completion.completionRevision <= 0 ||
      !/^no\b/i.test(String(completion.escalationRequired || "").trim()) ||
      !Number.isFinite(completion.completedAt) || completion.completedAt <= 0 ||
      completion.portfolioTaskId !== metadata.portfolioTaskId ||
      Number(completion.bindingRevision) !== Number(metadata.bindingRevision)) return false;
  for (var i = 0; i < fields.length; i++) {
    if (!String(completion[fields[i]] || "").trim()) return false;
  }
  return true;
}

function matchingExecution(metadata, control, execution) {
  if (!metadata || !control || !execution) return false;
  if (execution.executionId !== control.executionId) return false;
  if (execution.portfolioTaskId !== metadata.portfolioTaskId) return false;
  if (Number(execution.bindingRevision) !== Number(metadata.bindingRevision)) return false;
  if (execution.idempotencyKey !== metadata.idempotencyKey) return false;
  if (execution.mode !== "project_coordinator") return false;
  if (!metadata.targetProject || !execution.targetProject) return false;
  if (execution.targetProject.projectId !== metadata.targetProject.projectId) return false;
  if (execution.authorityId !== control.authorityId) return false;
  if (execution.currentEpoch !== control.epoch) return false;
  return execution.status === "failed";
}

function matchingFailedIncarnation(session, metadata, control, current) {
  if (!metadata || !metadata.targetProject || !control || !current) return false;
  if (current.incarnationId !== control.incarnationId) return false;
  if (current.epoch !== control.epoch || current.startState !== "failed") return false;
  if (current.failureCode !== "needs_input") return false;
  return sameRef(current.sessionRef, {
    projectId: metadata.targetProject.projectId,
    sessionStorageId: session.storageId,
  });
}

function matchingAuthority(metadata, control, authority, leases) {
  if (!metadata || !metadata.targetProject || !control || !authority) return false;
  if (authority.authorityId !== control.authorityId || authority.revokedAt !== null) return false;
  if (authority.portfolioTaskId !== metadata.portfolioTaskId) return false;
  if (Number(authority.bindingRevision) !== Number(metadata.bindingRevision)) return false;
  if (!authority.targetProject || authority.targetProject.projectId !== metadata.targetProject.projectId) {
    return false;
  }
  if (authority.role !== "coordinator") return false;
  return Array.isArray(leases) && leases.length === 0;
}

function durableMatches(session, metadata, durable) {
  var control = metadata && metadata.control;
  var execution = durable && durable.execution;
  var current = durable && durable.current;
  var authority = durable && durable.authority;
  return matchingExecution(metadata, control, execution) &&
    matchingFailedIncarnation(session, metadata, control, current) &&
    matchingAuthority(metadata, control, authority, durable && durable.leases);
}

function receiptMatchesControl(receipt, control) {
  if (!receipt || receipt.schema !== SCHEMA || receipt.version !== VERSION || !control) return false;
  if (receipt.executionId !== control.executionId || receipt.authorityId !== control.authorityId) {
    return false;
  }
  return receipt.incarnationId === control.incarnationId && Number(receipt.epoch) === Number(control.epoch);
}

function receiptMatchesCompletion(receipt, session, metadata) {
  var completion = session && session.orchestrationProjectCompletion;
  if (!receipt || !completion || !metadata) return false;
  if (receipt.portfolioTaskId !== metadata.portfolioTaskId) return false;
  if (Number(receipt.bindingRevision) !== Number(metadata.bindingRevision)) return false;
  if (receipt.sessionStorageId !== session.storageId) return false;
  if (Number(receipt.completionRevision) !== Number(completion.completionRevision)) return false;
  if (receipt.graphDigest !== completion.graphDigest) return false;
  return Number(receipt.completedAt) === Number(completion.completedAt);
}

function receiptMatchesSession(session, metadata) {
  var receipt = metadata && metadata.settledReadOnlyReviewReconciliation;
  var control = metadata && metadata.control;
  return receiptMatchesControl(receipt, control) && receiptMatchesCompletion(receipt, session, metadata);
}

function receiptMatchesDurable(session, metadata, durable) {
  return receiptMatchesSession(session, metadata) && durableMatches(session, metadata, durable);
}

function createReceipt(session, metadata, durable, now) {
  if (!localPendingReview(session, metadata) || !completionMatches(session, metadata) ||
      !durableMatches(session, metadata, durable) || session.isProcessing ||
      session._coopExecutionFence) return null;
  var completion = session.orchestrationProjectCompletion;
  var control = metadata.control;
  return {
    schema: SCHEMA,
    version: VERSION,
    executionId: control.executionId,
    authorityId: control.authorityId,
    incarnationId: control.incarnationId,
    epoch: control.epoch,
    portfolioTaskId: metadata.portfolioTaskId,
    bindingRevision: metadata.bindingRevision,
    sessionStorageId: session.storageId,
    completionRevision: completion.completionRevision,
    graphDigest: completion.graphDigest,
    completedAt: completion.completedAt,
    reconciledAt: now(),
  };
}

module.exports = {
  SCHEMA: SCHEMA,
  VERSION: VERSION,
  createReceipt: createReceipt,
  receiptMatchesDurable: receiptMatchesDurable,
  receiptMatchesSession: receiptMatchesSession,
};
