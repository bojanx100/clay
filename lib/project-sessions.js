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
var { attachProjectSessionsConfig } = require("./project-sessions-config");
var { attachProjectSessionsGitAccounts } = require("./project-sessions-git-accounts");
var { attachProjectSessionsHandoff } = require("./project-sessions-handoff");
var { attachProjectSessionsHistory } = require("./project-sessions-history");
var { attachProjectSessionsLive } = require("./project-sessions-live");
var { attachProjectSessionsPermissions } = require("./project-sessions-permissions");
var { attachProjectSessionsProjects } = require("./project-sessions-projects");
var { attachProjectSessionsRecords } = require("./project-sessions-records");
var { attachProjectSessionsRewind } = require("./project-sessions-rewind");
var { attachProjectSessionsSearch } = require("./project-sessions-search");
var { attachProjectSessionsSettings } = require("./project-sessions-settings");
var { attachProjectSessionsTui } = require("./project-sessions-tui");
var { attachProjectSessionsUserState } = require("./project-sessions-user-state");

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
  var tuiHandlers = attachProjectSessionsTui({
    cwd: cwd,
    slug: slug,
    clients: clients,
    sm: sm,
    tm: tm,
    send: send,
    sendTo: sendTo,
    usersModule: usersModule,
    userPresence: userPresence,
    getOsUserInfoForWs: getOsUserInfoForWs,
    hydrateImageRefs: hydrateImageRefs,
    onProcessingChanged: onProcessingChanged,
    resolveSessionHome: resolveSessionHome,
    notifications: ctx._notifications,
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
    stopTitleWatcher: tuiHandlers.stopTitleWatcher,
  });
  var historyHandlers = attachProjectSessionsHistory({
    sm: sm,
    sendTo: sendTo,
    getSessionForWs: getSessionForWs,
    hydrateImageRefs: hydrateImageRefs,
    compactAndContinue: compactAndContinue,
  });
  var handoffHandlers = attachProjectSessionsHandoff({
    cwd: cwd,
    slug: slug,
    imagesDir: imagesDir,
    adapters: adapters,
    clayPort: clayPort,
    clayTls: clayTls,
    clayAuthToken: clayAuthToken,
    sm: sm,
    sendTo: sendTo,
    sendToSession: sendToSession,
    usersModule: usersModule,
    getSessionForWs: getSessionForWs,
    cancelScheduledMessage: cancelScheduledMessage,
    clearPendingQueuedMessages: clearPendingQueuedMessages,
    sendConfigForSession: sendConfigForSession,
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
    copilotRouteIdForModel: handoffHandlers.copilotRouteIdForModel,
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

  function configStateForSession(session) {
    handoffHandlers.normalizeSessionRouteModel(session);
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
        tuiHandlers.prepareTuiSessionForGuiView(session);
        session.runtimeMode = "gui";
        session.runtimeTerminalId = null;
        session.tuiSuspended = false;
      } else {
        tuiHandlers.prepareTuiSessionForGuiView(session);
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
          var tuiCmd = "claude --session-id " + tuiSid + tuiHandlers.claudeModelFlagForSession(newSess) + tuiHandlers.claudePermissionFlagForSession(newSess) + "; exit\n";
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
            onData: tuiHandlers.makeTuiActivityHook(tuiLocalId),
          });
          if (tuiTerm) {
            newSess.terminalId = tuiTerm.id;
          }
        }
        // Persist immediately so the session reappears in the sidebar
        // after a daemon restart (the SDK path saves on stream events,
        // but TUI sessions never produce any so this is our only chance).
        try { sm.saveSessionFile(newSess); } catch (e) {}
        tuiHandlers.startTitleWatcher(newSess);
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

    if (handoffHandlers.handleHandoffMessage(ws, msg)) return true;

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

    if (tuiHandlers.handleTuiMessage(ws, msg)) return true;

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
