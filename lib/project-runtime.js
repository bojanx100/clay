var { createSDKBridge } = require("./sdk-bridge");
var providerHealth = require("./provider-health");
var { createTerminalManager } = require("./terminal-manager");
var { createNotesManager } = require("./notes");
var matesModule = require("./mates");
var usersModule = require("./users");
var { attachLoop } = require("./project-loop");
var { attachSessionCompaction } = require("./project-session-compaction");
var { attachWorkspace } = require("./project-workspace");
var { attachProjectScheduledMessages } = require("./project-scheduled-messages");
var { attachProjectProviderFailover } = require("./project-provider-failover");
var { attachProviderSwitchRequest } = require("./provider-switch-request");
var { attachProjectVendorModels } = require("./project-vendor-models");
var { attachProjectUpdateChecker } = require("./project-update-checker");
var { attachMateClaudeWatcher } = require("./project-mate-claude-watcher");

function attachProjectRuntime(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var opts = ctx.opts || {};
  var sm = ctx.sm;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToAdmins = ctx.sendToAdmins;
  var sendToSession = ctx.sendToSession;
  var pushModule = ctx.pushModule || null;
  var adapter = ctx.adapter || null;
  var adapters = ctx.adapters || {};
  var isMate = !!ctx.isMate;
  var dangerouslySkipPermissions = !!ctx.dangerouslySkipPermissions;
  var serverPort = ctx.serverPort;
  var serverTls = !!ctx.serverTls;
  var serverAuthToken = ctx.serverAuthToken || null;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var getLocalMcpServers = ctx.getLocalMcpServers;
  var getRemoteMcpServers = ctx.getRemoteMcpServers;
  var getTaskLauncher = ctx.getTaskLauncher || function () { return null; };
  var getUserMessage = ctx.getUserMessage || function () { return null; };
  var getAutoLaunch = ctx.getAutoLaunch || function () { return null; };
  var digestDmTurn = ctx.digestDmTurn || function () {};
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var imagesDir = ctx.imagesDir;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var loadImagesForSdk = ctx.loadImagesForSdk;
  var getSessionForWs = ctx.getSessionForWs;
  var getHubSchedules = ctx.getHubSchedules || function () { return []; };
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var worktreeMeta = ctx.worktreeMeta || null;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;
  var osUsers = !!ctx.osUsers;
  var getProjectList = ctx.getProjectList || function () { return []; };
  var projectOwnerId = ctx.projectOwnerId || null;
  var currentVersion = ctx.currentVersion;
  var updateChannel = ctx.updateChannel || "stable";
  var projectTimers = ctx.projectTimers || {};
  var sessionTitleMigrationScheduled = false;
  var notifications = opts.notificationsModule || null;
  var sessionCompaction = null;
  var scheduledMessages = null;
  var providerFailover = null;
  var workspace = null;

  function scheduleMessage(session, text, resetsAt, promptText, displayLabel, opts2) {
    if (!scheduledMessages) return;
    return scheduledMessages.scheduleMessage(session, text, resetsAt, promptText, displayLabel, opts2);
  }

  function cancelScheduledMessage(session) {
    if (!scheduledMessages) return;
    return scheduledMessages.cancelScheduledMessage(session);
  }

  function continueWithUsageCredits(session, text, promptText, displayLabel) {
    if (!scheduledMessages) return false;
    return scheduledMessages.continueWithUsageCredits(session, text, promptText, displayLabel);
  }

  function sendScheduledMessageNow(session, opts2) {
    if (!scheduledMessages) return false;
    return scheduledMessages.sendScheduledMessageNow(session, opts2);
  }

  function restoreScheduledMessageTimers() {
    if (!scheduledMessages) return;
    return scheduledMessages.restoreScheduledMessageTimers();
  }

  function autoResumeRestartSession(session) {
    if (!scheduledMessages) return;
    return scheduledMessages.autoResumeRestartSession(session);
  }

  function failoverAndContinue(session, failure) {
    if (!providerFailover) return false;
    return providerFailover.failoverAndContinue(session, failure);
  }

  function queueProviderFailover(session, failure) {
    if (!providerFailover) return false;
    return providerFailover.queueFailover(session, failure);
  }

  function getComparableFailoverSetting() {
    if (typeof opts.onGetProjectAutoContinueComparable !== "function") return true;
    var state = opts.onGetProjectAutoContinueComparable(slug);
    if (typeof state === "boolean") return state;
    return !state || state.enabled !== false;
  }

  // Per-provider health thresholds are process-wide (a vendor outage is
  // global). Read them from daemon config at bridge-creation time; calling
  // configure repeatedly across projects is harmless — it just re-applies the
  // same global values.
  if (typeof opts.onGetDaemonConfig === "function") {
    try {
      var _dcHealth = opts.onGetDaemonConfig();
      if (_dcHealth && _dcHealth.providerHealth) {
        providerHealth.configure(_dcHealth.providerHealth);
      }
    } catch (e) {}
  }

  var sdk = createSDKBridge({
    cwd: cwd,
    slug: slug,
    sessionManager: sm,
    send: send,
    pushModule: pushModule,
    adapter: adapter,
    adapters: adapters,
    getNotificationsModule: function () { return notifications; },
    mateDisplayName: opts.mateDisplayName || "",
    isMate: isMate,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    mcpServers: getLocalMcpServers,
    getRemoteMcpServers: getRemoteMcpServers,
    clayPort: serverPort,
    clayTls: serverTls,
    clayAuthToken: serverAuthToken,
    onProcessingChanged: onProcessingChanged,
    onWorktreeChange: function (session) {
      if (workspace && typeof workspace.notifyContextChanged === "function") {
        workspace.notifyContextChanged(session);
      }
    },
    onTurnDone: function (session, preview, fullText) {
      var taskLauncher = getTaskLauncher();
      var userMessage = getUserMessage();
      if (isMate) digestDmTurn(session, preview);
      if (taskLauncher && typeof taskLauncher.handleTaskTurnDone === "function") {
        taskLauncher.handleTaskTurnDone(session, preview, fullText);
      }
      if (userMessage && typeof userMessage.scheduleQueuedUserMessageFlush === "function") {
        userMessage.scheduleQueuedUserMessageFlush(session);
      }
    },
    scheduleMessage: scheduleMessage,
    cancelScheduledMessage: cancelScheduledMessage,
    continueWithUsageCredits: continueWithUsageCredits,
    failoverAndContinue: failoverAndContinue,
    queueProviderFailover: queueProviderFailover,
    compactAndContinue: function (session, opts2) {
      if (!sessionCompaction || typeof sessionCompaction.compactAndContinue !== "function") return null;
      return sessionCompaction.compactAndContinue(session, opts2);
    },
    getAutoContinueSetting: function (session) {
      if (usersModule.isMultiUser() && session && session.ownerId) {
        return usersModule.getAutoContinue(session.ownerId);
      }
      if (typeof opts.onGetDaemonConfig === "function") {
        var dc = opts.onGetDaemonConfig();
        return !!dc.autoContinueOnRateLimit;
      }
      return false;
    },
  });

  sessionCompaction = attachSessionCompaction({
    cwd: cwd,
    slug: slug,
    sm: sm,
    sdk: sdk,
    sendToSession: sendToSession,
    onProcessingChanged: onProcessingChanged,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    imagesDir: imagesDir,
  });

  scheduledMessages = attachProjectScheduledMessages({
    imagesDir: imagesDir,
    sm: sm,
    sdk: sdk,
    sendToSession: sendToSession,
    hydrateImageRefs: hydrateImageRefs,
    loadImagesForSdk: loadImagesForSdk,
    onProcessingChanged: onProcessingChanged,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
  });
  providerFailover = attachProjectProviderFailover({
    cwd: cwd,
    imagesDir: imagesDir,
    sm: sm,
    sendTo: sendTo,
    sendToSession: sendToSession,
    cancelScheduledMessage: cancelScheduledMessage,
    scheduledMessages: scheduledMessages,
    onProcessingChanged: onProcessingChanged,
    getComparableFailoverSetting: getComparableFailoverSetting,
  });
  // Gate behind the model's switch_provider MCP tool: validates with the
  // same route/model resolution /provider uses, posts a confirmation card,
  // and only a user approval runs the shared executor. Shares the failover
  // module's switcher instance so all three trigger paths stay identical.
  var providerSwitchRequest = attachProviderSwitchRequest({
    sm: sm,
    switcher: providerFailover.switcher,
    scheduledMessages: scheduledMessages,
  });
  setTimeout(function () {
    sm.sessions.forEach(function (session) {
      autoResumeRestartSession(session);
    });
  }, 1500);

  var vendorModels = attachProjectVendorModels({
    cwd: cwd,
    slug: slug,
    sm: sm,
    adapters: adapters,
    sendTo: sendTo,
    getSessionForWs: getSessionForWs,
    serverPort: serverPort,
    serverTls: serverTls,
    serverAuthToken: serverAuthToken,
  });

  var loop = attachLoop({
    cwd: cwd,
    slug: slug,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    pushModule: pushModule,
    notificationsModule: notifications,
    onScheduledTrigger: function (record) {
      var autoLaunch = getAutoLaunch();
      if (autoLaunch && typeof autoLaunch.runScheduled === "function") {
        autoLaunch.runScheduled(record);
      }
    },
    getHubSchedules: getHubSchedules,
    getLinuxUserForSession: getLinuxUserForSession,
    onProcessingChanged: onProcessingChanged,
    hydrateImageRefs: hydrateImageRefs,
  });

  var tm = createTerminalManager({ cwd: cwd, send: send, sendTo: sendTo });
  var nm = createNotesManager({ cwd: cwd, send: send, sendTo: sendTo });
  attachMateClaudeWatcher({
    cwd: cwd,
    isMate: isMate,
    projectOwnerId: projectOwnerId,
    matesModule: matesModule,
    nm: nm,
    getProjectList: getProjectList,
  });

  workspace = attachWorkspace({
    cwd: cwd,
    slug: slug,
    send: send,
    sendTo: sendTo,
    getSessionForWs: getSessionForWs,
    hydrateImageRefs: hydrateImageRefs,
    tm: tm,
    worktreeMeta: worktreeMeta,
    getOsUserInfoForWs: getOsUserInfoForWs,
    usersModule: usersModule,
    osUsers: osUsers,
    persistSession: function (session) { sm.saveSessionFile(session); },
  });

  var updateChecker = attachProjectUpdateChecker({
    currentVersion: currentVersion,
    updateChannel: updateChannel,
    sendToAdmins: sendToAdmins,
  });

  function warmup() {
    sdk.warmup();
    sdk.startIdleReaper();
    if (!osUsers && !sessionTitleMigrationScheduled) {
      sessionTitleMigrationScheduled = true;
      setTimeout(function () {
        try {
          sm.migrateSessionTitles(adapter, cwd);
        } catch (e) {
          console.error("[project] Session title migration failed for " + slug + ":", e && e.message ? e.message : e);
        }
      }, 5000);
    }
  }

  projectTimers.restoredScheduledTimer = setTimeout(function () {
    restoreScheduledMessageTimers();
  }, 2000);
  if (projectTimers.restoredScheduledTimer && typeof projectTimers.restoredScheduledTimer.unref === "function") {
    projectTimers.restoredScheduledTimer.unref();
  }

  return {
    sdk: sdk,
    sessionCompaction: sessionCompaction,
    scheduledMessages: scheduledMessages,
    scheduleMessage: scheduleMessage,
    cancelScheduledMessage: cancelScheduledMessage,
    continueWithUsageCredits: continueWithUsageCredits,
    sendScheduledMessageNow: sendScheduledMessageNow,
    restoreScheduledMessageTimers: restoreScheduledMessageTimers,
    autoResumeRestartSession: autoResumeRestartSession,
    vendorModels: vendorModels,
    loop: loop,
    loopState: loop.loopState,
    loopRegistry: loop.loopRegistry,
    loopDir: loop.loopDir,
    startLoop: loop.startLoop,
    stopLoop: loop.stopLoop,
    resumeLoop: loop.resumeLoop,
    tm: tm,
    nm: nm,
    workspace: workspace,
    updateChecker: updateChecker,
    notifications: notifications,
    warmup: warmup,
    requestProviderSwitch: providerSwitchRequest.requestSwitch,
  };
}

module.exports = {
  attachProjectRuntime: attachProjectRuntime,
};
