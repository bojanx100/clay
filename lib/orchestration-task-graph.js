var crypto = require("crypto");

var TERMINAL_STATUSES = {
  completed: true,
  failed: true,
  cancelled: true,
};

function ensureGraph(session) {
  if (!Array.isArray(session.orchestrationTasks)) session.orchestrationTasks = [];
  if (!Array.isArray(session.orchestrationEvents)) session.orchestrationEvents = [];
  if (!session.orchestrationGraphId) session.orchestrationGraphId = "graph-" + crypto.randomUUID();
  return session.orchestrationTasks;
}

function appendEvent(session, type, task, data) {
  ensureGraph(session);
  var event = {
    eventId: "event-" + crypto.randomUUID(),
    graphId: session.orchestrationGraphId,
    taskId: task && task.taskId || null,
    type: type,
    at: Date.now(),
    data: data || {},
  };
  session.orchestrationEvents.push(event);
  return event;
}

function findTask(session, taskId) {
  var tasks = ensureGraph(session);
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].taskId === taskId) return tasks[i];
  }
  return null;
}

function normalizeDependencies(value) {
  if (!Array.isArray(value)) return [];
  var result = [];
  for (var i = 0; i < value.length; i++) {
    var id = String(value[i] || "").trim();
    if (id && result.indexOf(id) === -1) result.push(id);
  }
  return result;
}

function createTask(session, input) {
  ensureGraph(session);
  var now = Date.now();
  var task = {
    taskId: input.taskId || "task-" + crypto.randomUUID(),
    clientRef: input.clientRef || null,
    parentTaskId: input.parentTaskId || null,
    title: input.title,
    objective: input.objective,
    context: input.context || "",
    acceptanceCriteria: input.acceptanceCriteria || "",
    ownedPaths: input.ownedPaths || "",
    dependencies: normalizeDependencies(input.dependencies),
    status: "queued",
    currentActivity: "Waiting for scheduler",
    provider: input.provider || null,
    model: input.model || null,
    providerRouteId: input.providerRouteId || null,
    providerPinned: !!input.providerPinned,
    modelPinned: !!input.modelPinned,
    difficulty: input.difficulty || null,
    attempt: 0,
    maxAttempts: Math.max(1, Number(input.maxAttempts) || 1),
    createdAt: now,
    updatedAt: now,
  };
  session.orchestrationTasks.push(task);
  appendEvent(session, "task_created", task, {
    dependencies: task.dependencies,
    parentTaskId: task.parentTaskId,
  });
  return task;
}

function dependencyState(session, task) {
  var waiting = [];
  var failed = [];
  for (var i = 0; i < task.dependencies.length; i++) {
    var dependency = findTask(session, task.dependencies[i]);
    if (!dependency || dependency.status === "failed" || dependency.status === "cancelled") {
      failed.push(task.dependencies[i]);
    } else if (dependency.status !== "completed") {
      waiting.push(task.dependencies[i]);
    }
  }
  return { waiting: waiting, failed: failed };
}

function refreshReadiness(session) {
  var tasks = ensureGraph(session);
  var changed = [];
  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i];
    if (TERMINAL_STATUSES[task.status] || task.status === "running" ||
        task.status === "needs_input" || task.status === "reviewing") continue;
    var state = dependencyState(session, task);
    var next = state.failed.length ? "blocked" : (state.waiting.length ? "queued" : "ready");
    var activity = state.failed.length
      ? "Blocked by failed dependency"
      : (state.waiting.length ? "Waiting for " + state.waiting.length + " task(s)" : "Ready to start");
    if (task.status !== next || task.currentActivity !== activity) {
      task.status = next;
      task.currentActivity = activity;
      task.updatedAt = Date.now();
      appendEvent(session, "task_readiness_changed", task, {
        status: next,
        waiting: state.waiting,
        failed: state.failed,
      });
      changed.push(task);
    }
  }
  return changed;
}

function runningCount(session) {
  var tasks = ensureGraph(session);
  var count = 0;
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].status === "running") count++;
  }
  return count;
}

function readyTasks(session, maxParallel) {
  refreshReadiness(session);
  var slots = Math.max(0, (Number(maxParallel) || 3) - runningCount(session));
  var result = [];
  var tasks = ensureGraph(session);
  var occupied = {};
  for (var j = 0; j < tasks.length; j++) {
    if (tasks[j].status === "running") occupied[ownershipKey(tasks[j])] = true;
  }
  for (var i = 0; i < tasks.length && result.length < slots; i++) {
    var key = ownershipKey(tasks[i]);
    if (tasks[i].status === "ready" && (!key || !occupied[key])) {
      result.push(tasks[i]);
      if (key) occupied[key] = true;
    }
  }
  return result;
}

function ownershipKey(task) {
  var value = String(task && task.ownedPaths || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!value || value.indexOf("read-only") !== -1) return "";
  return value;
}

function transition(session, task, status, data) {
  var previous = task.status;
  task.status = status;
  task.updatedAt = Date.now();
  if (data) Object.assign(task, data);
  appendEvent(session, "task_status_changed", task, {
    from: previous,
    to: status,
    activity: task.currentActivity || "",
  });
  return task;
}

function retryTask(session, task) {
  task.workerSessionId = null;
  task.workerStorageId = null;
  task.resultSummary = "";
  task.verification = "";
  transition(session, task, "queued", { currentActivity: "Queued for retry" });
  appendEvent(session, "task_retry_requested", task, { nextAttempt: task.attempt + 1 });
  return task;
}

module.exports = {
  appendEvent: appendEvent,
  createTask: createTask,
  ensureGraph: ensureGraph,
  findTask: findTask,
  readyTasks: readyTasks,
  refreshReadiness: refreshReadiness,
  retryTask: retryTask,
  transition: transition,
};
