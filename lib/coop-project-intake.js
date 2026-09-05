// Commissioning records scope; only the current resident coordinator can accept
// it. Delivery and provider-start receipts are never assignment acceptance.
var assignment = require("./coop-project-assignment");
var identity = require("./project-identity");
var plane = require("./coop-control-plane");
var graph = require("./orchestration-task-graph");
var fence = require("./coop-control-fence");
var bindings = require("./portfolio-execution-bindings");

var RETRY_MS = 60000;
var MAX_NOTIFICATIONS = 3;

function createProjectIntake(options) {
  var now = options.now || Date.now;

  function enabled() { return options.enabled === true; }
  function modeOn() { return enabled() && options.isLeadModeEnabled() === true; }

  function queued(root, task, reused) {
    return assignment.queuedResult(root, task, reused);
  }

  function linkAssignment(manager, root, task) {
    if (task.projectAssignment.threadLinked === true) return { ok: true };
    var linked = options.linkThread(task.projectAssignment.payload, queued(root, task, true));
    if (!linked || !linked.ok) return linked || { ok: false, reason: "thread_handoff_link_failed" };
    return assignment.update(manager, root, task, { threadLinked: true });
  }

  function reportAttention(manager, root, task) {
    var record = task.projectAssignment;
    if (record.attentionReported || Number(record.nextAttentionAt || 0) > now()) return false;
    var envelope;
    try { envelope = record.attentionEnvelope || options.createAttention(root, task); }
    catch (error) { return false; }
    if (!envelope) return false;
    var saved = assignment.update(manager, root, task, { attentionEnvelope: envelope,
      nextAttentionAt: now() + RETRY_MS });
    if (!saved.ok) return false;
    var result;
    try { result = options.deliverAttention(envelope); } catch (error) { result = null; }
    if (result && result.ok === true) return assignment.update(manager, root, task, { attentionReported: true }).ok;
    return false;
  }

  function notification(root, task) {
    var record = task.projectAssignment;
    return "Coop has commissioned a project assignment. Inspect the current project rules and " +
      "existing work, then accept this exact stored scope with accept_project_assignment. " +
      "Acceptance starts the ordinary project execution. If blocked, use request_task_input " +
      "on this task and report the decision needed to Coop. Do not resubmit delegate_task " +
      "or create a worker in Lead.\n" + JSON.stringify({ taskRef: record.taskRef,
        portfolioTaskId: record.payload.portfolioTaskId, bindingRevision: record.payload.bindingRevision,
        targetProject: record.payload.targetProject, admittedScope: record.payload }, null, 2);
  }

  function notify(manager, root, task) {
    var record = task.projectAssignment;
    if (modeOn() && !assignment.closed(task) && assignment.valid(root, task) && record.phase === "attention") {
      return reportAttention(manager, root, task);
    }
    if (!modeOn() || root._deleted || root.hidden || root.isProcessing ||
        !fence.isCurrent(root, "provider_start") || !assignment.valid(root, task) ||
        record.phase === "accepted" || assignment.closed(task) ||
        task.status === "needs_input" || task.status === "waiting_user" || task.status === "blocked" ||
        Number(record.nextNotificationAt || 0) > now()) return false;
    if ((root.pendingCoordinatorUpdates || []).length || (root.pendingUserMessageQueue || []).length ||
        (root.pendingCoopIngress || []).length || root.restartResumeEligible || root.restartAutoContinueQueued) return false;
    var dependencies = graph.dependencyState(root, task);
    if (dependencies.waiting.length || dependencies.failed.length) return false;
    if (!linkAssignment(manager, root, task).ok) return false;
    var attempts = Number(record.notificationAttempts || 0);
    if (attempts >= MAX_NOTIFICATIONS) {
      var attention = assignment.update(manager, root, task, { phase: "attention",
        reason: "assignment_acceptance_missing" }, { status: "needs_input",
        currentActivity: "Project coordinator has not accepted the assignment; Coop attention needed" });
      if (attention.ok) reportAttention(manager, root, task);
      return false;
    }
    var saved = assignment.update(manager, root, task, { notificationAttempts: attempts + 1,
      nextNotificationAt: now() + RETRY_MS });
    if (!saved.ok) return false;
    // This is a wake-up only. Pending scope remains durable if queueing, provider
    // creation, or the model turn fails. The next bounded attempt uses new text.
    var delivered;
    try { delivered = options.notifyCoordinator(root, notification(root, task)); }
    catch (error) { delivered = false; }
    return delivered === true;
  }

  function commission(manager, root, input, request) {
    if (!modeOn()) return { ok: false, reason: "lead_mode_disabled" };
    var staged = assignment.stage(manager, root, input, request, now());
    if (!staged.ok) return staged;
    var result = queued(root, staged.task, staged.reused);
    var linked = linkAssignment(manager, root, staged.task);
    if (!linked.ok) return linked;
    notify(manager, root, staged.task);
    return result;
  }

  function accept(caller, manager, input) {
    if (!modeOn()) return { ok: false, reason: "lead_mode_disabled" };
    var ref = identity.normalizeTaskRef(input && input.taskRef);
    if (!ref || Object.keys(input).some(function (key) { return key !== "taskRef"; }) ||
        Object.keys(input.taskRef).sort().join(",") !== "coordinatorSessionStorageId,projectId,taskId") {
      return { ok: false, reason: "exact_assignment_ref_required" };
    }
    var context = options.getControlSessionContext(caller, manager);
    if (!context || context.ok !== true || context.role !== "project_coordinator" ||
        ref.projectId !== identity.LEAD_PROJECT_ID ||
        ref.coordinatorSessionStorageId !== identity.sessionStorageId(caller)) {
      return { ok: false, reason: context && context.reason || "assignment_caller_mismatch" };
    }
    if (!fence.isCurrent(caller, "tool")) return { ok: false, reason: "assignment_caller_stale" };
    var task = graph.findTask(caller, ref.taskId);
    if (!assignment.valid(caller, task)) return { ok: false, reason: "assignment_integrity_failed" };
    var record = task.projectAssignment;
    var existing = options.existingExecution(record.payload, caller);
    if (existing) {
      var linked = options.linkThread(record.payload, Object.assign({}, existing, { taskRef: ref }));
      if (!linked || !linked.ok) return linked || { ok: false, reason: "thread_handoff_link_failed" };
      var reconciled = assignment.update(manager, caller, task, { phase: "accepted",
        acceptedAt: record.acceptedAt || now(), sessionRef: existing.sessionRef, reason: null });
      return reconciled.ok ? Object.assign({}, existing, { taskRef: ref }) : reconciled;
    }
    if (record.phase === "accepted") return { ok: false, reason: "accepted_assignment_binding_unavailable" };
    if (assignment.closed(task)) return { ok: false, reason: "assignment_closed" };
    var thread = linkAssignment(manager, caller, task);
    if (!thread.ok) return thread;
    var dependencies = graph.dependencyState(caller, task);
    if (dependencies.waiting.length || dependencies.failed.length) {
      return { ok: false, reason: "assignment_dependencies_unresolved" };
    }
    // Dispatch re-runs the original admission against current owner/grant state.
    // The model supplies only a TaskRef; the original source and scope come from
    // the validated record and cannot be replaced with claimed tool arguments.
    var starting = assignment.update(manager, caller, task, { phase: "accepting", acceptedAt: now() });
    if (!starting.ok) return starting;
    var result;
    try { result = options.dispatch(assignment.clone(record.payload), { manager: manager, root: caller, task: task }); }
    catch (error) { result = { ok: false, reason: "assignment_dispatch_failed" }; }
    if (!result || result.ok !== true) {
      var failure = assignment.update(manager, caller, task, { phase: "pending",
        reason: result && result.reason || "assignment_dispatch_failed" });
      return failure.ok ? result || { ok: false, reason: "assignment_dispatch_failed" } : failure;
    }
    var saved = assignment.update(manager, caller, task, { phase: "accepted",
      acceptedAt: now(), sessionRef: result.sessionRef, reason: null });
    return saved.ok ? Object.assign({}, result, { taskRef: ref, phase: "execution_dispatched" }) : saved;
  }

  function cancel(caller, manager, taskId, reason) {
    if (!enabled()) return { ok: false, reason: "not_pending_assignment" };
    var policy = plane.projectCoordinatorPolicy(caller);
    if (!manager || manager !== options.leadManager() || !policy ||
        manager.sessions.get(caller.localId) !== caller ||
        plane.projectCoordinatorFor(manager, policy.projectRef) !== caller) {
      return { ok: false, reason: "assignment_caller_mismatch" };
    }
    var task = graph.findTask(caller, taskId);
    if (!assignment.valid(caller, task)) return { ok: false, reason: "assignment_integrity_failed" };
    var record = task.projectAssignment;
    // A reserved binding can already own a target session even before the
    // coordinator row learns its worker reference. Reconcile that path first.
    if (!options.canCancel(record.payload) ||
        task.workerSessionRef || task.workerStorageId || record.phase === "accepted") {
      return { ok: false, reason: "not_pending_assignment" };
    }
    return assignment.update(manager, caller, task, { phase: "cancelled",
      reason: String(reason || "Dismissed by user"), resolvedAt: now() });
  }

  function roots() {
    var manager = options.leadManager();
    var found = [];
    if (manager && manager.sessions) manager.sessions.forEach(function (root) {
      var policy = plane.projectCoordinatorPolicy(root);
      if (policy && !root._deleted && plane.projectCoordinatorFor(manager, policy.projectRef) === root) {
        found.push({ manager: manager, root: root });
      }
    });
    return found;
  }

  function conflict(request) {
    if (!enabled()) return null;
    var result = null;
    roots().forEach(function (entry) {
      (entry.root.orchestrationTasks || []).forEach(function (task) {
        var record = task.projectAssignment;
        if (!record || record.phase === "accepted" || assignment.closed(task)) return;
        var prior = record.payload;
        if (!prior || !prior.targetProject || prior.targetProject.projectId !== request.targetProject.projectId) return;
        if (prior.portfolioTaskId === request.portfolioTaskId) {
          if (prior.bindingRevision !== request.bindingRevision) result = { ok: false, reason: "active_assignment_exists" };
          else if (bindings.requestEquivalence(prior, request) === "conflict") {
            result = { ok: false, reason: "assignment_idempotency_conflict" };
          }
        } else if (prior.workIdentity && prior.workIdentity === request.workIdentity) {
          result = { ok: false, reason: "duplicate_assignment_work_identity" };
        }
      });
    });
    return result;
  }

  function retryPending() {
    if (!modeOn()) return;
    roots().forEach(function (entry) {
      (entry.root.orchestrationTasks || []).forEach(function (task) {
        if (task.projectAssignment && task.projectAssignment.phase !== "accepted") notify(entry.manager, entry.root, task);
      });
    });
  }

  return { enabled: enabled, commission: commission, accept: accept, cancel: cancel,
    conflict: conflict, retryPending: retryPending };
}

module.exports = { createProjectIntake: createProjectIntake };
