var taskGraph = require("./orchestration-task-graph");

function attachTaskFollowup(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var onProcessingChanged = ctx.onProcessingChanged;

  function dispatchTaskMessage(parentSession, task, worker, text) {
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
    if (!worker.queryInstance && (!worker.worker || worker.messageQueue !== "worker")) {
      sdk.startQuery(worker, prompt, null, ensureProjectAccessForSession(worker));
    } else {
      sdk.pushMessage(worker, prompt, null);
    }
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

  function messageFromTool(input) {
    var parentSession = ctx.coordinatorForInput(input);
    if (!parentSession) return ctx.toolError("invalid or non-coordinator session id");
    var task = ctx.findTask(parentSession, String(input.taskId || ""));
    if (!task) return ctx.toolError("task not found");
    if (task.status === "completed") {
      return ctx.toolError("task is already completed; use retry_task for another pass");
    }
    if (task.status === "dismissed" || task.status === "cancelled") {
      return ctx.toolError("task is already resolved; use retry_task for another pass");
    }
    var worker = ctx.workerForTask(task);
    if (!worker) return ctx.toolError("worker session not found");
    var text = String(input.message || "").trim();
    if (!text) return ctx.toolError("message is required");
    if (worker.isProcessing) {
      if (!Array.isArray(worker.pendingCoordinatorMessages)) worker.pendingCoordinatorMessages = [];
      worker.pendingCoordinatorMessages.push(text);
      sm.saveSessionFile(worker);
      return ctx.toolSuccess("Queued the update for " + task.taskId + " after its current turn.");
    }
    dispatchTaskMessage(parentSession, task, worker, text);
    return ctx.toolSuccess("Sent the update to " + task.taskId + ".");
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

  return {
    deliverCoordinatorUpdate: deliverCoordinatorUpdate,
    dispatchTaskMessage: dispatchTaskMessage,
    messageFromTool: messageFromTool,
    resumeOwnedWorker: resumeOwnedWorker,
    retryExistingWorker: retryExistingWorker,
  };
}

module.exports = {
  attachTaskFollowup: attachTaskFollowup,
};
