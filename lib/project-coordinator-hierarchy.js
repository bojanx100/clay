// Durable project execution hierarchy.
//
// A ProjectRef owns one reusable project coordinator. Portfolio work runs in
// child task coordinators so a finished or archived task cannot retire the
// durable project root or block later and concurrent work.
var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var taskGraph = require("./orchestration-task-graph");

var PROJECT_COORDINATOR = "project_coordinator";
var TASK_COORDINATOR = "task_coordinator";

function storageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}

function taskCoordinatorRef(child) {
  var rootRef = projectIdentity.normalizeSessionRef(child && child.projectCoordinatorRef);
  if (!rootRef || !storageId(child)) return null;
  return {
    projectId: rootRef.projectId,
    sessionStorageId: storageId(child),
  };
}

function sessionByRef(sm, ref, projectId) {
  var normalized = projectIdentity.normalizeSessionRef(ref);
  if (!normalized || normalized.projectId !== projectId) return null;
  var found = null;
  sm.sessions.forEach(function (session) {
    if (!found && storageId(session) === normalized.sessionStorageId) found = session;
  });
  return found;
}

function projectCoordinatorCandidate(session) {
  if (!session || session._deleted || session.orchestrationParent) return false;
  if (session.coordinationRole === PROJECT_COORDINATOR) return true;
  var execution = session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
  return !!(session.coordinationMode && execution && execution.mode === PROJECT_COORDINATOR);
}

function findProjectCoordinator(sm, projectId, preferredRef) {
  var preferred = sessionByRef(sm, preferredRef, projectId);
  if (preferred && !preferred._deleted && preferred.coordinationMode &&
      !preferred.orchestrationParent) return preferred;
  var marked = null;
  var legacy = null;
  sm.sessions.forEach(function (session) {
    if (!projectCoordinatorCandidate(session)) return;
    if (!marked && session.coordinationRole === PROJECT_COORDINATOR) marked = session;
    if (!legacy) legacy = session;
  });
  return marked || legacy;
}

function reactivateProjectCoordinator(sm, session) {
  var changed = false;
  if (session.hidden) { session.hidden = false; changed = true; }
  if (session.closedAt) { session.closedAt = null; changed = true; }
  if (!session.coordinationMode) { session.coordinationMode = true; changed = true; }
  if (session.coordinationRole !== PROJECT_COORDINATOR) {
    session.coordinationRole = PROJECT_COORDINATOR;
    changed = true;
  }
  if (session.demoteCoordinatorWhenIdle) {
    session.demoteCoordinatorWhenIdle = false;
    changed = true;
  }
  if (!Array.isArray(session.orchestrationTasks)) {
    session.orchestrationTasks = [];
    changed = true;
  }
  if (!Array.isArray(session.orchestrationEvents)) {
    session.orchestrationEvents = [];
    changed = true;
  }
  var policy = session.orchestrationPolicy || {};
  if (policy.portfolioExecution) {
    session.title = "Project coordinator";
    session.titleManuallySet = true;
    session.orchestrationPolicy = Object.assign({}, policy);
    delete session.orchestrationPolicy.portfolioExecution;
    changed = true;
  }
  if (changed) sm.saveSessionFile(session, { durable: true });
  return session;
}

function createProjectCoordinator(sm, projectId, source) {
  var session = sm.createSessionRaw({
    storageId: crypto.randomUUID(),
    coordinationMode: true,
    coopControlledBy: source ? {
      coopSessionStorageId: source.sessionStorageId,
      since: Date.now(),
    } : null,
  });
  session.title = "Project coordinator";
  session.titleManuallySet = true;
  session.coordinationRole = PROJECT_COORDINATOR;
  session.orchestrationTasks = [];
  session.orchestrationEvents = [];
  session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
    projectCoordinator: {
      version: 1,
      projectId: projectId,
      createdAt: Date.now(),
    },
  });
  sm.saveSessionFile(session, { durable: true });
  sm.broadcastSessionList();
  return session;
}

function ensureProjectCoordinator(sm, projectId, preferredRef, source) {
  var existing = findProjectCoordinator(sm, projectId, preferredRef);
  return existing ? reactivateProjectCoordinator(sm, existing) :
    createProjectCoordinator(sm, projectId, source);
}

function taskClientRef(request) {
  return "portfolio:" + request.portfolioTaskId + ":" + request.bindingRevision;
}

function linkedTask(root, request) {
  var tasks = root.orchestrationTasks || [];
  var clientRef = taskClientRef(request);
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i] && tasks[i].clientRef === clientRef) return tasks[i];
  }
  return null;
}

function linkTaskCoordinator(sm, root, child, input) {
  var request = input.request;
  var task = linkedTask(root, request);
  if (!task) {
    task = taskGraph.createTask(root, {
      taskId: "task-" + crypto.randomUUID(),
      clientRef: taskClientRef(request),
      title: input.brief.title,
      objective: input.brief.objective,
      context: input.brief.context,
      acceptanceCriteria: input.brief.acceptanceCriteria,
      ownedPaths: input.brief.ownedPaths,
      provider: input.brief.provider,
      model: input.brief.model,
      coopTopicRef: request.coopTopicRef,
      coopProjectRef: request.targetProject,
    });
  }
  task.externalTaskCoordinator = true;
  task.status = "running";
  task.currentActivity = "Task coordinator is running";
  task.workerSessionId = child.localId;
  task.workerStorageId = storageId(child);
  task.updatedAt = Date.now();
  child.coordinationMode = true;
  child.coordinationRole = TASK_COORDINATOR;
  child.projectCoordinatorRef = projectIdentity.sessionRef({ projectId: request.targetProject.projectId }, root);
  child.orchestrationParent = {
    taskId: task.taskId,
    sessionId: root.localId,
    sessionStorageId: storageId(root),
    workerColor: task.workerColor || null,
  };
  sm.saveSessionFile(root, { durable: true });
  sm.saveSessionFile(child, { durable: true });
  sm.broadcastSessionList();
  return task;
}

function rollUpTaskCoordinator(sm, child, status, summary) {
  var parentMeta = child && child.orchestrationParent;
  if (!parentMeta || child.coordinationRole !== TASK_COORDINATOR) return false;
  var root = null;
  sm.sessions.forEach(function (session) {
    if (!root && storageId(session) === parentMeta.sessionStorageId) root = session;
  });
  var task = root && taskGraph.findTask(root, parentMeta.taskId);
  if (!task || !task.externalTaskCoordinator) return false;
  var next = status === "completed" ? "completed" :
    (status === "needs_input" ? "needs_input" : "failed");
  // Project completion is replayed at startup so stranded bindings can heal.
  // Once this durable task is completed, that replay must not invent another
  // transition timestamp/event: fan-in identity is derived from that terminal
  // timestamp, and restamping it redelivered already reconciled completions.
  if (next === "completed" && task.status === "completed") return false;
  task.status = next;
  task.currentActivity = next === "completed" ? "Task coordinator completed" :
    (next === "needs_input" ? "Task coordinator needs owner input" : "Task coordinator failed");
  task.resultSummary = String(summary || "").trim().slice(0, 4000);
  task.updatedAt = Date.now();
  taskGraph.appendEvent(root, "task_coordinator_" + next, task, {
    taskCoordinatorRef: taskCoordinatorRef(child),
  });
  sm.saveSessionFile(root, { durable: true });
  sm.broadcastSessionList();
  return true;
}

function markTaskCoordinatorRunning(sm, child) {
  var parentMeta = child && child.orchestrationParent;
  if (!parentMeta || child.coordinationRole !== TASK_COORDINATOR) return false;
  var root = null;
  sm.sessions.forEach(function (session) {
    if (!root && storageId(session) === parentMeta.sessionStorageId) root = session;
  });
  var task = root && taskGraph.findTask(root, parentMeta.taskId);
  if (!task || !task.externalTaskCoordinator) return false;
  task.status = "running";
  task.currentActivity = "Task coordinator is running";
  task.updatedAt = Date.now();
  taskGraph.appendEvent(root, "task_coordinator_resumed", task, {
    taskCoordinatorRef: taskCoordinatorRef(child),
  });
  sm.saveSessionFile(root, { durable: true });
  sm.broadcastSessionList();
  return true;
}

function unlinkTaskCoordinator(sm, root, child) {
  if (!root || !child || !Array.isArray(root.orchestrationTasks)) return false;
  var childStorageId = storageId(child);
  var removed = false;
  root.orchestrationTasks = root.orchestrationTasks.filter(function (task) {
    if (!task || !task.externalTaskCoordinator || task.workerStorageId !== childStorageId) return true;
    removed = true;
    return false;
  });
  if (!removed) return false;
  root.orchestrationEvents = (root.orchestrationEvents || []).filter(function (event) {
    return !event || event.taskId !== (child.orchestrationParent && child.orchestrationParent.taskId);
  });
  sm.saveSessionFile(root, { durable: true });
  sm.broadcastSessionList();
  return true;
}

module.exports = {
  PROJECT_COORDINATOR: PROJECT_COORDINATOR,
  TASK_COORDINATOR: TASK_COORDINATOR,
  ensureProjectCoordinator: ensureProjectCoordinator,
  findProjectCoordinator: findProjectCoordinator,
  linkTaskCoordinator: linkTaskCoordinator,
  markTaskCoordinatorRunning: markTaskCoordinatorRunning,
  projectCoordinatorCandidate: projectCoordinatorCandidate,
  rollUpTaskCoordinator: rollUpTaskCoordinator,
  unlinkTaskCoordinator: unlinkTaskCoordinator,
};
