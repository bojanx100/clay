var path = require("path");
var { fetchVersion, isNewer } = require("./updater");
var { execFileSync, spawn } = require("child_process");
var usersModule = require("./users");
var matesModule = require("./mates");
var userPresence = require("./user-presence");
var { attachSessions } = require("./project-sessions");
var { attachConnection } = require("./project-connection");
var { loadContextSources, saveContextSources } = require("./project-context-sources");
var { attachProjectFoundation } = require("./project-foundation");
var { attachProjectInteractions } = require("./project-interactions");
var { attachProjectRuntime } = require("./project-runtime");
var { attachProjectFeatures } = require("./project-features");
var { createProjectDestroy } = require("./project-destroy");
var { createCoordinatorProviderSwitch } = require("./coordinator-provider-switch");
var {
  IGNORED_DIRS,
  validateEnvString,
  safePath,
} = require("./project-path-utils");
// project-notifications is attached globally in server.js, passed via opts.notificationsModule

// YOKE adapter (replaces direct SDK access)
var yoke = require("./yoke");

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
  var getCoopSource = opts.getCoopSource || function () { return null; };
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

  var _yokeState = yoke.createAdapters({ cwd: cwd, slug: slug });
  var adapters = _yokeState.adapters;
  var defaultVendor = adapters.claude ? "claude" : Object.keys(adapters)[0] || "claude";
  var adapter = adapters[defaultVendor] || null;

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
  var _taskOrchestrationGate = _foundation.taskOrchestrationGate;

  var _userMessage = null;
  var _taskLauncher = null;
  var _taskOrchestrator = null;
  var _autoLaunch = null;
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
    getTaskOrchestrator: function () { return _taskOrchestrator; },
    getUserMessage: function () { return _userMessage; },
    getAutoLaunch: function () { return _autoLaunch; },
    digestDmTurn: function (session, preview) {
      if (digestDmTurn) digestDmTurn(session, preview);
    },
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    imagesDir: imagesDir,
    hydrateImageRefs: hydrateImageRefs,
    loadImagesForSdk: loadImagesForSdk,
    saveImageFile: saveImageFile,
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
  var sendScheduledMessageNow = _runtime.sendScheduledMessageNow;
  var autoResumeRestartSession = _runtime.autoResumeRestartSession;
  var _vendorModels = _runtime.vendorModels;
  var _loop = _runtime.loop;
  var loopRegistry = _runtime.loopRegistry;
  var tm = _runtime.tm;
  var nm = _runtime.nm;
  var _workspace = _runtime.workspace;
  var _updateChecker = _runtime.updateChecker;
  var _notifications = _runtime.notifications;
  // Arm the switch_provider model tool: its MCP registration happened in the
  // foundation with a late-binding holder; the runtime gate is ready now.
  if (_foundation.providerSwitchGate) {
    _foundation.providerSwitchGate.handler = _runtime.requestProviderSwitch;
  }
  if (_taskOrchestrationGate) {
    _taskOrchestrationGate.switchProvider = createCoordinatorProviderSwitch({
      sm: sm,
      crossProject: opts.crossProject,
    });
  }

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
    getCoopSource: getCoopSource,
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
  var handleDebatePauseToggle = _interactions.handleDebatePauseToggle;
  var restoreDebateState = _interactions.restoreDebateState;
  var handleMcpDebateApproval = _interactions.handleMcpDebateApproval;

  function handleDisconnection(ws) {
    if (_features && _features.liveUi) {
      _features.liveUi.handleDisconnect(ws);
    }
    // Clean up extension WS reference if this was the extension client
    if (browserState._extensionWs === ws) {
      browserState._extensionWs = null;
      browserState._extensionId = null;
      Object.keys(browserState._browserTabList).forEach(function (tabId) {
        delete browserState._browserTabList[tabId];
      });
      if (_mcp) _mcp.handleExtensionDisconnect();
    }
    _connection.handleDisconnection(ws);
  }

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

  var _features = attachProjectFeatures({
    cwd: cwd,
    slug: slug,
    opts: opts,
    isMate: isMate,
    osUsers: osUsers,
    multiUser: multiUser,
    sm: sm,
    sdk: sdk,
    nm: nm,
    tm: tm,
    clients: clients,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    sendExtensionCommandAny: sendExtensionCommandAny,
    requestTabContext: requestTabContext,
    browserState: browserState,
    pushModule: pushModule,
    adapter: adapter,
    adapters: adapters,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    getOsUserInfoForWs: getOsUserInfoForWs,
    getOsUserInfoForReq: getOsUserInfoForReq,
    hydrateImageRefs: hydrateImageRefs,
    loadImagesForSdk: loadImagesForSdk,
    saveImageFile: saveImageFile,
    imagesDir: imagesDir,
    onProcessingChanged: onProcessingChanged,
    loop: _loop,
    loopRegistry: loopRegistry,
    sessions: _sessions,
    workspace: _workspace,
    email: _email,
    mcp: _mcp,
    mateDatastore: _mateDatastore,
    knowledge: _knowledge,
    memory: _memory,
    notifications: _notifications,
    vendorModels: _vendorModels,
    projectTimers: projectTimers,
    scheduleMessage: scheduleMessage,
    cancelScheduledMessage: cancelScheduledMessage,
    sendScheduledMessageNow: sendScheduledMessageNow,
    digestDmTurn: digestDmTurn,
    gateMemory: gateMemory,
    escapeRegex: escapeRegex,
    getHubSchedules: getHubSchedules,
    getProjectOwnerId: function () { return projectOwnerId; },
    serverPort: serverPort,
    serverTls: serverTls,
    startFileWatch: startFileWatch,
    stopFileWatch: stopFileWatch,
    startDirWatch: startDirWatch,
    pendingDebateProposals: _pendingDebateProposals,
    handleMention: handleMention,
    handleUserMention: handleUserMention,
    debate: {
      handleDebateStart: handleDebateStart,
      handleDebateHandRaise: handleDebateHandRaise,
      handleDebateComment: handleDebateComment,
      handleDebateStop: handleDebateStop,
      handleDebateConcludeResponse: handleDebateConcludeResponse,
      handleDebateConfirmBrief: handleDebateConfirmBrief,
      handleDebateUserFloorResponse: handleDebateUserFloorResponse,
      handleDebatePauseToggle: handleDebatePauseToggle,
      handleMcpDebateApproval: handleMcpDebateApproval,
    },
    getLocalMcpServers: getLocalMcpServers,
    getRemoteMcpServers: function () { return _mcp.getMcpServers(); },
    projectLabel: _status.getProjectLabel(),
    extToken: _extToken,
    liveUiRegistry: opts.liveUiRegistry,
  });
  _userMessage = _features.userMessage;
  _taskLauncher = _features.taskLauncher;
  _taskOrchestrator = _features.taskOrchestrator;
  _autoLaunch = _features.autoLaunch;
  _messageRouter = _features.messageRouter;
  if (_taskOrchestrationGate && _taskOrchestrator) {
    _taskOrchestrationGate.delegate = _taskOrchestrator.delegateFromTool;
    _taskOrchestrationGate.message = _taskOrchestrator.messageFromTool;
    _taskOrchestrationGate.plan = _taskOrchestrator.planFromTool;
    _taskOrchestrationGate.report = _taskOrchestrator.reportFromTool;
    _taskOrchestrationGate.resolve = _taskOrchestrator.resolveFromTool;
    _taskOrchestrationGate.dismiss = _taskOrchestrator.dismissFromTool;
    _taskOrchestrationGate.requestInput = _taskOrchestrator.requestInputFromTool;
    _taskOrchestrationGate.retry = _taskOrchestrator.retryFromTool;
    _taskOrchestrationGate.adopt = _taskOrchestrator.adoptFromTool;
    _taskOrchestrationGate.listCoopSessions = _taskOrchestrator.listCoopSessionsFromTool;
    _taskOrchestrationGate.steerProjectCoordinator = _taskOrchestrator.steerProjectCoordinatorFromTool;
    _taskOrchestrationGate.migrateControlPlaneBinding = _taskOrchestrator.migrateControlPlaneBindingFromTool;
  }
  var getMcpBridgeHandler = _features.getMcpBridgeHandler;
  var handleHTTP = _features.handleHTTP;

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
    pendingDebateProposals: _pendingDebateProposals,
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
    getTaskOrchestrator: function () { return _taskOrchestrator; },
  });

  function deliverCoordinatorUpdate(sessionStorageId, text) {
    if (!_taskOrchestrator || typeof _taskOrchestrator.deliverCoordinatorUpdate !== "function") return false;
    return _taskOrchestrator.deliverCoordinatorUpdate(sessionStorageId, text);
  }

  function deliverCrossProjectEnvelope(envelope) {
    if (!_taskOrchestrator || typeof _taskOrchestrator.deliverCrossProjectEnvelope !== "function") {
      return { ok: false, reason: "target_not_capable" };
    }
    return _taskOrchestrator.deliverCrossProjectEnvelope(envelope);
  }

  var unregisterCrossProject = opts.crossProject &&
    typeof opts.crossProject.registerProjectResolver === "function" ?
    opts.crossProject.registerProjectResolver({
      getProjectId: function () {
        return sm && typeof sm.getProjectId === "function" ? sm.getProjectId() : null;
      },
      deliverCrossProjectEnvelope: deliverCrossProjectEnvelope,
      // The router resolves projects BY PROJECT ID through these resolvers
      // (server.js only indexes contexts by slug), so anything it needs to read
      // from a project has to be reachable here. Without this, the router could
      // not find the Lead project's sessions, so coopSessionRef() always
      // returned null and candidate admission failed closed forever.
      getSessionManager: function () { return sm; },
      getStatus: _status.getStatus,
      getProject: function () { return project; },
      slug: slug,
      switchProjectExecutionProvider: _runtime.switchProjectExecutionProvider,
    }) : null;

  return {
    cwd: cwd,
    slug: slug,
    crossProject: opts.crossProject,
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
    deliverCoordinatorUpdate: deliverCoordinatorUpdate,
    deliverCrossProjectEnvelope: deliverCrossProjectEnvelope,
    switchProjectExecutionProvider: _runtime.switchProjectExecutionProvider,
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
    destroy: function () {
      if (unregisterCrossProject) unregisterCrossProject();
      return destroyProject(_features.liveUi);
    },
  };
}
module.exports = { createProjectContext: createProjectContext, safePath: safePath, validateEnvString: validateEnvString };
