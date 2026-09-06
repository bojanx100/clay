// Evidence-checked helpers for one-off automation bookkeeping repairs.
//
// These functions do not read or write live state. Stores call them with the
// current record they already read, then persist the returned replacement.

var projectIdentity = require("./project-identity");
var repairEvidence = require("./project-automation-bookkeeping-evidence");
var candidateReconciliation = require("./project-automation-candidate-reconciliation");

var CANDIDATE_RECONSIDERATION_SCHEMA = "clay.automation_candidate_reconsideration";
var ISSUE_RECONSIDERATION_SCHEMA = "clay.issue_launch_state_reconsideration";
var OWNER_RECONSIDERATION_SCHEMA = "clay.owner_requested_automation_reconsideration";

function clone(value) {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

function positiveFiniteNumber(value) {
  var number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonemptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeOwnerReconsiderationEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schema !== OWNER_RECONSIDERATION_SCHEMA || value.version !== 1 ||
      value.reason !== "owner_requested_bounce_reconsideration" ||
      value.currentQualificationRequired !== true ||
      value.verifiedNoLiveSession !== true) {
    return null;
  }
  var requestedAt = positiveFiniteNumber(value.requestedAt);
  var refs = [];
  var sourceRefs = Array.isArray(value.ownerRequestRefs) ? value.ownerRequestRefs : [];
  for (var i = 0; i < sourceRefs.length; i++) {
    var ref = nonemptyText(sourceRefs[i]);
    if (!ref) return null;
    refs.push(ref);
  }
  if (!requestedAt || !refs.length) return null;
  return {
    schema: OWNER_RECONSIDERATION_SCHEMA,
    version: 1,
    reason: value.reason,
    ownerRequestRefs: refs,
    requestedAt: requestedAt,
    currentQualificationRequired: true,
    verifiedNoLiveSession: true,
  };
}

function completedBindingProof(candidate, bindingSnapshot) {
  var snapshot = candidateReconciliation.verifiedSnapshot(bindingSnapshot);
  if (!snapshot.ok) return snapshot;
  var binding = candidateReconciliation.exactBinding(candidate, snapshot);
  if (!binding) return { ok: false, reason: "binding_evidence_missing" };
  if (binding.status !== "completed") return { ok: false, reason: "binding_not_completed" };
  if (!positiveFiniteNumber(binding.completedAt) ||
      !projectIdentity.normalizeSessionRef(binding.coordinator) ||
      !projectIdentity.normalizeSessionRef(binding.projectCoordinator) ||
      !nonemptyText(binding.resultEventId) || !nonemptyText(binding.completionEventId)) {
    return { ok: false, reason: "binding_completion_evidence_incomplete" };
  }
  return {
    ok: true,
    proof: {
      kind: "completed_binding",
      portfolioTaskId: binding.portfolioTaskId,
      bindingRevision: binding.bindingRevision,
      targetProject: clone(binding.targetProject),
      completedAt: binding.completedAt,
      resultEventId: binding.resultEventId,
      completionEventId: binding.completionEventId,
      coordinator: clone(binding.coordinator),
      projectCoordinator: clone(binding.projectCoordinator),
    },
  };
}

function completedHistoricalBindingProof(candidate, evidence, options) {
  var requested = evidence && evidence.historicalBinding;
  var snapshot = candidateReconciliation.verifiedSnapshot(options && options.bindingSnapshot);
  if (!snapshot.ok) return snapshot;
  var matches = snapshot.bindings.filter(function (record) {
    return requested && record.portfolioTaskId === requested.portfolioTaskId &&
      record.bindingRevision === requested.bindingRevision &&
      repairEvidence.matchesWork(record, candidate, options.projectSlug);
  });
  var binding = matches.length === 1 ? matches[0] : null;
  var projectRef = projectIdentity.normalizeProjectRef(candidate && candidate.projectRef);
  var targetProject = projectIdentity.normalizeProjectRef(binding && binding.targetProject);
  if (!binding || !projectRef || !targetProject || targetProject.projectId !== projectRef.projectId ||
      !projectIdentity.isTaskId(binding.portfolioTaskId) ||
      !Number.isInteger(binding.bindingRevision) || binding.bindingRevision < 1 ||
      binding.status !== "completed" || !positiveFiniteNumber(binding.completedAt) ||
      !nonemptyText(binding.resultEventId) || !nonemptyText(binding.completionEventId)) {
    return { ok: false, reason: "historical_completion_evidence_incomplete" };
  }
  return {
    ok: true,
    proof: {
      kind: "completed_historical_binding",
      portfolioTaskId: binding.portfolioTaskId,
      bindingRevision: binding.bindingRevision,
      targetProject: clone(binding.targetProject),
      completedAt: binding.completedAt,
      resultEventId: binding.resultEventId,
      completionEventId: binding.completionEventId,
    },
  };
}

function sameReconsideration(record, request) {
  if (!record || record.schema !== CANDIDATE_RECONSIDERATION_SCHEMA ||
      record.reason !== request.reason || record.requestedAt !== request.requestedAt ||
      record.currentQualificationRequired !== true) return false;
  var refs = Array.isArray(record.ownerRequestRefs) ? record.ownerRequestRefs : [];
  if (refs.length !== request.ownerRequestRefs.length) return false;
  for (var i = 0; i < refs.length; i++) {
    if (refs[i] !== request.ownerRequestRefs[i]) return false;
  }
  return true;
}

function candidateReconsiderationProof(existing, evidence, options) {
  if (existing.binding) {
    return completedBindingProof(existing, options && options.bindingSnapshot);
  }
  if (existing.admission === "owner_approval" && !existing.qualificationReceipt &&
      !existing.ownerDecision) {
    return completedHistoricalBindingProof(existing, evidence, options);
  }
  return { ok: false, reason: "reconsideration_target_unproven" };
}

function prepareCandidateReconsideration(existing, evidence, options, timestamp) {
  options = options || {};
  var request = normalizeOwnerReconsiderationEvidence(evidence);
  if (!request) return { ok: false, reason: "invalid_reconsideration_evidence" };
  if (existing && existing.status === "pending" &&
      sameReconsideration(existing.reconsideration, request)) {
    return { ok: true, changed: false, candidate: clone(existing) };
  }
  if (!existing || existing.status !== "admitted") {
    return { ok: false, reason: "candidate_not_admitted" };
  }
  var proof = candidateReconsiderationProof(existing, evidence, options || {});
  if (!proof.ok) return proof;
  var conflicts = repairEvidence.bindingConflicts(existing, options.bindingSnapshot,
    options.projectSlug, proof.proof);
  if (!conflicts.ok) return conflicts;
  var live = repairEvidence.noLiveSession(existing, evidence, options.projectSlug);
  if (!live.ok) return live;
  var updated = Object.assign({}, existing, {
    status: "pending",
    eligibilityPass: null,
    qualificationReceipt: null,
    lastSeenAt: timestamp,
    reconsideration: {
      schema: CANDIDATE_RECONSIDERATION_SCHEMA,
      version: 1,
      reason: request.reason,
      ownerRequestRefs: request.ownerRequestRefs,
      requestedAt: request.requestedAt,
      appliedAt: timestamp,
      currentQualificationRequired: true,
      verifiedNoLiveSession: true,
      priorStatus: existing.status,
      priorAdmission: existing.admission,
      priorAdmittedAt: existing.admittedAt || null,
      priorBinding: existing.binding ? clone(existing.binding) : null,
      priorOwnerDecision: existing.ownerDecision ? clone(existing.ownerDecision) : null,
      completionProof: clone(proof.proof),
    },
  });
  delete updated.attention;
  delete updated.approvalStage;
  delete updated.ownerDecision;
  return { ok: true, changed: true, before: clone(existing), candidate: clone(updated) };
}

function normalizeStaleLaunchEntry(value, defaults) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var entry = Object.assign({}, defaults || {}, value);
  if (entry.status !== "launched" || entry.statusAtCompletion !== "" ||
      entry.armed !== false || Number(entry.completedAt) !== 0 ||
      !positiveFiniteNumber(entry.lastLaunchAt) ||
      !positiveFiniteNumber(entry.updatedAt)) {
    return null;
  }
  return entry;
}

function sameStaleEntry(left, right) {
  var fields = ["status", "statusAtCompletion", "armed", "lastLaunchAt",
    "completedAt", "updatedAt"];
  for (var i = 0; i < fields.length; i++) {
    if (left[fields[i]] !== right[fields[i]]) return false;
  }
  return true;
}

function prepareIssueLaunchStateClear(currentValue, evidence, defaults, context) {
  var request = normalizeOwnerReconsiderationEvidence(evidence);
  var expected = normalizeStaleLaunchEntry(evidence && evidence.expectedEntry, defaults);
  if (!request || !expected) return { ok: false, reason: "invalid_reconsideration_evidence" };
  var current = normalizeStaleLaunchEntry(currentValue, defaults);
  if (!current) return { ok: false, reason: "not_stale_launch" };
  if (!sameStaleEntry(current, expected)) {
    return { ok: false, reason: "stale_launch_mismatch" };
  }
  var candidate = { itemKey: context && context.itemKey,
    projectRef: context && context.projectRef };
  if (!candidate.itemKey || !projectIdentity.normalizeProjectRef(candidate.projectRef)) {
    return { ok: false, reason: "repair_project_required" };
  }
  var conflicts = repairEvidence.bindingConflicts(candidate, context.bindingSnapshot,
    context.projectSlug);
  if (!conflicts.ok) return conflicts;
  var live = repairEvidence.noLiveSession(candidate, evidence, context.projectSlug);
  if (!live.ok) return live;
  return {
    ok: true,
    before: current,
    reconsideration: {
      schema: ISSUE_RECONSIDERATION_SCHEMA,
      version: 1,
      reason: request.reason,
      ownerRequestRefs: request.ownerRequestRefs,
      requestedAt: request.requestedAt,
      currentQualificationRequired: true,
      verifiedNoLiveSession: true,
    },
  };
}

module.exports = {
  CANDIDATE_RECONSIDERATION_SCHEMA: CANDIDATE_RECONSIDERATION_SCHEMA,
  ISSUE_RECONSIDERATION_SCHEMA: ISSUE_RECONSIDERATION_SCHEMA,
  OWNER_RECONSIDERATION_SCHEMA: OWNER_RECONSIDERATION_SCHEMA,
  normalizeOwnerReconsiderationEvidence: normalizeOwnerReconsiderationEvidence,
  prepareCandidateReconsideration: prepareCandidateReconsideration,
  prepareIssueLaunchStateClear: prepareIssueLaunchStateClear,
};
