var taskGraph = require("./orchestration-task-graph");

function createExternalTaskCoordinator(ctx) {
  return function coordinateExternalTask(input) {
    var resolver = input.promoteCoordinator && ctx.ensureCoordinatorForInput ?
      ctx.ensureCoordinatorForInput : ctx.coordinatorForInput;
    var coordinator = resolver({
      coordinatorSessionId: input.coordinatorSessionId,
    });
    if (!coordinator) {
      return { ok: false, error: "Coordinator session not found or is not a coordinator" };
    }
    var clientRef = input.clientRef ? String(input.clientRef) : "";
    var tasks = Array.isArray(coordinator.orchestrationTasks) ?
      coordinator.orchestrationTasks : [];
    if (clientRef) {
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].clientRef === clientRef) {
          return taskResult(coordinator, tasks[i], true);
        }
      }
    }
    var task = taskGraph.createTask(coordinator, {
      title: input.title,
      objective: input.objective,
      context: input.context,
      acceptanceCriteria: input.acceptanceCriteria,
      ownedPaths: input.ownedPaths,
      imageRefs: input.imageRefs,
      clientRef: clientRef || null,
      provider: input.provider || null,
      model: input.model || null,
    });
    ctx.schedule(coordinator);
    ctx.sm.saveSessionFile(coordinator);
    return taskResult(coordinator, task, false);
  };
}

function taskResult(coordinator, task, skipped) {
  return {
    ok: true,
    skipped: !!skipped,
    coordinatorSessionId: coordinator.storageId || coordinator.localId,
    coordinatorLocalSessionId: coordinator.localId,
    orchestrationTaskId: task.taskId,
    workerSessionId: task.workerSessionId || null,
    workerStorageId: task.workerStorageId || null,
    workerColor: task.workerColor || null,
    title: task.title,
  };
}

module.exports = { createExternalTaskCoordinator: createExternalTaskCoordinator };
