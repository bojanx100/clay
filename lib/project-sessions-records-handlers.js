function canAccess(ctx, ws, session) {
  var usersModule = ctx.usersModule;
  if (usersModule && usersModule.isMultiUser() && ws && ws._clayUser) {
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
  return sm.sessions.get(Number(task.workerSessionId));
}

function closeWorker(ctx, task) {
  var sm = ctx.sm;
  var worker = workerForTask(sm, task);
  if (!worker) return;
  worker._orchestrationTaskClosed = true;
  worker.orchestrationParent = null;
  if (worker._orchestrationUnsubscribe) worker._orchestrationUnsubscribe();
  worker._orchestrationUnsubscribe = null;
  worker._orchestrationWatcherAttached = false;
  worker.taskStopRequested = true;
  if (worker.abortController) {
    try { worker.abortController.abort(); } catch (e) {}
  }
  if (typeof sm.hideSessionForActiveClients === "function") {
    sm.hideSessionForActiveClients(worker.localId);
  } else {
    sm.hideSession(worker.localId);
  }
}

function closeCoordinatorWorkers(ctx, session, tasksToClose) {
  var tasks = Array.isArray(tasksToClose) ? tasksToClose : activeOrchestrationTasks(session);
  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i];
    closeWorker(ctx, task);
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
  ctx.sm.saveSessionFile(session);
}

function sendCoordinatorStatus(ctx, session, pending) {
  ctx.sm.saveSessionFile(session);
  ctx.sm.broadcastSessionList();
  ctx.sendToSession(session.localId, {
    type: "coordinator_status",
    coordinationMode: true,
    demotionPending: pending,
  });
}

function demoteCoordinator(ctx, session) {
  session.coordinationMode = false;
  session.demoteCoordinatorWhenIdle = false;
  ctx.sm.saveSessionFile(session);
  ctx.sm.broadcastSessionList();
  ctx.sendToSession(session.localId, {
    type: "coordinator_status",
    coordinationMode: false,
    demotionPending: false,
  });
}

function handleDemote(ctx, ws, msg) {
  var sm = ctx.sm;
  var target = typeof msg.sessionId === "number" ? sm.sessions.get(msg.sessionId) : null;
  if (!target || !target.coordinationMode || target.orchestrationParent) return;
  if (!canAccess(ctx, ws, target)) return;
  var activeTasks = activeOrchestrationTasks(target);
  if (msg.action === "cancel") {
    target.demoteCoordinatorWhenIdle = false;
    sendCoordinatorStatus(ctx, target, false);
    return;
  }
  if (activeTasks.length === 0) {
    demoteCoordinator(ctx, target);
    return;
  }
  if (msg.action === "stop") {
    closeCoordinatorWorkers(ctx, target);
    demoteCoordinator(ctx, target);
    return;
  }
  if (msg.action === "after") {
    target.demoteCoordinatorWhenIdle = true;
    sendCoordinatorStatus(ctx, target, true);
    return;
  }
  ctx.sendTo(ws, {
    type: "coordinator_demote_required",
    id: target.localId,
    title: target.title || "Coordinator",
    activeWorkerCount: activeTasks.length,
  });
}

function handleVisibility(ctx, ws, msg) {
  var sm = ctx.sm;
  var valid = typeof msg.sessionId === "number" &&
    (msg.visibility === "shared" || msg.visibility === "private");
  if (!valid) return;
  var target = sm.sessions.get(msg.sessionId);
  if (target && (target.coopHome || target.coopChannel)) {
    ctx.sendTo(ws, { type: "error", text: "Coop conversations keep their owner routing and cannot change visibility" });
    return;
  }
  sm.setSessionVisibility(msg.sessionId, msg.visibility);
}

function handleBookmark(ctx, ws, msg) {
  if (typeof msg.sessionId !== "number") return;
  var target = ctx.sm.sessions.get(msg.sessionId);
  if (!target || !canAccess(ctx, ws, target)) return;
  ctx.sm.setSessionBookmarked(msg.sessionId, !!msg.bookmarked);
}

function handleBookmarkReorder(ctx, ws, msg) {
  if (typeof msg.sourceId !== "number" || typeof msg.targetId !== "number" ||
      msg.sourceId === msg.targetId) return;
  var sm = ctx.sm;
  var source = sm.sessions.get(msg.sourceId);
  var target = sm.sessions.get(msg.targetId);
  if (!source || !target || !canAccess(ctx, ws, source) || !canAccess(ctx, ws, target)) return;
  sm.reorderBookmarkedSessions(msg.sourceId, msg.targetId, msg.insertBefore !== false);
}

function bulkDeletableIds(ctx, ws, msg) {
  if (!Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) return [];
  var sm = ctx.sm;
  var ids = [];
  for (var i = 0; i < msg.sessionIds.length; i++) {
    var id = msg.sessionIds[i];
    if (typeof id !== "number") continue;
    var target = sm.sessions.get(id);
    if (!target || !canAccess(ctx, ws, target)) continue;
    if (target.coopHome || target.coopChannel) continue;
    ids.push(id);
  }
  return ids;
}

function stopTitleWatcher(ctx, session) {
  if (typeof ctx.stopTitleWatcher === "function") ctx.stopTitleWatcher(session);
}

function cleanupBeforeDelete(ctx, session) {
  var tm = ctx.tm;
  if (tm && session.mode === "tui" && typeof session.terminalId === "number") {
    try { tm.close(session.terminalId); } catch (e) {}
  }
  stopTitleWatcher(ctx, session);
}

function handleBulkDelete(ctx, ws, msg) {
  var ids = bulkDeletableIds(ctx, ws, msg);
  if (ids.length === 0) return;
  var sm = ctx.sm;
  for (var i = 0; i < ids.length; i++) {
    var target = sm.sessions.get(ids[i]);
    if (target) cleanupBeforeDelete(ctx, target);
  }
  sm.deleteSessionsBulk(ids, ws);
}

function hasDeletePermission(ctx, ws) {
  if (!ws || !ws._clayUser) return true;
  var permissions = ctx.usersModule.getEffectivePermissions(ws._clayUser, ctx.osUsers);
  return !!permissions.sessionDelete;
}

function handleDelete(ctx, ws, msg) {
  if (!hasDeletePermission(ctx, ws)) {
    ctx.sendTo(ws, { type: "error", text: "You do not have permission to delete sessions" });
    return;
  }
  var sm = ctx.sm;
  if (!msg.id || !sm.sessions.has(msg.id)) return;
  var target = sm.sessions.get(msg.id);
  if (target && (target.coopHome || target.coopChannel)) {
    ctx.sendTo(ws, { type: "error", text: "Coop conversations are permanent and cannot be deleted" });
    return;
  }
  if (target) cleanupBeforeDelete(ctx, target);
  sm.deleteSession(msg.id, ws);
}

function sendHideFallback(ctx, ws) {
  var sm = ctx.sm;
  var key = ws && ws._clayUser ? ws._clayUser.id : "_default";
  if (ws && ws._clayActiveSession && sm.sessions.has(ws._clayActiveSession)) {
    ctx.userPresence.setPresence(ctx.slug, key, ws._clayActiveSession, null);
    if (typeof ctx.loadContextSources === "function") {
      var sources = ctx.loadContextSources(ctx.slug, ws._clayActiveSession);
      ctx.sendTo(ws, { type: "context_sources_state", active: sources });
    }
    return;
  }
  ctx.userPresence.clearPresence(ctx.slug, key);
}

function handleHide(ctx, ws, msg) {
  var sm = ctx.sm;
  if (!msg.id || !sm.sessions.has(msg.id)) return;
  var target = sm.sessions.get(msg.id);
  if (target.coopHome || target.coopChannel) {
    ctx.sendTo(ws, { type: "error", text: "Coop conversations are permanent and cannot be hidden" });
    return;
  }
  var tasks = target.coordinationMode ? coordinatorTasks(target) : [];
  var atRiskTasks = target.coordinationMode ? atRiskOrchestrationTasks(target) : [];
  if (atRiskTasks.length > 0 && msg.closeWorkers !== true) {
    ctx.sendTo(ws, {
      type: "coordinator_close_required",
      id: target.localId,
      title: target.title || "Coordinator",
      activeWorkerCount: activeOrchestrationTasks(target).length,
      atRiskWorkerCount: atRiskTasks.length,
    });
    return;
  }
  if (tasks.length > 0) closeCoordinatorWorkers(ctx, target, tasks);
  sm.hideSession(msg.id, ws);
  sendHideFallback(ctx, ws);
}

function reportRenameFailure(error) {
  console.error("[project] SDK renameSession failed:", error.message);
}

function syncSdkRename(ctx, session) {
  var adapter = ctx.adapter;
  if (!session.cliSessionId || !adapter || typeof adapter.renameSession !== "function") return;
  try {
    var result = adapter.renameSession(session.cliSessionId, session.title, { dir: ctx.cwd });
    if (result && typeof result.catch === "function") result.catch(reportRenameFailure);
  } catch (e) {
    reportRenameFailure(e);
  }
}

function handleRename(ctx, msg) {
  var sm = ctx.sm;
  if (!msg.id || !sm.sessions.has(msg.id) || !msg.title) return;
  var session = sm.sessions.get(msg.id);
  session.title = String(msg.title).substring(0, 100);
  session.titleManuallySet = true;
  sm.saveSessionFile(session);
  sm.broadcastSessionList();
  syncSdkRename(ctx, session);
}

function attachProjectSessionsRecordsHandlers(ctx) {
  var handlers = Object.create(null);
  handlers.demote_session_from_coordinator = function (ws, msg) { handleDemote(ctx, ws, msg); };
  handlers.set_session_visibility = function (ws, msg) { handleVisibility(ctx, ws, msg); };
  handlers.set_session_bookmark = function (ws, msg) { handleBookmark(ctx, ws, msg); };
  handlers.reorder_session_bookmarks = function (ws, msg) { handleBookmarkReorder(ctx, ws, msg); };
  handlers.bulk_delete_sessions = function (ws, msg) { handleBulkDelete(ctx, ws, msg); };
  handlers.delete_session = function (ws, msg) { handleDelete(ctx, ws, msg); };
  handlers.hide_session = function (ws, msg) { handleHide(ctx, ws, msg); };
  handlers.rename_session = function (ws, msg) { handleRename(ctx, msg); };
  return handlers;
}

module.exports = {
  attachProjectSessionsRecordsHandlers: attachProjectSessionsRecordsHandlers,
};
