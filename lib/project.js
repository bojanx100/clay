var path = require("path");
var { fetchVersion, isNewer } = require("./updater");
var { execFileSync, spawn } = require("child_process");
var usersModule = require("./users");
var { fsAsUser } = require("./os-users");
var matesModule = require("./mates");
var userPresence = require("./user-presence");
var { attachHTTP } = require("./project-http");
var { attachFilesystem } = require("./project-filesystem");
var { attachSessions } = require("./project-sessions");
var { attachUserMessage } = require("./project-user-message");
var { attachTaskLauncher } = require("./project-task-launcher");
var { attachAutoLaunch } = require("./project-auto-launch");
var { attachTaskDashboard, startConfiguredDashboards } = require("./project-task-dashboard");
var { attachTaskSetup } = require("./project-task-setup");
var { attachConnection } = require("./project-connection");
var { loadContextSources, saveContextSources } = require("./project-context-sources");
var { createMcpBridgeHandlerFactory } = require("./project-mcp-bridge-handler");
var { attachProjectFoundation } = require("./project-foundation");
var { attachProjectInteractions } = require("./project-interactions");
var { attachProjectRuntime } = require("./project-runtime");
var { createProjectDestroy } = require("./project-destroy");
var { startExternalCodexSync } = require("./project-external-codex-sync");
var { attachProjectMessageRouter } = require("./project-message-router");
var {
  IGNORED_DIRS,
  BINARY_EXTS,
  IMAGE_EXTS,
  FS_MAX_SIZE,
  validateEnvString,
  safePath,
  safeAbsPath,
} = require("./project-path-utils");
// project-notifications is attached globally in server.js, passed via opts.notificationsModule

// YOKE adapter (replaces direct SDK access)
var yoke = require("./yoke");

/**
 * Create a project context — per-project state and handlers.
 * opts: { cwd, slug, title, pushModule, debug, dangerouslySkipPermissions, currentVersion }
 */
function createProjectContext(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug;
  var project = path.basename(cwd);
  var pushModule = opts.pushModule || null;
  var debug = opts.debug || false;
  var dangerouslySkipPermissions = opts.dangerouslySkipPermissions || false;
  var fullAutoMode = opts.fullAutoMode || false;
  var currentVersion = opts.currentVersion;
  var lanHost = opts.lanHost || null;
  var getProjectCount = opts.getProjectCount || function () { return 1; };
  var getProjectList = opts.getProjectList || function () { return []; };
  var getAllProjectSessions = opts.getAllProjectSessions || function () { return []; };
  var getAllProjectsWithSessions = opts.getAllProjectsWithSessions || function () { return []; };
  var isHostAgent = !!opts.isHostAgent;
  var getHubSchedules = opts.getHubSchedules || function () { return []; };
  var moveScheduleToProject = opts.moveScheduleToProject || function () { return { ok: false, error: "Not supported" }; };
  var moveAllSchedulesToProject = opts.moveAllSchedulesToProject || function () { return { ok: false, error: "Not supported" }; };
  var getScheduleCount = opts.getScheduleCount || function () { return 0; };
  var onProcessingChanged = opts.onProcessingChanged || function () {};
  var onSessionDone = opts.onSessionDone || function () {};
  var onPresenceChange = opts.onPresenceChange || function () {};
  var updateChannel = opts.updateChannel || "stable";
  var osUsers = opts.osUsers || false;
  var multiUser = opts.multiUser || false;
  var projectOwnerId = opts.projectOwnerId || null;
  var worktreeMeta = opts.worktreeMeta || null; // { parentSlug, branch, accessible }
  var isMate = opts.isMate || false;
  var onCreateWorktree = opts.onCreateWorktree || null;
  var serverPort = opts.port || 2633;
  var serverTls = opts.tls || false;
  var serverAuthToken = opts.authToken || null;
  var projectTimers = {};

  // --- YOKE adapters (multi-vendor, lazy init) ---
  var _yokeState = yoke.createAdapters({ cwd: cwd, slug: slug });
  var adapters = _yokeState.adapters;
  var defaultVendor = adapters.claude ? "claude" : Object.keys(adapters)[0] || "claude";
  var adapter = adapters[defaultVendor] || null;

  // Browser MCP server runs in-process via createSdkMcpServer (no child process spawn).
  // Do NOT write to .claude-local/settings.json -- the SDK reads that too, causing duplicate spawns.

  var _foundation = attachProjectFoundation({
    cwd: cwd,
    slug: slug,
    project: project,
    opts: opts,
    debug: debug,
    osUsers: osUsers,
    fullAutoMode: fullAutoMode,
    currentVersion: currentVersion,
    lanHost: lanHost,
    isMate: isMate,
    isHostAgent: isHostAgent,
    worktreeMeta: worktreeMeta,
    adapters: adapters,
    adapter: adapter,
    defaultVendor: defaultVendor,
    onSessionDone: onSessionDone,
    onPresenceChange: onPresenceChange,
    getProjectCount: getProjectCount,
    getProjectList: getProjectList,
    getAllProjectsWithSessions: getAllProjectsWithSessions,
    getSessionForWs: getSessionForWs,
    getProjectOwnerId: function () { return projectOwnerId; },
    setProjectOwnerId: function (id) { projectOwnerId = id; },
  });
  var imagesDir = _foundation.imagesDir;
  var hydrateImageRefs = _foundation.hydrateImageRefs;
  var saveImageFile = _foundation.saveImageFile;
  var loadImagesForSdk = _foundation.loadImagesForSdk;
  var getLinuxUserForSession = _foundation.getLinuxUserForSession;
  var ensureProjectAccessForSession = _foundation.ensureProjectAccessForSession;
  var getOsUserInfoForWs = _foundation.getOsUserInfoForWs;
  var getOsUserInfoForReq = _foundation.getOsUserInfoForReq;
  var clients = _foundation.clients;
  var send = _foundation.send;
  var sendTo = _foundation.sendTo;
  var sendToAdmins = _foundation.sendToAdmins;
  var broadcastClientCount = _foundation.broadcastClientCount;
  var sendToSession = _foundation.sendToSession;
  var sendToSessionOthers = _foundation.sendToSessionOthers;
  var broadcastPresence = _foundation.broadcastPresence;
  var _pendingDebateProposals = _foundation.pendingDebateProposals;
  var _extToken = _foundation.extToken;
  var browserState = _foundation.browserState;
  var sendExtensionCommandAny = _foundation.sendExtensionCommandAny;
  var requestTabContext = _foundation.requestTabContext;
  var _knowledge = _foundation.knowledge;
  var startFileWatch = _foundation.startFileWatch;
  var stopFileWatch = _foundation.stopFileWatch;
  var startDirWatch = _foundation.startDirWatch;
  var stopAllDirWatches = _foundation.stopAllDirWatches;
  var sm = _foundation.sm;
  var _status = _foundation.status;
  var _localMcp = _foundation.localMcp;
  var _mcp = _foundation.mcp;
  var _email = _foundation.email;
  var _mateDatastore = _foundation.mateDatastore;
  var getLocalMcpServers = _foundation.getLocalMcpServers;

  var _userMessage = null;
  var _taskLauncher = null;
  var _autoLaunch = null;
  var _taskDashboard = null;
  var _taskSetup = null;
  var _messageRouter = null;

  function handleMessage(ws, msg) {
    if (!_messageRouter) return;
    return _messageRouter.handleMessage(ws, msg);
  }

  function getSessionForWs(ws) {
    return sm.sessions.get(ws._clayActiveSession) || null;
  }

  var _runtime = attachProjectRuntime({
    cwd: cwd,
    slug: slug,
    opts: opts,
    sm: sm,
    send: send,
    sendTo: sendTo,
    sendToAdmins: sendToAdmins,
    sendToSession: sendToSession,
    pushModule: pushModule,
    adapter: adapter,
    adapters: adapters,
    isMate: isMate,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    serverPort: serverPort,
    serverTls: serverTls,
    serverAuthToken: serverAuthToken,
    onProcessingChanged: onProcessingChanged,
    getLocalMcpServers: getLocalMcpServers,
    getRemoteMcpServers: function () { return _mcp.getMcpServers(); },
    getTaskLauncher: function () { return _taskLauncher; },
    getUserMessage: function () { return _userMessage; },
    getAutoLaunch: function () { return _autoLaunch; },
    digestDmTurn: function (session, preview) {
      if (digestDmTurn) digestDmTurn(session, preview);
    },
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    imagesDir: imagesDir,
    hydrateImageRefs: hydrateImageRefs,
    loadImagesForSdk: loadImagesForSdk,
    getSessionForWs: getSessionForWs,
    getHubSchedules: getHubSchedules,
    getLinuxUserForSession: getLinuxUserForSession,
    worktreeMeta: worktreeMeta,
    getOsUserInfoForWs: getOsUserInfoForWs,
    osUsers: osUsers,
    currentVersion: currentVersion,
    updateChannel: updateChannel,
    projectTimers: projectTimers,
    getProjectList: getProjectList,
    projectOwnerId: projectOwnerId,
  });
  var sdk = _runtime.sdk;
  var _sessionCompaction = _runtime.sessionCompaction;
  var scheduleMessage = _runtime.scheduleMessage;
  var cancelScheduledMessage = _runtime.cancelScheduledMessage;
  var continueWithUsageCredits = _runtime.continueWithUsageCredits;
  var sendScheduledMessageNow = _runtime.sendScheduledMessageNow;
  var autoResumeRestartSession = _runtime.autoResumeRestartSession;
  var _vendorModels = _runtime.vendorModels;
  var _loop = _runtime.loop;
  var loopState = _runtime.loopState;
  var loopRegistry = _runtime.loopRegistry;
  var loopDir = _runtime.loopDir;
  var startLoop = _runtime.startLoop;
  var stopLoop = _runtime.stopLoop;
  var resumeLoop = _runtime.resumeLoop;
  var tm = _runtime.tm;
  var nm = _runtime.nm;
  var _workspace = _runtime.workspace;
  var _updateChecker = _runtime.updateChecker;
  var _notifications = _runtime.notifications;

  // --- WS connection handler (delegated to project-connection.js) ---
  function handleConnection(ws, wsUser) {
    _connection.handleConnection(ws, wsUser, handleMessage, handleDisconnection);

    // Initialize local MCP when a localhost client connects
    if (ws._clayLocal && _localMcp && !_localMcp.isReady()) {
      _localMcp.initialize(function () {
        // Rebuild proxy servers and broadcast state when local servers are ready
        _mcp.rebuildAndBroadcast();
      });
    }
  }

  // --- Shared helpers ---

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  var _interactions = attachProjectInteractions({
    cwd: cwd,
    slug: slug,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    isMate: isMate,
    projectOwnerId: projectOwnerId,
    getProjectOwnerId: function () { return projectOwnerId; },
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    saveImageFile: saveImageFile,
    hydrateImageRefs: hydrateImageRefs,
    onProcessingChanged: onProcessingChanged,
    getAllProjectSessions: getAllProjectSessions,
    handleMessage: handleMessage,
    getNotificationsModule: function () { return _notifications; },
    getProjectTitle: function () { return _status.getTitle() || slug; },
    isUserOnline: opts.isUserOnline || function () { return false; },
    pushModule: pushModule,
  });
  var _memory = _interactions.memory;
  var gateMemory = _interactions.gateMemory;
  var handleMention = _interactions.handleMention;
  var digestDmTurn = _interactions.digestDmTurn;
  var handleUserMention = _interactions.handleUserMention;
  var handleDebateStart = _interactions.handleDebateStart;
  var handleDebateHandRaise = _interactions.handleDebateHandRaise;
  var handleDebateComment = _interactions.handleDebateComment;
  var handleDebateStop = _interactions.handleDebateStop;
  var handleDebateConcludeResponse = _interactions.handleDebateConcludeResponse;
  var handleDebateConfirmBrief = _interactions.handleDebateConfirmBrief;
  var handleDebateUserFloorResponse = _interactions.handleDebateUserFloorResponse;
  var restoreDebateState = _interactions.restoreDebateState;
  var handleMcpDebateApproval = _interactions.handleMcpDebateApproval;

  // --- WS disconnection handler (delegated to project-connection.js) ---
  function handleDisconnection(ws) {
    // Clean up extension WS reference if this was the extension client
    if (browserState._extensionWs === ws) {
      browserState._extensionWs = null;
      browserState._extensionId = null;
      if (_mcp) _mcp.handleExtensionDisconnect();
    }
    _connection.handleDisconnection(ws);
  }

  // --- Sessions/config/project handler (delegated to project-sessions.js) ---
  var _sessions = attachSessions({
    cwd: cwd,
    slug: slug,
    isMate: isMate,
    osUsers: osUsers,
    debug: debug,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    fullAutoMode: fullAutoMode,
    currentVersion: currentVersion,
    sm: sm,
    sdk: sdk,
    tm: tm,
    clients: clients,
    send: send,
    sendTo: sendTo,
    sendToAdmins: sendToAdmins,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    opts: opts,
    usersModule: usersModule,
    userPresence: userPresence,
    matesModule: matesModule,
    pushModule: pushModule,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    getOsUserInfoForWs: getOsUserInfoForWs,
    hydrateImageRefs: hydrateImageRefs,
    imagesDir: imagesDir,
    onProcessingChanged: onProcessingChanged,
    broadcastPresence: broadcastPresence,
    adapter: adapter,
    adapters: adapters,
    clayPort: serverPort,
    clayTls: serverTls,
    clayAuthToken: serverAuthToken,
    getProjectList: getProjectList,
    getProjectCount: getProjectCount,
    getScheduleCount: getScheduleCount,
    moveScheduleToProject: moveScheduleToProject,
    moveAllSchedulesToProject: moveAllSchedulesToProject,
    getHubSchedules: getHubSchedules,
    fetchVersion: fetchVersion,
    isNewer: isNewer,
    scheduleMessage: scheduleMessage,
    cancelScheduledMessage: cancelScheduledMessage,
    getProjectOwnerId: function () { return projectOwnerId; },
    setProjectOwnerId: function (id) { projectOwnerId = id; },
    getUpdateChannel: function () { return updateChannel; },
    setUpdateChannel: function (ch) { updateChannel = ch; },
    getLatestVersion: _updateChecker.getLatestVersion,
    setLatestVersion: _updateChecker.setLatestVersion,
    onCreateWorktree: onCreateWorktree,
    IGNORED_DIRS: IGNORED_DIRS,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
    compactAndContinue: _sessionCompaction ? _sessionCompaction.compactAndContinue : null,
    _email: _email,
    _notifications: _notifications,
  });

  startExternalCodexSync({
    timers: projectTimers,
    clients: clients,
    sessions: _sessions,
    sm: sm,
    hydrateImageRefs: hydrateImageRefs,
  });

  // --- User message handler (delegated to project-user-message.js) ---
  _userMessage = attachUserMessage({
    cwd: cwd,
    slug: slug,
    isMate: isMate,
    osUsers: osUsers,
    sm: sm,
    sdk: sdk,
    nm: nm,
    tm: tm,
    clients: clients,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    opts: opts,
    usersModule: usersModule,
    matesModule: matesModule,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    getOsUserInfoForWs: getOsUserInfoForWs,
    hydrateImageRefs: hydrateImageRefs,
    saveImageFile: saveImageFile,
    imagesDir: imagesDir,
    onProcessingChanged: onProcessingChanged,
    onUserMessageDispatched: function (session, text) {
      if (_taskLauncher && typeof _taskLauncher.handleTaskUserMessageDispatched === "function") {
        return _taskLauncher.handleTaskUserMessageDispatched(session, text);
      }
      return "";
    },
    _loop: _loop,
    browserState: browserState,
    sendExtensionCommandAny: sendExtensionCommandAny,
    requestTabContext: requestTabContext,
    scheduleMessage: scheduleMessage,
    cancelScheduledMessage: cancelScheduledMessage,
    sendScheduledMessageNow: sendScheduledMessageNow,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
    digestDmTurn: digestDmTurn,
    gateMemory: gateMemory,
    escapeRegex: escapeRegex,
    adapter: adapter,
    getHubSchedules: getHubSchedules,
    getProjectOwnerId: function () { return projectOwnerId; },
    _email: _email,
  });

  // --- Project task launcher (`/launch`) ---
  _taskLauncher = attachTaskLauncher({
    cwd: cwd,
    slug: slug,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    usersModule: usersModule,
    getSessionForWs: getSessionForWs,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    onProcessingChanged: onProcessingChanged,
    onNeedsInput: function (session, text) {
      if (_autoLaunch && typeof _autoLaunch.notifyNeedsInput === "function") {
        _autoLaunch.notifyNeedsInput(session, text);
      }
    },
    onComplete: function (session, summary) {
      if (_autoLaunch && typeof _autoLaunch.notifyCompleted === "function") {
        _autoLaunch.notifyCompleted(session, summary);
      }
    },
  });
  _autoLaunch = attachAutoLaunch({
    cwd: cwd,
    slug: slug,
    sm: sm,
    loopRegistry: loopRegistry,
    getTaskLauncher: function () { return _taskLauncher; },
    notificationsModule: _notifications,
    pushModule: pushModule,
    send: send,
    sendTo: sendTo,
  });
  _autoLaunch.ensureSchedule();
  _taskSetup = attachTaskSetup({
    cwd: cwd,
    slug: slug,
    send: send,
    sendTo: sendTo,
    serverPort: serverPort,
    serverTls: serverTls,
    getAutoLaunch: function () { return _autoLaunch; },
  });
  _taskDashboard = attachTaskDashboard({
    cwd: cwd,
    sendTo: sendTo,
    usersModule: usersModule,
    osUsers: osUsers,
  });
  var daemonConfigForDashboards = typeof opts.onGetDaemonConfig === "function" ? opts.onGetDaemonConfig() : null;
  var dashboardAutoStartAllowed = !multiUser || !!(daemonConfigForDashboards && daemonConfigForDashboards.dashboardAutoStart === true);
  if (dashboardAutoStartAllowed) startConfiguredDashboards(cwd);

  // --- Filesystem handler (delegated to project-filesystem.js) ---
  var _filesystem = attachFilesystem({
    cwd: cwd,
    slug: slug,
    osUsers: osUsers,
    sm: sm,
    send: send,
    sendTo: sendTo,
    safePath: safePath,
    safeAbsPath: safeAbsPath,
    getOsUserInfoForWs: getOsUserInfoForWs,
    startFileWatch: startFileWatch,
    stopFileWatch: stopFileWatch,
    startDirWatch: startDirWatch,
    usersModule: usersModule,
    fsAsUser: fsAsUser,
    validateEnvString: validateEnvString,
    opts: opts,
    IGNORED_DIRS: IGNORED_DIRS,
    BINARY_EXTS: BINARY_EXTS,
    IMAGE_EXTS: IMAGE_EXTS,
    FS_MAX_SIZE: FS_MAX_SIZE,
  });

  _messageRouter = attachProjectMessageRouter({
    cwd: cwd,
    slug: slug,
    opts: opts,
    isMate: isMate,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    getSessionForWs: getSessionForWs,
    pendingDebateProposals: _pendingDebateProposals,
    handleMention: handleMention,
    handleUserMention: handleUserMention,
    vendorModels: _vendorModels,
    debate: {
      handleDebateStart: handleDebateStart,
      handleDebateHandRaise: handleDebateHandRaise,
      handleDebateComment: handleDebateComment,
      handleDebateStop: handleDebateStop,
      handleDebateConcludeResponse: handleDebateConcludeResponse,
      handleDebateConfirmBrief: handleDebateConfirmBrief,
      handleDebateUserFloorResponse: handleDebateUserFloorResponse,
      handleMcpDebateApproval: handleMcpDebateApproval,
    },
    modules: {
      email: _email,
      mcp: _mcp,
      mateDatastore: _mateDatastore,
      knowledge: _knowledge,
      notifications: _notifications,
      taskLauncher: _taskLauncher,
      autoLaunch: _autoLaunch,
      taskSetup: _taskSetup,
      taskDashboard: _taskDashboard,
      memory: _memory,
      sessions: _sessions,
      filesystem: _filesystem,
      workspace: _workspace,
      userMessage: _userMessage,
    },
  });

  var getMcpBridgeHandler = createMcpBridgeHandlerFactory({
    getLocalMcpServers: getLocalMcpServers,
    getRemoteMcpServers: function () { return _mcp.getMcpServers(); },
  });

  // --- HTTP handler (delegated to project-http.js) ---
  var _http = attachHTTP({
    cwd: cwd,
    slug: slug,
    project: _status.getProjectLabel(),
    sm: sm,
    send: send,
    imagesDir: imagesDir,
    osUsers: osUsers,
    pushModule: pushModule,
    safePath: safePath,
    safeAbsPath: safeAbsPath,
    getOsUserInfoForReq: getOsUserInfoForReq,
    sendExtensionCommandAny: sendExtensionCommandAny,
    _extToken: _extToken,
    _browserTabList: browserState._browserTabList,
    getMcpBridgeHandler: getMcpBridgeHandler,
    taskLauncher: _taskLauncher,
  });
  var handleHTTP = _http.handleHTTP;

  // --- Connection handler (delegated to project-connection.js) ---
  var _connection = attachConnection({
    cwd: cwd,
    slug: slug,
    isMate: isMate,
    osUsers: osUsers,
    debug: debug,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    currentVersion: currentVersion,
    lanHost: lanHost,
    sm: sm,
    tm: tm,
    nm: nm,
    clients: clients,
    send: send,
    sendTo: sendTo,
    opts: opts,
    _loop: _loop,
    _mcp: _mcp,
    _notifications: _notifications,
    resolveSessionForView: _sessions.resolveSessionForView,
    hydrateImageRefs: hydrateImageRefs,
    broadcastClientCount: broadcastClientCount,
    broadcastPresence: broadcastPresence,
    getProjectList: getProjectList,
    getHubSchedules: getHubSchedules,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
    scheduleMessage: scheduleMessage,
    autoResumeRestartSession: autoResumeRestartSession,
    _email: _email,
    restoreDebateState: restoreDebateState,
    stopFileWatch: stopFileWatch,
    stopAllDirWatches: stopAllDirWatches,
    getProjectOwnerId: function () { return projectOwnerId; },
    setProjectOwnerId: function (id) { projectOwnerId = id; },
    getLatestVersion: _updateChecker.getLatestVersion,
    getTitle: _status.getTitle,
    getProject: function () { return project; },
    // Exposed so the first websocket connection can lazily warm up the
    // adapters for this project (see project-connection handleConnection).
    warmup: _runtime.warmup,
  });

  var destroyProject = createProjectDestroy({
    cwd: cwd,
    slug: slug,
    timers: projectTimers,
    loop: _loop,
    email: _email,
    mateDatastore: _mateDatastore,
    stopFileWatch: stopFileWatch,
    stopAllDirWatches: stopAllDirWatches,
    sm: sm,
    tm: tm,
    clients: clients,
    adapters: adapters,
    sdk: sdk,
  });

  return {
    cwd: cwd,
    slug: slug,
    project: project,
    clients: clients,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    forEachClient: _foundation.forEachClient,
    handleConnection: handleConnection,
    handleMessage: handleMessage,
    handleDisconnection: handleDisconnection,
    handleHTTP: handleHTTP,
    getMcpBridgeHandler: getMcpBridgeHandler,
    getStatus: _status.getStatus,
    getSessionManager: function () { return sm; },
    getNotificationsModule: function () { return _notifications; },
    getSchedules: _loop.getSchedules,
    importSchedule: _loop.importSchedule,
    removeSchedule: _loop.removeSchedule,
    setTitle: _status.setTitle,
    setIcon: _status.setIcon,
    setProjectOwner: function (ownerId) { projectOwnerId = ownerId; },
    getProjectOwner: function () { return projectOwnerId; },
    refreshUserProfile: function (userId) {
      var user = usersModule.findUserById(userId);
      if (!user) return;
      for (var ws of clients) {
        if (ws._clayUser && ws._clayUser.id === userId) {
          ws._clayUser = user;
        }
      }
      broadcastClientCount();
      broadcastPresence();
    },
    destroy: destroyProject,
  };
}

module.exports = { createProjectContext: createProjectContext, safePath: safePath, validateEnvString: validateEnvString };
