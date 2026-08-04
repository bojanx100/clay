var taskGraph = require("./orchestration-task-graph");
var taskState = require("./orchestration-task-state");

function closeOrchestrationTask(ctx, parentSession, taskId, targetWs, options) {
  var sm = ctx.sm;
  var opts = options || {};
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
  var reason = String(opts.reason || "Dismissed by user").trim() || "Dismissed by user";
  if (task.status !== "completed" && task.status !== "dismissed" && task.status !== "cancelled") {
    taskGraph.transition(parentSession, task, "dismissed", {
      currentActivity: reason,
      resolutionReason: reason,
      resolutionSummary: reason,
      resolvedAt: Date.now(),
      userQuestion: "",
      waitingReason: "",
    });
  } else {
    taskGraph.appendEvent(parentSession, "task_worker_archived", task, { reason: reason });
  }
  task.archivedAt = Date.now();
  sm.saveSessionFile(parentSession);
  ctx.sendToSession(parentSession.localId, {
    type: "orchestration_tasks_state",
    tasks: taskState.orchestrationTasksForClient(parentSession),
    state: taskState.orchestrationStateForClient(parentSession),
  });
  if (worker) sm.hideSession(worker.localId, targetWs);
  sm.broadcastSessionList();
  return true;
}

module.exports = {
  closeOrchestrationTask: closeOrchestrationTask,
};
