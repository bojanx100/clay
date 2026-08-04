function attachProjectSessionsRecords(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var osUsers = ctx.osUsers;
  var sm = ctx.sm;
  var tm = ctx.tm;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var usersModule = ctx.usersModule;
  var userPresence = ctx.userPresence;
  var adapter = ctx.adapter;
  var loadContextSources = ctx.loadContextSources;
  var stopTitleWatcher = ctx.stopTitleWatcher;

  function canAccess(ws, session) {
    if (usersModule.isMultiUser() && ws._clayUser) {
      return usersModule.canAccessSession(ws._clayUser.id, session, { visibility: "public" });
    }
    return true;
  }

  function activeOrchestrationTasks(session) {
    if (!session || !Array.isArray(session.orchestrationTasks)) return [];
    return session.orchestrationTasks.filter(function (task) {
      return task && (task.status === "queued" || task.status === "ready" ||
        task.status === "running" || task.status === "reviewing");
    });
  }

  function coordinatorTasks(session) {
    if (!session || !Array.isArray(session.orchestrationTasks)) return [];
    return session.orchestrationTasks.filter(function (task) { return !!task; });
  }

  function atRiskOrchestrationTasks(session) {
    return coordinatorTasks(session).filter(function (task) {
      return task.status !== "completed" && task.status !== "dismissed" &&
        task.status !== "cancelled";
    });
  }

  function closeCoordinatorWorkers(session, tasksToClose) {
    var tasks = Array.isArray(tasksToClose) ? tasksToClose : activeOrchestrationTasks(session);
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      var worker = task.workerSessionId ? sm.sessions.get(task.workerSessionId) : null;
      if (worker) {
        worker._orchestrationTaskClosed = true;
        worker.orchestrationParent = null;
        if (worker._orchestrationUnsubscribe) worker._orchestrationUnsubscribe();
        worker._orchestrationUnsubscribe = null;
        worker._orchestrationWatcherAttached = false;
        worker.taskStopRequested = true;
        if (worker.abortController) {
          try { worker.abortController.abort(); } catch (e) {}
        }
        sm.hideSession(worker.localId);
      }
      if (task.status !== "completed" && task.status !== "dismissed" &&
          task.status !== "cancelled") {
        task.status = "cancelled";
        task.currentActivity = "Stopped when coordinator was closed";
        task.resolutionReason = "Coordinator was closed";
        task.resolutionSummary = "Stopped when coordinator was closed";
        task.resolvedAt = Date.now();
        task.updatedAt = Date.now();
      }
    }
    sm.saveSessionFile(session);
  }

  function demoteCoordinator(session) {
    session.coordinationMode = false;
    session.demoteCoordinatorWhenIdle = false;
    sm.saveSessionFile(session);
    sm.broadcastSessionList();
    sendToSession(session.localId, {
      type: "coordinator_status",
      coordinationMode: false,
      demotionPending: false,
    });
  }

  function handleRecordsMessage(ws, msg) {
    if (msg.type === "demote_session_from_coordinator") {
      var demoteTarget = typeof msg.sessionId === "number" ? sm.sessions.get(msg.sessionId) : null;
      if (!demoteTarget || !demoteTarget.coordinationMode || demoteTarget.orchestrationParent) return true;
      if (!canAccess(ws, demoteTarget)) return true;
      var activeDemotionTasks = activeOrchestrationTasks(demoteTarget);
      if (msg.action === "cancel") {
        demoteTarget.demoteCoordinatorWhenIdle = false;
        sm.saveSessionFile(demoteTarget);
        sm.broadcastSessionList();
        sendToSession(demoteTarget.localId, {
          type: "coordinator_status",
          coordinationMode: true,
          demotionPending: false,
        });
        return true;
      }
      if (activeDemotionTasks.length === 0) {
        demoteCoordinator(demoteTarget);
        return true;
      }
      if (msg.action === "stop") {
        closeCoordinatorWorkers(demoteTarget);
        demoteCoordinator(demoteTarget);
        return true;
      }
      if (msg.action === "after") {
        demoteTarget.demoteCoordinatorWhenIdle = true;
        sm.saveSessionFile(demoteTarget);
        sm.broadcastSessionList();
        sendToSession(demoteTarget.localId, {
          type: "coordinator_status",
          coordinationMode: true,
          demotionPending: true,
        });
        return true;
      }
      sendTo(ws, {
        type: "coordinator_demote_required",
        id: demoteTarget.localId,
        title: demoteTarget.title || "Coordinator",
        activeWorkerCount: activeDemotionTasks.length,
      });
      return true;
    }

    if (msg.type === "set_session_visibility") {
      if (typeof msg.sessionId === "number" && (msg.visibility === "shared" || msg.visibility === "private")) {
        var visibilityTarget = sm.sessions.get(msg.sessionId);
        if (visibilityTarget && (visibilityTarget.coopHome || visibilityTarget.coopChannel)) {
          sendTo(ws, { type: "error", text: "Coop conversations keep their owner routing and cannot change visibility" });
          return true;
        }
        sm.setSessionVisibility(msg.sessionId, msg.visibility);
      }
      return true;
    }

    if (msg.type === "set_session_bookmark") {
      if (typeof msg.sessionId === "number") {
        var bookmarkTarget = sm.sessions.get(msg.sessionId);
        if (!bookmarkTarget) return true;
        if (!canAccess(ws, bookmarkTarget)) return true;
        sm.setSessionBookmarked(msg.sessionId, !!msg.bookmarked);
      }
      return true;
    }

    if (msg.type === "reorder_session_bookmarks") {
      if (typeof msg.sourceId === "number" && typeof msg.targetId === "number" && msg.sourceId !== msg.targetId) {
        var source = sm.sessions.get(msg.sourceId);
        var target = sm.sessions.get(msg.targetId);
        if (!source || !target) return true;
        if (!canAccess(ws, source)) return true;
        if (!canAccess(ws, target)) return true;
        sm.reorderBookmarkedSessions(msg.sourceId, msg.targetId, msg.insertBefore !== false);
      }
      return true;
    }

    if (msg.type === "bulk_delete_sessions") {
      if (!Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) return true;
      var deletableIds = [];
      for (var di = 0; di < msg.sessionIds.length; di++) {
        var bulkId = msg.sessionIds[di];
        if (typeof bulkId !== "number") continue;
        var bulkTarget = sm.sessions.get(bulkId);
        if (!bulkTarget) continue;
        if (!canAccess(ws, bulkTarget)) continue;
        if (bulkTarget.coopHome || bulkTarget.coopChannel) continue;
        deletableIds.push(bulkId);
      }
      if (deletableIds.length > 0) {
        // TUI sessions: kill their PTYs and stop title watchers before the
        // records are wiped.
        for (var bdi = 0; bdi < deletableIds.length; bdi++) {
          var bdTarget = sm.sessions.get(deletableIds[bdi]);
          if (!bdTarget) continue;
          if (tm && bdTarget.mode === "tui" && typeof bdTarget.terminalId === "number") {
            try { tm.close(bdTarget.terminalId); } catch (e) {}
          }
          stopTitleWatcher(bdTarget);
        }
        sm.deleteSessionsBulk(deletableIds, ws);
      }
      return true;
    }

    if (msg.type === "delete_session") {
      if (ws._clayUser) {
        var sdPerms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
        if (!sdPerms.sessionDelete) {
          sendTo(ws, { type: "error", text: "You do not have permission to delete sessions" });
          return true;
        }
      }
      if (msg.id && sm.sessions.has(msg.id)) {
        // TUI session: kill the underlying PTY before deleting the session
        // record so the `claude` process is reaped and not left orphaned.
        var dsTarget = sm.sessions.get(msg.id);
        if (dsTarget && (dsTarget.coopHome || dsTarget.coopChannel)) {
          sendTo(ws, { type: "error", text: "Coop conversations are permanent and cannot be deleted" });
          return true;
        }
        if (dsTarget && dsTarget.mode === "tui" && typeof dsTarget.terminalId === "number" && tm) {
          try { tm.close(dsTarget.terminalId); } catch (e) {}
        }
        if (dsTarget) stopTitleWatcher(dsTarget);
        sm.deleteSession(msg.id, ws);
      }
      return true;
    }

    if (msg.type === "hide_session") {
      if (msg.id && sm.sessions.has(msg.id)) {
        var hideTarget = sm.sessions.get(msg.id);
        if (hideTarget.coopHome || hideTarget.coopChannel) {
          sendTo(ws, { type: "error", text: "Coop conversations are permanent and cannot be hidden" });
          return true;
        }
        var allCoordinatorTasks = hideTarget.coordinationMode ? coordinatorTasks(hideTarget) : [];
        var atRiskCoordinatorTasks = hideTarget.coordinationMode ? atRiskOrchestrationTasks(hideTarget) : [];
        if (atRiskCoordinatorTasks.length > 0 && msg.closeWorkers !== true) {
          sendTo(ws, {
            type: "coordinator_close_required",
            id: hideTarget.localId,
            title: hideTarget.title || "Coordinator",
            activeWorkerCount: activeOrchestrationTasks(hideTarget).length,
            atRiskWorkerCount: atRiskCoordinatorTasks.length,
          });
          return true;
        }
        if (allCoordinatorTasks.length > 0) closeCoordinatorWorkers(hideTarget, allCoordinatorTasks);
        sm.hideSession(msg.id, ws);
        var hsPresKey = ws._clayUser ? ws._clayUser.id : "_default";
        if (ws._clayActiveSession && sm.sessions.has(ws._clayActiveSession)) {
          userPresence.setPresence(slug, hsPresKey, ws._clayActiveSession, null);
          if (typeof loadContextSources === "function") {
            var hiddenFallbackSources = loadContextSources(slug, ws._clayActiveSession);
            sendTo(ws, { type: "context_sources_state", active: hiddenFallbackSources });
          }
        } else {
          userPresence.clearPresence(slug, hsPresKey);
        }
      }
      return true;
    }

    if (msg.type === "rename_session") {
      if (msg.id && sm.sessions.has(msg.id) && msg.title) {
        var s = sm.sessions.get(msg.id);
        s.title = String(msg.title).substring(0, 100);
        s.titleManuallySet = true;
        sm.saveSessionFile(s);
        sm.broadcastSessionList();
        // Sync title to SDK session
        if (s.cliSessionId) {
          adapter.renameSession(s.cliSessionId, s.title, { dir: cwd }).catch(function(e) {
            console.error("[project] SDK renameSession failed:", e.message);
          });
        }
      }
      return true;
    }

    return false;
  }

  return {
    handleRecordsMessage: handleRecordsMessage,
  };
}

module.exports = { attachProjectSessionsRecords: attachProjectSessionsRecords };
