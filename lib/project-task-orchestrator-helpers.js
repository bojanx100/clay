var taskGraph = require("./orchestration-task-graph");

var ARCHIVABLE_TASK_STATUSES = {
  completed: true,
  dismissed: true,
  cancelled: true,
};

var NON_ARCHIVABLE_WORKER_STATUSES = {
  failed: true,
  interrupted: true,
  blocked: true,
  reviewing: true,
  needs_input: true,
  waiting_user: true,
};

function announceWorkerStarted(parentSession, task, worker, sm, sendToSession) {
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

function structuredField(text, name) {
  var match = String(text || "").match(new RegExp("(?:^|\\n)" + name + ":\\s*([^\\n]+)", "i"));
  return match ? match[1].trim() : "";
}

function workerHasCompletedTurn(worker) {
  var history = worker && worker.history;
  if (!Array.isArray(history)) return false;
  for (var i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].type === "done") return true;
  }
  return false;
}

function detachWorker(sm, worker) {
  if (!worker) return;
  if (typeof sm.hideSession === "function") sm.hideSession(worker.localId);
  else worker.hidden = true;
  worker._orchestrationTaskClosed = true;
  worker.orchestrationParent = null;
  if (worker._orchestrationUnsubscribe) worker._orchestrationUnsubscribe();
  worker._orchestrationUnsubscribe = null;
  worker._orchestrationWatcherAttached = false;
  sm.saveSessionFile(worker);
}

function archiveTaskWorker(sm, parentSession, task, worker, reason) {
  if (!task || !ARCHIVABLE_TASK_STATUSES[task.status]) return false;
  if (worker && !workerCanArchive(worker)) return false;
  var changed = false;
  if (!task.archivedAt) {
    task.archivedAt = Date.now();
    taskGraph.appendEvent(parentSession, "task_worker_archived", task, {
      reason: reason || "Terminal task worker archived",
    });
    changed = true;
  }
  if (worker && !worker.hidden && typeof sm.hideSession === "function") {
    sm.hideSession(worker.localId);
    changed = true;
  }
  if (changed) {
    sm.saveSessionFile(parentSession);
    if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
  }
  return changed;
}

function safeOrphanWorker(worker) {
  return !!(worker && Array.isArray(worker.history) && worker.history.length > 0 &&
    workerCanArchive(worker) &&
    !worker.queryInstance && (!Array.isArray(worker.pendingCoordinatorMessages) ||
      worker.pendingCoordinatorMessages.length === 0));
}

function workerStatus(worker) {
  var parent = worker && worker.orchestrationParent || {};
  return String(worker && (worker.workerStatus || worker.taskStatus || worker.status) ||
    parent.taskStatus || "").trim().toLowerCase();
}

function workerCanArchive(worker) {
  return !!(worker && !worker.isProcessing && !worker.restartResumeEligible &&
    !worker.interruptedByRestart &&
    !NON_ARCHIVABLE_WORKER_STATUSES[workerStatus(worker)]);
}

function reconcileWorkerSessions(sm, slug, sessionByStorageId) {
  if (slug === "lead" || !sm.sessions || typeof sm.sessions.forEach !== "function") return;
  var workers = [];
  sm.sessions.forEach(function (session) {
    if (session && session.orchestrationParent && !session.hidden) workers.push(session);
  });
  for (var i = 0; i < workers.length; i++) {
    var worker = workers[i];
    var owner = worker.orchestrationParent || {};
    var parent = sessionByStorageId(owner.sessionStorageId);
    if (!parent && Number.isFinite(Number(owner.sessionId))) parent = sm.sessions.get(Number(owner.sessionId));
    var task = parent && taskGraph.findTask(parent, String(owner.taskId || ""));
    if (task) {
      archiveTaskWorker(sm, parent, task, worker, "Recovered terminal task worker");
    } else if ((!parent || parent.hidden) && safeOrphanWorker(worker) &&
        typeof sm.hideSession === "function") {
      sm.hideSession(worker.localId);
    }
  }
}

module.exports = {
  announceWorkerStarted: announceWorkerStarted,
  archiveTaskWorker: archiveTaskWorker,
  detachWorker: detachWorker,
  reconcileWorkerSessions: reconcileWorkerSessions,
  structuredField: structuredField,
  workerHasCompletedTurn: workerHasCompletedTurn,
};
