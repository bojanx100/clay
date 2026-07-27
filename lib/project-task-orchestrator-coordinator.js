// project-task-orchestrator-coordinator.js - Coordinator lookup and on-demand promotion

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

  function coordinatorForInput(input) {
    var session = sessionForInput(input);
    if (!session || !session.coordinationMode || session.orchestrationParent) return null;
    return session;
  }

  function ensureCoordinatorForInput(input) {
    var session = sessionForInput(input);
    if (!session || session.orchestrationParent) return null;
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
    storageIdForSession: storageIdForSession,
  };
}

module.exports = { attachCoordinatorResolver: attachCoordinatorResolver };
