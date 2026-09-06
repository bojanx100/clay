var deriveControlledBy = require("./coop-control-provenance").deriveControlledBy;
var shouldSuppressOwnerNotification =
  require("./coop-control-provenance").shouldSuppressOwnerNotification;
var buildFanInEvent = require("./coop-fanin-events").buildFanInEvent;
var attachCoopFanIn = require("./coop-fanin-delivery").attachCoopFanIn;
var attachCoopWatchdog = require("./coop-watchdog-runtime").attachCoopWatchdog;
var readOnlyExecution = require("./read-only-execution");

function attachTaskOrchestratorCoop(ctx) {
  var sm = ctx.sm;
  var slug = ctx.slug || null;
  var crossProject = ctx.crossProject || null;
  var usersModule = ctx.usersModule;
  var queueCoordinatorUpdate = ctx.queueCoordinatorUpdate;
  var workerForTask = ctx.workerForTask;
  var now = ctx.now || Date.now;
  var coopFanIn = attachCoopFanIn({
    sm: sm,
    slug: slug,
    crossProject: crossProject,
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

  // Attempt an immediate replay of anything already sitting in the outbox
  // (e.g. left over from before a daemon restart) as soon as this project
  // attaches, rather than waiting for the first 60s watchdog tick.
  // Delivery must be immediate when possible; the watchdog tick below is
  // strictly the fallback for what immediate delivery could not resolve.
  if (typeof coopFanIn.retryPending === "function") coopFanIn.retryPending();

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
    readOnlyExecution.inherit(parentSession, worker, sm);
    var controlledBy = deriveControlledBy(parentSession, now());
    if (controlledBy) worker.coopControlledBy = controlledBy;
  }

  function refreshWatchdog() {
    coopWatchdog.refresh();
  }

  function stopWatchdog() {
    coopWatchdog.stop();
  }

  // On attach (project boot, including after a daemon restart), the
  // session manager has already loaded any persisted controlled sessions
  // and orchestration state, and the fan-in outbox has already loaded any
  // pending (undelivered) events from disk. Without this, the watchdog
  // would only ever start from a *live* task-transition event, so a
  // restart with pending controlled work or a pending cross-project
  // delivery would sit idle until unrelated new activity happened to
  // trigger refreshWatchdog() -- defeating the "replayable after
  // restart/reconnect" requirement for missed/pending events.
  refreshWatchdog();

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
