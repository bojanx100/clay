var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var taskGraph = require("./orchestration-task-graph");

function attachTaskFollowup(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var onProcessingChanged = ctx.onProcessingChanged;

  function externalBinding(parentSession, task) {
    var match = task && task.externalTaskCoordinator &&
      String(task.clientRef || "").match(/^portfolio:(.+):([0-9]+)$/);
    var source = projectIdentity.sessionRef({ projectId: ctx.projectId() }, parentSession);
    var targetProject = projectIdentity.normalizeProjectRef(task && task.coopProjectRef);
    if (!match || !source || !targetProject || !ctx.crossProject ||
        typeof ctx.crossProject.getExecutionBinding !== "function") return null;
    var binding = ctx.crossProject.getExecutionBinding(match[1], Number(match[2]));
    var projectCoordinator = projectIdentity.normalizeSessionRef(binding && binding.projectCoordinator);
    var bindingTarget = projectIdentity.normalizeProjectRef(binding && binding.targetProject);
    var bindingWorker = projectIdentity.normalizeSessionRef(binding && binding.coordinator);
    var worker = projectIdentity.normalizeSessionRef(task.workerSessionRef);
    if (!binding || binding.mode !== "project_coordinator" || !projectCoordinator ||
        !bindingTarget || bindingTarget.projectId !== targetProject.projectId ||
        !bindingWorker || !worker || bindingWorker.projectId !== worker.projectId ||
        bindingWorker.sessionStorageId !== worker.sessionStorageId ||
        worker.projectId !== targetProject.projectId ||
        projectCoordinator.projectId !== source.projectId ||
        projectCoordinator.sessionStorageId !== source.sessionStorageId) return null;
    return { binding: binding, projectCoordinator: projectCoordinator,
      source: source, targetProject: targetProject, worker: worker };
  }

  function routeExternalTask(parentSession, task, text) {
    var refs = externalBinding(parentSession, task);
    if (!refs || typeof ctx.crossProject.messageProjectExecution !== "function") {
      return { ok: false, reason: "cross_project_worker_unavailable" };
    }
    var result = ctx.crossProject.messageProjectExecution({
      source: refs.source,
      targetProject: refs.targetProject,
      targetCoordinator: refs.projectCoordinator,
      portfolioTaskId: refs.binding.portfolioTaskId,
      bindingRevision: refs.binding.bindingRevision,
      idempotencyKey: "task-followup-" + crypto.randomUUID(),
      message: text,
    });
    if (!result || result.ok !== true) return result || { ok: false, reason: "delivery_error" };
    ctx.updateTask(parentSession, task.taskId, {
      status: "running", resultSummary: "", verification: "", progress: 0,
      currentActivity: "Project task coordinator is continuing",
      resolutionReason: "", resolutionSummary: "", resolvedAt: null,
      userQuestion: "", waitingReason: "", userAnsweredAt: null,
    });
    return Object.assign({ ok: true, sessionStorageId: refs.worker.sessionStorageId }, result);
  }

  function dismissExternalTask(parentSession, task, reason) {
    if (!task || !task.externalTaskCoordinator) return null;
    var refs = externalBinding(parentSession, task);
    if (refs && refs.source.projectId !== projectIdentity.LEAD_PROJECT_ID) return null;
    if (!refs || typeof ctx.crossProject.dismissProjectExecution !== "function") return false;
    var result = ctx.crossProject.dismissProjectExecution({
      source: refs.source, targetProject: refs.targetProject,
      portfolioTaskId: refs.binding.portfolioTaskId,
      bindingRevision: refs.binding.bindingRevision,
      idempotencyKey: "dismiss-task-" + task.taskId,
      reason: reason,
    });
    return !!(result && result.ok === true);
  }

  function dispatchTaskMessage(parentSession, task, worker, text, imageRefs) {
    var prompt = [
      "[Coordinator update for task " + task.taskId + "]",
      text,
      "",
      "Continue the owned task and return the structured worker report again.",
    ].join("\n");
    var item = {
      type: "user_message",
      text: prompt,
      orchestrationTaskId: task.taskId,
      synthetic: true,
      origin: { kind: "coordinator" },
      _ts: Date.now(),
    };
    if (Array.isArray(imageRefs) && imageRefs.length) item.imageRefs = imageRefs;
    worker.history.push(item);
    sm.appendToSessionFile(worker, item);
    ctx.updateTask(parentSession, task.taskId, {
      status: "running",
      resultSummary: "",
      verification: "",
      progress: 0,
      currentActivity: "Worker session " + worker.localId + " is continuing",
      resolutionReason: "",
      resolutionSummary: "",
      resolvedAt: null,
      userQuestion: "",
      waitingReason: "",
      userAnsweredAt: null,
    });
    ctx.watchWorker(parentSession, task, worker);
    worker.isProcessing = true;
    worker._queryStartTs = Date.now();
    onProcessingChanged();
    var images = Array.isArray(imageRefs) && ctx.loadImagesForSdk ?
      ctx.loadImagesForSdk(imageRefs) : null;
    if (!worker.queryInstance && (!worker.worker || worker.messageQueue !== "worker")) {
      sdk.startQuery(worker, prompt, images, ensureProjectAccessForSession(worker));
    } else {
      sdk.pushMessage(worker, prompt, images);
    }
    sm.broadcastSessionList();
  }

  function restoreLiveUiWorker(parentSession, task, worker) {
    var wasArchived = !!(task.archivedAt || worker.hidden ||
      worker._orchestrationTaskClosed || worker.taskStopRequested);
    delete task.archivedAt;
    delete task.resolvedByCoordinator;
    if (!wasArchived) return;
    delete worker.hidden;
    delete worker.orchestrationDetachedAt;
    worker._orchestrationTaskClosed = false;
    worker.taskStopRequested = false;
    taskGraph.appendEvent(parentSession, "task_worker_restored", task, {
      reason: "The user added Live UI feedback before approving the change",
    });
    sm.saveSessionFile(worker);
    sm.saveSessionFile(parentSession);
    sm.broadcastSessionList();
  }

  function retryExistingWorker(parentSession, task) {
    var reusableStatus = task && (task.status === "completed" || task.status === "reviewing" ||
      task.status === "needs_input" || task.status === "waiting_user");
    if (!reusableStatus) return null;
    var worker = ctx.workerForTask(task);
    var owner = worker && worker.orchestrationParent;
    if (!worker || worker.hidden || worker.isProcessing || worker.taskStopRequested ||
        worker._orchestrationTaskClosed || !owner || owner.taskId !== task.taskId) {
      return null;
    }
    var nextAttempt = (task.attempt || 0) + 1;
    task.attempt = nextAttempt;
    taskGraph.appendEvent(parentSession, "task_retry_requested", task, {
      nextAttempt: nextAttempt,
      reusedWorkerSessionId: worker.localId,
    });
    dispatchTaskMessage(parentSession, task, worker,
      "Retry this task in the same worker conversation. Re-read the current inputs and " +
      "perform another complete pass; do not assume the previous result is still current.");
    return worker;
  }

  function resolvedTaskError(task, liveUiFollowup) {
    if (task.status === "completed" && !liveUiFollowup) {
      return "task is already completed; use retry_task for another pass";
    }
    if (task.status === "dismissed" || task.status === "cancelled") {
      return "task is already resolved; use retry_task for another pass";
    }
    return "";
  }

  function queueTaskMessage(worker, task, text, input, liveUiFollowup) {
    if (!Array.isArray(worker.pendingCoordinatorMessages)) {
      worker.pendingCoordinatorMessages = [];
    }
    worker.pendingCoordinatorMessages.push(liveUiFollowup ? {
      text: text,
      imageRefs: Array.isArray(input.imageRefs) ? input.imageRefs : [],
    } : text);
    sm.saveSessionFile(worker);
    return ctx.toolSuccess("Queued the update for the existing worker " + task.taskId +
      " after its current turn.");
  }

  function messageFromTool(input) {
    var parentSession = ctx.coordinatorForInput(input);
    if (!parentSession) return ctx.toolError("invalid or non-coordinator session id");
    var owned = ctx.coordinatorOwningTask(parentSession, String(input.taskId || ""));
    if (!owned) return ctx.toolError("task not found");
    parentSession = owned.owner;
    var task = owned.task;
    var liveUiFollowup = input._liveUiFollowup === true;
    var resolutionError = resolvedTaskError(task, liveUiFollowup);
    if (resolutionError) return ctx.toolError(resolutionError);
    var worker = ctx.workerForTask(task);
    var text = String(input.message || "").trim();
    if (!text) return ctx.toolError("message is required");
    if (!worker && task.externalTaskCoordinator) {
      var routed = routeExternalTask(parentSession, task, text);
      return routed && routed.ok === true ?
        ctx.toolSuccess("Sent the update to project task coordinator " + task.taskId + ".") :
        ctx.toolError("project task coordinator update failed: " +
          String(routed && routed.reason || "delivery_error"));
    }
    if (!worker) return ctx.toolError("worker session not found");
    if (liveUiFollowup) restoreLiveUiWorker(parentSession, task, worker);
    if (worker.isProcessing) return queueTaskMessage(
      worker, task, text, input, liveUiFollowup);
    dispatchTaskMessage(parentSession, task, worker, text,
      Array.isArray(input.imageRefs) ? input.imageRefs : null);
    return ctx.toolSuccess("Sent the update to the existing worker " + task.taskId + ".");
  }

  function resumeOwnedWorker(worker) {
    var owner = worker && worker.orchestrationParent;
    if (!owner || worker._orchestrationTaskClosed) return "";
    var parent = ctx.sessionByStorageId(owner.sessionStorageId) || sm.sessions.get(owner.sessionId);
    var task = ctx.findTask(parent, owner.taskId);
    if (!task) return "";
    ctx.updateTask(parent, task.taskId, {
      status: "running",
      resultSummary: "",
      verification: "",
      resolutionReason: "",
      resolutionSummary: "",
      resolvedAt: null,
      userQuestion: "",
      waitingReason: "",
      userAnsweredAt: null,
    });
    ctx.watchWorker(parent, task, worker);
    return "";
  }

  function deliverCoordinatorUpdate(sessionStorageId, text) {
    var session = ctx.sessionByStorageId(String(sessionStorageId || ""));
    if (!session) return false;
    ctx.queueCoordinatorUpdate(session, text);
    return true;
  }

  function deliveryWasApplied(session, eventId) {
    var pending = session && session.pendingCoordinatorUpdates || [];
    for (var i = 0; i < pending.length; i++) {
      if (hasDeliveryMarker(pending[i] && pending[i].text, eventId)) return true;
    }
    var history = session && session.history || [];
    for (var j = history.length - 1; j >= 0; j--) {
      var item = history[j];
      if (hasDeliveryMarker(item && item.text, eventId)) return true;
    }
    return false;
  }

  function hasDeliveryMarker(text, eventId) {
    return typeof text === "string" && text.indexOf("<cross_project_delivery_event id=\"" +
      eventId + "\" />") !== -1;
  }

  function deliveryText(text, eventId) {
    return text + "\n<cross_project_delivery_event id=\"" + eventId + "\" />";
  }

  // The transport persists its own inbox cursor, but the canonical target
  // session records an event id too. That closes the crash window between
  // applying a queued update and persisting the sender acknowledgement.
  function deliverCrossProjectEnvelope(envelope) {
    var destination = envelope && envelope.destination;
    var payload = envelope && envelope.payload;
    var eventId = envelope && envelope.eventId;
    if (!destination || !eventId || !payload || payload.type !== "coordinator_update" ||
        typeof payload.text !== "string") {
      return { ok: false, reason: "invalid_payload" };
    }
    var session = ctx.sessionByStorageId(String(destination.sessionStorageId || ""));
    if (!session) return { ok: false, reason: "session_not_found" };
    if (session.hidden) return { ok: false, reason: "session_archived" };
    if (deliveryWasApplied(session, eventId)) {
      // If a restart kept the durable queue but not its active stream, let
      // normal coordinator scheduling resume it without injecting it again.
      if (typeof ctx.flushCoordinatorUpdates === "function") ctx.flushCoordinatorUpdates(session);
      return { ok: true, duplicate: true };
    }
    ctx.queueCoordinatorUpdate(session, deliveryText(payload.text, eventId));
    return { ok: true };
  }

  return {
    deliverCoordinatorUpdate: deliverCoordinatorUpdate,
    deliverCrossProjectEnvelope: deliverCrossProjectEnvelope,
    dismissExternalTask: dismissExternalTask,
    dispatchTaskMessage: dispatchTaskMessage,
    messageFromTool: messageFromTool,
    resumeOwnedWorker: resumeOwnedWorker,
    retryExistingWorker: retryExistingWorker,
    retryExternalTask: function (parentSession, task) {
      if (!task || !task.externalTaskCoordinator) return null;
      return routeExternalTask(parentSession, task,
        "Retry this task in the same project coordinator conversation. Re-read the current " +
        "authoritative inputs, preserve the stable task identity, and complete another pass.");
    },
  };
}

module.exports = {
  attachTaskFollowup: attachTaskFollowup,
};
