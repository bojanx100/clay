function attachSessionBroadcast(ctx) {
  var send = ctx.send;
  var sendEach = ctx.sendEach;
  var getVisibleSessions = ctx.getVisibleSessions;
  var getActiveSessionId = ctx.getActiveSessionId;
  var getSingleUserUnread = ctx.getSingleUserUnread;
  var getEffectiveAutomationMode = ctx.getEffectiveAutomationMode;
  var resolveLoopInfo = null;
  var sessionListBroadcastTimer = null;
  var SESSION_LIST_BROADCAST_DEBOUNCE_MS = 50;

  function setResolveLoopInfo(fn) {
    resolveLoopInfo = fn;
  }

  function mapSessionForClient(s, clientActiveId, wsUnread) {
    var loop = s.loop ? Object.assign({}, s.loop) : null;
    if (loop && loop.loopId && resolveLoopInfo) {
      var info = resolveLoopInfo(loop.loopId);
      if (info) {
        if (info.name) loop.name = info.name;
        if (info.source) loop.source = info.source;
      }
    }
    var activeSessionId = getActiveSessionId();
    var isActive = (typeof clientActiveId === "number") ? s.localId === clientActiveId : s.localId === activeSessionId;
    var unreadMap = wsUnread || getSingleUserUnread();
    var activeOrchestrationCount = 0;
    if (Array.isArray(s.orchestrationTasks)) {
      for (var oi = 0; oi < s.orchestrationTasks.length; oi++) {
        var orchestrationStatus = s.orchestrationTasks[oi] && s.orchestrationTasks[oi].status;
        if (orchestrationStatus === "queued" || orchestrationStatus === "ready" ||
            orchestrationStatus === "running" || orchestrationStatus === "reviewing") {
          activeOrchestrationCount++;
        }
      }
    }
    return {
      id: s.localId,
      cliSessionId: s.cliSessionId || null,
      title: s.title || "New Session",
      active: isActive,
      isProcessing: s.isProcessing,
      lastActivity: s.lastActivity || s.createdAt || 0,
      lastViewedAt: s.lastViewedAt || 0,
      loop: loop,
      ownerId: s.ownerId || null,
      sessionVisibility: s.sessionVisibility || "shared",
      bookmarked: !!s.bookmarked,
      favoriteOrder: typeof s.favoriteOrder === "number" ? s.favoriteOrder : null,
      unread: unreadMap[s.localId] || 0,
      vendor: s.vendor || null,
      providerRouteId: s.providerRouteId || null,
      model: s.model || null,
      automationMode: getEffectiveAutomationMode(s),
      permissionMode: s.permissionMode || null,
      codexApproval: s.codexApproval || null,
      codexSandbox: s.codexSandbox || null,
      codexWebSearch: s.codexWebSearch || null,
      mode: s.mode || "gui",
      terminalId: typeof s.terminalId === "number" ? s.terminalId : null,
      runtimeMode: s.runtimeMode || null,
      runtimeTerminalId: typeof s.runtimeTerminalId === "number" ? s.runtimeTerminalId : null,
      taskLauncher: s.taskLauncher ? {
        autoLaunch: !!s.taskLauncher.autoLaunch,
        kind: s.taskLauncher.autoKind || "issue",
        completed: !!s.taskLauncher.workflowCompleted,
      } : null,
      coordinationMode: !!s.coordinationMode,
      orchestrationActiveCount: activeOrchestrationCount,
      orchestrationParent: s.orchestrationParent ? {
        taskId: s.orchestrationParent.taskId,
        sessionId: s.orchestrationParent.sessionId,
      } : null,
      orchestrationAdoption: s.orchestrationAdoption || null,
    };
  }

  function broadcastSessionList() {
    if (sessionListBroadcastTimer) return;
    sessionListBroadcastTimer = setTimeout(function () {
      sessionListBroadcastTimer = null;
      broadcastSessionListNow();
    }, SESSION_LIST_BROADCAST_DEBOUNCE_MS);
    if (sessionListBroadcastTimer.unref) sessionListBroadcastTimer.unref();
  }

  function broadcastSessionListNow() {
    var allVisible = getVisibleSessions();
    if (sendEach) {
      var recipients = [];
      var canSharePayload = true;
      sendEach(function (ws, filterFn) {
        if (!ws || ws.readyState !== 1) return;
        recipients.push({ ws: ws, filterFn: filterFn });
        if (filterFn) canSharePayload = false;
        if (typeof ws._clayActiveSession === "number" && ws._clayActiveSession !== getActiveSessionId()) canSharePayload = false;
        if (ws._clayUnread && Object.keys(ws._clayUnread).length > 0) canSharePayload = false;
      });
      if (canSharePayload) {
        var sharedPayload = JSON.stringify({
          type: "session_list",
          sessions: allVisible.map(function (s) { return mapSessionForClient(s); }),
        });
        for (var i = 0; i < recipients.length; i++) {
          try { recipients[i].ws.send(sharedPayload); } catch (e) {}
        }
        return;
      }
      for (var r = 0; r < recipients.length; r++) {
        var rec = recipients[r];
        var filtered = rec.filterFn ? allVisible.filter(rec.filterFn) : allVisible;
        var clientActiveId = rec.ws._clayActiveSession;
        var wsUnread = rec.ws._clayUnread || {};
        try {
          rec.ws.send(JSON.stringify({
            type: "session_list",
            sessions: filtered.map(function (s) { return mapSessionForClient(s, clientActiveId, wsUnread); }),
          }));
        } catch (e2) {}
      }
    } else {
      send({
        type: "session_list",
        sessions: allVisible.map(function (s) { return mapSessionForClient(s); }),
      });
    }
  }

  return {
    broadcastSessionList: broadcastSessionList,
    setResolveLoopInfo: setResolveLoopInfo,
  };
}

module.exports = {
  attachSessionBroadcast: attachSessionBroadcast,
};
