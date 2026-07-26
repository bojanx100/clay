var { fsAsUser } = require("./os-users");
var usersModule = require("./users");
var matesModule = require("./mates");
var { attachHTTP } = require("./project-http");
var { attachFilesystem } = require("./project-filesystem");
var { attachUserMessage } = require("./project-user-message");
var { attachTaskLauncher } = require("./project-task-launcher");
var { attachTaskOrchestrator } = require("./project-task-orchestrator");
var { attachAutoLaunch } = require("./project-auto-launch");
var { attachTaskDashboard, startConfiguredDashboards } = require("./project-task-dashboard");
var { attachTaskSetup } = require("./project-task-setup");
var { createMcpBridgeHandlerFactory } = require("./project-mcp-bridge-handler");
var { startExternalCodexSync } = require("./project-external-codex-sync");
var { attachProjectMessageRouter } = require("./project-message-router");
var { loadContextSources, saveContextSources } = require("./project-context-sources");
var {
  IGNORED_DIRS,
  BINARY_EXTS,
  IMAGE_EXTS,
  FS_MAX_SIZE,
  validateEnvString,
  safePath,
  safeAbsPath,
} = require("./project-path-utils");

function attachProjectFeatures(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var opts = ctx.opts || {};
  var isMate = !!ctx.isMate;
  var osUsers = !!ctx.osUsers;
  var multiUser = !!ctx.multiUser;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var nm = ctx.nm;
  var tm = ctx.tm;
  var clients = ctx.clients;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var sendToSessionOthers = ctx.sendToSessionOthers;
  var sendExtensionCommandAny = ctx.sendExtensionCommandAny;
  var requestTabContext = ctx.requestTabContext;
  var browserState = ctx.browserState;
  var pushModule = ctx.pushModule || null;
  var adapter = ctx.adapter || null;
  var adapters = ctx.adapters || {};
  var getSessionForWs = ctx.getSessionForWs;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;
  var getOsUserInfoForReq = ctx.getOsUserInfoForReq;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var saveImageFile = ctx.saveImageFile;
  var imagesDir = ctx.imagesDir;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var loop = ctx.loop;
  var sessions = ctx.sessions;
  var workspace = ctx.workspace;
  var email = ctx.email;
  var mcp = ctx.mcp;
  var mateDatastore = ctx.mateDatastore;
  var knowledge = ctx.knowledge;
  var memory = ctx.memory;
  var notifications = ctx.notifications;
  var vendorModels = ctx.vendorModels;
  var taskLauncher = null;
  var autoLaunch = null;
  var taskOrchestrator = attachTaskOrchestrator({
    cwd: cwd,
    sm: sm,
    sdk: sdk,
    sendToSession: sendToSession,
    onProcessingChanged: onProcessingChanged,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
  });

  startExternalCodexSync({
    timers: ctx.projectTimers,
    clients: clients,
    sessions: sessions,
    sm: sm,
    hydrateImageRefs: hydrateImageRefs,
  });

  var userMessage = attachUserMessage({
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
      taskOrchestrator.resumeOwnedWorker(session);
      if (taskLauncher && typeof taskLauncher.handleTaskUserMessageDispatched === "function") {
        return taskLauncher.handleTaskUserMessageDispatched(session, text);
      }
      return "";
    },
    coordinateQueuedMessage: taskOrchestrator.coordinateQueuedMessage,
    closeOrchestrationTask: taskOrchestrator.closeTask,
    resolveOrchestrationTask: taskOrchestrator.resolveTask,
    listAdoptionCoordinators: taskOrchestrator.listAdoptionCoordinators,
    proposeSessionAdoption: taskOrchestrator.proposeSessionAdoption,
    _loop: loop,
    browserState: browserState,
    sendExtensionCommandAny: sendExtensionCommandAny,
    requestTabContext: requestTabContext,
    scheduleMessage: ctx.scheduleMessage,
    cancelScheduledMessage: ctx.cancelScheduledMessage,
    sendScheduledMessageNow: ctx.sendScheduledMessageNow,
    handleSwitchCommand: sessions ? sessions.handleSwitchCommand : null,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
    digestDmTurn: ctx.digestDmTurn,
    gateMemory: ctx.gateMemory,
    escapeRegex: ctx.escapeRegex,
    adapter: adapter,
    getHubSchedules: ctx.getHubSchedules,
    getProjectOwnerId: ctx.getProjectOwnerId,
    _email: email,
  });

  taskLauncher = attachTaskLauncher({
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
      if (autoLaunch && typeof autoLaunch.notifyNeedsInput === "function") {
        autoLaunch.notifyNeedsInput(session, text);
      }
    },
    onComplete: function (session, summary) {
      if (autoLaunch && typeof autoLaunch.notifyCompleted === "function") {
        autoLaunch.notifyCompleted(session, summary);
      }
    },
  });

  autoLaunch = attachAutoLaunch({
    cwd: cwd,
    slug: slug,
    sm: sm,
    loopRegistry: ctx.loopRegistry,
    getTaskLauncher: function () { return taskLauncher; },
    notificationsModule: notifications,
    pushModule: pushModule,
    send: send,
    sendTo: sendTo,
  });
  autoLaunch.ensureSchedule();

  var taskSetup = attachTaskSetup({
    cwd: cwd,
    slug: slug,
    send: send,
    sendTo: sendTo,
    serverPort: ctx.serverPort,
    serverTls: ctx.serverTls,
    getAutoLaunch: function () { return autoLaunch; },
  });
  var taskDashboard = attachTaskDashboard({
    cwd: cwd,
    sendTo: sendTo,
    usersModule: usersModule,
    osUsers: osUsers,
  });
  var daemonConfigForDashboards = typeof opts.onGetDaemonConfig === "function" ? opts.onGetDaemonConfig() : null;
  var dashboardAutoStartAllowed = !multiUser || !!(daemonConfigForDashboards && daemonConfigForDashboards.dashboardAutoStart === true);
  if (dashboardAutoStartAllowed) startConfiguredDashboards(cwd);

  var filesystem = attachFilesystem({
    cwd: cwd,
    slug: slug,
    osUsers: osUsers,
    sm: sm,
    send: send,
    sendTo: sendTo,
    safePath: safePath,
    safeAbsPath: safeAbsPath,
    getOsUserInfoForWs: getOsUserInfoForWs,
    startFileWatch: ctx.startFileWatch,
    stopFileWatch: ctx.stopFileWatch,
    startDirWatch: ctx.startDirWatch,
    usersModule: usersModule,
    fsAsUser: fsAsUser,
    validateEnvString: validateEnvString,
    opts: opts,
    IGNORED_DIRS: IGNORED_DIRS,
    BINARY_EXTS: BINARY_EXTS,
    IMAGE_EXTS: IMAGE_EXTS,
    FS_MAX_SIZE: FS_MAX_SIZE,
  });

  var messageRouter = attachProjectMessageRouter({
    cwd: cwd,
    slug: slug,
    opts: opts,
    isMate: isMate,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    getSessionForWs: getSessionForWs,
    pendingDebateProposals: ctx.pendingDebateProposals,
    handleMention: ctx.handleMention,
    handleUserMention: ctx.handleUserMention,
    vendorModels: vendorModels,
    debate: ctx.debate,
    modules: {
      email: email,
      mcp: mcp,
      mateDatastore: mateDatastore,
      knowledge: knowledge,
      notifications: notifications,
      taskLauncher: taskLauncher,
      autoLaunch: autoLaunch,
      taskSetup: taskSetup,
      taskDashboard: taskDashboard,
      memory: memory,
      sessions: sessions,
      filesystem: filesystem,
      workspace: workspace,
      userMessage: userMessage,
    },
  });

  var getMcpBridgeHandler = createMcpBridgeHandlerFactory({
    getLocalMcpServers: ctx.getLocalMcpServers,
    getRemoteMcpServers: ctx.getRemoteMcpServers,
  });

  var http = attachHTTP({
    cwd: cwd,
    slug: slug,
    project: ctx.projectLabel,
    sm: sm,
    send: send,
    imagesDir: imagesDir,
    osUsers: osUsers,
    pushModule: pushModule,
    safePath: safePath,
    safeAbsPath: safeAbsPath,
    getOsUserInfoForReq: getOsUserInfoForReq,
    sendExtensionCommandAny: sendExtensionCommandAny,
    _extToken: ctx.extToken,
    _browserTabList: browserState._browserTabList,
    getMcpBridgeHandler: getMcpBridgeHandler,
    taskLauncher: taskLauncher,
  });

  return {
    userMessage: userMessage,
    taskLauncher: taskLauncher,
    taskOrchestrator: taskOrchestrator,
    autoLaunch: autoLaunch,
    taskSetup: taskSetup,
    taskDashboard: taskDashboard,
    filesystem: filesystem,
    messageRouter: messageRouter,
    getMcpBridgeHandler: getMcpBridgeHandler,
    handleHTTP: http.handleHTTP,
  };
}

module.exports = {
  attachProjectFeatures: attachProjectFeatures,
};
