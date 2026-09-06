// Shared lookups for explicit bookkeeping repair and missing-binding capacity.
var identity = require("./project-identity");
var automationIdentity = require("./project-automation-identity");
var reconciliation = require("./project-automation-candidate-reconciliation");

var SETTLED = { completed: true, failed: true, superseded: true, cancelled: true,
  unrouted: true, dismissed: true, deleted: true };

function itemKey(value) {
  var text = String(value || "");
  var url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/.exec(text);
  return url ? url[1] + "#" + url[2] : text.replace(/^github:/, "");
}

function matchesWork(record, candidate, projectSlug) {
  if (!record || !candidate) return false;
  var key = candidate.itemKey;
  var taskId = record.portfolioTaskId;
  var number = /#(\d+)$/.exec(key || "");
  return taskId === automationIdentity.portfolioTaskIdFor(candidate) ||
    !!(candidate.binding && taskId === candidate.binding.portfolioTaskId) ||
    !!(projectSlug && number && taskId === "portfolio-" + projectSlug + "-" + number[1]) ||
    itemKey(record.workIdentity) === key ||
    itemKey(record.automationAuthorization && record.automationAuthorization.itemKey) === key;
}

function bindingConflicts(candidate, bindingSnapshot, projectSlug, priorBinding) {
  var snapshot = reconciliation.verifiedSnapshot(bindingSnapshot);
  if (!snapshot.ok) return snapshot;
  for (var i = 0; i < snapshot.bindings.length; i++) {
    var record = snapshot.bindings[i];
    if (!matchesWork(record, candidate, projectSlug)) continue;
    if (record.targetProject.projectId !== candidate.projectRef.projectId) {
      return { ok: false, reason: "binding_project_conflict" };
    }
    if (!SETTLED[record.status]) return { ok: false, reason: "active_binding_conflict" };
    if (priorBinding && record.portfolioTaskId === priorBinding.portfolioTaskId &&
        record.bindingRevision > priorBinding.bindingRevision) {
      return { ok: false, reason: "newer_binding_conflict" };
    }
  }
  return { ok: true, bindings: snapshot.bindings };
}

function noLiveSession(candidate, evidence, projectSlug) {
  var snapshot = evidence && evidence.sessionSnapshot;
  var ref = identity.normalizeProjectRef(snapshot && snapshot.projectRef);
  if (!candidate || !ref || !candidate.projectRef ||
      ref.projectId !== candidate.projectRef.projectId || !Array.isArray(snapshot.sessions)) {
    return { ok: false, reason: "session_snapshot_required" };
  }
  for (var i = 0; i < snapshot.sessions.length; i++) {
    var session = snapshot.sessions[i];
    if (!session || !identity.sessionStorageId(session)) {
      return { ok: false, reason: "session_snapshot_malformed" };
    }
    var policy = session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
    var tl = session.taskLauncher || {};
    var key = itemKey(tl.automationClaimKey || tl.itemKey || tl.itemUrl);
    if (key !== candidate.itemKey && !matchesWork(policy, candidate, projectSlug)) continue;
    var explicitProject = identity.normalizeProjectRef(session.projectRef ||
      (session.projectId ? { projectId: session.projectId } : null) ||
      (policy && policy.targetProject));
    if (explicitProject && explicitProject.projectId !== ref.projectId) {
      return { ok: false, reason: "session_project_conflict" };
    }
    if (session.isProcessing === true || (policy && !SETTLED[policy.status]) ||
        (!session.hidden && !session.closedAt && !tl.workflowCompleted &&
        !tl.executionCompletionReported)) {
      return { ok: false, reason: "live_session_conflict" };
    }
  }
  return { ok: true };
}

module.exports = { matchesWork: matchesWork, bindingConflicts: bindingConflicts,
  noLiveSession: noLiveSession };
