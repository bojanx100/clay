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

module.exports = {
  announceWorkerStarted: announceWorkerStarted,
  structuredField: structuredField,
  workerHasCompletedTurn: workerHasCompletedTurn,
};
