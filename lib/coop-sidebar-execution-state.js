// Read-only execution truth for sidebar rows. A saved task status describes
// intent; only current session activity proves that execution is taking place.
var hasStaleProcessingState = require("./sessions-queued-messages").hasStaleProcessingState;
var projectIdentity = require("./project-identity");
var lifecycle = require("./coop-session-lifecycle");

function processing(session) {
  return !!(session && session.isProcessing === true && !session.hidden &&
    !session.closedAt && !session._deleted && !hasStaleProcessingState(session));
}

function exactBinding(session, projectId, bindings) {
  var execution = session && session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
  if (!execution) return null;
  var list = Array.isArray(bindings) ? bindings : [];
  for (var i = 0; i < list.length; i++) {
    var binding = list[i];
    var ref = binding && (binding.mode === "project_coordinator" ? binding.coordinator : binding.worker);
    if (ref && ref.projectId === projectId &&
        ref.sessionStorageId === (session.storageId || session.cliSessionId) &&
        binding.targetProject && binding.targetProject.projectId === projectId &&
        binding.portfolioTaskId === execution.portfolioTaskId &&
        binding.bindingRevision === execution.bindingRevision &&
        binding.idempotencyKey === execution.idempotencyKey && binding.mode === execution.mode) return binding;
  }
  return null;
}

function taskState(task, session, projectId, bindings, children) {
  var status = task && task.status || "queued";
  if (["completed", "cancelled", "dismissed", "superseded"].indexOf(status) !== -1) return status;
  var binding = exactBinding(session, projectId, bindings);
  var role = session && session.coordinationRole || "worker";
  status = lifecycle.lifecycleState(session, binding, task, role);
  if (lifecycle.ATTENTION[status] || lifecycle.TERMINAL[status]) return status;
  var list = Array.isArray(children) ? children : [];
  var attention = list.find(function (child) { return lifecycle.ATTENTION[child.status]; });
  if (attention) return attention.status;
  if (status === "running" || status === "active" || status === "reviewing") {
    return processing(session) || list.some(function (child) { return child.status === "running"; })
      ? "running" : status === "reviewing" ? "reviewing" : "waiting";
  }
  return status;
}

function activity(status, session, task) {
  if (status === "waiting") return "Execution is not running";
  if (status === "reviewing" && !processing(session)) return "Awaiting review";
  var execution = session && session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
  if (lifecycle.ATTENTION[status]) return task && (task.userQuestion || task.waitingReason) ||
    execution && (execution.statusReason || execution.reason || execution.completionRefusalReason) || "";
  return session && session.currentActivity || task && task.currentActivity || "";
}


var ACTIVE_STATUSES = lifecycle.ACTIVE;
var RESOLVED_TASK_STATUSES = { completed: true, dismissed: true, cancelled: true };
function cleanText(value, fallback) { return String(value || fallback || ""); }
function sameSessionRef(left, right) {
  return !!(left && right && left.projectId === right.projectId && left.sessionStorageId === right.sessionStorageId);
}
  function typedExecution(session) {
    var execution = session && session.orchestrationPolicy &&
      session.orchestrationPolicy.portfolioExecution;
    if (!execution || execution.mode !== "project_coordinator" || !projectIdentity.isTaskId(execution.portfolioTaskId) ||
        !Number.isInteger(execution.bindingRevision) || execution.bindingRevision < 1 ||
        !projectIdentity.isTaskId(execution.idempotencyKey)) return null;
    return execution;
  }

  function bindingBuckets(bindings) {
    var buckets = {};
    var list = Array.isArray(bindings) ? bindings : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || !projectIdentity.isTaskId(item.portfolioTaskId)) continue;
      if (!buckets[item.portfolioTaskId]) buckets[item.portfolioTaskId] = [];
      buckets[item.portfolioTaskId].push(item);
    }
    return buckets;
  }

  function hasNewerCommittedTypedBinding(child, projectId, buckets) {
    var execution = typedExecution(child);
    if (!execution || execution.status !== "failed") return false;
    var childRef = projectIdentity.sessionRef({ projectId: projectId }, child);
    var candidates = buckets[execution.portfolioTaskId] || [];
    var exactFailed = false;
    var newerCommitted = false;
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var target = projectIdentity.normalizeProjectRef(candidate.targetProject);
      var coordinator = projectIdentity.normalizeSessionRef(candidate.coordinator);
      if (!target || target.projectId !== projectId || candidate.mode !== execution.mode || !Number.isInteger(candidate.bindingRevision) || !projectIdentity.isTaskId(candidate.idempotencyKey)) {
        continue;
      }
      if (candidate.bindingRevision === execution.bindingRevision &&
          candidate.idempotencyKey === execution.idempotencyKey &&
          candidate.status === "failed" && sameSessionRef(coordinator, childRef)) exactFailed = true;
      if (candidate.bindingRevision > execution.bindingRevision && coordinator &&
          candidate.status !== "pending" && candidate.status !== "unrouted") {
        newerCommitted = true;
      }
    }
    return exactFailed && newerCommitted;
  }

  // Lead's historical reconciliation is represented on the typed child
  // lifecycle, not copied into the persistent Lead task. A terminal failed
  // execution that has both completion-delivery edges is no longer foreground
  // work when its parent task was left running by the old coordinator. The
  // child is already matched to the exact persistent Lead TaskRef above, and
  // the typed target project prevents a similarly titled task from matching.
  // Do not require a current binding-store row: terminal bindings are retained
  // in the historical ledger but may no longer be in the active binding list.
  function hasReconciledTerminalFailure(child, projectId) {
    var execution = typedExecution(child);
    var target = execution && projectIdentity.normalizeProjectRef(execution.targetProject);
    if (!execution || execution.status !== "failed" ||
        !target || target.projectId !== projectId ||
        !Number.isFinite(execution.terminalAt) || execution.terminalAt <= 0 ||
        typeof execution.projectCompletionResultEventId !== "string" ||
        !execution.projectCompletionResultEventId ||
        typeof execution.projectCompletionDeliveryEventId !== "string" ||
        !execution.projectCompletionDeliveryEventId) return false;
    return true;
  }

  function effectiveTaskStatus(task, child, projectId, buckets, workers) {
    var taskStatus = cleanText(task && task.status, "queued");
    // The parent task is the authoritative disposition. A failed child binding
    // remains immutable audit evidence after the coordinator dismisses or
    // completes that task, but it must not reopen a closed sidebar row.
    if (RESOLVED_TASK_STATUSES[taskStatus]) return taskStatus;
    // Older persistent coordinator metadata can remain running after Lead has
    // durably reconciled a terminal child execution. Hide only that exact
    // lifecycle shape; explicit failed/needs_input parent dispositions remain
    // owner-visible, as do failures without terminal reconciliation evidence.
    if (ACTIVE_STATUSES[taskStatus] &&
        hasReconciledTerminalFailure(child, projectId)) return "reconciled";
    var execution = child && child.orchestrationPolicy && child.orchestrationPolicy.portfolioExecution;
    var childStatus = cleanText(execution && execution.status, "");
    if (childStatus === "failed" && hasNewerCommittedTypedBinding(child, projectId, buckets)) {
      return "superseded";
    }
    return taskState(task, child, projectId,
      buckets[execution && execution.portfolioTaskId] || [], workers);
  }


module.exports = { processing: processing, taskState: taskState, activity: activity,
  bindingBuckets: bindingBuckets, effectiveTaskStatus: effectiveTaskStatus };
