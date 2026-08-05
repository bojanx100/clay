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

function indexDeliveredIds(list) {
  var index = {};
  for (var i = 0; i < list.length; i++) {
    index[String(list[i] || "")] = true;
  }
  return index;
}

// Resolves a single missed transition event for one controlled session, or
// null if the session isn't controlled, has no matching watched-status
// task, or fails to build a valid event. Pulled out of the main scan loop
// so each condition contributes to a much smaller function's complexity.
function missedTransitionForSession(session, tasks, now) {
  if (!isCoopControlled(session)) return null;
  var task = matchingTask(tasks, session);
  if (!task || !WATCH_STATUSES[task.status]) return null;
  return buildFanInEvent(session, task, {
    status: task.status,
    occurredAt: task.statusTransitionAt,
    summary: task.resultSummary || task.resolutionSummary || task.currentActivity || "",
  }, { now: now });
}

function findMissedTransitions(snapshot, options) {
  var opts = options || {};
  if (!finiteNumber(opts.now)) {
    throw new TypeError("Coop watchdog requires an injected finite now value");
  }
  var sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  var tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : [];
  var deliveredIds = indexDeliveredIds(
    Array.isArray(snapshot && snapshot.deliveredEventIds) ? snapshot.deliveredEventIds : []);
  var seen = {};
  var events = [];
  for (var i = 0; i < sessions.length; i++) {
    var event = missedTransitionForSession(sessions[i], tasks, opts.now);
    if (!event || deliveredIds[event.eventId] || seen[event.eventId]) continue;
    seen[event.eventId] = true;
    events.push(event);
  }
  return events;
}

module.exports = {
  findMissedTransitions: findMissedTransitions,
};
