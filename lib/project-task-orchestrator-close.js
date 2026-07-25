var orchestrationTasksForClient = require("./orchestration-task-state").orchestrationTasksForClient;

function closeOrchestrationTask(ctx, parentSession, taskId, targetWs) {
  var sm = ctx.sm;
  var tasks = parentSession && parentSession.orchestrationTasks;
  if (!Array.isArray(tasks) || !taskId) return false;
  var taskIndex = -1;
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].taskId === taskId) {
      taskIndex = i;
      break;
    }
  }
  if (taskIndex === -1) return false;
  var task = tasks[taskIndex];
  var worker = sm.sessions.get(task.workerSessionId);
  if (worker && worker.orchestrationParent &&
      worker.orchestrationParent.taskId === taskId) {
    worker._orchestrationTaskClosed = true;
    if (worker._orchestrationUnsubscribe) worker._orchestrationUnsubscribe();
    worker._orchestrationUnsubscribe = null;
    worker._orchestrationWatcherAttached = false;
    worker.taskStopRequested = true;
    if (worker.abortController) worker.abortController.abort();
  }
  tasks.splice(taskIndex, 1);
  sm.saveSessionFile(parentSession);
  ctx.sendToSession(parentSession.localId, {
    type: "orchestration_tasks_state",
    tasks: orchestrationTasksForClient(parentSession),
  });
  if (worker) sm.hideSession(worker.localId, targetWs);
  return true;
}

module.exports = {
  closeOrchestrationTask: closeOrchestrationTask,
};
