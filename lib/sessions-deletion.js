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

  function isProtectedCoopHome(session) {
    return !!(session && session.coopHome);
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
    if (!session || isProtectedCoopHome(session)) return;

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

  function hideSession(localId, targetWs) {
    var session = sessions.get(localId);
    if (!session || isProtectedCoopHome(session)) return;
    session.hidden = true;
    saveSessionFile(session);
    hideCoordinatorWorkers(session);

    var targetActive = !!(targetWs && targetWs._clayActiveSession === localId);
    var globalActive = getActiveSessionId() === localId;
    if (targetActive || globalActive) {
      var nextSession = mostRecentVisibleSessionForWs(targetWs, localId);
      if (nextSession) {
        switchSession(nextSession.localId, targetWs);
        return;
      }
      if (targetActive && targetWs) targetWs._clayActiveSession = null;
      if (globalActive) setActiveSessionId(null);
      if (targetActive && targetWs && sendTo) {
        sendTo(targetWs, { type: "session_closed", id: localId });
      } else if (globalActive) {
        send({ type: "session_closed", id: localId });
      }
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

  function hideSessionForActiveClients(localId) {
    var session = sessions.get(localId);
    if (!session || isProtectedCoopHome(session)) return;
    if (!sendEach) {
      hideSession(localId, null);
      return;
    }

    session.hidden = true;
    saveSessionFile(session);
    hideCoordinatorWorkers(session);

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
    if (!session || isProtectedCoopHome(session)) return;
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
      if (isProtectedCoopHome(sessions.get(id))) continue;
      seen[id] = true;
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
