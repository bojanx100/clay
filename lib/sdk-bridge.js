var { attachSkillDiscovery } = require("./sdk-skill-discovery");
var { attachBridgePermissions } = require("./sdk-bridge-permissions");

// Opt-in per-event tracing. Logging every streamed event synchronously stalls
// the event loop during heavy command output and delays WebSocket heartbeat
// pongs (root cause of the "random freeze / auto-refresh"). Silent by default;
// set CLAY_DEBUG_EVENTS=1 to re-enable.
var CLAY_DEBUG_EVENTS = process.env.CLAY_DEBUG_EVENTS === "1";
var { createMessageQueue } = require("./sdk-message-queue");
var { attachMessageProcessor } = require("./sdk-message-processor");
var { attachBridgeAuth } = require("./sdk-bridge-auth");
var { attachBridgeModels } = require("./sdk-bridge-models");
var { mergeMcpServers } = require("./sdk-bridge-mcp");
var { attachAutoTitle } = require("./sdk-bridge-auto-title");
var { attachIdleReaper } = require("./sdk-bridge-idle-reaper");
var { attachBridgeProcesses } = require("./sdk-bridge-processes");
var { attachBridgeDialogs } = require("./sdk-bridge-dialogs");
var { attachBridgeRecovery } = require("./sdk-bridge-recovery");
var { attachBridgeWarmup } = require("./sdk-bridge-warmup");
var { attachBridgeControls } = require("./sdk-bridge-controls");
var { attachBridgeMentions } = require("./sdk-bridge-mentions");
var { attachBridgeRewind } = require("./sdk-bridge-rewind");
var { attachBridgeStream } = require("./sdk-bridge-stream");
var { attachBridgeQueryStart } = require("./sdk-bridge-query-start");

function createSDKBridge(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var sm = opts.sessionManager;   // session manager instance
  var send = opts.send;           // broadcast to all clients
  var pushModule = opts.pushModule;
  var getNotificationsModule = opts.getNotificationsModule || function () { return null; };
  var adapter = opts.adapter;
  var adapters = opts.adapters || {};
  var mateDisplayName = opts.mateDisplayName || "";
  var isMate = opts.isMate || (slug.indexOf("mate-") === 0);
  var dangerouslySkipPermissions = opts.dangerouslySkipPermissions || false;
  // mcpServers may be either a static object or a getter function. The
  // getter form lets callers gate individual servers at call time (e.g.
  // clay-browser is only exposed while the Chrome extension is connected).
  var _mcpServersSrc = opts.mcpServers || null;
  function getMcpServers() {
    if (typeof _mcpServersSrc === "function") return _mcpServersSrc() || null;
    return _mcpServersSrc;
  }
  var getRemoteMcpServers = opts.getRemoteMcpServers || null;
  var clayPort = opts.clayPort || 2633;
  var clayTls = opts.clayTls || false;
  var clayAuthToken = opts.clayAuthToken || null;
  var onProcessingChanged = opts.onProcessingChanged || function () {};
  var onWorktreeChange = opts.onWorktreeChange || function () {};
  var bridgeAuth = attachBridgeAuth({
    getNotificationsModule: getNotificationsModule,
    slug: slug,
    adapter: adapter,
  });
  var getFreshAuthState = bridgeAuth.getFreshAuthState;
  var isAuthErrorMessage = bridgeAuth.isAuthErrorMessage;
  var getLoginCommand = bridgeAuth.getLoginCommand;
  var getVendorDisplayName = bridgeAuth.getVendorDisplayName;
  var notifyAuthRequired = bridgeAuth.notifyAuthRequired;
  var logAuthDecision = bridgeAuth.logAuthDecision;

  var bridgeRecovery = attachBridgeRecovery({ opts: opts });
  var isTransientStreamError = bridgeRecovery.isTransientStreamError;
  var autoResumeAllowed = bridgeRecovery.autoResumeAllowed;
  var scheduleInterruptResume = bridgeRecovery.scheduleInterruptResume;
  var rateLimitResumeLabel = bridgeRecovery.rateLimitResumeLabel;

  var bridgeModels = attachBridgeModels({
    sm: sm,
    send: send,
    adapter: adapter,
  });
  var getModelsForVendor = bridgeModels.getModelsForVendor;
  var getModelsForSession = bridgeModels.getModelsForSession;
  var copilotRouteIdForModel = bridgeModels.copilotRouteIdForModel;
  var modelEntryValue = bridgeModels.modelEntryValue;
  var modelListContains = bridgeModels.modelListContains;
  var resolveModelInList = bridgeModels.resolveModelInList;
  var sendModelInfoForVendor = bridgeModels.sendModelInfoForVendor;
  var onTurnDone = opts.onTurnDone || null;

  var idleReaper = attachIdleReaper({ sm: sm });
  var startIdleReaper = idleReaper.startIdleReaper;
  var stopIdleReaper = idleReaper.stopIdleReaper;

  // --- Skill discovery (extracted to sdk-skill-discovery.js) ---
  var skills = attachSkillDiscovery({ cwd: cwd });
  var discoverSkillDirs = skills.discoverSkillDirs;
  var mergeSkills = skills.mergeSkills;

  var bridgeWarmup = attachBridgeWarmup({
    adapter: adapter,
    adapters: adapters,
    sm: sm,
    send: send,
    cwd: cwd,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    clayPort: clayPort,
    clayTls: clayTls,
    clayAuthToken: clayAuthToken,
    slug: slug,
    discoverSkillDirs: discoverSkillDirs,
    mergeSkills: mergeSkills,
    getModelsForVendor: getModelsForVendor,
  });
  var warmup = bridgeWarmup.warmup;

  var autoTitle = attachAutoTitle({
    cwd: cwd,
    sm: sm,
    adapter: adapter,
    getAdapterForSession: getAdapterForSession,
  });
  var autoGenerateTitle = autoTitle.autoGenerateTitle;

  // --- Message processing (extracted to sdk-message-processor.js) ---
  var msgProcessor = attachMessageProcessor({
    sm: sm,
    send: send,
    slug: slug,
    cwd: cwd,
    isMate: isMate,
    mateDisplayName: mateDisplayName,
    pushModule: pushModule,
    getNotificationsModule: getNotificationsModule,
    adapter: adapter,
    onProcessingChanged: onProcessingChanged,
    onTurnDone: onTurnDone,
    onWorktreeChange: onWorktreeChange,
    onAutoTitle: function (session) { autoGenerateTitle(session); },
    opts: opts,
    discoverSkillDirs: discoverSkillDirs,
    mergeSkills: mergeSkills,
    // Transient-failure recovery helpers, shared so in-band "API Error:" turns
    // (delivered as an assistant message + normal result, not a thrown error)
    // auto-resume with the same one-shot, budget-capped policy as thrown errors.
    isTransientStreamError: isTransientStreamError,
    autoResumeAllowed: autoResumeAllowed,
    scheduleInterruptResume: scheduleInterruptResume,
    saveImageFile: opts.saveImageFile,
    getLinuxUserForSession: opts.getLinuxUserForSession,
  });
  var processSDKMessage = msgProcessor.processSDKMessage;
  var sendAndRecord = msgProcessor.sendAndRecord;
  var sendToSession = msgProcessor.sendToSession;
  var bridgePermissions = attachBridgePermissions({
    sm: sm,
    sendAndRecord: sendAndRecord,
    onProcessingChanged: onProcessingChanged,
    pushModule: pushModule,
    getNotificationsModule: getNotificationsModule,
    getRemoteMcpServers: getRemoteMcpServers,
    slug: slug,
    adapter: adapter,
  });
  var checkToolWhitelist = bridgePermissions.checkToolWhitelist;
  var handleCanUseTool = bridgePermissions.handleCanUseTool;
  var permissionPushTitle = bridgePermissions.permissionPushTitle;
  var permissionPushBody = bridgePermissions.permissionPushBody;

  var bridgeDialogs = attachBridgeDialogs({
    sendAndRecord: sendAndRecord,
    pushModule: pushModule,
    slug: slug,
  });
  var handleElicitation = bridgeDialogs.handleElicitation;
  var handleUserDialog = bridgeDialogs.handleUserDialog;

  var bridgeProcesses = attachBridgeProcesses({ cwd: cwd });
  var ensureLinuxUserProjectDir = bridgeProcesses.ensureLinuxUserProjectDir;
  var findConflictingClaude = bridgeProcesses.findConflictingClaude;
  var isClaudeProcess = bridgeProcesses.isClaudeProcess;

  var bridgeControls = attachBridgeControls({
    sm: sm,
    send: send,
    adapter: adapter,
    modelEntryValue: modelEntryValue,
    sendModelInfoForVendor: sendModelInfoForVendor,
  });
  var setModel = bridgeControls.setModel;
  var setEffort = bridgeControls.setEffort;
  var setPermissionMode = bridgeControls.setPermissionMode;
  var stopTask = bridgeControls.stopTask;
  var reloadSkills = bridgeControls.reloadSkills;
  var setMcpPermissionModeOverride = bridgeControls.setMcpPermissionModeOverride;

  var bridgeMentions = attachBridgeMentions({
    adapters: adapters,
    adapter: adapter,
    cwd: cwd,
    mergeMcpServers: mergeMcpServers,
    getMcpServers: getMcpServers,
    getRemoteMcpServers: getRemoteMcpServers,
    checkToolWhitelist: checkToolWhitelist,
  });
  var createMentionSession = bridgeMentions.createMentionSession;

  var bridgeStream = attachBridgeStream({
    adapter: adapter,
    sm: sm,
    send: send,
    sendAndRecord: sendAndRecord,
    sendToSession: sendToSession,
    processSDKMessage: processSDKMessage,
    onProcessingChanged: onProcessingChanged,
    onTurnDone: onTurnDone,
    opts: opts,
    getVendorDisplayName: getVendorDisplayName,
    isAuthErrorMessage: isAuthErrorMessage,
    getFreshAuthState: getFreshAuthState,
    logAuthDecision: logAuthDecision,
    getLoginCommand: getLoginCommand,
    notifyAuthRequired: notifyAuthRequired,
    findConflictingClaude: findConflictingClaude,
    isTransientStreamError: isTransientStreamError,
    autoResumeAllowed: autoResumeAllowed,
    scheduleInterruptResume: scheduleInterruptResume,
    sendModelInfoForVendor: sendModelInfoForVendor,
    rateLimitResumeLabel: rateLimitResumeLabel,
    debugEvents: CLAY_DEBUG_EVENTS,
    pushModule: pushModule,
    getNotificationsModule: getNotificationsModule,
    slug: slug,
  });
  var processQueryStream = bridgeStream.processQueryStream;

  function getAdapterForSession(session) {
    var vendor = session.vendor || sm.defaultVendor || "claude";
    return adapters[vendor] || adapter;
  }

  var bridgeRewind = attachBridgeRewind({
    adapter: adapter,
    cwd: cwd,
    sendAndRecord: sendAndRecord,
    getAdapterForSession: getAdapterForSession,
  });
  var getOrCreateRewindQuery = bridgeRewind.getOrCreateRewindQuery;
  var rewindPreview = bridgeRewind.rewindPreview;
  var rewindExecuteFiles = bridgeRewind.rewindExecuteFiles;
  var rollbackConversation = bridgeRewind.rollbackConversation;
  var forkSessionUnified = bridgeRewind.forkSession;

  var bridgeQueryStart = attachBridgeQueryStart({
    adapters: adapters,
    adapter: adapter,
    cwd: cwd,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    clayPort: clayPort,
    clayTls: clayTls,
    clayAuthToken: clayAuthToken,
    slug: slug,
    sm: sm,
    send: send,
    sendToSession: sendToSession,
    sendAndRecord: sendAndRecord,
    onProcessingChanged: onProcessingChanged,
    ensureLinuxUserProjectDir: ensureLinuxUserProjectDir,
    getFreshAuthState: getFreshAuthState,
    logAuthDecision: logAuthDecision,
    getVendorDisplayName: getVendorDisplayName,
    getLoginCommand: getLoginCommand,
    notifyAuthRequired: notifyAuthRequired,
    copilotRouteIdForModel: copilotRouteIdForModel,
    getModelsForSession: getModelsForSession,
    modelListContains: modelListContains,
    resolveModelInList: resolveModelInList,
    modelEntryValue: modelEntryValue,
    mergeMcpServers: mergeMcpServers,
    getMcpServers: getMcpServers,
    getRemoteMcpServers: getRemoteMcpServers,
    handleCanUseTool: handleCanUseTool,
    handleElicitation: handleElicitation,
    handleUserDialog: handleUserDialog,
    processQueryStream: processQueryStream,
  });
  var startQuery = bridgeQueryStart.startQuery;
  var ensureVendorReady = bridgeQueryStart.ensureVendorReady;

  function pushMessage(session, text, images) {
    session.lastActivityAt = Date.now();
    // Route through QueryHandle (works for both in-process and worker paths)
    var _canPush = !!(session.queryInstance && typeof session.queryInstance.pushMessage === "function");
    // Paste-delivery instrumentation: confirm the full agent-facing text reaches
    // the adapter (a missing queryInstance silently drops it). Filter: [clay-paste]
    try {
      console.log("[clay-paste] pushMessage: session=" + session.localId +
        " textLen=" + ((text || "").length) + " delivered=" + _canPush);
    } catch (e) {}
    if (_canPush) {
      session.queryInstance.pushMessage(text, images);
    }
  }

  return {
    createMessageQueue: createMessageQueue,
    processSDKMessage: processSDKMessage,
    checkToolWhitelist: checkToolWhitelist,
    handleCanUseTool: handleCanUseTool,
    handleElicitation: handleElicitation,
    processQueryStream: processQueryStream,
    getOrCreateRewindQuery: getOrCreateRewindQuery,
    rewindPreview: rewindPreview,
    rewindExecuteFiles: rewindExecuteFiles,
    rollbackConversation: rollbackConversation,
    forkSession: forkSessionUnified,
    startQuery: startQuery,
    ensureVendorReady: ensureVendorReady,
    // Exposed so other auto-resume paths (e.g. restart-resume in project.js)
    // share the SAME consecutive-resume budget instead of each minting their
    // own. Keeps the runaway-resume bound authoritative across all callers.
    autoResumeAllowed: autoResumeAllowed,
    pushMessage: pushMessage,
    setModel: setModel,
    setEffort: setEffort,
    setPermissionMode: setPermissionMode,
    isClaudeProcess: isClaudeProcess,
    permissionPushTitle: permissionPushTitle,
    permissionPushBody: permissionPushBody,
    warmup: warmup,
    stopTask: stopTask,
    reloadSkills: reloadSkills,
    setMcpPermissionModeOverride: setMcpPermissionModeOverride,
    createMentionSession: createMentionSession,
    startIdleReaper: startIdleReaper,
    stopIdleReaper: stopIdleReaper,
  };
}

module.exports = { createSDKBridge, createMessageQueue };
