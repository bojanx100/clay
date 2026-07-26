function attachCoordinatorDemotion(ctx) {
  function hasActiveTasks(parentSession) {
    var tasks = parentSession && parentSession.orchestrationTasks;
    if (!Array.isArray(tasks)) return false;
    return tasks.some(function (task) {
      var status = task && task.status;
      return status === "queued" || status === "ready" ||
        status === "running" || status === "reviewing";
    });
  }

  function demote(parentSession) {
    if (!parentSession || !parentSession.coordinationMode) return;
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
