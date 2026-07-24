var crypto = require("crypto");
var { meaningfulTextTitle } = require("./text-title");
var { orchestrationTasksForClient } = require("./orchestration-task-state");

function attachTaskOrchestrator(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendToSession = ctx.sendToSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;

  function tasksForClient(parentSession) {
    return orchestrationTasksForClient(parentSession);
  }

  function sendState(parentSession) {
    sendToSession(parentSession.localId, {
      type: "orchestration_tasks_state",
      tasks: tasksForClient(parentSession),
    });
  }

  function updateTask(parentSession, taskId, updates) {
    var tasks = parentSession.orchestrationTasks || [];
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].taskId !== taskId) continue;
      Object.assign(tasks[i], updates, { updatedAt: Date.now() });
      sm.saveSessionFile(parentSession);
      sendState(parentSession);
      return tasks[i];
    }
    return null;
  }

  function watchWorker(parentSession, taskId, worker) {
    if (!worker || worker._orchestrationWatcherAttached) return;
    worker._orchestrationWatcherAttached = true;
    sm.subscribeSession(worker.localId, function (event) {
      if (!event) return;
      if (event.type === "done") {
        updateTask(parentSession, taskId, { status: "completed" });
      }
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
        var worker = sm.sessions.get(tasks[i].workerSessionId);
        if (!worker) {
          updateTask(parentSession, tasks[i].taskId, { status: "failed" });
          continue;
        }
        if (!worker.isProcessing) {
          updateTask(parentSession, tasks[i].taskId, {
            status: workerHasCompletedTurn(worker) ? "completed" : "failed",
          });
          continue;
        }
        watchWorker(parentSession, tasks[i].taskId, worker);
      }
    });
  }

  function workerPrompt(parentSession, queuedItem) {
    var taskText = queuedItem.text || queuedItem.displayText || "";
    return [
      "You are a bounded worker created by a coordinating Clay session.",
      "Complete only the task below. Follow all project instructions.",
      "Do not broaden product scope or delegate further. If the task conflicts",
      "with other in-flight work or cannot be completed safely in this shared",
      "workspace, stop and explain the conflict instead of overwriting work.",
      "",
      "Parent session: " + (parentSession.title || "Untitled session"),
      "",
      "Task:",
      taskText,
    ].join("\n");
  }

  function startTask(parentSession, queuedItem, owner) {
    if (!parentSession || !queuedItem) return null;
    var taskId = "task-" + crypto.randomUUID();
    var title = meaningfulTextTitle(queuedItem.displayText || queuedItem.text || "", 80) || "Parallel task";
    var sessionOpts = {
      storageId: crypto.randomUUID(),
      vendor: parentSession.vendor || sm.defaultVendor || "claude",
      providerRouteId: parentSession.providerRouteId || null,
      model: parentSession.model || parentSession.requestedModel || null,
      permissionMode: parentSession.permissionMode || null,
      automationMode: parentSession.automationMode || null,
      codexApproval: parentSession.codexApproval || null,
      codexSandbox: parentSession.codexSandbox || null,
      codexWebSearch: parentSession.codexWebSearch || null,
      mode: "gui",
    };
    if (owner && owner.id) sessionOpts.ownerId = owner.id;
    var worker = sm.createSessionRaw(sessionOpts);
    worker.title = title;
    worker.titleManuallySet = true;
    worker.orchestrationParent = {
      taskId: taskId,
      sessionId: parentSession.localId,
    };
    var prompt = workerPrompt(parentSession, queuedItem);
    var userMessage = {
      type: "user_message",
      text: queuedItem.displayText || queuedItem.text || "",
      orchestrationTaskId: taskId,
      _ts: Date.now(),
    };
    if (owner && owner.id) {
      userMessage.from = owner.id;
      userMessage.fromName = owner.displayName || owner.username || "";
    }
    worker.history.push(userMessage);
    sm.appendToSessionFile(worker, userMessage);

    if (!Array.isArray(parentSession.orchestrationTasks)) parentSession.orchestrationTasks = [];
    parentSession.orchestrationTasks.push({
      taskId: taskId,
      title: title,
      status: "running",
      workerSessionId: worker.localId,
      provider: worker.vendor || null,
      model: worker.model || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    sm.saveSessionFile(parentSession);
    sm.saveSessionFile(worker);
    sendState(parentSession);
    sm.broadcastSessionList();

    watchWorker(parentSession, taskId, worker);

    worker.isProcessing = true;
    worker._queryStartTs = Date.now();
    onProcessingChanged();
    try {
      sdk.startQuery(worker, prompt, queuedItem.images || null, ensureProjectAccessForSession(worker));
    } catch (e) {
      worker.isProcessing = false;
      updateTask(parentSession, taskId, { status: "failed" });
    }
    return {
      taskId: taskId,
      workerSessionId: worker.localId,
    };
  }

  restoreWorkers();

  return {
    startTask: startTask,
    sendState: sendState,
    tasksForClient: tasksForClient,
  };
}

module.exports = {
  attachTaskOrchestrator: attachTaskOrchestrator,
};
