var orchestrationTaskState = require("./orchestration-task-state");
var coopChannels = require("./project-coop-channels");
var { isCoopControlled } = require("./coop-control-provenance");

function resolveClientLoop(session, resolveLoopInfo) {
  var loop = session.loop ? Object.assign({}, session.loop) : null;
  if (!loop || !loop.loopId || !resolveLoopInfo) return loop;
  var info = resolveLoopInfo(loop.loopId);
  if (!info) return loop;
  if (info.name) loop.name = info.name;
  if (info.source) loop.source = info.source;
  return loop;
}

function isClientActiveSession(session, clientActiveId, activeSessionId) {
  if (typeof clientActiveId === "number") return session.localId === clientActiveId;
  return session.localId === activeSessionId;
}

function isActiveOrchestrationStatus(status) {
  return status === "queued" || status === "ready" ||
    status === "running" || status === "reviewing";
}

function countActiveOrchestrationTasks(session) {
  var activeOrchestrationCount = 0;
  if (!Array.isArray(session.orchestrationTasks)) return activeOrchestrationCount;
  for (var oi = 0; oi < session.orchestrationTasks.length; oi++) {
    var orchestrationStatus = session.orchestrationTasks[oi] && session.orchestrationTasks[oi].status;
    if (isActiveOrchestrationStatus(orchestrationStatus)) activeOrchestrationCount++;
  }
  return activeOrchestrationCount;
}

function mapTaskLauncherForClient(taskLauncher) {
  if (!taskLauncher) return null;
  return {
    autoLaunch: !!taskLauncher.autoLaunch,
    kind: taskLauncher.autoKind || "issue",
    completed: !!taskLauncher.workflowCompleted,
  };
}

function sessionIdentityFields(session, isActive) {
  return {
    id: session.localId,
    cliSessionId: session.cliSessionId || null,
    title: session.title || "New Session",
    coopHome: !!session.coopHome,
    coopChannel: coopChannels.channelForClient(session.coopChannel),
    active: isActive,
    isProcessing: session.isProcessing,
    lastActivity: session.lastActivity || session.createdAt || 0,
    lastViewedAt: session.lastViewedAt || 0,
  };
}

function sessionOwnershipFields(session, unreadMap) {
  return {
    ownerId: session.ownerId || null,
    leadOwned: isCoopControlled(session),
    sessionVisibility: session.sessionVisibility || "shared",
    bookmarked: !!session.bookmarked,
    favoriteOrder: typeof session.favoriteOrder === "number" ? session.favoriteOrder : null,
    unread: unreadMap[session.localId] || 0,
  };
}

function sessionProviderFields(session, getEffectiveAutomationMode) {
  return {
    vendor: session.vendor || null,
    providerRouteId: session.providerRouteId || null,
    model: session.model || null,
    automationMode: getEffectiveAutomationMode(session),
    permissionMode: session.permissionMode || null,
    codexApproval: session.codexApproval || null,
    codexSandbox: session.codexSandbox || null,
    codexWebSearch: session.codexWebSearch || null,
  };
}

function sessionRuntimeFields(session) {
  return {
    mode: session.mode || "gui",
    terminalId: typeof session.terminalId === "number" ? session.terminalId : null,
    runtimeMode: session.runtimeMode || null,
    runtimeTerminalId: typeof session.runtimeTerminalId === "number" ? session.runtimeTerminalId : null,
    taskLauncher: mapTaskLauncherForClient(session.taskLauncher),
  };
}

function sessionOrchestrationFields(session, orchestrationGroups, activeOrchestrationCount) {
  var state = orchestrationTaskState.orchestrationStateForClient(session);
  return {
    coordinationMode: !!session.coordinationMode,
    demotionPending: !!session.demoteCoordinatorWhenIdle,
    orchestrationActiveCount: activeOrchestrationCount,
    orchestrationPhase: state.phase,
    orchestrationUnresolvedCount: state.metrics.unresolved,
    orchestrationParent: orchestrationTaskState.orchestrationParentForClient(session),
    orchestrationGroupParent: orchestrationTaskState.orchestrationGroupParentForClient(session, orchestrationGroups),
    orchestrationAdoption: session.orchestrationAdoption || null,
  };
}

function attachSessionBroadcast(ctx) {
  var projectSlug = ctx.projectSlug || "";
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

  function mapSessionForClient(s, clientActiveId, wsUnread, orchestrationGroups) {
    var loop = resolveClientLoop(s, resolveLoopInfo);
    var activeSessionId = getActiveSessionId();
    var isActive = isClientActiveSession(s, clientActiveId, activeSessionId);
    var unreadMap = wsUnread || getSingleUserUnread();
    var activeOrchestrationCount = countActiveOrchestrationTasks(s);
    return Object.assign(sessionIdentityFields(s, isActive),
      { loop: loop },
      sessionOwnershipFields(s, unreadMap),
      sessionProviderFields(s, getEffectiveAutomationMode),
      sessionRuntimeFields(s),
      sessionOrchestrationFields(s, orchestrationGroups, activeOrchestrationCount));
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
        var sharedGroups = orchestrationTaskState.buildOrchestrationSessionGroups(allVisible);
        var sharedPayload = JSON.stringify({
          type: "session_list",
          projectSlug: projectSlug,
          sessions: allVisible.map(function (s) { return mapSessionForClient(s, null, null, sharedGroups); }),
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
        var filteredGroups = orchestrationTaskState.buildOrchestrationSessionGroups(filtered);
        try {
          rec.ws.send(JSON.stringify({
            type: "session_list",
            projectSlug: projectSlug,
            sessions: filtered.map(function (s) {
              return mapSessionForClient(s, clientActiveId, wsUnread, filteredGroups);
            }),
          }));
        } catch (e2) {}
      }
    } else {
      var groups = orchestrationTaskState.buildOrchestrationSessionGroups(allVisible);
      send({
        type: "session_list",
        projectSlug: projectSlug,
        sessions: allVisible.map(function (s) { return mapSessionForClient(s, null, null, groups); }),
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
