var { fsAsUser } = require("./os-users");
var usersModule = require("./users");
var leadMode = require("./lead-mode");
var matesModule = require("./mates");
var { attachHTTP } = require("./project-http");
var { attachFilesystem } = require("./project-filesystem");
var { attachUserMessage } = require("./project-user-message");
var { attachTaskLauncher } = require("./project-task-launcher");
var { attachTaskOrchestrator } = require("./project-task-orchestrator");
var { attachSessionCompaction } = require("./project-session-compaction");
var {
  attachCoopSelfCleanupRuntime,
  createLeadWakeHandler,
  LEAD_WAKE_INTERVAL_MS,
} = require("./coop-self-cleanup-runtime");
var { attachAutoLaunch } = require("./project-auto-launch");
var { attachTaskDashboard, startConfiguredDashboards } = require("./project-task-dashboard");
var { attachTaskSetup } = require("./project-task-setup");
var { createMcpBridgeHandlerFactory } = require("./project-mcp-bridge-handler");
var { startExternalCodexSync } = require("./project-external-codex-sync");
var { attachProjectMessageRouter } = require("./project-message-router");
var { attachProjectHumanAttention } = require("./project-human-attention");
var { attachProjectLiveUi } = require("./project-live-ui");
var { createLiveUiRegistry } = require("./server-live-ui-registry");
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

function attachCleanupForProject(ctx) {
  if (ctx.isMate) return null;
  var sm = ctx.sm;
  var isLeadProject = ctx.slug === "lead";

  function leadModeEnabled() {
    return leadMode.getLeadMode();
  }

  var cleanupCompaction = attachSessionCompaction({
    cwd: ctx.cwd,
    sm: sm,
    sdk: ctx.sdk,
    sendToSession: ctx.sendToSession,
    onProcessingChanged: ctx.onProcessingChanged,
    ensureProjectAccessForSession: ctx.ensureProjectAccessForSession,
    imagesDir: ctx.imagesDir,
    loadImagesForSdk: ctx.loadImagesForSdk,
    now: ctx.coopSelfCleanupNow,
  });
  var leadWakeHandler = isLeadProject ? createLeadWakeHandler({
    projectSlug: ctx.slug,
    sm: sm,
    scheduleMessage: ctx.scheduleMessage,
    now: ctx.coopSelfCleanupNow,
  }) : null;
  var runtime = attachCoopSelfCleanupRuntime({
    sm: sm,
    projectSlug: ctx.slug,
    compactAndContinue: cleanupCompaction.compactAndContinue,
    getLeadMode: leadModeEnabled,
    thresholds: ctx.coopSelfCleanupThresholds,
    intervalMs: isLeadProject ? LEAD_WAKE_INTERVAL_MS : ctx.coopSelfCleanupIntervalMs,
    now: ctx.coopSelfCleanupNow,
    setInterval: ctx.coopSelfCleanupSetInterval,
    clearInterval: ctx.coopSelfCleanupClearInterval,
    onTick: leadWakeHandler,
  });
  runtime.resumeLeadWhenIngressDrained = function () {
    if (!leadWakeHandler) return false;
    return leadWakeHandler({ leadMode: leadModeEnabled() }, { force: true });
  };
  runtime.start(isLeadProject);
  if (ctx.projectTimers) ctx.projectTimers.coopSelfCleanupRuntime = runtime;
  return runtime;
}

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
    slug: slug,
    crossProject: opts.crossProject || null,
    resolveGlobalSessionRef: opts.resolveGlobalSessionRef || null,
    sm: sm,
    sdk: sdk,
    sendToSession: sendToSession,
    onProcessingChanged: onProcessingChanged,
    onCoopActionQueueChanged: opts.onCoopActionQueueChanged || null,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    loadImagesForSdk: ctx.loadImagesForSdk,
  });
  var liveUi = null;
  var coopSelfCleanup = attachCleanupForProject(ctx);
  var humanAttention = attachProjectHumanAttention({
    service: opts.humanAttention || null,
    slug: slug,
    sendTo: sendTo,
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
    isCoopTopicOwner: ctx.isCoopTopicOwner,
    getProjectList: ctx.getProjectList,
    onCoopIngressDrained: coopSelfCleanup && coopSelfCleanup.resumeLeadWhenIngressDrained,
    matesModule: matesModule,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    getOsUserInfoForWs: getOsUserInfoForWs,
    hydrateImageRefs: hydrateImageRefs,
    saveImageFile: saveImageFile,
    imagesDir: imagesDir,
    onProcessingChanged: onProcessingChanged,
    onUserMessageDispatched: function (session, text, actorUserId) {
      var directives = [];
      taskOrchestrator.resumeOwnedWorker(session);
      var reconciliationDirective = taskOrchestrator.resumeWaitingCoordinator(
        session, text, actorUserId);
      if (reconciliationDirective) directives.push(reconciliationDirective);
      if (taskLauncher && typeof taskLauncher.handleTaskUserMessageDispatched === "function") {
        var taskDirective = taskLauncher.handleTaskUserMessageDispatched(session, text, actorUserId);
        if (taskDirective) directives.push(taskDirective);
      }
      return directives.join("\n\n");
    },
    coordinateQueuedMessage: taskOrchestrator.coordinateQueuedMessage,
    closeOrchestrationTask: taskOrchestrator.closeTask,
    retryOrchestrationReconciliation: taskOrchestrator.retryReconciliation,
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

  liveUi = attachProjectLiveUi({
    slug: slug,
    registry: ctx.liveUiRegistry || createLiveUiRegistry(),
    workspace: workspace,
    browserState: browserState,
    getSessionForWs: getSessionForWs,
    usersModule: usersModule,
    sendTo: sendTo,
    sendExtensionCommandAny: sendExtensionCommandAny,
    sm: sm,
    taskOrchestrator: taskOrchestrator,
    saveImageFile: saveImageFile,
    getLinuxUserForSession: getLinuxUserForSession,
    createSessionForMessage: sessions && sessions.createSessionForMessage,
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
    // Lazy: auto-launch owns the gate and is attached after this.
    getAutomationGate: function () {
      return autoLaunch ? autoLaunch.automationGate : null;
    },
    coordinateExternalTask: taskOrchestrator.coordinateExternalTask,
    onNeedsInput: function (session, text) {
      if (autoLaunch && typeof autoLaunch.notifyNeedsInput === "function") {
        autoLaunch.notifyNeedsInput(session, text);
      }
    },
    onComplete: function (session, summary) {
      if (autoLaunch && typeof autoLaunch.notifyCompleted === "function") {
        return autoLaunch.notifyCompleted(session, summary);
      }
      return { ok: false, reason: "auto_launch_unavailable" };
    },
  });

  autoLaunch = attachAutoLaunch({
    cwd: cwd,
    slug: slug,
    sm: sm,
    getSessionForWs: getSessionForWs,
    listAutoApprovalProjects: opts.listAutoApprovalProjects || null,
    // The typed cross-project execution router. Admission needs it to turn a
    // pending candidate into a canonical binding; without it admission fails
    // closed and says so rather than dropping the work.
    crossProject: opts.crossProject || null,
    // The LIVE canonical Coop session that admitted work is attributed to.
    // Resolved per call, never fabricated: a binding whose source is invented
    // produces an execution outside Coop's task graph, with no coordinator
    // owning it. Returning null makes admission fail closed and stay visible,
    // which is the safe direction.
    getCoopSource: ctx.getCoopSource || null,
    loopRegistry: ctx.loopRegistry,
    getTaskLauncher: function () { return taskLauncher; },
    notificationsModule: notifications,
    pushModule: pushModule,
    send: send,
    sendTo: sendTo,
  });
  // Adopt already-running legacy automation BEFORE the first tick can propose,
  // so in-flight work is drained rather than duplicated.
  try {
    autoLaunch.drainLegacyAutomation();
  } catch (e) {
    console.error("[project] legacy automation drain failed:", e && e.message);
  }
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
    onEnvironmentChanged: function () {
      return sdk && typeof sdk.refreshEnvironmentRuntime === "function" ?
        sdk.refreshEnvironmentRuntime() : false;
    },
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
      liveUi: liveUi,
      userMessage: userMessage,
      humanAttention: humanAttention,
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
    liveUi: liveUi,
    coopSelfCleanup: coopSelfCleanup,
    messageRouter: messageRouter,
    getMcpBridgeHandler: getMcpBridgeHandler,
    handleHTTP: http.handleHTTP,
  };
}

module.exports = {
  attachProjectFeatures: attachProjectFeatures,
};
