// project-task-orchestrator-coordinator.js - Coordinator lookup and on-demand promotion
var taskGraph = require("./orchestration-task-graph");
var sessionExecutionBinding =
  require("./portfolio-execution-bindings").sessionExecutionBinding;

function attachCoordinatorResolver(ctx) {
  var sm = ctx.sm;
  var sendToSession = ctx.sendToSession;

  function storageIdForSession(session) {
    return session && (session.storageId || session.cliSessionId) || null;
  }

  function sessionByStorageId(storageId) {
    if (!storageId || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
    var found = null;
    sm.sessions.forEach(function (session) {
      if (!found && storageIdForSession(session) === storageId) found = session;
    });
    return found;
  }

  function sessionForInput(input) {
    var suppliedId = input && input.coordinatorSessionId;
    var session = sessionByStorageId(String(suppliedId || ""));
    var localId = Number(suppliedId);
    if (!session && Number.isFinite(localId)) session = sm.sessions.get(localId);
    return session;
  }

  function workerForTask(task) {
    if (!task) return null;
    var worker = task.workerStorageId ? sessionByStorageId(task.workerStorageId) : null;
    if (!worker && task.workerSessionId) worker = sm.sessions.get(task.workerSessionId);
    if (worker) {
      task.workerSessionId = worker.localId;
      task.workerStorageId = storageIdForSession(worker);
    }
    return worker;
  }

  function parentSession(session) {
    var owner = session && session.orchestrationParent;
    var parent = owner && sessionByStorageId(owner.sessionStorageId);
    var localId = owner && Number(owner.sessionId);
    if (!parent && Number.isFinite(localId)) parent = sm.sessions.get(localId);
    if (parent) return parent;
    var execution = sessionExecutionBinding(session);
    if (!execution || !execution.source) return null;
    return sessionByStorageId(execution.source.sessionStorageId);
  }

  function descendsFrom(coordinator, candidate) {
    if (!coordinator || !candidate) return false;
    var rootStorageId = storageIdForSession(coordinator);
    var current = candidate;
    var seen = {};
    while (current) {
      if (current === coordinator) return true;
      var key = storageIdForSession(current) || String(current.localId || "");
      if (seen[key]) break;
      seen[key] = true;
      var parent = parentSession(current);
      if (parent) {
        current = parent;
        continue;
      }
      if (coordinator.coopHome && rootStorageId && current.coopControlledBy &&
          current.coopControlledBy.coopSessionStorageId === rootStorageId) {
        return true;
      }
      break;
    }
    return false;
  }

  function coordinatorOwningTask(coordinator, taskId) {
    var direct = coordinator && taskGraph.findTask(coordinator, String(taskId || ""));
    if (direct) return { owner: coordinator, task: direct };
    if (!coordinator || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
    var found = null;
    sm.sessions.forEach(function (candidate) {
      if (found || !candidate || candidate === coordinator ||
          !Array.isArray(candidate.orchestrationTasks) ||
          !descendsFrom(coordinator, candidate)) return;
      var task = taskGraph.findTask(candidate, String(taskId || ""));
      if (task) found = { owner: candidate, task: task };
    });
    return found;
  }

  function coordinatorForInput(input) {
    var session = sessionForInput(input);
    var execution = sessionExecutionBinding(session);
    if (!session || !session.coordinationMode ||
        session.orchestrationParent && session.coordinationRole !== "task_coordinator" ||
        execution && execution.mode === "direct_leaf") return null;
    return session;
  }

  function ensureCoordinatorForInput(input) {
    var session = sessionForInput(input);
    var execution = sessionExecutionBinding(session);
    if (!session || session.orchestrationParent && session.coordinationRole !== "task_coordinator" ||
        execution && execution.mode === "direct_leaf") return null;
    if (session.coordinationMode) return session;
    session.coordinationMode = true;
    sm.saveSessionFile(session);
    sm.broadcastSessionList();
    sendToSession(session.localId, {
      type: "coordinator_status",
      coordinationMode: true,
    });
    return session;
  }

  return {
    coordinatorForInput: coordinatorForInput,
    ensureCoordinatorForInput: ensureCoordinatorForInput,
    sessionByStorageId: sessionByStorageId,
    sessionForInput: sessionForInput,
    storageIdForSession: storageIdForSession,
    coordinatorOwningTask: coordinatorOwningTask,
    workerForTask: workerForTask,
  };
}

module.exports = { attachCoordinatorResolver: attachCoordinatorResolver };
