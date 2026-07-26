var crypto = require("crypto");
var closeOrchestrationTask = require("./project-task-orchestrator-close").closeOrchestrationTask;
var taskGraph = require("./orchestration-task-graph");
var createToolHandlers = require("./orchestration-tool-handlers").createToolHandlers;
var attachSessionAdoption = require("./project-session-adoption").attachSessionAdoption;
var createQueuedCoordinator = require("./project-coordinate-queued").createQueuedCoordinator;
var prepareWorkerSession = require("./adaptive-worker-routing").prepareWorkerSession;
var attachCoordinatorDemotion =
  require("./project-task-orchestrator-demotion").attachCoordinatorDemotion;
var {
  orchestrationTasksForClient,
  workerPrompt,
  workerResultUpdateText,
  workerResultText,
  workerStatusFromResult,
  isVerifiedCompletion,
} = require("./orchestration-task-state");
function attachTaskOrchestrator(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendToSession = ctx.sendToSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var coordinatorDemotion = attachCoordinatorDemotion({
    sendToSession: sendToSession,
    sm: sm,
  });

  function toolError(text) {
    return {
      content: [{ type: "text", text: "Error: " + text }],
      isError: true,
    };
  }
  function toolSuccess(text) {
    return { content: [{ type: "text", text: text }] };
  }
  function tasksForClient(parentSession) {
    return orchestrationTasksForClient(parentSession);
  }
  function sendState(parentSession) {
    sendToSession(parentSession.localId, {
      type: "orchestration_tasks_state",
      tasks: tasksForClient(parentSession),
    });
  }
  function announceWorkerStarted(parentSession, task, worker) {
    var item = {
      type: "system_info",
      text: "Started worker " + worker.localId + " for “" + task.title + "”.",
      orchestrationTaskId: task.taskId,
      workerSessionId: worker.localId,
      _ts: Date.now(),
    };
    parentSession.history.push(item);
    sm.appendToSessionFile(parentSession, item);
    sendToSession(parentSession.localId, item);
  }
  function findTask(parentSession, taskId) {
    if (!parentSession) return null;
    return taskGraph.findTask(parentSession, taskId);
  }
  function updateTask(parentSession, taskId, updates) {
    var task = findTask(parentSession, taskId);
    if (!task) return null;
    var nextStatus = updates && updates.status;
    if (nextStatus && nextStatus !== task.status) {
      taskGraph.transition(parentSession, task, nextStatus, updates);
    } else {
      Object.assign(task, updates, { updatedAt: Date.now() });
      taskGraph.appendEvent(parentSession, "task_updated", task, updates);
    }
    sm.saveSessionFile(parentSession);
    sendState(parentSession);
    return task;
  }
  function coordinatorForInput(input) {
    var suppliedId = input && input.coordinatorSessionId;
    var session = sessionByStorageId(String(suppliedId || ""));
    var localId = Number(suppliedId);
    if (!session && Number.isFinite(localId)) session = sm.sessions.get(localId);
    if (!session || !session.coordinationMode || session.orchestrationParent) return null;
    return session;
  }

  function storageIdForSession(session) {
    return session && (session.storageId || session.cliSessionId) || null;
  }

  function sessionByStorageId(storageId) {
    if (!storageId || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
    var found = null;
    sm.sessions.forEach(function (session) {
      if (!found && storageIdForSession(session) === storageId) found = session;
    });
    return found;
  }

  function workerForTask(task) {
    if (!task) return null;
    var worker = task.workerStorageId ? sessionByStorageId(task.workerStorageId) : null;
    if (!worker && task.workerSessionId) worker = sm.sessions.get(task.workerSessionId);
    if (worker) {
      task.workerSessionId = worker.localId;
      task.workerStorageId = storageIdForSession(worker);
    }
    return worker;
  }

  function queueCoordinatorUpdate(parentSession, text) {
    if (!Array.isArray(parentSession.pendingCoordinatorUpdates)) {
      parentSession.pendingCoordinatorUpdates = [];
    }
    parentSession.pendingCoordinatorUpdates.push({
      text: text,
      queuedAt: Date.now(),
    });
    sm.saveSessionFile(parentSession);
    flushCoordinatorUpdates(parentSession);
  }

  function dispatchCoordinatorUpdate(parentSession, text) {
    var item = {
      type: "user_message",
      text: text,
      synthetic: true,
      origin: { kind: "task-notification" },
      fromName: "Clay workers",
      internalOnly: true,
      _ts: Date.now(),
    };
    parentSession.history.push(item);
    sm.appendToSessionFile(parentSession, item);
    parentSession.isProcessing = true;
    parentSession._queryStartTs = Date.now();
    parentSession.sentToolResults = {};
    onProcessingChanged();
    sendToSession(parentSession.localId, { type: "status", status: "processing" });
    if (!parentSession.queryInstance && (!parentSession.worker || parentSession.messageQueue !== "worker")) {
      sdk.startQuery(parentSession, text, null, ensureProjectAccessForSession(parentSession));
    } else {
      sdk.pushMessage(parentSession, text, null);
    }
    sm.broadcastSessionList();
  }

  function flushCoordinatorUpdates(parentSession) {
    if (!parentSession || parentSession.isProcessing) return false;
    if (parentSession.restartResumeEligible || parentSession.restartAutoContinueQueued) return false;
    if (Array.isArray(parentSession.pendingUserMessageQueue) &&
        parentSession.pendingUserMessageQueue.length > 0) return false;
    var pending = parentSession.pendingCoordinatorUpdates;
    if (!Array.isArray(pending) || pending.length === 0) return false;
    var updates = pending.splice(0, pending.length);
    sm.saveSessionFile(parentSession);
    var text = updates.map(function (entry) { return entry.text; }).join("\n\n---\n\n");
    dispatchCoordinatorUpdate(parentSession, text);
    return true;
  }

  function finishWorkerTurn(parentSession, task, worker) {
    if (worker._orchestrationTaskClosed || !findTask(parentSession, task.taskId)) return;
    var resultText = workerResultText(worker);
    var status = workerStatusFromResult(resultText);
    updateTask(parentSession, task.taskId, {
      status: status,
      resultSummary: resultText,
      currentActivity: status === "completed" ? "Completed; awaiting coordinator integration" : "Needs coordinator attention",
      verification: structuredField(resultText, "VERIFICATION"),
    });
    if (status === "failed" && task.attempt < task.maxAttempts) {
      detachWorker(worker);
      taskGraph.retryTask(parentSession, task);
      scheduleReadyTasks(parentSession);
      return;
    }
    queueCoordinatorUpdate(parentSession, workerResultUpdateText(task, worker, resultText, status));
    scheduleReadyTasks(parentSession);
    coordinatorDemotion.completePending(parentSession);
  }

  function structuredField(text, name) {
    var match = String(text || "").match(new RegExp("(?:^|\\n)" + name + ":\\s*([^\\n]+)", "i"));
    return match ? match[1].trim() : "";
  }

  function watchWorker(parentSession, task, worker) {
    if (!worker || worker._orchestrationWatcherAttached) return;
    worker._orchestrationWatcherAttached = true;
    var unsubscribe = sm.subscribeSession(worker.localId, function (event) {
      if (!event || event.type !== "done") return;
      if (task.status !== "running" || worker._orchestrationTaskClosed) return;
      if (Array.isArray(worker.pendingCoordinatorMessages) &&
          worker.pendingCoordinatorMessages.length > 0) {
        var nextMessage = worker.pendingCoordinatorMessages.shift();
        sm.saveSessionFile(worker);
        dispatchTaskMessage(parentSession, task, worker, nextMessage);
        return;
      }
      if (unsubscribe) unsubscribe();
      worker._orchestrationUnsubscribe = null;
      worker._orchestrationWatcherAttached = false;
      finishWorkerTurn(parentSession, task, worker);
    });
    worker._orchestrationUnsubscribe = unsubscribe;
  }

  function workerHasCompletedTurn(worker) {
    var history = worker && worker.history;
    if (!Array.isArray(history)) return false;
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].type === "done") return true;
    }
    return false;
  }

  function detachWorker(worker) {
    if (!worker) return;
    worker._orchestrationTaskClosed = true;
    worker.orchestrationParent = null;
    if (worker._orchestrationUnsubscribe) worker._orchestrationUnsubscribe();
    worker._orchestrationUnsubscribe = null;
    worker._orchestrationWatcherAttached = false;
    sm.saveSessionFile(worker);
  }
  function restoreWorkers() {
    if (!sm.sessions || typeof sm.sessions.forEach !== "function") return;
    sm.sessions.forEach(function (parentSession) {
      var tasks = parentSession && parentSession.orchestrationTasks;
      if (!Array.isArray(tasks)) return;
      for (var i = 0; i < tasks.length; i++) {
        var worker = workerForTask(tasks[i]);
        if (tasks[i].status !== "running" && !worker) continue;
        if (!worker) {
          updateTask(parentSession, tasks[i].taskId, { status: "failed" });
          continue;
        }
        var parentStorageId = storageIdForSession(parentSession);
        worker.orchestrationParent = {
          taskId: tasks[i].taskId,
          sessionId: parentSession.localId,
          sessionStorageId: parentStorageId,
        };
        sm.saveSessionFile(worker);
        sm.saveSessionFile(parentSession);
        if (tasks[i].status !== "running") continue;
        if (!worker.isProcessing) {
          if (worker.restartResumeEligible) {
            watchWorker(parentSession, tasks[i], worker);
            continue;
          }
          if (worker.interruptedByRestart) {
            var interruptionText = "Worker was interrupted by a restart and is not eligible for automatic resume.";
            updateTask(parentSession, tasks[i].taskId, {
              status: "needs_input",
              resultSummary: interruptionText,
            });
            queueCoordinatorUpdate(
              parentSession,
              workerResultUpdateText(tasks[i], worker, interruptionText, "needs_input")
            );
            continue;
          }
          if (workerHasCompletedTurn(worker) && !tasks[i].resultSummary) {
            finishWorkerTurn(parentSession, tasks[i], worker);
          } else if (!workerHasCompletedTurn(worker)) {
            updateTask(parentSession, tasks[i].taskId, { status: "failed" });
          }
          continue;
        }
        watchWorker(parentSession, tasks[i], worker);
      }
      scheduleReadyTasks(parentSession);
      flushCoordinatorUpdates(parentSession);
    });
  }

  function startTaskFromBrief(parentSession, brief) {
    var task = brief.task || taskGraph.createTask(parentSession, brief);
    var taskId = task.taskId;
    var sessionOpts = prepareWorkerSession(sm, parentSession, task, crypto.randomUUID());
    var worker = sm.createSessionRaw(sessionOpts);
    worker.title = brief.title;
    worker.titleManuallySet = true;
    worker.orchestrationParent = {
      taskId: taskId,
      sessionId: parentSession.localId,
      sessionStorageId: storageIdForSession(parentSession),
    };
    var prompt = workerPrompt(parentSession, brief, taskId)
      .replace("{{WORKER_SESSION_ID}}", String(worker.localId));
    var userMessage = {
      type: "user_message",
      text: prompt,
      orchestrationTaskId: taskId,
      synthetic: true,
      origin: { kind: "coordinator" },
      _ts: Date.now(),
    };
    worker.history.push(userMessage);
    sm.appendToSessionFile(worker, userMessage);

    task.attempt = (task.attempt || 0) + 1;
    task.workerSessionId = worker.localId;
    task.workerStorageId = storageIdForSession(worker);
    task.provider = worker.vendor || null;
    task.model = worker.model || null;
    taskGraph.transition(parentSession, task, "running", {
      currentActivity: "Worker session " + worker.localId + " is running",
    });
    sm.saveSessionFile(parentSession);
    sm.saveSessionFile(worker);
    sendState(parentSession);
    announceWorkerStarted(parentSession, task, worker);
    sm.broadcastSessionList();
    watchWorker(parentSession, task, worker);

    worker.isProcessing = true;
    worker._queryStartTs = Date.now();
    onProcessingChanged();
    try {
      var startResult = sdk.startQuery(worker, prompt, brief.images || null, ensureProjectAccessForSession(worker));
      if (startResult && typeof startResult.catch === "function") {
        startResult.catch(function (e) {
          worker.isProcessing = false;
          updateTask(parentSession, taskId, {
            status: "failed",
            resultSummary: (e && e.message) || "Worker failed to start",
          });
        });
      }
    } catch (e) {
      worker.isProcessing = false;
      updateTask(parentSession, taskId, {
        status: "failed",
        resultSummary: (e && e.message) || "Worker failed to start",
      });
    }
    return task;
  }

  function scheduleReadyTasks(parentSession) {
    var policy = parentSession.orchestrationPolicy || {};
    var ready = taskGraph.readyTasks(parentSession, policy.maxParallel || 3);
    for (var i = 0; i < ready.length; i++) {
      startTaskFromBrief(parentSession, {
        task: ready[i],
        title: ready[i].title,
        objective: ready[i].objective,
        context: ready[i].context,
        acceptanceCriteria: ready[i].acceptanceCriteria,
        ownedPaths: ready[i].ownedPaths,
        provider: ready[i].provider,
        model: ready[i].model,
        images: ready[i].images || null,
      });
    }
    sm.saveSessionFile(parentSession);
    sendState(parentSession);
    return ready;
  }

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
    task.status = "running";
    task.resultSummary = "";
    task.updatedAt = Date.now();
    sm.saveSessionFile(parentSession);
    sendState(parentSession);
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

  function messageFromTool(input) {
    var parentSession = coordinatorForInput(input);
    if (!parentSession) return toolError("invalid or non-coordinator session id");
    var task = findTask(parentSession, String(input.taskId || ""));
    if (!task) return toolError("task not found");
    var worker = workerForTask(task);
    if (!worker) return toolError("worker session not found");
    var text = String(input.message || "").trim();
    if (!text) return toolError("message is required");
    if (worker.isProcessing) {
      if (!Array.isArray(worker.pendingCoordinatorMessages)) worker.pendingCoordinatorMessages = [];
      worker.pendingCoordinatorMessages.push(text);
      sm.saveSessionFile(worker);
      return toolSuccess("Queued the update for " + task.taskId + " after its current turn.");
    }
    dispatchTaskMessage(parentSession, task, worker, text);
    return toolSuccess("Sent the update to " + task.taskId + ".");
  }

  function resumeOwnedWorker(worker) {
    var owner = worker && worker.orchestrationParent;
    if (!owner || worker._orchestrationTaskClosed) return "";
    var parent = sessionByStorageId(owner.sessionStorageId) || sm.sessions.get(owner.sessionId);
    var task = findTask(parent, owner.taskId);
    if (!task) return "";
    updateTask(parent, task.taskId, { status: "running", resultSummary: "" });
    watchWorker(parent, task, worker);
    return "";
  }

  restoreWorkers();
  var toolHandlers = createToolHandlers({
    afterResolve: function (parentSession) {
      coordinatorDemotion.completePending(parentSession);
    },
    beforeRetry: function (parentSession, task) {
      detachWorker(workerForTask(task));
    },
    coordinatorForInput: coordinatorForInput,
    error: toolError,
    schedule: scheduleReadyTasks,
    sessionById: function (id) {
      return sessionByStorageId(String(id || "")) || sm.sessions.get(Number(id));
    },
    success: toolSuccess,
    updateTask: updateTask,
    isVerifiedCompletion: isVerifiedCompletion,
  });
  var sessionAdoption = attachSessionAdoption({
    cwd: ctx.cwd,
    sm: sm,
    coordinatorForInput: coordinatorForInput,
    dispatchTaskMessage: dispatchTaskMessage,
    error: toolError,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    success: toolSuccess,
    watchWorker: watchWorker,
  });
  var coordinateQueuedMessage = createQueuedCoordinator({
    cwd: ctx.cwd,
    schedule: scheduleReadyTasks,
    sendToSession: sendToSession,
    sm: sm,
  });

  return {
    coordinateQueuedMessage: coordinateQueuedMessage,
    resumeOwnedWorker: resumeOwnedWorker,
    closeTask: function (parentSession, taskId, targetWs) {
      var closed = closeOrchestrationTask(ctx, parentSession, taskId, targetWs);
      if (closed && parentSession.coordinationMode &&
          (!Array.isArray(parentSession.orchestrationTasks) ||
           parentSession.orchestrationTasks.length === 0)) {
        coordinatorDemotion.demote(parentSession);
      }
      return closed;
    },
    delegateFromTool: toolHandlers.delegate,
    flushCoordinatorUpdates: flushCoordinatorUpdates,
    messageFromTool: messageFromTool,
    adoptFromTool: sessionAdoption.adoptFromTool,
    listAdoptionCoordinators: sessionAdoption.listCoordinators,
    proposeSessionAdoption: sessionAdoption.propose,
    planFromTool: toolHandlers.plan,
    reportFromTool: toolHandlers.report,
    resolveFromTool: toolHandlers.resolve,
    retryFromTool: toolHandlers.retry,
    sendState: sendState,
    tasksForClient: tasksForClient,
  };
}

module.exports = {
  attachTaskOrchestrator: attachTaskOrchestrator,
};
