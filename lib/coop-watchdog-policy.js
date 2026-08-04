var buildFanInEvent = require("./coop-fanin-events").buildFanInEvent;
var isCoopControlled = require("./coop-control-provenance").isCoopControlled;

var WATCH_STATUSES = {
  completed: true,
  failed: true,
  dismissed: true,
  cancelled: true,
  reviewing: true,
  blocked: true,
  needs_input: true,
  waiting_user: true,
};

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function sessionStorageId(session) {
  return session && (session.storageId || session.cliSessionId) || null;
}

function valueKey(value) {
  if (value == null || value === "") return "";
  return typeof value + ":" + String(value);
}

function taskMatchesSession(task, session) {
  if (!task || !session) return false;
  var localId = session.localId != null ? session.localId : null;
  var storageId = sessionStorageId(session);
  if (task.taskId && session.orchestrationParent && task.taskId === session.orchestrationParent.taskId) {
    return true;
  }
  if (task.workerSessionId != null && task.workerSessionId === localId) return true;
  if (task.workerStorageId && task.workerStorageId === storageId) return true;
  return false;
}

function matchingTask(tasks, session) {
  for (var i = 0; i < tasks.length; i++) {
    if (taskMatchesSession(tasks[i], session)) return tasks[i];
  }
  return null;
}

function findMissedTransitions(snapshot, options) {
  var opts = options || {};
  if (!finiteNumber(opts.now)) {
    throw new TypeError("Coop watchdog requires an injected finite now value");
  }
  var sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  var tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : [];
  var deliveredIds = {};
  var deliveredList = Array.isArray(snapshot && snapshot.deliveredEventIds)
    ? snapshot.deliveredEventIds : [];
  for (var di = 0; di < deliveredList.length; di++) {
    deliveredIds[String(deliveredList[di] || "")] = true;
  }
  var seen = {};
  var events = [];
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    if (!isCoopControlled(session)) continue;
    var task = matchingTask(tasks, session);
    if (!task || !WATCH_STATUSES[task.status]) continue;
    var event = buildFanInEvent(session, task, {
      status: task.status,
      occurredAt: task.statusTransitionAt,
      summary: task.resultSummary || task.resolutionSummary || task.currentActivity || "",
    }, { now: opts.now });
    if (!event || deliveredIds[event.eventId] || seen[event.eventId]) continue;
    seen[event.eventId] = true;
    events.push(event);
  }
  return events;
}

module.exports = {
  findMissedTransitions: findMissedTransitions,
};
