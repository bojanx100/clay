var deriveControlledBy = require("./coop-control-provenance").deriveControlledBy;
var shouldSuppressOwnerNotification =
  require("./coop-control-provenance").shouldSuppressOwnerNotification;
var buildFanInEvent = require("./coop-fanin-events").buildFanInEvent;
var attachCoopFanIn = require("./coop-fanin-delivery").attachCoopFanIn;
var attachCoopWatchdog = require("./coop-watchdog-runtime").attachCoopWatchdog;

function attachTaskOrchestratorCoop(ctx) {
  var sm = ctx.sm;
  var usersModule = ctx.usersModule;
  var queueCoordinatorUpdate = ctx.queueCoordinatorUpdate;
  var workerForTask = ctx.workerForTask;
  var now = ctx.now || Date.now;
  var coopFanIn = attachCoopFanIn({
    sm: sm,
    usersModule: usersModule,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    now: now,
  });
  var coopWatchdog = attachCoopWatchdog({
    sm: sm,
    usersModule: usersModule,
    fanInDelivery: coopFanIn,
    now: now,
  });

  function sanitizedTaskUpdates(updates) {
    var input = updates || {};
    var clean = {};
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].charAt(0) === "_") continue;
      clean[keys[i]] = input[keys[i]];
    }
    return clean;
  }

  function latestTaskTransitionAt(parentSession, task) {
    var events = parentSession && Array.isArray(parentSession.orchestrationEvents)
      ? parentSession.orchestrationEvents : [];
    for (var i = events.length - 1; i >= 0; i--) {
      var event = events[i];
      if (!event || event.type !== "task_status_changed" || event.taskId !== task.taskId) continue;
      if (event.data && event.data.to === task.status) return event.at;
    }
    return task && task.updatedAt || now();
  }

  function shouldFanInStatus(previousStatus, nextStatus) {
    var active = previousStatus === "queued" || previousStatus === "ready" || previousStatus === "running";
    if (!active) return false;
    return nextStatus === "completed" || nextStatus === "failed" || nextStatus === "dismissed" ||
      nextStatus === "cancelled" || nextStatus === "reviewing" || nextStatus === "blocked" ||
      nextStatus === "needs_input" || nextStatus === "waiting_user";
  }

  function maybeDeliverTaskTransition(parentSession, task, previousStatus, options) {
    var opts = options || {};
    if (!task || !shouldFanInStatus(previousStatus, task.status) || opts.skipFanIn) return;
    var worker = workerForTask(task);
    if (!worker || !shouldSuppressOwnerNotification(worker, usersModule)) return;
    var event = buildFanInEvent(worker, task, {
      from: previousStatus,
      status: task.status,
      occurredAt: latestTaskTransitionAt(parentSession, task),
      summary: task.resultSummary || task.resolutionSummary || task.currentActivity || "",
    });
    if (event) coopFanIn.deliverEvent(event);
  }

  function applyWorkerControl(parentSession, worker) {
    var controlledBy = deriveControlledBy(parentSession, now());
    if (controlledBy) worker.coopControlledBy = controlledBy;
  }

  function refreshWatchdog() {
    coopWatchdog.refresh();
  }

  function stopWatchdog() {
    coopWatchdog.stop();
  }

  return {
    applyWorkerControl: applyWorkerControl,
    maybeDeliverTaskTransition: maybeDeliverTaskTransition,
    refreshWatchdog: refreshWatchdog,
    sanitizedTaskUpdates: sanitizedTaskUpdates,
    stopWatchdog: stopWatchdog,
  };
}

module.exports = {
  attachTaskOrchestratorCoop: attachTaskOrchestratorCoop,
};
