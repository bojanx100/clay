var provenance = require("./coop-control-provenance");
var taskGraph = require("./orchestration-task-graph");
var fence = require("./coop-control-fence");

function createDispatchControl(ctx) {
  function controlled(session) {
    return provenance.isCoopControlled(session) || provenance.isCanonicalCoopSession(session);
  }

  function canDispatch(session) {
    if (!controlled(session)) return true;
    // The application supplies its global setting; isolated orchestrators can
    // run without a Lead service. Never infer ownership from a role or title.
    if (ctx.getLeadMode && ctx.getLeadMode() !== true) return false;
    if (ctx.crossProject && ctx.crossProject.canRunCoordinatorUpdate &&
        !ctx.crossProject.canRunCoordinatorUpdate(ctx.slug, session)) return false;
    return fence.isCurrent(session, "provider_start");
  }

  function guardTool(handler) {
    return function (input) {
      var session = ctx.sessionForInput(input);
      var owned = session && input && input.taskId && ctx.coordinatorOwningTask(session, input.taskId);
      if (!canDispatch(session) || owned && !canDispatch(owned.owner)) {
        return ctx.error("Coop orchestration is paused. Enable Lead mode to dispatch new work; " +
          "the owner can still message an existing worker directly.");
      }
      return handler(input);
    };
  }

  // The daemon's existing delivery clock calls this after startup admission.
  // A paused graph needs no browser, new owner message, or new task to resume.
  function resume(session) {
    if (!controlled(session) || session.hidden || session.destroying ||
        ctx.sm.sessions.get(session.localId) !== session) return;
    var tasks = session.orchestrationTasks || [];
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      if (task.externalTaskCoordinator || task.externalAdoptedSession || task.archivedAt ||
          task.status === "dismissed" || task.status === "cancelled") continue;
      var worker = ctx.workerForTask(task);
      if (!worker || worker.isProcessing || worker._queryStarting || worker.hidden ||
          worker.taskStopRequested || worker._orchestrationTaskClosed ||
          worker.restartResumeEligible || worker.restartAutoContinueQueued) continue;
      ctx.followup().dispatchPendingTaskMessage(session, task, worker);
    }
    if (canDispatch(session) && taskGraph.readyTasks(session, (session.orchestrationPolicy || {}).maxParallel || 3).length) {
      ctx.schedule(session);
    }
  }

  return { canDispatch: canDispatch, guardTool: guardTool, resume: resume };
}

module.exports = { createDispatchControl: createDispatchControl };
