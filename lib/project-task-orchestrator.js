var crypto = require("crypto");
var {
  orchestrationTasksForClient,
  coordinatorActivationPrompt,
  workerResultText,
  workerStatusFromResult,
} = require("./orchestration-task-state");

function attachTaskOrchestrator(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendToSession = ctx.sendToSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;

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

  function findTask(parentSession, taskId) {
    var tasks = parentSession && parentSession.orchestrationTasks;
    if (!Array.isArray(tasks)) return null;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].taskId === taskId) return tasks[i];
    }
    return null;
  }

  function updateTask(parentSession, taskId, updates) {
    var task = findTask(parentSession, taskId);
    if (!task) return null;
    Object.assign(task, updates, { updatedAt: Date.now() });
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

  function resultUpdateText(task, worker, resultText, status) {
    return [
      "[Clay worker update]",
      "Task ID: " + task.taskId,
      "Title: " + task.title,
      "Status: " + status,
      "Worker session: " + worker.localId,
      "Provider: " + (worker.vendor || "unknown"),
      "",
      "Worker result:",
      resultText || "(The worker returned no written result.)",
      "",
      "You own this result. Reconcile it with the other active tasks and the",
      "user's intent. Delegate follow-up or integration work if needed. Report",
      "a unified outcome only when the relevant task graph is complete.",
    ].join("\n");
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
      _ts: Date.now(),
    };
    parentSession.history.push(item);
    sm.appendToSessionFile(parentSession, item);
    sendToSession(parentSession.localId, item);
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
    var resultText = workerResultText(worker);
    var status = workerStatusFromResult(resultText);
    updateTask(parentSession, task.taskId, {
      status: status,
      resultSummary: resultText,
    });
    queueCoordinatorUpdate(parentSession, resultUpdateText(task, worker, resultText, status));
  }

  function watchWorker(parentSession, task, worker) {
    if (!worker || worker._orchestrationWatcherAttached) return;
    worker._orchestrationWatcherAttached = true;
    sm.subscribeSession(worker.localId, function (event) {
      if (!event || event.type !== "done") return;
      if (Array.isArray(worker.pendingCoordinatorMessages) &&
          worker.pendingCoordinatorMessages.length > 0) {
        var nextMessage = worker.pendingCoordinatorMessages.shift();
        sm.saveSessionFile(worker);
        dispatchTaskMessage(parentSession, task, worker, nextMessage);
        return;
      }
      finishWorkerTurn(parentSession, task, worker);
    });
  }

  function workerHasCompletedTurn(worker) {
    var history = worker && worker.history;
    if (!Array.isArray(history)) return false;
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].type === "done") return true;
    }
    return false;
  }

  function restoreWorkers() {
    if (!sm.sessions || typeof sm.sessions.forEach !== "function") return;
    sm.sessions.forEach(function (parentSession) {
      var tasks = parentSession && parentSession.orchestrationTasks;
      if (!Array.isArray(tasks)) return;
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].status !== "running") continue;
        var worker = workerForTask(tasks[i]);
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
              resultUpdateText(tasks[i], worker, interruptionText, "needs_input")
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
      flushCoordinatorUpdates(parentSession);
    });
  }

  function workerPrompt(parentSession, brief, taskId) {
    return [
      "You are a bounded worker owned by a Clay coordinator.",
      "Do not broaden product scope or delegate further. Work only inside the",
      "declared ownership boundary. If the task conflicts with in-flight work,",
      "stop and report the conflict instead of overwriting it.",
      "",
      "Coordinator session: " + parentSession.localId,
      "Task ID: " + taskId,
      "Title: " + brief.title,
      "",
      "Objective:",
      brief.objective,
      "",
      "Relevant context:",
      brief.context,
      "",
      "Acceptance criteria:",
      brief.acceptanceCriteria,
      "",
      "Owned paths/subsystem:",
      brief.ownedPaths,
      "",
      "Complete the task, verify it, and end with this structured report:",
      "WORKER_STATUS: completed | needs_input | blocked | failed",
      "SUMMARY: concise outcome",
      "CHANGES: files and behavior changed, or none",
      "COMMITS: hashes and messages, or none",
      "VERIFICATION: commands/evidence",
      "ESCALATION_REQUIRED: yes | no",
    ].join("\n");
  }

  function startTaskFromBrief(parentSession, brief) {
    var taskId = "task-" + crypto.randomUUID();
    var sessionOpts = {
      storageId: crypto.randomUUID(),
      ownerId: parentSession.ownerId || null,
      vendor: brief.provider || parentSession.vendor || sm.defaultVendor || "claude",
      providerRouteId: brief.provider ? null : (parentSession.providerRouteId || null),
      model: brief.model || parentSession.model || parentSession.requestedModel || null,
      permissionMode: parentSession.permissionMode || null,
      automationMode: parentSession.automationMode || null,
      codexApproval: parentSession.codexApproval || null,
      codexSandbox: parentSession.codexSandbox || null,
      codexWebSearch: parentSession.codexWebSearch || null,
      mode: "gui",
    };
    var worker = sm.createSessionRaw(sessionOpts);
    worker.title = brief.title;
    worker.titleManuallySet = true;
    worker.orchestrationParent = {
      taskId: taskId,
      sessionId: parentSession.localId,
      sessionStorageId: storageIdForSession(parentSession),
    };
    var prompt = workerPrompt(parentSession, brief, taskId);
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

    if (!Array.isArray(parentSession.orchestrationTasks)) parentSession.orchestrationTasks = [];
    var task = {
      taskId: taskId,
      title: brief.title,
      objective: brief.objective,
      acceptanceCriteria: brief.acceptanceCriteria,
      ownedPaths: brief.ownedPaths,
      status: "running",
      workerSessionId: worker.localId,
      workerStorageId: storageIdForSession(worker),
      provider: worker.vendor || null,
      model: worker.model || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    parentSession.orchestrationTasks.push(task);
    sm.saveSessionFile(parentSession);
    sm.saveSessionFile(worker);
    sendState(parentSession);
    sm.broadcastSessionList();
    watchWorker(parentSession, task, worker);

    worker.isProcessing = true;
    worker._queryStartTs = Date.now();
    onProcessingChanged();
    try {
      var startResult = sdk.startQuery(worker, prompt, null, ensureProjectAccessForSession(worker));
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

  function delegateFromTool(input) {
    var parentSession = coordinatorForInput(input);
    if (!parentSession) return toolError("invalid or non-coordinator session id");
    var required = ["title", "objective", "context", "acceptanceCriteria", "ownedPaths"];
    for (var i = 0; i < required.length; i++) {
      if (!String(input[required[i]] || "").trim()) {
        return toolError(required[i] + " is required");
      }
    }
    var task = startTaskFromBrief(parentSession, {
      title: String(input.title).trim(),
      objective: String(input.objective).trim(),
      context: String(input.context).trim(),
      acceptanceCriteria: String(input.acceptanceCriteria).trim(),
      ownedPaths: String(input.ownedPaths).trim(),
      provider: String(input.provider || "").trim() || null,
      model: String(input.model || "").trim() || null,
    });
    return toolSuccess(
      "Started owned worker task " + task.taskId + " in session " +
      task.workerSessionId + ". Its result will return to this coordinator automatically."
    );
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

  function activateCoordinator(session, userText) {
    if (!session) return "";
    session.coordinationMode = true;
    sm.saveSessionFile(session);
    return coordinatorActivationPrompt(storageIdForSession(session) || session.localId, userText || "");
  }

  restoreWorkers();

  return {
    activateCoordinator: activateCoordinator,
    delegateFromTool: delegateFromTool,
    flushCoordinatorUpdates: flushCoordinatorUpdates,
    messageFromTool: messageFromTool,
    sendState: sendState,
    tasksForClient: tasksForClient,
  };
}

module.exports = {
  attachTaskOrchestrator: attachTaskOrchestrator,
};
