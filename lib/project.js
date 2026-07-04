var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var { createSessionManager } = require("./sessions");
var { codexConfigForAutomation } = require("./automation-modes");
var { CODEX_DEFAULTS } = require("./codex-defaults");
var { createSDKBridge, createMessageQueue } = require("./sdk-bridge");
var { createTerminalManager } = require("./terminal-manager");
var { createNotesManager } = require("./notes");
var { fetchVersion, isNewer } = require("./updater");
var { execFileSync, spawn } = require("child_process");
var usersModule = require("./users");
var { fsAsUser } = require("./os-users");
var crisisSafety = require("./crisis-safety");
var matesModule = require("./mates");
var sessionSearch = require("./session-search");
var userPresence = require("./user-presence");
var { attachDebate } = require("./project-debate");
var { attachMemory } = require("./project-memory");
var { attachMateInteraction } = require("./project-mate-interaction");
var { attachUserMention } = require("./project-user-mention");
var { attachLoop } = require("./project-loop");
var { attachFileWatch } = require("./project-file-watch");
var { attachHTTP } = require("./project-http");
var { attachImage } = require("./project-image");
var { attachKnowledge } = require("./project-knowledge");
var { attachFilesystem } = require("./project-filesystem");
var { attachSessions } = require("./project-sessions");
var { attachUserMessage } = require("./project-user-message");
var { attachSessionCompaction } = require("./project-session-compaction");
var { attachTaskLauncher } = require("./project-task-launcher");
var { attachAutoLaunch } = require("./project-auto-launch");
var { attachTaskDashboard, startConfiguredDashboards } = require("./project-task-dashboard");
var { attachTaskSetup } = require("./project-task-setup");
var { attachConnection } = require("./project-connection");
var { attachMcp } = require("./project-mcp");
var { attachMateDatastore } = require("./project-mate-datastore");
var { createLocalMcp } = require("./mcp-local");
var { attachEmail: attachEmailModule } = require("./project-email");
var { attachWorkspace } = require("./project-workspace");
var { loadContextSources, saveContextSources } = require("./project-context-sources");
var { createProjectLocalMcpServers } = require("./project-local-mcp-servers");
var { attachProjectOsUsers } = require("./project-os-users");
var { attachProjectClients } = require("./project-clients");
var { attachProjectBrowserExtension } = require("./project-browser-extension");
var { createMcpBridgeHandlerFactory } = require("./project-mcp-bridge-handler");
var { attachProjectScheduledMessages } = require("./project-scheduled-messages");
var { attachProjectVendorModels } = require("./project-vendor-models");
var { attachProjectUpdateChecker } = require("./project-update-checker");
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
  var title = opts.title || null;
  var icon = opts.icon || null;
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
  var sessionTitleMigrationScheduled = false;

  // --- YOKE adapters (multi-vendor, lazy init) ---
  var _yokeState = yoke.createAdapters({ cwd: cwd, slug: slug });
  var adapters = _yokeState.adapters;
  var defaultVendor = adapters.claude ? "claude" : Object.keys(adapters)[0] || "claude";
  var adapter = adapters[defaultVendor] || null;

  // Browser MCP server runs in-process via createSdkMcpServer (no child process spawn).
  // Do NOT write to .claude-local/settings.json -- the SDK reads that too, causing duplicate spawns.

  // --- Image engine (delegated to project-image.js) ---
  var _image = attachImage({ cwd: cwd, slug: slug });
  var imagesDir = _image.imagesDir;
  var hydrateImageRefs = _image.hydrateImageRefs;
  var saveImageFile = _image.saveImageFile;
  var loadImagesForSdk = _image.loadImagesForSdk;

  // --- OS-level user isolation helper ---
  var _osUsers = attachProjectOsUsers({
    cwd: cwd,
    osUsers: osUsers,
  });
  var getLinuxUserForSession = _osUsers.getLinuxUserForSession;
  var ensureProjectAccessForSession = _osUsers.ensureProjectAccessForSession;
  var getOsUserInfoForWs = _osUsers.getOsUserInfoForWs;
  var getOsUserInfoForReq = _osUsers.getOsUserInfoForReq;

  // --- Per-project clients ---
  var _clients = attachProjectClients({
    usersModule: usersModule,
    onPresenceChange: onPresenceChange,
  });
  var clients = _clients.clients;
  var send = _clients.send;
  var sendTo = _clients.sendTo;
  var sendToAdmins = _clients.sendToAdmins;
  var broadcastClientCount = _clients.broadcastClientCount;
  var sendToOthers = _clients.sendToOthers;
  var sendToSession = _clients.sendToSession;
  var sendToSessionOthers = _clients.sendToSessionOthers;
  var broadcastPresence = _clients.broadcastPresence;

  // --- Browser extension state (shared mutable object) ---
  var _pendingDebateProposals = {}; // proposalId -> { resolve, briefData }
  var _browserExtension = attachProjectBrowserExtension({
    sendTo: sendTo,
  });
  var _extToken = _browserExtension.extToken;
  var browserState = _browserExtension.browserState;
  var sendExtensionCommandAny = _browserExtension.sendExtensionCommandAny;
  var requestTabContext = _browserExtension.requestTabContext;

  // --- Knowledge engine (delegated to project-knowledge.js) ---
  var _knowledge = attachKnowledge({
    cwd: cwd,
    isMate: isMate,
    sendTo: sendTo,
    matesModule: matesModule,
    getProjectOwnerId: function () { return projectOwnerId; },
  });

  // --- File/directory watcher engine (delegated to project-file-watch.js) ---
  var _fileWatch = attachFileWatch({
    cwd: cwd,
    send: send,
    safePath: safePath,
    BINARY_EXTS: BINARY_EXTS,
    FS_MAX_SIZE: FS_MAX_SIZE,
    IGNORED_DIRS: IGNORED_DIRS,
  });
  var startFileWatch = _fileWatch.startFileWatch;
  var stopFileWatch = _fileWatch.stopFileWatch;
  var startDirWatch = _fileWatch.startDirWatch;
  var stopDirWatch = _fileWatch.stopDirWatch;
  var stopAllDirWatches = _fileWatch.stopAllDirWatches;

  // --- Session manager ---
  var sm = createSessionManager({
    cwd: cwd,
    send: send,
    sendTo: sendTo,
    sendEach: function (fn) {
      for (var ws of clients) {
        var user = ws._clayUser;
        var filterFn = null;
        if (usersModule.isMultiUser() && user) {
          filterFn = (function (u) {
            return function (s) {
              return usersModule.canAccessSession(u.id, s, { visibility: "public" });
            };
          })(user);
        }
        fn(ws, filterFn);
      }
    },
    onSessionDone: onSessionDone,
  });
  sm.availableVendors = Object.keys(adapters);
  sm.defaultVendor = defaultVendor;

  var _srvMode = typeof opts.onGetServerDefaultMode === "function" ? opts.onGetServerDefaultMode() : null;
  sm._savedDefaultMode = fullAutoMode ? "bypassPermissions" : ((_srvMode && _srvMode.mode) || "default");
  sm.serverDefaultMode = sm._savedDefaultMode;
  // Immediately apply the saved default so config_state on connect reflects it
  // before the SDK has warmed up and fired system/init.
  if (sm._savedDefaultMode) sm.currentPermissionMode = sm._savedDefaultMode;
  if (fullAutoMode) {
    var fullAutoCodexConfig = codexConfigForAutomation("full");
    sm.codexApproval = fullAutoCodexConfig.approval;
    sm.codexSandbox = fullAutoCodexConfig.sandbox;
    sm.defaultAutomationMode = "full";
  }

  var _srvEffort = typeof opts.onGetServerDefaultEffort === "function" ? opts.onGetServerDefaultEffort() : null;
  sm.serverDefaultEffort = (_srvEffort && _srvEffort.effort) || "medium";
  sm.currentEffort = sm.serverDefaultEffort;

  var _srvDefaultVendorModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel(defaultVendor) : null;
  var _srvClaudeModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel("claude") : null;
  var _srvCodexModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel("codex") : null;
  var _srvCopilotModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel("github-copilot") : null;
  var _srvModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel() : null;
  sm.defaultModelsByVendor = {
    claude: (_srvClaudeModel && _srvClaudeModel.model) || null,
    codex: (_srvCodexModel && _srvCodexModel.model) || null,
    "github-copilot": (_srvCopilotModel && _srvCopilotModel.model) || null,
  };
  sm.serverDefaultModelsByVendor = Object.assign({}, sm.defaultModelsByVendor);
  sm._savedDefaultModel = (_srvDefaultVendorModel && _srvDefaultVendorModel.model) || (_srvModel && _srvModel.model) || null;
  // Immediately apply the saved default so config_state on connect reflects it
  // before the SDK has warmed up and fired system/init.
  if (sm._savedDefaultModel) sm.currentModel = sm._savedDefaultModel;

  var _srvCodex = typeof opts.onGetServerCodexDefaults === "function" ? opts.onGetServerCodexDefaults() : null;
  sm.serverDefaultCodexConfig = {
    approval: CODEX_DEFAULTS.approval,
    sandbox: CODEX_DEFAULTS.sandbox,
    webSearch: CODEX_DEFAULTS.webSearch,
  };
  if (_srvCodex) {
    var codexDefaults = Object.assign({}, _srvCodex || {});
    sm.serverDefaultCodexConfig = {
      approval: codexDefaults.approval || CODEX_DEFAULTS.approval,
      sandbox: codexDefaults.sandbox || CODEX_DEFAULTS.sandbox,
      webSearch: codexDefaults.webSearch || CODEX_DEFAULTS.webSearch,
    };
    if (!fullAutoMode) {
      sm.codexApproval = codexDefaults.approval || sm.codexApproval || CODEX_DEFAULTS.approval;
      sm.codexSandbox = codexDefaults.sandbox || sm.codexSandbox || CODEX_DEFAULTS.sandbox;
    }
    sm.codexWebSearch = codexDefaults.webSearch || sm.codexWebSearch || CODEX_DEFAULTS.webSearch;
  }
  if (fullAutoMode) {
    sm.serverDefaultCodexConfig.approval = sm.codexApproval || sm.serverDefaultCodexConfig.approval;
    sm.serverDefaultCodexConfig.sandbox = sm.codexSandbox || sm.serverDefaultCodexConfig.sandbox;
  }

  // --- Local MCP (direct process management for localhost clients) ---
  var _localMcp = createLocalMcp();

  // --- MCP bridge (remote MCP servers via Chrome Extension) ---
  var _mcp = attachMcp({
    send: send,
    sendTo: sendTo,
    slug: slug,
    isMate: isMate,
    getExtensionWs: function () { return browserState._extensionWs; },
    getExtensionId: function () { return browserState._extensionId || null; },
    getEnabledMcpServers: function () {
      return typeof opts.onGetProjectMcpServers === "function"
        ? opts.onGetProjectMcpServers(slug) : [];
    },
    setEnabledMcpServers: function (servers) {
      if (typeof opts.onSetProjectMcpServers === "function") {
        opts.onSetProjectMcpServers(slug, servers);
      }
    },
    localMcp: _localMcp,
  });

  // --- Email module (delegated to project-email.js) ---
  var _email = attachEmailModule({
    slug: slug,
    send: send,
    sendTo: sendTo,
    clients: clients,
    loadContextSources: loadContextSources,
    getUserIdForWs: function (ws) {
      return (ws._clayUser && ws._clayUser.id) || "default";
    },
  });

  // --- Mate datastore (Mate projects only) ---
  var _mateDatastore = attachMateDatastore({
    cwd: cwd,
    slug: slug,
    isMate: isMate,
    send: send,
    sendTo: sendTo,
    clients: clients,
    getSessionForWs: getSessionForWs,
    usersModule: usersModule,
    getProjectOwnerId: function () { return projectOwnerId; },
  });

  // --- MCP tool servers (created via YOKE adapter) ---
  var _localMcpServers = createProjectLocalMcpServers({
    adapter: adapter,
    isMate: isMate,
    isHostAgent: isHostAgent,
    slug: slug,
    sm: sm,
    clients: clients,
    browserState: browserState,
    sendExtensionCommandAny: sendExtensionCommandAny,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
    getAllProjectsWithSessions: getAllProjectsWithSessions,
    pendingDebateProposals: _pendingDebateProposals,
    email: _email,
    mateDatastore: _mateDatastore,
  });
  var getLocalMcpServers = _localMcpServers.getLocalMcpServers;

  var _userMessage = null;
  var _taskLauncher = null;
  var _autoLaunch = null;
  var _taskDashboard = null;
  var _taskSetup = null;
  var _sessionCompaction = null;
  var _scheduledMessages = null;

  function scheduleMessage(session, text, resetsAt, promptText, displayLabel, opts2) {
    if (!_scheduledMessages) return;
    return _scheduledMessages.scheduleMessage(session, text, resetsAt, promptText, displayLabel, opts2);
  }

  function cancelScheduledMessage(session) {
    if (!_scheduledMessages) return;
    return _scheduledMessages.cancelScheduledMessage(session);
  }

  function continueWithUsageCredits(session, text, promptText, displayLabel) {
    if (!_scheduledMessages) return false;
    return _scheduledMessages.continueWithUsageCredits(session, text, promptText, displayLabel);
  }

  function sendScheduledMessageNow(session, opts2) {
    if (!_scheduledMessages) return false;
    return _scheduledMessages.sendScheduledMessageNow(session, opts2);
  }

  function restoreScheduledMessageTimers() {
    if (!_scheduledMessages) return;
    return _scheduledMessages.restoreScheduledMessageTimers();
  }

  function autoResumeRestartSession(session) {
    if (!_scheduledMessages) return;
    return _scheduledMessages.autoResumeRestartSession(session);
  }

  // --- SDK bridge ---
  var sdk = createSDKBridge({
    cwd: cwd,
    slug: slug,
    sessionManager: sm,
    send: send,
    pushModule: pushModule,
    adapter: adapter,
    adapters: adapters,
    getNotificationsModule: function () { return _notifications; },
    mateDisplayName: opts.mateDisplayName || "",
    isMate: isMate,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    mcpServers: getLocalMcpServers,
    getRemoteMcpServers: function () { return _mcp.getMcpServers(); },
    clayPort: serverPort,
    clayTls: serverTls,
    clayAuthToken: serverAuthToken,
    onProcessingChanged: onProcessingChanged,
    // The agent switched the worktree it's editing in (mid-turn): push a live
    // context update so the Session Context panel tracks it without waiting for
    // the turn to finish. _workspace is assigned later in this scope.
    onWorktreeChange: function (session) {
      if (_workspace && typeof _workspace.notifyContextChanged === "function") {
        _workspace.notifyContextChanged(session);
      }
    },
    onTurnDone: function (session, preview, fullText) {
      if (isMate) digestDmTurn(session, preview);
      if (_taskLauncher && typeof _taskLauncher.handleTaskTurnDone === "function") {
        _taskLauncher.handleTaskTurnDone(session, preview, fullText);
      }
      if (_userMessage && typeof _userMessage.scheduleQueuedUserMessageFlush === "function") {
        _userMessage.scheduleQueuedUserMessageFlush(session);
      }
    },
    scheduleMessage: function (session, text, resetsAt, promptText, displayLabel, opts2) {
      scheduleMessage(session, text, resetsAt, promptText, displayLabel, opts2);
    },
    cancelScheduledMessage: function (session) {
      cancelScheduledMessage(session);
    },
    continueWithUsageCredits: function (session, text, promptText, displayLabel) {
      return continueWithUsageCredits(session, text, promptText, displayLabel);
    },
    compactAndContinue: function (session, opts2) {
      if (!_sessionCompaction || typeof _sessionCompaction.compactAndContinue !== "function") return null;
      return _sessionCompaction.compactAndContinue(session, opts2);
    },
    getAutoContinueSetting: function (session) {
      // Per-user setting in multi-user mode
      if (usersModule.isMultiUser() && session && session.ownerId) {
        return usersModule.getAutoContinue(session.ownerId);
      }
      // Single-user: fall back to daemon config
      if (typeof opts.onGetDaemonConfig === "function") {
        var dc = opts.onGetDaemonConfig();
        return !!dc.autoContinueOnRateLimit;
      }
      return false;
    },
  });

  _sessionCompaction = attachSessionCompaction({
    cwd: cwd,
    slug: slug,
    sm: sm,
    sdk: sdk,
    sendToSession: sendToSession,
    onProcessingChanged: onProcessingChanged,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    imagesDir: imagesDir,
  });

  _scheduledMessages = attachProjectScheduledMessages({
    sm: sm,
    sdk: sdk,
    sendToSession: sendToSession,
    hydrateImageRefs: hydrateImageRefs,
    loadImagesForSdk: loadImagesForSdk,
    onProcessingChanged: onProcessingChanged,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
  });
  setTimeout(function () {
    sm.sessions.forEach(function (session) {
      autoResumeRestartSession(session);
    });
  }, 1500);

  var _vendorModels = attachProjectVendorModels({
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

  // --- Loop engine (delegated to project-loop.js) ---
  // --- Notification center (global singleton from server.js) ---
  var _notifications = opts.notificationsModule || null;

  var _loop = attachLoop({
    cwd: cwd,
    slug: slug,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    pushModule: pushModule,
    notificationsModule: _notifications,
    onScheduledTrigger: function (record) {
      if (_autoLaunch && typeof _autoLaunch.runScheduled === "function") {
        _autoLaunch.runScheduled(record);
      }
    },
    getHubSchedules: getHubSchedules,
    getLinuxUserForSession: getLinuxUserForSession,
    onProcessingChanged: onProcessingChanged,
    hydrateImageRefs: hydrateImageRefs,
  });
  var loopState = _loop.loopState;
  var loopRegistry = _loop.loopRegistry;
  var loopDir = _loop.loopDir;
  var startLoop = _loop.startLoop;
  var stopLoop = _loop.stopLoop;
  var resumeLoop = _loop.resumeLoop;

  // Mate CLAUDE.md crisis safety watcher
  var crisisWatcher = null;
  var crisisDebounce = null;



  // --- Terminal manager ---
  var tm = createTerminalManager({ cwd: cwd, send: send, sendTo: sendTo });
  var nm = createNotesManager({ cwd: cwd, send: send, sendTo: sendTo });

  // --- Session Context ("Workspace") panel ---
  var _workspace = attachWorkspace({
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

  var _updateChecker = attachProjectUpdateChecker({
    currentVersion: currentVersion,
    updateChannel: updateChannel,
    sendToAdmins: sendToAdmins,
  });

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

  // --- WS message handler ---
  function getSessionForWs(ws) {
    return sm.sessions.get(ws._clayActiveSession) || null;
  }

  function handleMessage(ws, msg) {
    // --- Heartbeat liveness probe (client detects zombie sockets after sleep) ---
    if (msg && msg.type === "ping") {
      sendTo(ws, { type: "pong" });
      return;
    }

    // --- Cross-project routing (e.g. permission_response from notification banner) ---
    if (msg.targetSlug && msg.targetSlug !== slug && opts.getProject) {
      var targetCtx = opts.getProject(msg.targetSlug);
      if (targetCtx) {
        targetCtx.handleMessage(ws, msg);
        return;
      }
    }

    // --- DM messages (delegated to server-level handler) ---
    if (msg.type === "dm_open" || msg.type === "dm_send" || msg.type === "dm_list" || msg.type === "dm_typing" || msg.type === "dm_add_favorite" || msg.type === "dm_remove_favorite" || msg.type === "mate_create" || msg.type === "mate_list" || msg.type === "mate_delete" || msg.type === "mate_update" || msg.type === "mate_readd_builtin" || msg.type === "mate_list_available_builtins" || msg.type === "email_accounts_list" || msg.type === "email_account_add" || msg.type === "email_account_remove" || msg.type === "email_account_test" || msg.type === "home_clay_open" || msg.type === "home_clay_send" || msg.type === "home_clay_new_session" || msg.type === "home_clay_close") {
      if (typeof opts.onDmMessage === "function") {
        opts.onDmMessage(ws, msg);
      }
      return;
    }

    // --- @Mention: invoke another Mate inline ---
    if (msg.type === "mention") {
      handleMention(ws, msg);
      return;
    }

    // --- @Mention: user-to-user side conversation in this session ---
    if (msg.type === "user_mention") {
      handleUserMention(ws, msg);
      return;
    }

    if (msg.type === "mention_stop") {
      var session = getSessionForWs(ws);
      if (session && session._mentionInProgress) {
        // Abort the active mention session for this mate
        var mateId = msg.mateId;
        if (mateId && session._mentionSessions && session._mentionSessions[mateId]) {
          session._mentionSessions[mateId].abort();
          session._mentionSessions[mateId].close();
          delete session._mentionSessions[mateId];
        }
        session._mentionInProgress = false;
        session._mentionActiveMateId = null;
        sendToSession(session.localId, { type: "mention_done", mateId: mateId, stopped: true });
        send({ type: "mention_processing", mateId: mateId, active: false });
      }
      return;
    }

    // --- Vendor model switching ---
    if (_vendorModels.handleMessage(ws, msg)) return;

    // --- Debate ---
    if (msg.type === "debate_start") {
      handleDebateStart(ws, msg);
      return;
    }
    if (msg.type === "debate_hand_raise") {
      handleDebateHandRaise(ws);
      return;
    }
    if (msg.type === "debate_comment") {
      handleDebateComment(ws, msg);
      return;
    }
    if (msg.type === "debate_stop") {
      handleDebateStop(ws);
      return;
    }
    if (msg.type === "debate_conclude_response") {
      handleDebateConcludeResponse(ws, msg);
      return;
    }
    if (msg.type === "debate_confirm_brief") {
      handleDebateConfirmBrief(ws);
      return;
    }
    if (msg.type === "debate_proposal_response") {
      // Match the most recent pending proposal (proposalId may not be
      // available on the client since it's not part of the tool input)
      var _dpKeys = Object.keys(_pendingDebateProposals);
      if (_dpKeys.length === 0) return;
      var _dpKey = msg.proposalId || _dpKeys[_dpKeys.length - 1];
      var pending = _pendingDebateProposals[_dpKey];
      if (!pending) return;
      delete _pendingDebateProposals[_dpKey];
      if (msg.action === "start") {
        // Set up debate state on the session, then transition to live
        var _dpSession = getSessionForWs(ws);
        if (_dpSession) {
          var _dpMateId = isMate ? path.basename(cwd) : null;
          handleMcpDebateApproval(_dpSession, pending.briefData, _dpMateId, ws);
        }
        pending.resolve({ action: "start" });
      } else {
        pending.resolve({ action: "cancel" });
      }
      return;
    }
    if (msg.type === "debate_user_floor_response") {
      handleDebateUserFloorResponse(ws, msg);
      return;
    }

    // --- Email defaults (project-level) ---
    if (_email.handleEmailMessage(ws, msg)) return;

    // --- MCP bridge (remote MCP servers via extension) ---
    if (_mcp.handleMcpMessage(ws, msg)) return;

    // --- Mate datastore ---
    if (_mateDatastore.handleMateDatastoreMessage(ws, msg)) return;

    // --- Knowledge file management (delegated to project-knowledge.js) ---
    if (_knowledge.handleKnowledgeMessage(ws, msg)) return;

    // --- Notifications (delegated to project-notifications.js) ---
    if (_notifications.handleNotificationMessage(ws, msg)) return;

    // --- Project task launcher (delegated to project-task-launcher.js) ---
    if (_taskLauncher && _taskLauncher.handleLaunchMessage(ws, msg)) return;

    // --- Auto-launch settings (delegated to project-auto-launch.js) ---
    if (_autoLaunch && _autoLaunch.handleMessage(ws, msg)) return;

    // --- Task launcher setup wizard (delegated to project-task-setup.js) ---
    if (_taskSetup && _taskSetup.handleMessage(ws, msg)) return;

    // --- Project dashboard commands (delegated to project-task-dashboard.js) ---
    if (_taskDashboard && _taskDashboard.handleDashboardMessage(ws, msg)) return;

    // --- Memory (session digests) management (delegated to project-memory.js) ---
    if (msg.type === "memory_list") { _memory.handleMemoryList(ws); return; }
    if (msg.type === "memory_search") { _memory.handleMemorySearch(ws, msg); return; }
    if (msg.type === "memory_delete") { _memory.handleMemoryDelete(ws, msg); return; }

    // --- Sessions, config, project mgmt (delegated to project-sessions.js) ---
    if (_sessions.handleSessionsMessage(ws, msg)) return;

    // --- Filesystem, settings, env (delegated to project-filesystem.js) ---
    if (_filesystem.handleFilesystemMessage(ws, msg)) return;

    // --- Session Context / Workspace panel (delegated to project-workspace.js) ---
    if (_workspace.handleWorkspaceMessage(ws, msg)) return;

    // --- Notes, terminals, context, user message (delegated to project-user-message.js) ---
    if (_userMessage.handleUserMessage(ws, msg)) return;
  }

  // --- Shared helpers ---

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // --- Memory engine (delegated to project-memory.js) ---
  var _memory = attachMemory({
    cwd: cwd,
    sm: sm,
    sdk: sdk,
    sendTo: sendTo,
    matesModule: matesModule,
    sessionSearch: sessionSearch,
    getAllProjectSessions: getAllProjectSessions,
    projectOwnerId: projectOwnerId,
    handleMessage: handleMessage,
  });
  var loadMateDigests = _memory.loadMateDigests;
  var gateMemory = _memory.gateMemory;
  var updateMemorySummary = _memory.updateMemorySummary;
  var initMemorySummary = _memory.initMemorySummary;

  // --- Mate interaction engine (delegated to project-mate-interaction.js) ---
  // Note: checkForDmDebateBrief comes from _debate (initialized below),
  // so we use a lazy getter that resolves at call time.
  var _mateInteraction = attachMateInteraction({
    cwd: cwd,
    slug: slug,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    matesModule: matesModule,
    isMate: isMate,
    projectOwnerId: projectOwnerId,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    saveImageFile: saveImageFile,
    hydrateImageRefs: hydrateImageRefs,
    onProcessingChanged: onProcessingChanged,
    loadMateDigests: loadMateDigests,
    updateMemorySummary: updateMemorySummary,
    initMemorySummary: initMemorySummary,
    getNotificationsModule: function () { return _notifications; },
    get checkForDmDebateBrief() { return checkForDmDebateBrief; },
  });
  var handleMention = _mateInteraction.handleMention;
  var getMateProfile = _mateInteraction.getMateProfile;
  var loadMateClaudeMd = _mateInteraction.loadMateClaudeMd;
  var digestDmTurn = _mateInteraction.digestDmTurn;
  var enqueueDigest = _mateInteraction.enqueueDigest;

  // --- User-to-user mention engine (delegated to project-user-mention.js) ---
  var _userMention = attachUserMention({
    slug: slug,
    sm: sm,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    saveImageFile: saveImageFile,
    hydrateImageRefs: hydrateImageRefs,
    usersModule: usersModule,
    pushModule: pushModule,
    isUserOnline: opts.isUserOnline || function () { return false; },
    getNotificationsModule: function () { return _notifications; },
    getProjectTitle: function () { return title || slug; },
  });
  var handleUserMention = _userMention.handleUserMention;

  // --- Debate engine (delegated to project-debate.js) ---
  var _debate = attachDebate({
    cwd: cwd,
    slug: slug,
    isMate: isMate,
    projectOwnerId: projectOwnerId,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sm: sm,
    sdk: sdk,
    getMateProfile: getMateProfile,
    loadMateClaudeMd: loadMateClaudeMd,
    loadMateDigests: loadMateDigests,
    hydrateImageRefs: hydrateImageRefs,
    onProcessingChanged: onProcessingChanged,
    getLinuxUserForSession: getLinuxUserForSession,
    getSessionForWs: getSessionForWs,
    updateMemorySummary: updateMemorySummary,
    initMemorySummary: initMemorySummary,
  });
  var handleDebateStart = _debate.handleDebateStart;
  var handleDebateHandRaise = _debate.handleDebateHandRaise;
  var handleDebateComment = _debate.handleDebateComment;
  var handleDebateStop = _debate.handleDebateStop;
  var handleDebateConcludeResponse = _debate.handleDebateConcludeResponse;
  var handleDebateConfirmBrief = _debate.handleDebateConfirmBrief;
  var handleDebateUserFloorResponse = _debate.handleDebateUserFloorResponse;
  var restoreDebateState = _debate.restoreDebateState;
  var checkForDmDebateBrief = _debate.checkForDmDebateBrief;
  var handleMcpDebateApproval = _debate.handleMcpDebateApproval;

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

  var externalCodexSyncTimer = setInterval(function () {
    if (!clients || clients.size === 0 || !_sessions || typeof _sessions.resolveSessionForView !== "function") return;
    var synced = {};
    for (var ws of clients) {
      if (!ws || ws.readyState !== 1 || !ws._clayActiveSession) continue;
      if (synced[ws._clayActiveSession]) continue;
      var session = sm.sessions.get(ws._clayActiveSession);
      if (!session || session.vendor !== "codex") continue;
      if (session.isProcessing || session.queryInstance) continue;
      var beforeMtime = session._historyMtime || 0;
      _sessions.resolveSessionForView(session, ws);
      var afterMtime = session._historyMtime || 0;
      if (afterMtime && afterMtime !== beforeMtime) {
        sm.switchSession(session.localId, ws, hydrateImageRefs);
        synced[session.localId] = true;
      }
    }
  }, 5000);
  if (externalCodexSyncTimer && typeof externalCodexSyncTimer.unref === "function") externalCodexSyncTimer.unref();

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

  var getMcpBridgeHandler = createMcpBridgeHandlerFactory({
    getLocalMcpServers: getLocalMcpServers,
    getRemoteMcpServers: function () { return _mcp.getMcpServers(); },
  });

  // --- HTTP handler (delegated to project-http.js) ---
  var _http = attachHTTP({
    cwd: cwd,
    slug: slug,
    project: title || project,
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
    getTitle: function () { return title; },
    getProject: function () { return project; },
    // Exposed so the first websocket connection can lazily warm up the
    // adapters for this project (see project-connection handleConnection).
    warmup: function () {
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
    },
  });

  var restoredScheduledTimer = setTimeout(function () {
    restoreScheduledMessageTimers();
  }, 2000);
  if (restoredScheduledTimer && typeof restoredScheduledTimer.unref === "function") restoredScheduledTimer.unref();

  // --- Destroy ---
  function destroy() {
    if (restoredScheduledTimer) {
      clearTimeout(restoredScheduledTimer);
      restoredScheduledTimer = null;
    }
    if (externalCodexSyncTimer) {
      clearInterval(externalCodexSyncTimer);
      externalCodexSyncTimer = null;
    }
    _loop.stopTimer();
    _email.destroy();
    if (_mateDatastore && typeof _mateDatastore.closeAllDatastores === "function") {
      try { _mateDatastore.closeAllDatastores(); } catch (e) {}
    }
    stopFileWatch();
    stopAllDirWatches();
    // Abort all active sessions and clean up mention sessions
    sm.sessions.forEach(function (session) {
      session.destroying = true;
      if (session.autoContinueTimer) {
        clearTimeout(session.autoContinueTimer);
        session.autoContinueTimer = null;
      }
      if (session.scheduledMessage && session.scheduledMessage.timer) {
        clearTimeout(session.scheduledMessage.timer);
        session.scheduledMessage = null;
      }
      if (session.abortController) {
        try { session.abortController.abort(); } catch (e) {}
      }
      // Close SDK query to terminate the underlying claude child process
      if (session.queryInstance && typeof session.queryInstance.close === "function") {
        try { session.queryInstance.close(); } catch (e) {}
      }
      session.queryInstance = null;
      if (session.messageQueue) {
        try { session.messageQueue.end(); } catch (e) {}
      }
      if (session.worker) {
        try { session.worker.kill(); } catch (e) {}
        session.worker = null;
      }
      // Close all mention SDK sessions to prevent zombie processes
      if (session._mentionSessions) {
        var mateIds = Object.keys(session._mentionSessions);
        for (var mi = 0; mi < mateIds.length; mi++) {
          try { session._mentionSessions[mateIds[mi]].close(); } catch (e) {}
        }
        session._mentionSessions = {};
      }
    });
    // Kill all terminals
    tm.destroyAll();
    for (var ws of clients) {
      try { ws.close(); } catch (e) {}
    }
    clients.clear();
    // Cleanup tmp upload directory
    try {
      var cwdHash = crypto.createHash("sha256").update(cwd).digest("hex").substring(0, 12);
      var tmpDir = path.join(os.tmpdir(), "clay-" + cwdHash);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}

    var codexShutdown = Promise.resolve(true);
    if (adapters && adapters.codex && typeof adapters.codex.shutdown === "function") {
      codexShutdown = adapters.codex.shutdown().catch(function(err) {
        console.error("[project] Codex shutdown failed for " + slug + ":", err && err.message ? err.message : err);
        return false;
      });
    }
    return codexShutdown;
  }

  // --- Status info ---
  function getStatus() {
    var sessionCount = sm.sessions.size;
    var hasProcessing = false;
    var pendingPermCount = 0;
    sm.sessions.forEach(function (s) {
      if (s.isProcessing) hasProcessing = true;
      if (s.pendingPermissions) {
        pendingPermCount += Object.keys(s.pendingPermissions).length;
      }
    });
    var status = {
      slug: slug,
      path: cwd,
      project: project,
      title: title,
      icon: icon,
      clients: clients.size,
      sessions: sessionCount,
      isProcessing: hasProcessing,
      pendingPermissions: pendingPermCount,
      projectOwnerId: projectOwnerId,
    };
    if (isMate) {
      status.isMate = true;
      status.mateId = path.basename(cwd);
    }
    if (worktreeMeta) {
      status.isWorktree = true;
      status.parentSlug = worktreeMeta.parentSlug;
      status.branch = worktreeMeta.branch;
      status.worktreeAccessible = worktreeMeta.accessible;
    }
    if (usersModule.isMultiUser()) {
      status.onlineUsers = _clients.getOnlineUsers();
    }
    return status;
  }

  function setTitle(newTitle) {
    title = newTitle || null;
    send({ type: "info", cwd: cwd, slug: slug, project: title || project, version: currentVersion, debug: !!debug, osUsers: osUsers, lanHost: lanHost, projectCount: getProjectCount(), projects: getProjectList(), projectOwnerId: projectOwnerId });
  }

  function setIcon(newIcon) {
    icon = newIcon || null;
  }

  // Mate projects: watch CLAUDE.md and enforce system-managed sections
  if (isMate) {
    var claudeMdPath = path.join(cwd, "CLAUDE.md");
    // Derive mateId from cwd (last path segment) and build ctx for dynamic team section
    var _mateId = path.basename(cwd);
    var _mateCtx = matesModule.buildMateCtx(projectOwnerId);
    // Collect non-mate projects for project registry injection
    var _projectList = (getProjectList() || []).filter(function (p) { return !p.isMate; });
    var _enforceOpts = { ctx: _mateCtx, mateId: _mateId, projects: _projectList };
    // Enforce all system sections atomically on startup (single read/write)
    var _selfWrite = false; // suppress watcher when we wrote the file ourselves
    try { _selfWrite = !!matesModule.enforceAllSections(claudeMdPath, _enforceOpts); } catch (e) {}
    // Sync sticky notes knowledge file on startup
    try {
      var knDir = path.join(cwd, "knowledge");
      var knFile = path.join(knDir, "sticky-notes.md");
      var notesText = nm.getActiveNotesText();
      if (notesText) {
        fs.mkdirSync(knDir, { recursive: true });
        fs.writeFileSync(knFile, notesText);
      } else {
        try { fs.unlinkSync(knFile); } catch (e) {}
      }
    } catch (e) {}
    // Watch for changes
    try {
      crisisWatcher = fs.watch(claudeMdPath, function () {
        if (crisisDebounce) clearTimeout(crisisDebounce);
        crisisDebounce = setTimeout(function () {
          crisisDebounce = null;
          // Skip if the previous change was our own write
          if (_selfWrite) { _selfWrite = false; return; }
          // Atomic enforce: single read/write for all system sections
          try { _selfWrite = !!matesModule.enforceAllSections(claudeMdPath, _enforceOpts); } catch (e) {}
        }, 500);
      });
      crisisWatcher.on("error", function () {});
    } catch (e) {}
  }

  return {
    cwd: cwd,
    slug: slug,
    project: project,
    clients: clients,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    forEachClient: _clients.forEachClient,
    handleConnection: handleConnection,
    handleMessage: handleMessage,
    handleDisconnection: handleDisconnection,
    handleHTTP: handleHTTP,
    getMcpBridgeHandler: getMcpBridgeHandler,
    getStatus: getStatus,
    getSessionManager: function () { return sm; },
    getNotificationsModule: function () { return _notifications; },
    getSchedules: _loop.getSchedules,
    importSchedule: _loop.importSchedule,
    removeSchedule: _loop.removeSchedule,
    setTitle: setTitle,
    setIcon: setIcon,
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
      sdk.stopIdleReaper();
      return destroy();
    },
  };
}

module.exports = { createProjectContext: createProjectContext, safePath: safePath, validateEnvString: validateEnvString };
