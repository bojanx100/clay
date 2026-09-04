var findMissedTransitions = require("./coop-watchdog-policy").findMissedTransitions;
var shouldSuppressOwnerNotification =
  require("./coop-control-provenance").shouldSuppressOwnerNotification;

var ACTIVE_STATUSES = {
  queued: true,
  ready: true,
  running: true,
};

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

function attachCoopWatchdog(ctx) {
  var sm = ctx.sm;
  var usersModule = ctx.usersModule;
  var fanInDelivery = ctx.fanInDelivery;
  var now = ctx.now || Date.now;
  var setIntervalFn = ctx.setInterval || setInterval;
  var clearIntervalFn = ctx.clearInterval || clearInterval;
  var intervalMs = ctx.intervalMs || 60000;
  var timerId = null;

  function storageIdForSession(session) {
    return session && (session.storageId || session.cliSessionId) || null;
  }

  function sessionByStorageId(storageId) {
    if (!storageId || !sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
    var found = null;
    sm.sessions.forEach(function (session) {
      if (!found && storageIdForSession(session) === storageId) found = session;
    });
    return found;
  }

  function taskForWorker(session) {
    var owner = session && session.orchestrationParent;
    if (!owner) return null;
    var parent = sessionByStorageId(owner.sessionStorageId) ||
      (sm.sessions && sm.sessions.get ? sm.sessions.get(owner.sessionId) : null);
    if (!parent || !Array.isArray(parent.orchestrationTasks)) return null;
    for (var i = 0; i < parent.orchestrationTasks.length; i++) {
      var task = parent.orchestrationTasks[i];
      if (!task || task.taskId !== owner.taskId) continue;
      return Object.assign({}, task, {
        workerSessionId: task.workerSessionId,
        workerStorageId: task.workerStorageId,
        statusTransitionAt: latestTransitionAt(parent, task),
      });
    }
    return null;
  }

  function latestTransitionAt(parent, task) {
    var events = parent && Array.isArray(parent.orchestrationEvents) ? parent.orchestrationEvents : [];
    for (var i = events.length - 1; i >= 0; i--) {
      var event = events[i];
      if (!event || event.type !== "task_status_changed" || event.taskId !== task.taskId) continue;
      if (event.data && event.data.to === task.status) return event.at;
    }
    return task && task.updatedAt || now();
  }

  function buildSnapshot() {
    var sessions = [];
    var tasks = [];
    if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") {
      return { sessions: sessions, tasks: tasks, deliveredEventIds: [] };
    }
    sm.sessions.forEach(function (session) {
      if (!shouldSuppressOwnerNotification(session, usersModule)) return;
      if (!session.orchestrationParent) return;
      sessions.push(session);
      var task = taskForWorker(session);
      if (task) tasks.push(task);
    });
    return {
      sessions: sessions,
      tasks: tasks,
      deliveredEventIds: fanInDelivery.getDeliveredEventIds(),
    };
  }

  // Whether one task belonging to `session`'s orchestration owner still
  // counts as active/missed work: either genuinely in-flight, or in a
  // watched terminal/attention status with a still-undelivered fan-in
  // event for it.
  function taskIsOutstanding(task, session, owner, deliveredIds) {
    if (!task || task.taskId !== owner.taskId) return false;
    if (ACTIVE_STATUSES[task.status]) return true;
    if (!WATCH_STATUSES[task.status]) return false;
    var missed = findMissedTransitions({
      sessions: [session],
      tasks: [task],
      deliveredEventIds: [],
    }, { now: now() })[0];
    return !!(missed && !deliveredIds[missed.eventId]);
  }

  function sessionHasOutstandingWork(session, tasks, deliveredIds) {
    var owner = session && session.orchestrationParent;
    if (!owner) return false;
    for (var ti = 0; ti < tasks.length; ti++) {
      if (taskIsOutstanding(tasks[ti], session, owner, deliveredIds)) return true;
    }
    return false;
  }

  function hasActiveControlledWork(snapshot) {
    if (fanInDelivery.hasPendingWork && fanInDelivery.hasPendingWork()) return true;
    var sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
    var tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : [];
    var delivered = Array.isArray(snapshot && snapshot.deliveredEventIds)
      ? snapshot.deliveredEventIds : [];
    var deliveredIds = {};
    for (var i = 0; i < delivered.length; i++) deliveredIds[String(delivered[i] || "")] = true;
    for (var si = 0; si < sessions.length; si++) {
      if (sessionHasOutstandingWork(sessions[si], tasks, deliveredIds)) return true;
    }
    return false;
  }

  function start() {
    if (timerId) return;
    timerId = setIntervalFn(function () {
      tick();
    }, intervalMs);
    if (timerId && typeof timerId.unref === "function") timerId.unref();
  }

  function stop() {
    if (!timerId) return;
    clearIntervalFn(timerId);
    timerId = null;
  }

  function tick() {
    if (typeof fanInDelivery.retryPending === "function") fanInDelivery.retryPending();
    var snapshot = buildSnapshot();
    if (!hasActiveControlledWork(snapshot)) {
      stop();
      return [];
    }
    var events = findMissedTransitions(snapshot, { now: now() });
    for (var i = 0; i < events.length; i++) fanInDelivery.deliverEvent(events[i]);
    if (!hasActiveControlledWork(buildSnapshot())) stop();
    return events;
  }

  function refresh() {
    var snapshot = buildSnapshot();
    if (hasActiveControlledWork(snapshot)) start();
    else stop();
    return snapshot;
  }

  return {
    isRunning: function () { return !!timerId; },
    refresh: refresh,
    stop: stop,
    tick: tick,
  };
}

module.exports = {
  attachCoopWatchdog: attachCoopWatchdog,
};
