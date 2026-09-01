var fs = require("fs");
var tombstones = require("./tombstones");
var handoffPackage = require("./handoff-package");

function attachSessionDeletion(ctx) {
  var cwd = ctx.cwd || null;
  var sessions = ctx.sessions;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendEach = ctx.sendEach;
  var getSingleUserUnread = ctx.getSingleUserUnread;
  var getSessionStorageId = ctx.getSessionStorageId;
  var sessionFilePath = ctx.sessionFilePath;
  var saveSessionFile = ctx.saveSessionFile;
  var getActiveSessionId = ctx.getActiveSessionId;
  var setActiveSessionId = ctx.setActiveSessionId;
  var switchSession = ctx.switchSession;
  var createSession = ctx.createSession;
  var broadcastSessionList = ctx.broadcastSessionList;
  var mostRecentVisibleSessionForWs = ctx.mostRecentVisibleSessionForWs;

  function isProtectedCoopSession(session) {
    return !!(session && (session.coopHome || session.coopChannel));
  }

  function isCoopManagedWorker(session) {
    return !!(session && (session.coopControlledBy || session.orchestrationParent));
  }

  function cleanupMentionSessions(session) {
    if (session._mentionSessions) {
      var mateIds = Object.keys(session._mentionSessions);
      for (var mi = 0; mi < mateIds.length; mi++) {
        try { session._mentionSessions[mateIds[mi]].close(); } catch (e) {}
      }
      session._mentionSessions = {};
    }
  }

  function cleanupRuntime(session) {
    cleanupMentionSessions(session);
    if (session._providerFailoverTimer) {
      clearTimeout(session._providerFailoverTimer);
      session._providerFailoverTimer = null;
    }
    if (session.abortController) {
      try { session.abortController.abort(); } catch(e) {}
    }
    if (session.queryInstance && typeof session.queryInstance.close === "function") {
      try { session.queryInstance.close(); } catch(e) {}
    }
    session.queryInstance = null;
    if (session.messageQueue) {
      try { session.messageQueue.end(); } catch(e) {}
    }
    if (session.worker) {
      try { session.worker.kill(); } catch(e) {}
      session.worker = null;
    }
    session._deleted = true;
    if (session._saveCoalesceTimer) {
      clearTimeout(session._saveCoalesceTimer);
      session._saveCoalesceTimer = null;
    }
  }

  // Stop a session's live runtime without deleting it. Unlike cleanupRuntime,
  // this keeps the session resumable: it never sets _deleted, tombstones, or
  // removes the file. The next user message respawns the worker (resuming from
  // cliSessionId), and taskStopRequested resets when that turn starts. Used by
  // the hide/close path so a closed session stops immediately instead of
  // continuing behind the scenes (agent turn, auto-continue, provider failover,
  // scheduled message).
  function stopSessionRuntime(session) {
    if (!session) return;
    cleanupMentionSessions(session);
    session.taskStopRequested = true;
    session.isProcessing = false;
    if (session.autoContinueTimer) {
      clearTimeout(session.autoContinueTimer);
      session.autoContinueTimer = null;
    }
    if (session.scheduledMessage && session.scheduledMessage.timer) {
      clearTimeout(session.scheduledMessage.timer);
      session.scheduledMessage = null;
    }
    if (session._providerFailoverTimer) {
      clearTimeout(session._providerFailoverTimer);
      session._providerFailoverTimer = null;
    }
    if (session.abortController) {
      try { session.abortController.abort(); } catch (e) {}
    }
    if (session.queryInstance && typeof session.queryInstance.close === "function") {
      try { session.queryInstance.close(); } catch (e) {}
    }
    session.queryInstance = null;
    if (session.messageQueue && typeof session.messageQueue.end === "function") {
      try { session.messageQueue.end(); } catch (e) {}
    }
    if (session.worker) {
      try { session.worker.kill(); } catch (e) {}
      session.worker = null;
    }
  }

  function tombstoneAndRemoveFile(session) {
    var storageId = getSessionStorageId(session);
    if (storageId) {
      tombstones.add(storageId);
      if (session.cliSessionId && session.cliSessionId !== storageId) {
        tombstones.add(session.cliSessionId);
      }
      try { fs.unlinkSync(sessionFilePath(storageId)); } catch(e) {}
      // The session's handoff package (transcript + image copies) goes with it.
      if (cwd) handoffPackage.removeHandoffPackage(cwd, storageId);
    }
  }

  function deleteSession(localId, targetWs) {
    var session = sessions.get(localId);
    if (!session || isProtectedCoopSession(session)) return;
    if (isCoopManagedWorker(session)) {
      hideSession(localId, targetWs);
      return;
    }

    delete getSingleUserUnread()[localId];
    cleanupRuntime(session);
    tombstoneAndRemoveFile(session);
    sessions.delete(localId);

    if (getActiveSessionId() === localId) {
      var remaining = [...sessions.keys()];
      if (remaining.length > 0) {
        switchSession(remaining[remaining.length - 1], targetWs);
      } else {
        createSession(null, targetWs);
      }
    } else {
      broadcastSessionList();
    }
  }

  function findWorkerSessionForTask(task) {
    var byId = typeof task.workerSessionId === "number" ? sessions.get(task.workerSessionId) : null;
    if (byId && (!task.workerStorageId || getSessionStorageId(byId) === task.workerStorageId)) return byId;
    if (!task.workerStorageId) return byId;
    var found = null;
    sessions.forEach(function (s) {
      if (!found && getSessionStorageId(s) === task.workerStorageId) found = s;
    });
    return found || byId;
  }

  // Hiding a coordinator must take its worker sessions with it — a worker
  // with a hidden parent has no row to nest under and would dangle at the
  // top level of the sidebar (boss report 2026-08-04: auto-launch closed a
  // coordinator and stranded its completed workers).
  function hideCoordinatorWorkers(session) {
    if (!session.coordinationMode || !Array.isArray(session.orchestrationTasks)) return;
    for (var i = 0; i < session.orchestrationTasks.length; i++) {
      var task = session.orchestrationTasks[i];
      if (!task) continue;
      var worker = findWorkerSessionForTask(task);
      if (!worker || worker === session || worker.hidden) continue;
      worker.hidden = true;
      saveSessionFile(worker);
    }
  }

  function finishHiddenActiveSession(localId, targetWs, targetActive, globalActive) {
    var nextSession = mostRecentVisibleSessionForWs(targetWs, localId);
    if (nextSession) {
      switchSession(nextSession.localId, targetWs);
      return true;
    }
    if (targetActive && targetWs) targetWs._clayActiveSession = null;
    if (globalActive) setActiveSessionId(null);
    if (targetActive && targetWs && sendTo) {
      sendTo(targetWs, { type: "session_closed", id: localId });
    } else if (globalActive) {
      send({ type: "session_closed", id: localId });
    }
    return false;
  }

  function hideSession(localId, targetWs, options) {
    var session = sessions.get(localId);
    if (!session || isProtectedCoopSession(session)) return;
    // Background projection cleanup has no target WebSocket, but any number
    // of browser clients may still be viewing the session it removes from the
    // sidebar. Route every attached client before applying the shared hide.
    if (!targetWs && sendEach) {
      hideSessionForActiveClients(localId, options);
      return;
    }
    var projectionOnly = !!(options && options.projectionOnly === true);
    var cascadeWorkers = !!(options && options.cascadeWorkers === true);
    if (!projectionOnly) stopSessionRuntime(session);
    session.hidden = true;
    saveSessionFile(session);
    // A projection-only hide must OPT IN to taking the workers with it.
    //
    // Ungating this entirely looks right -- the invariant above says a hidden
    // coordinator must not strand its workers -- but it breaks a deliberate one:
    // coop-self-cleanup-runtime judges each session individually (category
    // guards, not_coop_controlled) and then hides exactly that projection, so a
    // cascade there would hide workers it never evaluated, possibly still
    // running. That is asserted by "projection-only hiding does not cascade or
    // delete through session deletion", which a blanket change fails.
    //
    // So the cascade is explicit and only hideDismissedSession asks for it: there
    // the coordinator's task is dismissed and archived, so its workers are over
    // by construction. Without it those workers never got `hidden`, and since
    // both session_list producers filter on that flag, they leaked into the
    // sidebar and the mobile Projects picker under a coordinator the owner had
    // already dismissed.
    if (!projectionOnly || cascadeWorkers) hideCoordinatorWorkers(session);

    var targetActive = !!(targetWs && targetWs._clayActiveSession === localId);
    var globalActive = getActiveSessionId() === localId;
    if (targetActive || globalActive) {
      if (finishHiddenActiveSession(localId, targetWs, targetActive, globalActive)) return;
    }
    broadcastSessionList();
  }

  function sendSessionClosedToWs(ws, localId) {
    if (!ws || ws.readyState !== 1) return;
    if (sendTo) {
      sendTo(ws, { type: "session_closed", id: localId });
      return;
    }
    try { ws.send(JSON.stringify({ type: "session_closed", id: localId })); } catch (e) {}
  }

  function hideSessionForActiveClients(localId, options) {
    var session = sessions.get(localId);
    if (!session || isProtectedCoopSession(session)) return;
    if (!sendEach) {
      hideSession(localId, null, options);
      return;
    }

    var projectionOnly = !!(options && options.projectionOnly === true);
    var cascadeWorkers = !!(options && options.cascadeWorkers === true);
    if (!projectionOnly) stopSessionRuntime(session);
    session.hidden = true;
    saveSessionFile(session);
    // Same opt-in as hideSession above, and this is the path that actually ran
    // for the leak: hideDismissedSession passes no targetWs, so hideSession
    // routes straight here through hideSessionForActiveClients.
    if (!projectionOnly || cascadeWorkers) hideCoordinatorWorkers(session);

    var activeClients = [];
    sendEach(function (ws) {
      if (ws && ws._clayActiveSession === localId) activeClients.push(ws);
    });

    for (var i = 0; i < activeClients.length; i++) {
      var ws = activeClients[i];
      var nextSession = mostRecentVisibleSessionForWs(ws, localId);
      if (nextSession) {
        switchSession(nextSession.localId, ws);
      } else {
        ws._clayActiveSession = null;
        sendSessionClosedToWs(ws, localId);
      }
    }

    if (getActiveSessionId() === localId) {
      var globalNext = mostRecentVisibleSessionForWs(null, localId);
      if (globalNext) {
        setActiveSessionId(globalNext.localId);
      } else {
        setActiveSessionId(null);
      }
    }

    broadcastSessionList();
  }

  function deleteSessionQuiet(localId) {
    var session = sessions.get(localId);
    if (!session || isProtectedCoopSession(session)) return;
    delete getSingleUserUnread()[localId];
    cleanupRuntime(session);
    tombstoneAndRemoveFile(session);
    sessions.delete(localId);
  }

  function deleteSessionsBulk(localIds, targetWs) {
    if (!Array.isArray(localIds) || localIds.length === 0) return;

    var seen = {};
    var ids = [];
    for (var i = 0; i < localIds.length; i++) {
      var id = localIds[i];
      if (typeof id !== "number" || seen[id] || !sessions.has(id)) continue;
      var session = sessions.get(id);
      if (isProtectedCoopSession(session)) continue;
      seen[id] = true;
      if (isCoopManagedWorker(session)) {
        hideSession(id, targetWs);
        continue;
      }
      ids.push(id);
    }
    if (ids.length === 0) return;

    var deletedActive = false;
    for (var j = 0; j < ids.length; j++) {
      if (ids[j] === getActiveSessionId()) deletedActive = true;
      deleteSessionQuiet(ids[j]);
    }

    if (sessions.size === 0) {
      createSession(null, targetWs);
      return;
    }

    if (deletedActive) {
      var remaining = [...sessions.keys()];
      switchSession(remaining[remaining.length - 1], targetWs);
    } else {
      broadcastSessionList();
    }
  }

  return {
    deleteSession: deleteSession,
    hideSession: hideSession,
    hideSessionForActiveClients: hideSessionForActiveClients,
    deleteSessionQuiet: deleteSessionQuiet,
    deleteSessionsBulk: deleteSessionsBulk,
  };
}

module.exports = {
  attachSessionDeletion: attachSessionDeletion,
};
