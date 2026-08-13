var taskGraph = require("./orchestration-task-graph");

function attachCoordinatorDemotion(ctx) {
  function hasActiveTasks(parentSession) {
    return taskGraph.graphResolutionState(parentSession).metrics.unresolved > 0;
  }

  function demote(parentSession) {
    if (!parentSession || !parentSession.coordinationMode) return;
    if (parentSession.coordinationRole === "project_coordinator") return;
    parentSession.coordinationMode = false;
    parentSession.demoteCoordinatorWhenIdle = false;
    ctx.sm.saveSessionFile(parentSession);
    ctx.sm.broadcastSessionList();
    ctx.sendToSession(parentSession.localId, {
      type: "coordinator_status",
      coordinationMode: false,
      demotionPending: false,
    });
  }

  function completePending(parentSession) {
    if (!parentSession || !parentSession.demoteCoordinatorWhenIdle ||
        hasActiveTasks(parentSession)) return;
    demote(parentSession);
  }

  return {
    completePending: completePending,
    demote: demote,
  };
}

module.exports = {
  attachCoordinatorDemotion: attachCoordinatorDemotion,
};
