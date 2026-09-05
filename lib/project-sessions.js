var { getCodexConfig } = require("./codex-defaults");
var {
  normalizeAutomationMode,
  claudePermissionForAutomation,
  codexConfigForAutomation,
  automationForSession,
} = require("./automation-modes");
var { attachProjectSessionsConfig } = require("./project-sessions-config");
var { attachCoopChannels } = require("./project-coop-channels");
var { attachProjectSessionsGitAccounts } = require("./project-sessions-git-accounts");
var { attachProjectSessionsHandoff } = require("./project-sessions-handoff");
var { attachProjectSessionsHistory } = require("./project-sessions-history");
var { attachProjectSessionsLifecycle } = require("./project-sessions-lifecycle");
var { attachProjectSessionsLive } = require("./project-sessions-live");
var { attachProjectSessionsPermissions } = require("./project-sessions-permissions");
var { attachProjectSessionsProjects } = require("./project-sessions-projects");
var { attachProjectSessionsRecords } = require("./project-sessions-records");
var { attachProjectSessionsRewind } = require("./project-sessions-rewind");
var { attachProjectSessionsSearch } = require("./project-sessions-search");
var { attachProjectSessionsSettings } = require("./project-sessions-settings");
var { attachProjectSessionsTui } = require("./project-sessions-tui");
var { attachProjectSessionsUserState } = require("./project-sessions-user-state");
var leadMode = require("./lead-mode");
var { attachProjectSessionsView } = require("./project-sessions-view");
var { attachCoopIncarnationControl } = require("./coop-incarnation-control");

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
 *   autoResumeRestartSession,
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
  var coopChannelHandlers = attachCoopChannels({
    slug: slug,
    sm: sm,
    getProjectList: getProjectList,
    sendTo: sendTo,
    usersModule: usersModule,
  });
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
  var viewHandlers = attachProjectSessionsView({
    cwd: cwd,
    sm: sm,
    tm: tm,
    resolveSessionHome: resolveSessionHome,
    getClaudeOpenModeForWs: getClaudeOpenModeForWs,
    tuiHandlers: tuiHandlers,
  });
  var lifecycleHandlers = attachProjectSessionsLifecycle({
    slug: slug,
    sm: sm,
    tm: tm,
    sendTo: sendTo,
    send: send,
    sendToSession: sendToSession,
    clients: clients,
    usersModule: usersModule,
    userPresence: userPresence,
    getSessionForWs: getSessionForWs,
    getOsUserInfoForWs: getOsUserInfoForWs,
    hydrateImageRefs: hydrateImageRefs,
    broadcastPresence: broadcastPresence,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
    getClaudeOpenModeForWs: getClaudeOpenModeForWs,
    viewHandlers: viewHandlers,
    tuiHandlers: tuiHandlers,
    email: ctx._email,
    onSetProjectLastVendor: opts.onSetProjectLastVendor,
    autoResumeRestartSession: ctx.autoResumeRestartSession,
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
    prepareTuiSessionForGuiView: tuiHandlers.prepareTuiSessionForGuiView,
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
    sdk: sdk,
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
  var coopIncarnationHandlers = attachCoopIncarnationControl({
    slug: slug,
    sm: sm,
    switcher: handoffHandlers,
    sendTo: sendTo,
    sendConfigForSession: sendConfigForSession,
    getSessionForWs: getSessionForWs,
    isCoopTopicOwner: ctx.isCoopTopicOwner,
    opts: opts,
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
    isKnownCodexSession: viewHandlers.isKnownCodexSession,
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
    leadMode: leadMode,
  });
  leadMode.registerBroadcaster(slug, send);

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
      effort: (session && session.effort) || sm.currentEffort || "medium",
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

  function handleSessionsMessage(ws, msg) {
    var handlers = [
      coopChannelHandlers.handleCoopChannelMessage,
      liveHandlers.handleLiveMessage,
      historyHandlers.handleHistoryMessage,
      lifecycleHandlers.handleLifecycleMessage,
      recordsHandlers.handleRecordsMessage,
      projectHandlers.handleProjectMessage,
      searchHandlers.handleSearchMessage,
      coopIncarnationHandlers.handleMessage,
      handoffHandlers.handleHandoffMessage,
      tuiHandlers.handleTuiMessage,
      userStateHandlers.handleUserStateMessage,
      configHandlers.handleConfigMessage,
      settingsHandlers.handleSettingsMessage,
      rewindHandlers.handleRewindMessage,
      permissionHandlers.handlePermissionsMessage,
      gitAccountHandlers.handleGitAccountMessage,
    ];
    for (var i = 0; i < handlers.length; i++) {
      if (handlers[i](ws, msg)) return true;
    }
    return false;
  }

  return {
    createSessionForMessage: lifecycleHandlers.createSessionForMessage,
    handleSessionsMessage: handleSessionsMessage,
    resolveSessionForView: viewHandlers.resolveSessionForView,
    handleSwitchCommand: handoffHandlers.handleSwitchCommand,
  };
}

module.exports = { attachSessions: attachSessions };
