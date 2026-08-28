var taskGraph = require("./orchestration-task-graph");
var taskState = require("./orchestration-task-state");
var decisionStaging = require("./coop-owner-decision-staging");

function workerForTask(sm, task) {
  var worker = null;
  if (task && task.workerStorageId && sm.sessions && typeof sm.sessions.forEach === "function") {
    sm.sessions.forEach(function (session) {
      var storageId = session && (session.storageId || session.cliSessionId);
      if (!worker && storageId === task.workerStorageId) worker = session;
    });
  }
  if (worker) return worker;
  if (!task || task.workerSessionId == null) return null;
  var localId = Number(task.workerSessionId);
  return Number.isFinite(localId) ? sm.sessions.get(localId) : null;
}

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
  var worker = workerForTask(sm, task);
  if (worker && worker.orchestrationParent &&
      worker.orchestrationParent.taskId === taskId) {
    worker._orchestrationTaskClosed = true;
    if (worker._orchestrationUnsubscribe) worker._orchestrationUnsubscribe();
    worker._orchestrationUnsubscribe = null;
    worker._orchestrationWatcherAttached = false;
    worker.taskStopRequested = true;
    if (worker.abortController) worker.abortController.abort();
    worker.orchestrationDetachedAt = Date.now();
  }
  var reason = String(opts.reason || "Dismissed by user").trim() || "Dismissed by user";
  if (task.status !== "completed" && task.status !== "dismissed" && task.status !== "cancelled") {
    var decision = decisionStaging.validDecision(task.ownerDecision);
    var withdrawal = decision && decision.state === "unanswered"
      ? decisionStaging.withdrawalUpdates(decision, reason) : null;
    taskGraph.transition(parentSession, task, "dismissed", {
      currentActivity: withdrawal ? withdrawal.currentActivity : reason,
      resolutionReason: withdrawal ? withdrawal.resolutionReason : reason,
      resolutionSummary: withdrawal ? withdrawal.resolutionSummary : reason,
      resolvedAt: withdrawal ? withdrawal.resolvedAt : Date.now(),
      userQuestion: withdrawal ? withdrawal.userQuestion : "",
      waitingReason: withdrawal ? withdrawal.waitingReason : "",
      ownerDecision: withdrawal ? withdrawal.ownerDecision : task.ownerDecision,
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
