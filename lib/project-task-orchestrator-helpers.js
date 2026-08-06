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

var PREMATURE_ARCHIVE_REASONS = {
  "Recovered terminal task worker": true,
  "Resolved by coordinator": true,
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

function hideArchivedSession(sm, worker) {
  if (!worker || worker.hidden) return false;
  if (typeof sm.hideSessionForActiveClients === "function") {
    sm.hideSessionForActiveClients(worker.localId);
  } else if (typeof sm.hideSession === "function") {
    sm.hideSession(worker.localId);
  } else {
    worker.hidden = true;
    sm.saveSessionFile(worker);
  }
  return true;
}

function detachWorker(sm, worker) {
  if (!worker) return;
  hideArchivedSession(sm, worker);
  worker._orchestrationTaskClosed = true;
  worker.orchestrationDetachedAt = Date.now();
  if (worker._orchestrationUnsubscribe) worker._orchestrationUnsubscribe();
  worker._orchestrationUnsubscribe = null;
  worker._orchestrationWatcherAttached = false;
  sm.saveSessionFile(worker);
}

function archiveTaskWorker(sm, parentSession, task, worker, reason) {
  if (!task || !ARCHIVABLE_TASK_STATUSES[task.status]) return false;
  if (worker && !workerCanArchive(worker, true)) return false;
  var changed = false;
  if (!task.archivedAt) {
    task.archivedAt = Date.now();
    taskGraph.appendEvent(parentSession, "task_worker_archived", task, {
      reason: reason || "Terminal task worker archived",
    });
    changed = true;
  }
  if (worker && hideArchivedSession(sm, worker)) changed = true;
  if (changed) {
    sm.saveSessionFile(parentSession);
    if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
  }
  return changed;
}

function latestTaskArchiveReason(parentSession, task) {
  var events = parentSession && parentSession.orchestrationEvents;
  if (!Array.isArray(events) || !task) return "";
  for (var i = events.length - 1; i >= 0; i--) {
    var event = events[i];
    if (!event || event.type !== "task_worker_archived" || event.taskId !== task.taskId) continue;
    return String(event.data && event.data.reason || "");
  }
  return "";
}

function restorePrematureArchive(sm, parentSession, task, worker) {
  if (!parentSession || parentSession.hidden || !parentSession.coordinationMode ||
      !task || !task.archivedAt || !ARCHIVABLE_TASK_STATUSES[task.status] || !worker ||
      !PREMATURE_ARCHIVE_REASONS[latestTaskArchiveReason(parentSession, task)]) return false;
  delete task.archivedAt;
  delete worker.hidden;
  taskGraph.appendEvent(parentSession, "task_worker_restored", task, {
    reason: "Resolved workers remain available from the coordinator sidebar",
  });
  sm.saveSessionFile(worker);
  sm.saveSessionFile(parentSession);
  return true;
}

function safeOrphanWorker(worker) {
  return !!(worker && workerHasCompletedTurn(worker) && workerCanArchive(worker) &&
    !worker.queryInstance && (!Array.isArray(worker.pendingCoordinatorMessages) ||
      worker.pendingCoordinatorMessages.length === 0));
}

function workerStatus(worker) {
  var parent = worker && worker.orchestrationParent || {};
  var explicit = worker && (worker.workerStatus || worker.taskStatus);
  if (explicit) return String(explicit).trim().toLowerCase();
  if (parent.taskStatus) return String(parent.taskStatus).trim().toLowerCase();
  var history = worker && worker.history;
  if (!Array.isArray(history)) return "";
  for (var i = history.length - 1; i >= 0; i--) {
    var text = history[i] && history[i].text;
    var match = String(text || "").match(/(?:^|\n)WORKER_STATUS:\s*([a-z_]+)/i);
    if (match) return match[1].trim().toLowerCase();
  }
  return "";
}

function workerCanArchive(worker, canonicalTerminal) {
  return !!(worker && !worker.isProcessing && !worker.restartResumeEligible &&
    !worker.interruptedByRestart &&
    (canonicalTerminal || !NON_ARCHIVABLE_WORKER_STATUSES[workerStatus(worker)]));
}

function reconcileWorkerSessions(sm, slug, sessionByStorageId) {
  if (slug === "lead" || !sm.sessions || typeof sm.sessions.forEach !== "function") return;
  var workers = [];
  sm.sessions.forEach(function (session) {
    if (session && session.orchestrationParent) workers.push(session);
  });
  var restored = false;
  for (var i = 0; i < workers.length; i++) {
    var worker = workers[i];
    var owner = worker.orchestrationParent || {};
    var parent = sessionByStorageId(owner.sessionStorageId);
    if (!parent && Number.isFinite(Number(owner.sessionId))) parent = sm.sessions.get(Number(owner.sessionId));
    var task = parent && taskGraph.findTask(parent, String(owner.taskId || ""));
    if (task) {
      if (restorePrematureArchive(sm, parent, task, worker)) {
        restored = true;
      } else if (!worker.hidden && (parent.hidden || task.archivedAt)) {
        archiveTaskWorker(sm, parent, task, worker, "Recovered archived task worker");
      }
    } else if ((!parent || parent.hidden) && safeOrphanWorker(worker)) {
      hideArchivedSession(sm, worker);
    }
  }
  if (restored && typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
}

module.exports = {
  announceWorkerStarted: announceWorkerStarted,
  archiveTaskWorker: archiveTaskWorker,
  detachWorker: detachWorker,
  reconcileWorkerSessions: reconcileWorkerSessions,
  structuredField: structuredField,
  workerHasCompletedTurn: workerHasCompletedTurn,
};
