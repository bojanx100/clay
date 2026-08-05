// project-task-orchestrator-coordinator.js - Coordinator lookup and on-demand promotion
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

  function coordinatorForInput(input) {
    var session = sessionForInput(input);
    var execution = sessionExecutionBinding(session);
    if (!session || !session.coordinationMode || session.orchestrationParent ||
        execution && execution.mode === "direct_leaf") return null;
    return session;
  }

  function ensureCoordinatorForInput(input) {
    var session = sessionForInput(input);
    var execution = sessionExecutionBinding(session);
    if (!session || session.orchestrationParent ||
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
    workerForTask: workerForTask,
  };
}

module.exports = { attachCoordinatorResolver: attachCoordinatorResolver };
