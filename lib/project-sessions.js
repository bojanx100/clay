var crypto = require("crypto");
var { execFileSync } = require("child_process");
var { CODEX_DEFAULTS, getCodexConfig } = require("./codex-defaults");
var {
  normalizeAutomationMode,
  claudePermissionForAutomation,
  automationForClaudePermission,
  codexConfigForAutomation,
  automationForCodexConfig,
  automationForSession,
} = require("./automation-modes");
var { withClaudeFallbackModels } = require("./claude-defaults");
var { buildHandoffContext } = require("./handoff-context");
var { listProviderRoutes, routeForId, routeForVendor, knownModelsForProvider, knownModelsForRoute } = require("./provider-routes");
var { attachProjectSessionsConfig } = require("./project-sessions-config");
var { attachProjectSessionsGitAccounts } = require("./project-sessions-git-accounts");
var { attachProjectSessionsHistory } = require("./project-sessions-history");
var { attachProjectSessionsLive } = require("./project-sessions-live");
var { attachProjectSessionsPermissions } = require("./project-sessions-permissions");
var { attachProjectSessionsProjects } = require("./project-sessions-projects");
var { attachProjectSessionsRecords } = require("./project-sessions-records");
var { attachProjectSessionsRewind } = require("./project-sessions-rewind");
var { attachProjectSessionsSearch } = require("./project-sessions-search");
var { attachProjectSessionsSettings } = require("./project-sessions-settings");
var { attachProjectSessionsUserState } = require("./project-sessions-user-state");
var yoke = require("./yoke");
var tombstones = require("./tombstones");

/**
 * Attach session management, config, project management, and mid-section
 * message handlers to a project context.
 *
 * ctx fields:
 *   cwd, slug, isMate, osUsers, debug, dangerouslySkipPermissions, currentVersion,
 *   sm, sdk, tm, clients,
 *   send, sendTo, sendToAdmins, sendToSession, sendToSessionOthers,
 *   opts, usersModule, userPresence, matesModule, pushModule,
 *   getSessionForWs, getLinuxUserForSession, ensureProjectAccessForSession, getOsUserInfoForWs,
 *   hydrateImageRefs, onProcessingChanged, broadcastPresence,
 *   adapter, getProjectList, getProjectCount, getScheduleCount,
 *   moveScheduleToProject, moveAllSchedulesToProject, getHubSchedules,
 *   fetchVersion, isNewer, onCreateWorktree, IGNORED_DIRS,
 *   scheduleMessage, cancelScheduledMessage,
 *   getProjectOwnerId, setProjectOwnerId,
 *   getUpdateChannel, setUpdateChannel,
 *   getLatestVersion, setLatestVersion
 */
function attachSessions(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var isMate = ctx.isMate;
  var osUsers = ctx.osUsers;
  var currentVersion = ctx.currentVersion;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var tm = ctx.tm;
  var clients = ctx.clients;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToAdmins = ctx.sendToAdmins;
  var sendToSession = ctx.sendToSession;
  var sendToSessionOthers = ctx.sendToSessionOthers;
  var opts = ctx.opts;
  var usersModule = ctx.usersModule;
  var userPresence = ctx.userPresence;
  var pushModule = ctx.pushModule;
  var imagesDir = ctx.imagesDir || null;
  var getSessionForWs = ctx.getSessionForWs;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var onProcessingChanged = ctx.onProcessingChanged;
  var broadcastPresence = ctx.broadcastPresence;
  var adapter = ctx.adapter;
  var adapters = ctx.adapters || {};
  var clayPort = ctx.clayPort || null;
  var clayTls = ctx.clayTls || false;
  var clayAuthToken = ctx.clayAuthToken || "";
  var getProjectList = ctx.getProjectList;
  var getProjectCount = ctx.getProjectCount;
  var getScheduleCount = ctx.getScheduleCount;
  var moveScheduleToProject = ctx.moveScheduleToProject;
  var moveAllSchedulesToProject = ctx.moveAllSchedulesToProject;
  var getHubSchedules = ctx.getHubSchedules;
  var fetchVersion = ctx.fetchVersion;
  var isNewer = ctx.isNewer;
  var onCreateWorktree = ctx.onCreateWorktree;
  var IGNORED_DIRS = ctx.IGNORED_DIRS;
  var scheduleMessage = ctx.scheduleMessage;
  var cancelScheduledMessage = ctx.cancelScheduledMessage;
  var getProjectOwnerId = ctx.getProjectOwnerId;
  var setProjectOwnerId = ctx.setProjectOwnerId;
  var getUpdateChannel = ctx.getUpdateChannel;
  var setUpdateChannel = ctx.setUpdateChannel;
  var getLatestVersion = ctx.getLatestVersion;
  var setLatestVersion = ctx.setLatestVersion;
  var loadContextSources = ctx.loadContextSources;
  var saveContextSources = ctx.saveContextSources;
  var compactAndContinue = ctx.compactAndContinue || null;
  var configHandlers = attachProjectSessionsConfig({
    currentVersion: currentVersion,
    sm: sm,
    tm: tm,
    clients: clients,
    send: send,
    sendTo: sendTo,
    sendToAdmins: sendToAdmins,
    opts: opts,
    usersModule: usersModule,
    fetchVersion: fetchVersion,
    isNewer: isNewer,
    getUpdateChannel: getUpdateChannel,
    setUpdateChannel: setUpdateChannel,
    getLatestVersion: getLatestVersion,
    setLatestVersion: setLatestVersion,
  });
  var searchHandlers = attachProjectSessionsSearch({
    sm: sm,
    sendTo: sendTo,
    getSessionForWs: getSessionForWs,
  });
  var projectHandlers = attachProjectSessionsProjects({
    cwd: cwd,
    slug: slug,
    osUsers: osUsers,
    sm: sm,
    send: send,
    sendTo: sendTo,
    opts: opts,
    usersModule: usersModule,
    moveScheduleToProject: moveScheduleToProject,
    moveAllSchedulesToProject: moveAllSchedulesToProject,
    getHubSchedules: getHubSchedules,
    getScheduleCount: getScheduleCount,
    onCreateWorktree: onCreateWorktree,
    IGNORED_DIRS: IGNORED_DIRS,
    getProjectOwnerId: getProjectOwnerId,
    setProjectOwnerId: setProjectOwnerId,
  });
  var recordsHandlers = attachProjectSessionsRecords({
    cwd: cwd,
    slug: slug,
    osUsers: osUsers,
    sm: sm,
    tm: tm,
    sendTo: sendTo,
    usersModule: usersModule,
    userPresence: userPresence,
    adapter: adapter,
    loadContextSources: loadContextSources,
    stopTitleWatcher: stopTitleWatcher,
  });
  var historyHandlers = attachProjectSessionsHistory({
    sm: sm,
    sendTo: sendTo,
    getSessionForWs: getSessionForWs,
    hydrateImageRefs: hydrateImageRefs,
    compactAndContinue: compactAndContinue,
  });
  var gitAccountHandlers = attachProjectSessionsGitAccounts({
    opts: opts,
    sendTo: sendTo,
  });
  var settingsHandlers = attachProjectSessionsSettings({
    slug: slug,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    opts: opts,
    getSessionForWs: getSessionForWs,
    sendConfigForSession: sendConfigForSession,
    applyAutomationModeToSession: applyAutomationModeToSession,
    copilotRouteIdForModel: copilotRouteIdForModel,
    isKnownCodexSession: isKnownCodexSession,
  });
  var rewindHandlers = attachProjectSessionsRewind({
    cwd: cwd,
    sm: sm,
    sdk: sdk,
    sendTo: sendTo,
    getSessionForWs: getSessionForWs,
    onProcessingChanged: onProcessingChanged,
    hydrateImageRefs: hydrateImageRefs,
    resolveSessionHome: resolveSessionHome,
  });
  var liveHandlers = attachProjectSessionsLive({
    sm: sm,
    sdk: sdk,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    usersModule: usersModule,
    pushModule: pushModule,
    getSessionForWs: getSessionForWs,
    clearPendingQueuedMessages: clearPendingQueuedMessages,
  });
  var permissionHandlers = attachProjectSessionsPermissions({
    osUsers: osUsers,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    usersModule: usersModule,
    getSessionForWs: getSessionForWs,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    onProcessingChanged: onProcessingChanged,
  });
  var userStateHandlers = attachProjectSessionsUserState({
    slug: slug,
    isMate: isMate,
    sendTo: sendTo,
    usersModule: usersModule,
    userPresence: userPresence,
  });

  // Resolve the active user's Claude open-mode preference ('gui' or 'tui').
  // Multi-user mode reads per-user storage; single-user mode falls back to
  // the daemon-level default ('gui').
  function getClaudeOpenModeForWs(ws) {
    var defaultMode = (usersModule && typeof usersModule.defaultClaudeOpenMode === "function") ? usersModule.defaultClaudeOpenMode() : "gui";
    if (!usersModule || typeof usersModule.getClaudeOpenMode !== "function") return defaultMode;
    var uid = ws && ws._clayUser ? ws._clayUser.id : null;
    if (!uid) return defaultMode;
    try { return usersModule.getClaudeOpenMode(uid) || defaultMode; } catch (e) { return defaultMode; }
  }

  // Resolve the home directory where Claude Code writes JSONL for a
  // given session. In OS-isolation mode each Clay user runs as a real
  // Linux account so JSONL lives under /home/clay-name; for single-user
  // installs we fall back to the daemon's own home.
  function resolveSessionHome(session) {
    var home = null;
    if (osUsers && session && session.ownerId) {
      try {
        var ownerUser = usersModule.findUserById ? usersModule.findUserById(session.ownerId) : null;
        if (ownerUser && ownerUser.linuxUser) {
          var info = require("./os-users").resolveOsUserInfo(ownerUser.linuxUser);
          if (info && info.home) home = info.home;
        }
      } catch (e) {}
    }
    return home || require("os").homedir();
  }

  // Watch the per-session jsonl Claude Code writes and mirror its auto /
  // user titles into Clay's session.title. Lets TUI sessions move past the
  // generic "New Session" label without us having to scrape the PTY output.
  // The watcher is started lazily (on TUI session creation / first click
  // after restart) and torn down on session delete via _titleWatcherStop.
  function startTitleWatcher(session) {
    if (!session || !session.cliSessionId) return;
    if (session._titleWatcherStop) return; // already watching
    var watcher;
    try { watcher = require("./claude-jsonl-watcher"); } catch (e) { return; }
    var home = resolveSessionHome(session);
    var jsonlPath = watcher.jsonlPathFor(home, cwd, session.cliSessionId);
    if (!jsonlPath) return;
    var localId = session.localId;
    var stop = watcher.start(jsonlPath, {
      onTitle: function (title) {
        var s = sm.sessions.get(localId);
        if (!s) return;
        if (s.titleManuallySet) return;
        var clean = String(title || "").trim().substring(0, 200);
        if (!clean || s.title === clean) return;
        s.title = clean;
        s.titleAutoGenerated = true;
        try { sm.saveSessionFile(s); } catch (e) {}
        try { sm.broadcastSessionList(); } catch (e) {}
      },
      // Fire a notification with the response preview so the user sees
      // claude's reply surface in the notification center / banner the
      // same way SDK sessions do via response_done. We piggyback on the
      // existing tui_attention type so the Open here / Go to session
      // buttons keep working.
      onResponse: function (text) {
        var s = sm.sessions.get(localId);
        if (!s) return;
        var preview = String(text || "").trim();
        if (!preview) return;
        // First-line preview, capped so the banner stays compact.
        var firstLine = preview.split("\n")[0];
        if (firstLine.length > 200) firstLine = firstLine.substring(0, 200) + "...";
        var termId = (typeof s.runtimeTerminalId === "number")
          ? s.runtimeTerminalId
          : (typeof s.terminalId === "number" ? s.terminalId : null);
        // Don't banner a session someone is already watching — they can see
        // the reply in the TUI. Gate at the source (server) rather than relying
        // on the client's activeSessionId suppression, which isn't reliable for
        // TUI sessions and lets banners pile up for the session in view.
        var beingViewed = false;
        for (var vws of clients) {
          if (vws.readyState === 1 && vws._clayActiveSession === s.localId) {
            beingViewed = true;
            break;
          }
        }
        if (!beingViewed) {
          try {
            ctx._notifications && ctx._notifications.notify("tui_attention", {
              slug: slug,
              sessionId: s.localId,
              ownerId: s.ownerId || null,
              targetUserId: s.ownerId || null,
              title: "Claude responded",
              body: firstLine,
              terminalId: termId,
              sessionTitle: s.title || "",
              cliSessionId: s.cliSessionId || null,
            });
          } catch (e) {}
        }
        // Re-read the assistant text index and broadcast it so any client
        // with this session in view can wire hover-to-grab onto the new
        // message right away. The transcript is small enough that a full
        // re-send beats maintaining a delta protocol.
        try {
          var newIndex = require("./tui-transcript-index").readAssistantIndex(resolveSessionHome(s), cwd, s.cliSessionId);
          send({
            type: "tui_transcript_state",
            id: s.localId,
            cliSessionId: s.cliSessionId,
            messages: newIndex.messages,
          });
        } catch (e) {}
      },
    });
    session._titleWatcherStop = stop;
  }

  function stopTitleWatcher(session) {
    if (session && typeof session._titleWatcherStop === "function") {
      try { session._titleWatcherStop(); } catch (e) {}
      session._titleWatcherStop = null;
    }
  }

  // Kick off watchers for any TUI sessions already loaded from disk so
  // their titles refresh as soon as Claude Code rewrites the jsonl, even
  // before the user clicks them.
  try {
    sm.sessions.forEach(function (s) {
      if (s.mode === "tui" && s.cliSessionId) startTitleWatcher(s);
    });
  } catch (e) {}

  // Build a PTY onData hook that mirrors SDK-style isProcessing onto the
  // Clay session record. Each output chunk marks isProcessing=true; after
  // 500ms of quiet we flip back to false. State transitions broadcast the
  // session list so the sidebar / icon-strip processing dot picks it up.
  // We track the timer on the session record itself so it can be cleared
  // on delete / mode flip without holding a separate map.
  var TUI_QUIET_MS = 500;
  function makeTuiActivityHook(localId) {
    return function onPtyData() {
      var s = sm.sessions.get(localId);
      if (!s) return;
      if (!s.isProcessing) {
        s.isProcessing = true;
        try { sm.broadcastSessionList(); } catch (e) {}
        try { if (typeof onProcessingChanged === "function") onProcessingChanged(s); } catch (e) {}
      }
      if (s._tuiQuietTimer) clearTimeout(s._tuiQuietTimer);
      s._tuiQuietTimer = setTimeout(function () {
        var s2 = sm.sessions.get(localId);
        if (!s2) return;
        s2._tuiQuietTimer = null;
        if (s2.isProcessing) {
          s2.isProcessing = false;
          try { sm.broadcastSessionList(); } catch (e) {}
          try { if (typeof onProcessingChanged === "function") onProcessingChanged(s2); } catch (e) {}
        }
      }, TUI_QUIET_MS);
    };
  }

  // Spawn a transient PTY for "view this Claude GUI session as TUI" (the
  // user's claudeOpenMode is 'tui'). The session itself stays a GUI session
  // on disk; we only attach a runtime terminal so xterm can render
  // `claude --resume <cliSessionId>`. When the PTY dies the runtime link
  // clears and the next click can re-attach without converting the session.
  function spawnRuntimeTuiPty(session, ws) {
    if (!tm || !session || !session.cliSessionId) return null;
    if (typeof session.runtimeTerminalId === "number" && tm.has(session.runtimeTerminalId)) {
      // A previous click already spawned one and it's still alive; reuse
      // it. tm.attach will replay scrollback on the new client subscription.
      return session.runtimeTerminalId;
    }
    var sid = session.cliSessionId;
    var localId = session.localId;
    var cmd = "claude --resume " + sid + claudePermissionFlagForSession(session) + "; exit\n";
    var term = tm.create(80, 24, getOsUserInfoForWs(ws), ws, {
      initialInput: cmd,
      kind: "tui-session",
      title: "claude (resume) " + sid.slice(0, 8),
      onExit: function () {
        // Don't delete the session record - the underlying GUI session is
        // still real. Just drop the runtime link so the sidebar/icon can
        // refresh.
        var s = sm.sessions.get(localId);
        if (s) {
          s.runtimeTerminalId = null;
          try { sm.broadcastSessionList(); } catch (e) {}
        }
      },
      onData: makeTuiActivityHook(localId),
    });
    if (term) {
      session.runtimeTerminalId = term.id;
      return term.id;
    }
    return null;
  }

  function claudePermissionFlagForSession(session) {
    if (!session) return "";
    if (session.dangerouslySkipPermissions) return " --dangerously-skip-permissions";
    var mode = session.permissionMode || claudePermissionForAutomation(session.automationMode);
    if (mode && mode !== "default") return " --permission-mode " + mode;
    return "";
  }

  function claudeModelFlagForSession(session) {
    if (!session || !session.model || session.model === "default") return "";
    return " --model " + session.model;
  }

  function currentSessionAutomationMode(session) {
    return automationForSession(session, sm.currentPermissionMode || "default", getCodexConfig(sm, session));
  }

  function getServerDefaultCodexConfig() {
    return Object.assign({}, sm.serverDefaultCodexConfig || {
      approval: CODEX_DEFAULTS.approval,
      sandbox: CODEX_DEFAULTS.sandbox,
      webSearch: CODEX_DEFAULTS.webSearch,
    });
  }

  function modelEntryValue(model) {
    if (!model) return "";
    if (typeof model === "string") return model;
    return model.value || model.id || "";
  }

  function canonicalModelId(model) {
    return modelEntryValue(model).toLowerCase().replace(/[-.]/g, "");
  }

  function resolveModelForVendor(vendor, model, provider) {
    if (!vendor || !model) return null;
    var models = (sm.modelsByVendor && sm.modelsByVendor[vendor]) || [];
    if (provider) {
      var knownModels = knownModelsForProvider(provider);
      if (knownModels.length > 0) {
        var combined = models.slice();
        var seen = {};
        for (var mi = 0; mi < combined.length; mi++) {
          seen[canonicalModelId(combined[mi])] = true;
        }
        for (var ki = 0; ki < knownModels.length; ki++) {
          var known = knownModels[ki];
          if (!seen[canonicalModelId(known)]) combined.push(known);
        }
        models = combined;
      }
    }
    if (vendor === "claude") models = withClaudeFallbackModels(models);
    var wanted = canonicalModelId(model);
    for (var i = 0; i < models.length; i++) {
      var value = modelEntryValue(models[i]);
      if (value === model || canonicalModelId(value) === wanted) return value;
    }
    return null;
  }

  function vendorHasModel(vendor, model, provider) {
    return !!resolveModelForVendor(vendor, model, provider);
  }

  function modelsForRoute(route, vendor) {
    var list = (sm.modelsByVendor && sm.modelsByVendor[vendor]) || [];
    if (route) {
      var known = vendor === "github-copilot" ? knownModelsForProvider(route.provider) : knownModelsForRoute(route);
      if (known.length > 0) list = known;
    }
    if (vendor === "claude") list = withClaudeFallbackModels(list);
    return list;
  }

  function modelMatchesRouteFamily(model, targetRoute) {
    if (!model || !targetRoute || !targetRoute.modelFamily) return true;
    if (model === "auto" || model === "default") return false;
    if (targetRoute.modelFamily === "claude") return model.indexOf("claude-") === 0;
    if (targetRoute.modelFamily === "gpt") return model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1;
    return true;
  }

  function familyForModel(model) {
    if (!model) return "";
    if (model.indexOf("claude-") === 0) return "claude";
    if (model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1) return "gpt";
    return "";
  }

  function familyForRouteId(routeId) {
    var route = routeId ? routeForId(routeId) : null;
    return route && route.modelFamily ? route.modelFamily : "";
  }

  function sourceModelForHandoff(sourceSession) {
    if (!sourceSession) return null;
    var sourceModel = sourceSession.verifiedModel || sourceSession.requestedModel || sourceSession.model || null;
    if (!sourceModel || sourceModel === "default") return null;
    var currentRoute = sourceSession.providerRouteId ? routeForId(sourceSession.providerRouteId) : null;
    if (currentRoute && !modelMatchesRouteFamily(sourceModel, currentRoute)) return null;
    return sourceModel;
  }

  function routeForHandoffTarget(toVendor, sourceSession, requestedRouteId, requestedModel) {
    if (requestedRouteId) return routeForId(requestedRouteId);
    if (toVendor !== "github-copilot") return routeForVendor(toVendor);
    var sourceModel = sourceModelForHandoff(sourceSession) || requestedModel || "";
    var family = familyForModel(sourceModel);
    if (!family) family = familyForRouteId((sourceSession && sourceSession.providerRouteId) || null);
    if (!family && sourceSession && sourceSession.vendor === "claude") family = "claude";
    if (!family && sourceSession && sourceSession.vendor === "codex") family = "gpt";
    if (family === "claude") return routeForId("claude-github-copilot");
    return routeForId("codex-github-copilot");
  }

  function copilotRouteIdForModel(model) {
    var family = familyForModel(model);
    if (family === "claude") return "claude-github-copilot";
    if (family === "gpt") return "codex-github-copilot";
    return null;
  }

  function clearPendingQueuedMessages(session) {
    if (!session) return;
    session.pendingUserMessageQueue = [];
    if (Array.isArray(session.history)) {
      var nextHistory = [];
      for (var i = 0; i < session.history.length; i++) {
        var item = session.history[i];
        if (item && item.type === "user_message" && item.queuedPending) continue;
        nextHistory.push(item);
      }
      session.history = nextHistory;
    }
    sm.saveSessionFile(session);
  }

  function familyDefaultVendor(targetRoute) {
    if (!targetRoute) return null;
    if (targetRoute.modelFamily === "gpt") return "codex";
    if (targetRoute.modelFamily === "claude") return "claude";
    return targetRoute.vendor;
  }

  function routeDefaultCandidates(targetRoute) {
    var candidates = [];
    if (!targetRoute) return candidates;
    var familyVendor = familyDefaultVendor(targetRoute);
    if (familyVendor && sm.serverDefaultModelsByVendor && sm.serverDefaultModelsByVendor[familyVendor]) candidates.push(sm.serverDefaultModelsByVendor[familyVendor]);
    if (sm.serverDefaultModelsByVendor && sm.serverDefaultModelsByVendor[targetRoute.vendor]) candidates.push(sm.serverDefaultModelsByVendor[targetRoute.vendor]);
    if (familyVendor && sm.defaultModelsByVendor && sm.defaultModelsByVendor[familyVendor]) candidates.push(sm.defaultModelsByVendor[familyVendor]);
    if (sm.defaultModelsByVendor && sm.defaultModelsByVendor[targetRoute.vendor]) candidates.push(sm.defaultModelsByVendor[targetRoute.vendor]);
    if (targetRoute.defaultModel) candidates.push(targetRoute.defaultModel);
    if (targetRoute.vendor === "claude") candidates.push("default");
    return candidates;
  }

  function defaultModelForRoute(targetRoute) {
    var candidates = routeDefaultCandidates(targetRoute);
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!candidate) continue;
      if (!modelMatchesRouteFamily(candidate, targetRoute)) continue;
      var resolved = resolveModelForVendor(targetRoute.vendor, candidate, targetRoute.provider);
      if (resolved) return resolved;
    }
    if (targetRoute && targetRoute.vendor === "claude") return "default";
    return null;
  }

  function modelForHandoff(sourceSession, targetRoute, requestedModel) {
    var preferredModel = requestedModel && requestedModel !== "default" ? requestedModel : null;
    if (preferredModel && targetRoute && modelMatchesRouteFamily(preferredModel, targetRoute)) {
      var resolvedPreferred = resolveModelForVendor(targetRoute.vendor, preferredModel, targetRoute.provider);
      if (resolvedPreferred) return resolvedPreferred;
    }
    var sourceModel = sourceModelForHandoff(sourceSession);
    var currentModel = sourceModel && sourceModel !== "default" ? sourceModel : null;
    if (currentModel && targetRoute && modelMatchesRouteFamily(currentModel, targetRoute)) {
      var resolvedCurrent = resolveModelForVendor(targetRoute.vendor, currentModel, targetRoute.provider);
      if (resolvedCurrent) return resolvedCurrent;
    }
    if (targetRoute) return defaultModelForRoute(targetRoute);
    return currentModel;
  }

  function normalizeSessionRouteModel(session) {
    if (!session || !session.providerRouteId) return;
    var route = routeForId(session.providerRouteId);
    if (!route) return;
    var defaultModel = defaultModelForRoute(route);
    if (!defaultModel) return;
    var model = session.model && session.model !== "default" ? session.model : null;
    if (model && modelMatchesRouteFamily(model, route) && vendorHasModel(route.vendor, model, route.provider)) return;
    session.model = defaultModel;
  }

  function configStateForSession(session) {
    normalizeSessionRouteModel(session);
    return {
      type: "config_state",
      model: (session && session.model) || sm.currentModel || "",
      mode: (session && session.permissionMode) || sm.currentPermissionMode || "default",
      automationMode: currentSessionAutomationMode(session),
      effort: sm.currentEffort || "medium",
      betas: sm.currentBetas || [],
      thinking: sm.currentThinking || "adaptive",
      thinkingBudget: sm.currentThinkingBudget || 10000,
    };
  }

  function sendConfigForSession(ws, session) {
    var configMsg = configStateForSession(session);
    if (ws) sendTo(ws, configMsg);
    else send(configMsg);
    var codexMsg = Object.assign({ type: "codex_config", automationMode: currentSessionAutomationMode(session) }, getCodexConfig(sm, session));
    if (ws) sendTo(ws, codexMsg);
    else send(codexMsg);
  }

  function applyAutomationModeToSession(session, mode) {
    var normalized = normalizeAutomationMode(mode);
    session.automationMode = normalized;
    if (session.vendor === "codex") {
      var codexConfig = codexConfigForAutomation(normalized);
      session.permissionMode = normalized === "full" ? "bypassPermissions" : "default";
      session.codexApproval = codexConfig.approval;
      session.codexSandbox = codexConfig.sandbox;
      sm.currentPermissionMode = session.permissionMode;
      sm.codexApproval = codexConfig.approval;
      sm.codexSandbox = codexConfig.sandbox;
    } else {
      var claudeMode = claudePermissionForAutomation(normalized);
      session.permissionMode = claudeMode;
      sm.currentPermissionMode = claudeMode;
      session.dangerouslySkipPermissions = claudeMode === "bypassPermissions";
    }
  }

  function hasUnclosedScheduledMessage(session) {
    if (!session || !Array.isArray(session.history)) return false;
    for (var i = session.history.length - 1; i >= 0; i--) {
      var item = session.history[i];
      if (!item) continue;
      if (item.type === "scheduled_message_sent" || item.type === "scheduled_message_cancelled" || item.type === "vendor_switched") return false;
      if (item.type === "scheduled_message_queued") return true;
    }
    return false;
  }

  function installedVendorList() {
    var installed = yoke.checkInstalled();
    var names = Object.keys(installed);
    var result = [];
    for (var i = 0; i < names.length; i++) {
      if (installed[names[i]]) result.push(names[i]);
    }
    return result;
  }

  function refreshVendorState(ws) {
    (async function () {
      yoke.invalidateAuthCache();
      var installed = installedVendorList();
      for (var i = 0; i < installed.length; i++) {
        var vendor = installed[i];
        if (adapters[vendor]) continue;
        await yoke.lazyCreateAdapter(adapters, vendor, {
          cwd: cwd,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });
      }
      sm.availableVendors = Object.keys(adapters);
      sm.installedVendors = installed;
      sm.providerRoutes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
      var currentVendor = (getSessionForWs(ws) && getSessionForWs(ws).vendor) || sm.defaultVendor || "claude";
      var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[currentVendor]) || [];
      if (currentVendor === "claude") vendorModels = withClaudeFallbackModels(vendorModels);
      sendTo(ws, {
        type: "model_info",
        model: "",
        models: vendorModels,
        vendor: currentVendor,
        availableVendors: sm.availableVendors || [],
        installedVendors: sm.installedVendors || [],
        providerRoutes: sm.providerRoutes || [],
      });
      sendTo(ws, { type: "toast", level: "info", message: "Vendor status refreshed" });
    })().catch(function (e) {
      sendTo(ws, { type: "toast", level: "warn", message: "Vendor refresh failed", detail: e.message || String(e) });
    });
  }

  // Prepare a born-TUI session to be rendered via the SDK GUI chat for the
  // current click. Reads the CLI jsonl transcript (cli-sessions.js),
  // populates session.history, and tears
  // down the PTY. The born-TUI marker (session.mode === 'tui') is kept on
  // disk so that flipping claudeOpenMode back to 'tui' later restores the
  // embedded-terminal experience instead of locking the session as GUI.
  //
  // Idempotent: if the PTY is already gone and history is populated, this
  // is a no-op (avoids re-reading jsonl and re-writing the session file on
  // every click while the user is reading the session in GUI mode).
  function prepareTuiSessionForGuiView(session) {
    if (!session || session.cliSessionId == null) return;
    var cliSess;
    try { cliSess = require("./cli-sessions"); } catch (e) { return; }
    // Re-read whenever the jsonl has changed since the last hydrate (a TUI
    // turn appended messages), not just when history is empty. The earlier
    // "already hydrated" short-circuit kept stale history after a
    // Resume -> chat -> Close cycle (showed A instead of A').
    var home = resolveSessionHome(session);
    var mtime = cliSess.cliSessionFileMtime(home, cwd, session.cliSessionId);
    var fresh = (typeof session.terminalId !== "number") &&
                Array.isArray(session.history) && session.history.length > 0 &&
                session._historyMtime === mtime;
    if (fresh) return;
    var history = null;
    // Synchronous read: switch_session must populate session.history before
    // the session_switched broadcast replays it. readCliSessionHistory is
    // Promise-based and would resolve too late (the transcript came up empty).
    try { history = cliSess.readCliSessionHistorySync(home, cwd, session.cliSessionId); } catch (e) { history = null; }
    if (Array.isArray(history)) {
      session.history = history;
      session._historyMtime = mtime;
    }
    if (typeof session.terminalId === "number" && tm) {
      try { tm.close(session.terminalId); } catch (e) {}
    }
    session.terminalId = null;
    try { sm.saveSessionFile(session); } catch (e) {}
  }

  // For imported Codex sessions, hydrate session.history from the rollout the
  // first time the session is viewed (or whenever the rollout's mtime advances).
  // Live Codex GUI sessions build history through doSendAndRecord; only the
  // import path lands here. Text-only stub: user prompts + agent messages.
  function prepareCodexSessionForView(session) {
    if (!session || (!session.cliSessionId && !session.storageId)) return;
    if (session.isProcessing || session.queryInstance) return;
    var cliSess;
    try { cliSess = require("./cli-sessions"); } catch (e) { return; }
    var home = resolveSessionHome(session);
    var threadId = null;
    var mtime = 0;
    var candidates = [];
    if (session.storageId) candidates.push(session.storageId);
    if (session.cliSessionId && session.cliSessionId !== session.storageId) candidates.push(session.cliSessionId);
    for (var ci = 0; ci < candidates.length; ci++) {
      var candidateMtime = cliSess.codexRolloutMtime(home, candidates[ci], cwd);
      if (candidateMtime) {
        threadId = candidates[ci];
        mtime = candidateMtime;
        break;
      }
    }
    if (!mtime) return;
    var hasHistory = Array.isArray(session.history) && session.history.length > 0;
    var fresh = hasHistory && session._historyMtime === mtime;
    if (fresh) return;
    var usingStorageThread = threadId && session.storageId && threadId === session.storageId;
    if (hasHistory && !session._historyMtime && !usingStorageThread) return;
    var history = null;
    try { history = cliSess.readCodexHistorySync(home, threadId, cwd); } catch (e) { history = null; }
    if (Array.isArray(history) && history.length > 0) {
      session.history = history;
      session._historyMtime = mtime;
      try { sm.saveSessionFile(session); } catch (e) {}
    }
  }

  function isKnownCodexSession(session) {
    if (!session || !session.cliSessionId) return false;
    var cliSess;
    try { cliSess = require("./cli-sessions"); } catch (e) { return false; }
    var home = resolveSessionHome(session);
    var mtime = 0;
    try { mtime = cliSess.codexRolloutMtime(home, session.cliSessionId, cwd); } catch (e) { mtime = 0; }
    return !!mtime;
  }

  function prepareCopilotSessionForView(session) {
    if (!session || !session.cliSessionId) return;
    if (session.isProcessing || session.queryInstance) return;
    var copilotSess;
    try { copilotSess = require("./copilot-sessions"); } catch (e) { return; }
    var home = resolveSessionHome(session);
    var mtime = copilotSess.copilotSessionMtime(home, session.cliSessionId, cwd);
    if (!mtime) return;
    var hasHistory = Array.isArray(session.history) && session.history.length > 0;
    if (hasHistory && session._historyMtime === mtime) return;
    if (hasHistory && !session._historyMtime) {
      var hasVendorSwitch = false;
      for (var hi = 0; hi < session.history.length; hi++) {
        if (session.history[hi] && session.history[hi].type === "vendor_switched") {
          hasVendorSwitch = true;
          break;
        }
      }
      if (hasVendorSwitch || (session.storageId && session.storageId !== session.cliSessionId)) return;
    }
    var history = null;
    try { history = copilotSess.readCopilotHistorySync(home, session.cliSessionId, cwd); } catch (e) { history = null; }
    if (Array.isArray(history) && history.length > 0) {
      session.history = history;
      session._historyMtime = mtime;
      try { sm.saveSessionFile(session); } catch (e2) {}
    }
  }

  // Resolve how a session should be presented to a viewer WITHOUT spawning a
  // PTY or broadcasting: set runtimeMode / runtimeTerminalId / tuiSuspended and
  // hydrate the transcript for the read-only and GUI cases. Single source of
  // truth shared by switch_session (which additionally spawns for born-GUI)
  // and the connect/restore path (project-connection.js) so a refreshed
  // born-TUI session shows the same read-only + Resume view as a fresh click.
  function resolveSessionForView(session, ws) {
    if (!session) return;
    if (session.vendor && session.vendor !== "claude") {
      if (session.vendor === "codex") {
        prepareCodexSessionForView(session);
      } else if (session.vendor === "github-copilot") {
        prepareCopilotSessionForView(session);
      }
      session.tuiSuspended = false;
      return;
    }
    var pref = getClaudeOpenModeForWs(ws);
    // A LIVE runtime always wins over the viewer's claudeOpenMode pref:
    // another user (or this user in another tab) may be in the session right
    // now, so we join it in whatever mode it is actually running and never
    // convert or kill it. "tui stays tui, gui stays gui."
    var liveNativePty = tm && typeof session.terminalId === "number" && tm.has(session.terminalId);
    var liveResumePty = tm && typeof session.runtimeTerminalId === "number" && tm.has(session.runtimeTerminalId);
    var liveSdk = !!session.queryInstance || !!session.isProcessing;
    if (liveNativePty) {
      session.runtimeMode = "tui";
      session.runtimeTerminalId = session.terminalId;
      session.tuiSuspended = false;
      return;
    }
    if (liveResumePty) {
      session.runtimeMode = "tui";
      session.tuiSuspended = false;
      return;
    }
    if (liveSdk) {
      // Actively running as a GUI/SDK session - show GUI for everyone.
      session.runtimeMode = (session.mode === "tui") ? "gui" : null;
      session.runtimeTerminalId = null;
      session.tuiSuspended = false;
      return;
    }
    // Cold session: apply the viewer's pref.
    if (session.mode === "tui") {
      if (pref === "gui") {
        prepareTuiSessionForGuiView(session);
        session.runtimeMode = "gui";
        session.runtimeTerminalId = null;
        session.tuiSuspended = false;
      } else {
        prepareTuiSessionForGuiView(session);
        session.runtimeMode = null;
        session.runtimeTerminalId = null;
        session.tuiSuspended = true;
      }
    } else {
      // Born-GUI: always GUI. We no longer auto-convert a GUI session to a
      // `claude --resume` terminal on a pref=tui click - that hijacked shared
      // GUI sessions in multi-user. Such sessions render as their SDK chat.
      session.runtimeMode = null;
      session.tuiSuspended = false;
    }
  }

  function handleSessionsMessage(ws, msg) {

    if (liveHandlers.handleLiveMessage(ws, msg)) return true;

    if (historyHandlers.handleHistoryMessage(ws, msg)) return true;

    if (msg.type === "new_session") {
      var sessionOpts = {};
      if (ws._clayUser && usersModule.isMultiUser()) sessionOpts.ownerId = ws._clayUser.id;
      if (msg.sessionVisibility) sessionOpts.sessionVisibility = msg.sessionVisibility;
      var newSessionVendor = msg.vendor || sm.defaultVendor || "claude";
      if (newSessionVendor === "codex" || newSessionVendor === "claude" || newSessionVendor === "github-copilot") sessionOpts.vendor = newSessionVendor;
      if (!sessionOpts.vendor) sessionOpts.vendor = "claude";
      if (sm.serverDefaultModelsByVendor && sm.serverDefaultModelsByVendor[sessionOpts.vendor]) {
        sessionOpts.model = sm.serverDefaultModelsByVendor[sessionOpts.vendor];
      } else if (sm.defaultModelsByVendor && sm.defaultModelsByVendor[sessionOpts.vendor]) {
        sessionOpts.model = sm.defaultModelsByVendor[sessionOpts.vendor];
      }
      if (sessionOpts.vendor === "codex" || sessionOpts.vendor === "github-copilot") {
        var newCodexDefaults = getServerDefaultCodexConfig();
        sessionOpts.codexApproval = newCodexDefaults.approval || CODEX_DEFAULTS.approval;
        sessionOpts.codexSandbox = newCodexDefaults.sandbox || CODEX_DEFAULTS.sandbox;
        sessionOpts.codexWebSearch = newCodexDefaults.webSearch || CODEX_DEFAULTS.webSearch;
        sessionOpts.automationMode = automationForCodexConfig(sessionOpts.codexApproval, sessionOpts.codexSandbox);
        sessionOpts.permissionMode = sessionOpts.automationMode === "full" ? "bypassPermissions" : "default";
      } else {
        sessionOpts.permissionMode = sm.serverDefaultMode || sm._savedDefaultMode || sm.currentPermissionMode || "default";
        sessionOpts.automationMode = automationForClaudePermission(sessionOpts.permissionMode);
        sessionOpts.dangerouslySkipPermissions = sessionOpts.permissionMode === "bypassPermissions";
      }
      sm.currentEffort = sm.serverDefaultEffort || sm.currentEffort || "medium";
      // Mode resolution: non-Claude sessions are always GUI (no TUI adapter).
      // Claude sessions honor the explicit msg.mode if provided, otherwise
      // fall back to the user's claudeOpenMode preference. This is what
      // makes the sidebar's "Claude" icon button create the right kind of
      // session without the client needing to know the preference.
      var requestedMode;
      if (sessionOpts.vendor === "codex" || sessionOpts.vendor === "github-copilot") {
        requestedMode = "gui";
      } else if (msg.mode === "tui" || msg.mode === "gui") {
        requestedMode = msg.mode;
      } else {
        requestedMode = getClaudeOpenModeForWs(ws);
      }
      var newSess;
      if (requestedMode === "tui") {
        // TUI sessions own their cliSessionId up-front so we can launch
        // `claude --session-id <uuid>` and resume the same conversation
        // from external terminals (claude --resume <uuid>) and from the
        // jsonl watcher (~/.claude/projects/<cwd>/<uuid>.jsonl).
        //
        // Construction order matters: createSession() fires session_switched
        // synchronously, so we must populate terminalId on the record before
        // switching. Use createSessionRaw + switchSession to get the right
        // ordering and avoid an extra rebroadcast.
        sessionOpts.mode = "tui";
        sessionOpts.cliSessionId = crypto.randomUUID();
        sessionOpts.vendor = sessionOpts.vendor || "claude";
        // Per-session bypass-permissions: TUI shell command only. The flag is
        // persisted on the session so lazy-resume re-spawns the same way.
        if (msg.dangerouslySkipPermissions) {
          sessionOpts.dangerouslySkipPermissions = true;
          sessionOpts.permissionMode = "bypassPermissions";
          sessionOpts.automationMode = "full";
        }
        newSess = sm.createSessionRaw(sessionOpts);
        if (tm) {
          var tuiSid = newSess.cliSessionId;
          var tuiLocalId = newSess.localId;
          var tuiCmd = "claude --session-id " + tuiSid + claudeModelFlagForSession(newSess) + claudePermissionFlagForSession(newSess) + "; exit\n";
          var tuiTerm = tm.create(80, 24, getOsUserInfoForWs(ws), ws, {
            initialInput: tuiCmd,
            kind: "tui-session",
            title: "claude " + tuiSid.slice(0, 8),
            onExit: function (termSession) {
              var s = sm.sessions.get(tuiLocalId);
              if (!s) return;
              if (termSession && termSession.reclaimed) {
                // Reclaimed (idle sweep or explicit Close), not a real /exit:
                // keep the session (its jsonl transcript stays on disk and
                // lazy-resume can re-spawn claude). Just drop the dead PTY link.
                s.terminalId = null;
                try { sm.saveSessionFile(s); } catch (e) {}
                try { sm.broadcastSessionList(); } catch (e) {}
              } else {
                try { sm.deleteSessionQuiet(tuiLocalId); } catch (e) {}
                try { sm.broadcastSessionList(); } catch (e) {}
              }
            },
            onData: makeTuiActivityHook(tuiLocalId),
          });
          if (tuiTerm) {
            newSess.terminalId = tuiTerm.id;
          }
        }
        // Persist immediately so the session reappears in the sidebar
        // after a daemon restart (the SDK path saves on stream events,
        // but TUI sessions never produce any so this is our only chance).
        try { sm.saveSessionFile(newSess); } catch (e) {}
        startTitleWatcher(newSess);
        sm.switchSession(newSess.localId, ws);
      } else {
        newSess = sm.createSession(sessionOpts, ws);
      }
      ws._clayActiveSession = newSess.localId;
      // Apply project-level email defaults to new session
      if (typeof ctx._email === "object" && ctx._email.getEmailDefaults) {
        var emailDefaults = ctx._email.getEmailDefaults();
        if (emailDefaults.length > 0) {
          var defaultSources = emailDefaults.map(function (id) { return "email:" + id; });
          saveContextSources(slug, newSess.localId, defaultSources);
          sendTo(ws, { type: "context_sources_state", active: defaultSources });
        }
      }
      var nsPresKey = ws._clayUser ? ws._clayUser.id : "_default";
      userPresence.setPresence(slug, nsPresKey, newSess.localId, null);
      if (usersModule.isMultiUser()) {
        broadcastPresence();
      }
      return true;
    }

    if (recordsHandlers.handleRecordsMessage(ws, msg)) return true;

    if (projectHandlers.handleProjectMessage(ws, msg)) return true;

    if (searchHandlers.handleSearchMessage(ws, msg)) return true;

    if (msg.type === "refresh_vendors") {
      refreshVendorState(ws);
      return true;
    }

    if (msg.type === "handoff_session") {
      var sourceSession = null;
      if (typeof msg.sessionId === "number") {
        sourceSession = sm.sessions.get(msg.sessionId);
        if (sourceSession && usersModule.isMultiUser() && ws._clayUser) {
          if (!usersModule.canAccessSession(ws._clayUser.id, sourceSession, { visibility: "public" })) return true;
        }
      } else {
        sourceSession = getSessionForWs(ws);
      }
      if (!sourceSession || !msg.targetVendor) return true;
      var fromVendor = sourceSession.vendor || "claude";
      var toVendor = msg.targetVendor;
      var requestedTargetModel = typeof msg.targetModel === "string" ? msg.targetModel : null;
      var targetRoute = routeForHandoffTarget(toVendor, sourceSession, msg.targetRouteId || null, requestedTargetModel);
      if (msg.targetRouteId && (!targetRoute || targetRoute.vendor !== toVendor)) {
        sendTo(ws, { type: "toast", level: "warn", message: "Provider route is not available" });
        return true;
      }
      if (fromVendor === toVendor && (!targetRoute || sourceSession.providerRouteId === targetRoute.id)) return true;
      var availableVendors = sm.availableVendors || [];
      if (availableVendors.indexOf(toVendor) === -1) {
        var routeLabel = toVendor;
        var routeSetup = "Clay does not have a runnable adapter for that provider yet.";
        var routes = sm.providerRoutes || listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
        for (var ri = 0; ri < routes.length; ri++) {
          if (routes[ri].vendor === toVendor) {
            routeLabel = routes[ri].label || routeLabel;
            routeSetup = routes[ri].setup || routeSetup;
            break;
          }
        }
        sendTo(ws, { type: "toast", level: "warn", message: routeLabel + " is not available", detail: routeSetup });
        return true;
      }
      if (sourceSession.isProcessing) {
        sendTo(ws, { type: "toast", level: "warn", message: "Stop the current task before switching vendor" });
        return true;
      }
      if (sourceSession.scheduledMessage && typeof cancelScheduledMessage === "function") {
        cancelScheduledMessage(sourceSession);
      } else if (hasUnclosedScheduledMessage(sourceSession)) {
        sourceSession.rateLimitAutoContinuePending = false;
        sm.sendAndRecord(sourceSession, { type: "scheduled_message_cancelled" });
      }

      var targetModel = targetRoute ? modelForHandoff(sourceSession, targetRoute, requestedTargetModel) : null;
      var handoffTranscript = buildHandoffContext(sourceSession, {
        fromVendor: fromVendor,
        toVendor: toVendor,
        cwd: cwd,
        imagesDir: imagesDir,
        targetRouteLabel: targetRoute ? targetRoute.label : null,
        targetModel: targetModel,
      });

      // Switch vendor in-place: reset the CLI session so the new vendor starts fresh,
      // keep display history, and stash the transcript for context injection on next send.
      var previousCliSessionId = sourceSession.cliSessionId || null;
      var fromRouteId = sourceSession.providerRouteId || null;
      if (!sourceSession.storageId) {
        sourceSession.storageId = previousCliSessionId || ("handoff-" + crypto.randomUUID());
      }
      sourceSession.vendor = toVendor;
      if (targetRoute) {
        sourceSession.providerRouteId = targetRoute.id;
        if (targetModel) {
          sourceSession.model = targetModel;
          sourceSession.requestedModel = targetModel;
          sourceSession.verifiedModel = null;
          sourceSession.modelVerificationSource = null;
          sm.currentModel = "";
        }
      }
      sourceSession.mode = "gui"; // Codex and future vendors are always GUI
      sourceSession.cliSessionId = null; // let the new vendor's adapter assign a fresh session ID
      if (handoffTranscript) {
        sourceSession.handoffContext = handoffTranscript;
        sourceSession.handoffContextTurnsRemaining = toVendor === "github-copilot" ? 1 : 4;
      }
      clearPendingQueuedMessages(sourceSession);
      sendToSession(sourceSession.localId, { type: "queued_user_messages_cleared" });
      if (previousCliSessionId) {
        try { tombstones.add(previousCliSessionId); } catch (e) {}
      }

      // Force-close any live query so its processQueryStream finally-block
      // nulls out session.queryInstance before the next send. Without this
      // the idle Claude process stays alive and pushMessage routes to it
      // instead of startQuery picking the new vendor's adapter.
      if (sourceSession.queryInstance && typeof sourceSession.queryInstance.close === "function") {
        try { sourceSession.queryInstance.close(); } catch (e) {}
      } else if (sourceSession.messageQueue && typeof sourceSession.messageQueue.end === "function") {
        try { sourceSession.messageQueue.end(); } catch (e) {}
      }
      sourceSession.queryInstance = null;
      sourceSession.messageQueue = null;

      // Record who/what triggered this handoff. Handoffs are manual-only (this
      // handler is the single producer of vendor_switched), so capturing the
      // source makes "I didn't switch this" diagnosable instead of a mystery.
      var handoffSource = typeof msg.source === "string" ? msg.source : "unknown";
      var handoffUserId = (ws && ws._clayUser && ws._clayUser.id) || null;
      console.log("[handoff] session " + sourceSession.localId + ": " + fromVendor +
        " -> " + toVendor + " (source=" + handoffSource + ", user=" + (handoffUserId || "n/a") + ")");
      var switchEntry = {
        type: "vendor_switched",
        fromVendor: fromVendor,
        toVendor: toVendor,
        fromRouteId: fromRouteId,
        targetRouteId: targetRoute ? targetRoute.id : null,
        targetRouteLabel: targetRoute ? targetRoute.label : null,
        targetModel: sourceSession.model || null,
        targetModels: modelsForRoute(targetRoute, toVendor),
        initiatedBy: { source: handoffSource, userId: handoffUserId },
        _ts: Date.now(),
      };
      sourceSession.history.push(switchEntry);
      sm.appendToSessionFile(sourceSession, switchEntry);
      sm.saveSessionFile(sourceSession);
      sm.broadcastSessionList();

      // Show a divider in the chat
      sendToSession(sourceSession.localId, switchEntry);
      sendConfigForSession(ws, sourceSession);
      sendTo(ws, { type: "toast", level: "info", message: "Switched to " + ((targetRoute && targetRoute.label) || toVendor) + " - context will be passed on your next message" });
      return true;
    }

    if (msg.type === "switch_session") {
      // Prefer the persistent storageId when provided: localId is a throwaway
      // counter reassigned on every restart, so a stale localId (e.g. from the
      // auto-launch activity history) can resolve to the wrong live session.
      // Resolve storageId -> current localId; ignore if no live session matches
      // (the original was deleted), which makes the click a clean no-op.
      if (msg.storageId) {
        var xsResolved = null;
        sm.sessions.forEach(function (s) {
          if (xsResolved == null && (s.storageId === msg.storageId || s.cliSessionId === msg.storageId)) {
            xsResolved = s.localId;
          }
        });
        msg.id = xsResolved;
      }
      if (msg.id && sm.sessions.has(msg.id)) {
        // resolveSessionForView sets runtimeMode / runtimeTerminalId /
        // tuiSuspended (and hydrates the transcript) before sm.switchSession
        // broadcasts session_switched. A live runtime keeps its actual mode
        // for every viewer; only cold sessions follow the clicker's
        // claudeOpenMode pref. Nothing is spawned here. The codex branch
        // hydrates session.history from the rollout file for imported
        // sessions; live codex sessions short-circuit.
        var xmTarget = sm.sessions.get(msg.id);
        if (xmTarget) {
          resolveSessionForView(xmTarget, ws);
        }
        // If the target session's vendor doesn't own the currently cached
        // model, clear sm.currentModel so the UI and next query don't leak
        // the previous session's vendor-specific model into this one.
        var switchTargetSess = sm.sessions.get(msg.id);
        if (switchTargetSess && sm.currentModel) {
          var targetVendor = switchTargetSess.vendor || sm.defaultVendor || null;
          var tvModels = (targetVendor && sm.modelsByVendor && sm.modelsByVendor[targetVendor]) || [];
          var found = false;
          var _curLc = sm.currentModel.toLowerCase();
          for (var tvi = 0; tvi < tvModels.length; tvi++) {
            var tvEntry = tvModels[tvi];
            var tvVal = typeof tvEntry === "string" ? tvEntry : (tvEntry && (tvEntry.value || tvEntry.id)) || "";
            if (tvVal === sm.currentModel || (tvVal && (tvVal.toLowerCase().indexOf(_curLc) !== -1 || _curLc.indexOf(tvVal.toLowerCase()) !== -1))) { found = true; break; }
          }
          if (tvModels.length > 0 && !found) {
            sm.currentModel = "";
          }
        }
        // Check access in multi-user mode
        if (usersModule.isMultiUser() && ws._clayUser) {
          var switchTarget = sm.sessions.get(msg.id);
          if (!usersModule.canAccessSession(ws._clayUser.id, switchTarget, { visibility: "public" })) return true;
          ws._clayActiveSession = msg.id;
          sm.switchSession(msg.id, ws, hydrateImageRefs);
          broadcastPresence();
        } else {
          ws._clayActiveSession = msg.id;
          sm.switchSession(msg.id, ws, hydrateImageRefs);
        }
        // Send per-session context sources
        if (typeof loadContextSources === "function") {
          var switchedSources = loadContextSources(slug, msg.id);
          sendTo(ws, { type: "context_sources_state", active: switchedSources });
        }
        var swPresKey = ws._clayUser ? ws._clayUser.id : "_default";
        userPresence.setPresence(slug, swPresKey, msg.id, null);
      }
      return true;
    }

    if (msg.type === "sync_external_session") {
      var syncTarget = null;
      if (msg.id && sm.sessions.has(msg.id)) {
        syncTarget = sm.sessions.get(msg.id);
      } else {
        syncTarget = getSessionForWs(ws);
      }
      if (!syncTarget) return true;
      if (syncTarget.vendor === "codex") {
        var beforeMtime = syncTarget._historyMtime || 0;
        resolveSessionForView(syncTarget, ws);
        var afterMtime = syncTarget._historyMtime || 0;
        if (afterMtime && afterMtime !== beforeMtime) {
          sm.switchSession(syncTarget.localId, ws, hydrateImageRefs);
        }
        return true;
      }
      // Non-Codex (Claude etc.): live messages are broadcast fire-and-forget and
      // only replayed on a full reconnect/refresh. A wake/focus/interaction probe
      // that recovers a zombie socket WITHOUT a full reconnect, or a client whose
      // server-side active session drifted from what it's actually viewing (a
      // server-initiated switch reassigns every socket's _clayActiveSession),
      // would otherwise stay behind until a manual refresh. Re-switch (full
      // replay — the same battle-tested path as reconnect) only when this socket
      // is genuinely behind, so a current client never re-renders / flickers:
      //   (a) the server thinks this socket views a different session than the
      //       client reported (msg.id) — it's been missing this session's
      //       broadcasts; or
      //   (b) the live history grew past what this socket was last caught up to.
      var deliveredLen = ws._clayDeliveredLen || 0;
      var mismatched = msg.id && ws._clayActiveSession !== syncTarget.localId;
      var behind = syncTarget.history && syncTarget.history.length > deliveredLen;
      if (mismatched || behind) {
        sm.switchSession(syncTarget.localId, ws, hydrateImageRefs);
      }
      return true;
    }

    // Lazy-resume: the user clicked "Resume" on a TUI session shown read-only.
    // Spawn `claude --resume <cliSessionId>` now and re-broadcast
    // session_switched so the client swaps the transcript for the live xterm.
    if (msg.type === "resume_tui_session") {
      if (msg.id && sm.sessions.has(msg.id)) {
        var rtTarget = sm.sessions.get(msg.id);
        var rtOk = rtTarget && (rtTarget.vendor === "claude" || !rtTarget.vendor) &&
                   rtTarget.cliSessionId && tm;
        if (rtOk) {
          if (usersModule.isMultiUser() && ws._clayUser &&
              !usersModule.canAccessSession(ws._clayUser.id, rtTarget, { visibility: "public" })) {
            return true;
          }
          var rtRid = spawnRuntimeTuiPty(rtTarget, ws);
          if (typeof rtRid === "number") {
            rtTarget.runtimeMode = "tui";
            rtTarget.runtimeTerminalId = rtRid;
            rtTarget.tuiSuspended = false;
            startTitleWatcher(rtTarget);
          }
          ws._clayActiveSession = msg.id;
          sm.switchSession(msg.id, ws, hydrateImageRefs);
        }
      }
      return true;
    }

    // Explicit Close: the user closed a live TUI session from the title bar.
    // Kill its PTY now (don't wait for the idle sweep) but keep the session -
    // it drops to the read-only transcript + Resume bar, freeing resources
    // immediately while staying resumable.
    if (msg.type === "suspend_tui_session") {
      if (msg.id && sm.sessions.has(msg.id)) {
        var stTarget = sm.sessions.get(msg.id);
        var stOk = stTarget && (stTarget.vendor === "claude" || !stTarget.vendor);
        if (stOk && (!usersModule.isMultiUser() || !ws._clayUser ||
            usersModule.canAccessSession(ws._clayUser.id, stTarget, { visibility: "public" }))) {
          if (tm) {
            var stTid = (typeof stTarget.terminalId === "number") ? stTarget.terminalId : null;
            var stRid = (typeof stTarget.runtimeTerminalId === "number") ? stTarget.runtimeTerminalId : null;
            if (stTid != null && tm.has(stTid)) { tm.markReclaimed(stTid); tm.close(stTid); }
            if (stRid != null && tm.has(stRid)) { tm.markReclaimed(stRid); tm.close(stRid); }
          }
          stTarget.terminalId = null;
          stTarget.runtimeTerminalId = null;
          // Hydrate the transcript so the session has read-only content for
          // the next time it is opened, then close the current view. Reopening
          // the session later shows the suspended Resume view.
          prepareTuiSessionForGuiView(stTarget);
          stTarget.runtimeMode = null;
          stTarget.tuiSuspended = true;
          sm.saveSessionFile(stTarget);
          ws._clayActiveSession = null;
          var stPresKey = ws._clayUser ? ws._clayUser.id : "_default";
          userPresence.clearPresence(slug, stPresKey);
          sendTo(ws, { type: "session_closed", id: msg.id });
          sm.broadcastSessionList();
        }
      }
      return true;
    }

    // Client asks for the assistant text index of a Claude TUI session so
    // it can wire hover-to-grab on the rendered terminal output. Only the
    // raw markdown of assistant text messages is returned — no tool calls,
    // no user prompts. Codex sessions skip the feature.
    if (msg.type === "tui_transcript_request") {
      var tprId = msg.id;
      var tprSess = (tprId && sm.sessions.has(tprId)) ? sm.sessions.get(tprId) : null;
      if (!tprSess || !tprSess.cliSessionId || tprSess.mode !== "tui") return true;
      if (tprSess.vendor && tprSess.vendor !== "claude") return true;
      if (usersModule.isMultiUser() && ws._clayUser
          && !usersModule.canAccessSession(ws._clayUser.id, tprSess, { visibility: "public" })) {
        return true;
      }
      try {
        var tprIndex = require("./tui-transcript-index").readAssistantIndex(resolveSessionHome(tprSess), cwd, tprSess.cliSessionId);
        sendTo(ws, {
          type: "tui_transcript_state",
          id: tprId,
          cliSessionId: tprSess.cliSessionId,
          messages: tprIndex.messages,
        });
      } catch (e) {}
      return true;
    }

    if (userStateHandlers.handleUserStateMessage(ws, msg)) return true;

    if (configHandlers.handleConfigMessage(ws, msg)) return true;

    if (settingsHandlers.handleSettingsMessage(ws, msg)) return true;

    if (rewindHandlers.handleRewindMessage(ws, msg)) return true;

    if (permissionHandlers.handlePermissionsMessage(ws, msg)) return true;

    if (gitAccountHandlers.handleGitAccountMessage(ws, msg)) return true;

    return false;
  }

  return {
    handleSessionsMessage: handleSessionsMessage,
    resolveSessionForView: resolveSessionForView,
  };
}

module.exports = { attachSessions: attachSessions };
