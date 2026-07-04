var usersModule = require("./users");
var { getCodexConfig } = require("./codex-defaults");
var { withClaudeFallbackModels } = require("./claude-defaults");
var { claudePermissionForAutomation } = require("./automation-modes");
var { listProviderRoutes } = require("./provider-routes");
var { attachSkillDiscovery } = require("./sdk-skill-discovery");
var { attachBridgePermissions } = require("./sdk-bridge-permissions");

// Opt-in per-event tracing. Logging every streamed event synchronously stalls
// the event loop during heavy command output and delays WebSocket heartbeat
// pongs (root cause of the "random freeze / auto-refresh"). Silent by default;
// set CLAY_DEBUG_EVENTS=1 to re-enable.
var CLAY_DEBUG_EVENTS = process.env.CLAY_DEBUG_EVENTS === "1";
var { createMessageQueue } = require("./sdk-message-queue");
var { attachMessageProcessor } = require("./sdk-message-processor");
var { meaningfulTextTitle } = require("./text-title");
var { attachBridgeAuth } = require("./sdk-bridge-auth");
var { attachBridgeModels } = require("./sdk-bridge-models");
var { extractMcpDescriptors, callMcpToolHandler, mergeMcpServers } = require("./sdk-bridge-mcp");
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

  async function startQuery(session, text, images, linuxUser) {
    function shouldResetCopilotHandoffNativeSession() {
      return !!(session &&
        session.vendor === "github-copilot" &&
        session.handoffContextConsumed &&
        !session.copilotHandoffNativeReset &&
        session.cliSessionId &&
        session.storageId &&
        session.storageId !== session.cliSessionId);
    }

    async function ensureVendorReady(vendor) {
      if (!vendor) return null;
      var vendorAdapter = adapters[vendor] || null;
      if (!vendorAdapter) {
        var yoke = require("./yoke");
        vendorAdapter = await yoke.lazyCreateAdapter(adapters, vendor, {
          cwd: cwd,
          dangerouslySkipPermissions: dangerouslySkipPermissions,
          linuxUser: linuxUser || undefined,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });
      } else if ((!sm.modelsByVendor || !sm.modelsByVendor[vendor]) && typeof vendorAdapter.init === "function") {
        await vendorAdapter.init({
          cwd: cwd,
          dangerouslySkipPermissions: dangerouslySkipPermissions,
          linuxUser: linuxUser || undefined,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });
      }
      if (vendorAdapter) {
        sm.availableVendors = Object.keys(adapters);
        sm.modelsByVendor = sm.modelsByVendor || {};
        if (!sm.modelsByVendor[vendor] && typeof vendorAdapter.supportedModels === "function") {
          var discoveredModels = await vendorAdapter.supportedModels();
          sm.modelsByVendor[vendor] = vendor === "claude" ? withClaudeFallbackModels(discoveredModels) : discoveredModels;
        }
      }
      return vendorAdapter;
    }

    // If vendor is set but adapter not ready, try lazy creation (user may have logged in)
    if (session.vendor && !adapters[session.vendor]) {
      var lazyAdapter = await ensureVendorReady(session.vendor);
      if (lazyAdapter) {
        console.log("[sdk-bridge] Lazy adapter created for " + session.vendor);
      }
    } else if (session.vendor) {
      await ensureVendorReady(session.vendor);
    }
    if (session.vendor && !adapters[session.vendor]) {
      var freshAuth = getFreshAuthState();
      logAuthDecision("pre-auth-required", session, null, freshAuth);
      if (freshAuth[session.vendor]) {
        var recoveredAdapter = await ensureVendorReady(session.vendor);
        if (recoveredAdapter) {
          console.log("[sdk-bridge] Auth recheck recovered adapter for " + session.vendor);
        }
      }
    }
    // If still not available after lazy check, send auth_required
    if (session.vendor && !adapters[session.vendor]) {
      var vendorName = getVendorDisplayName(session.vendor);
      var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
      var authLinuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
      var canAutoLogin = !usersModule.isMultiUser()
        || !!authLinuxUser
        || (authUser && authUser.role === "admin");
      var authState = getFreshAuthState();
      logAuthDecision("emit-auth-required", session, "missing adapter", authState);
      if (authState[session.vendor]) {
        sendAndRecord(session, {
          type: "error",
          text: vendorName + " auth is available, but the adapter could not be initialized.",
        });
        sendAndRecord(session, { type: "done", code: 1 });
        return;
      }
      var authMsg2 = {
        type: "auth_required",
        text: vendorName + " is not logged in.",
        vendor: session.vendor,
        loginCommand: getLoginCommand(session.vendor),
        linuxUser: authLinuxUser,
        canAutoLogin: canAutoLogin,
      };
      sendAndRecord(session, authMsg2);
      if (!notifyAuthRequired(
        session,
        vendorName + " is not logged in.",
        "Open a terminal, then click the URL and follow the instructions.",
        authLinuxUser,
        canAutoLogin,
        getLoginCommand(session.vendor)
      )) {
        // chat message already sent above
      }
      sendAndRecord(session, { type: "done", code: 1 });
      return;
    }
    // Select adapter based on session vendor (fallback to default)
    var sessionAdapter = (session.vendor && adapters[session.vendor]) || adapter;
    console.log("[sdk-bridge] startQuery: vendor=" + sessionAdapter.vendor + " session=" + session.localId + " text=" + (text || "").substring(0, 50));
    // Remember linuxUser for auto-continue after rate limit
    session.lastLinuxUser = linuxUser || null;

    var t0 = session._queryStartTs || Date.now();

    // Wait for previous worker to fully exit before spawning a new one.
    // Without this, the new worker may try to resume the SDK session file
    // while the old worker is still flushing it to disk, causing
    // "no conversation found" and losing all prior context.
    // Harmless if null (no previous worker).
    if (session._workerExitPromise) {
      var exitWait = session._workerExitPromise;
      session._workerExitPromise = null;
      await Promise.race([
        exitWait,
        new Promise(function(resolve) { setTimeout(resolve, 3000); }),
      ]);
    }

    // Ensure Linux user project directory exists (runs in parallel with worker boot)
    if (linuxUser) {
      ensureLinuxUserProjectDir(linuxUser, session);
    }

    session.blocks = {};
    session.sentToolResults = {};
    session.activeTaskToolIds = {};
    session.pendingElicitations = {};
    session.streamedText = false;
    session.responsePreview = "";
    // Reset the terminal-event latch for this turn. doSendAndRecord sets it true
    // when a "done" is emitted; the query loop's finally uses it as a safety net.
    session._turnDoneSent = false;

    // For in-process path, create AbortController. For worker path, the adapter
    // handles abort internally and exposes it via handle.abort().
    if (!linuxUser) {
      session.abortController = new AbortController();
    }

    // Build Claude-specific adapter options
    var claudeOpts = {
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      enableFileCheckpointing: true,
      extraArgs: { "replay-user-messages": null },
      promptSuggestions: true,
      agentProgressSummaries: true,
    };

    // Per-loop settings override global defaults when present
    var ls = session.loopSettings || {};

    if (sm.currentBetas && sm.currentBetas.length > 0) {
      claudeOpts.betas = sm.currentBetas;
    }
    var thinkingMode = ls.thinking || sm.currentThinking;
    if (thinkingMode === "disabled") {
      claudeOpts.thinking = { type: "disabled" };
    } else if (thinkingMode === "budget") {
      var budgetTokens = ls.thinkingBudget || sm.currentThinkingBudget;
      if (budgetTokens) claudeOpts.thinking = { type: "enabled", budgetTokens: budgetTokens };
    }

    if (ls.permissionMode) {
      session._loopPermissionMode = ls.permissionMode;
    }

    // Pass through any extra SDK settings from LOOP.json
    if (ls.disableAllHooks !== undefined) {
      claudeOpts.settings = Object.assign({}, claudeOpts.settings || {}, { disableAllHooks: ls.disableAllHooks });
    }

    if (dangerouslySkipPermissions) {
      claudeOpts.allowDangerouslySkipPermissions = true;
      claudeOpts.permissionMode = "bypassPermissions";
    } else {
      var sessionAutomationMode = session.automationMode ? claudePermissionForAutomation(session.automationMode) : null;
      var globalMode = session.permissionMode || sessionAutomationMode || sm.currentPermissionMode || "default";
      var effectiveDefault;
      if (globalMode === "bypassPermissions") effectiveDefault = "bypassPermissions";
      else if (session.acceptEditsAfterStart) effectiveDefault = "acceptEdits";
      else effectiveDefault = globalMode;
      var modeToApply = session._loopPermissionMode || effectiveDefault;
      if (modeToApply && modeToApply !== "default") {
        claudeOpts.permissionMode = modeToApply;
      }
    }
    // Clear one-shot acceptEditsAfterStart regardless of which branch ran above,
    // so the flag does not linger into subsequent turns.
    if (session.acceptEditsAfterStart) delete session.acceptEditsAfterStart;
    if (session.cliSessionId && session.lastRewindUuid) {
      claudeOpts.resumeSessionAt = session.lastRewindUuid;
      delete session.lastRewindUuid;
      sm.saveSessionFile(session);
    }

    // Pass linuxUser to adapter for worker-based queries
    if (linuxUser) {
      claudeOpts.linuxUser = linuxUser;
      claudeOpts.singleTurn = !!session.singleTurn;
      claudeOpts.originalHome = require("./config").REAL_HOME || null;
      claudeOpts.projectPath = session.cwd || null;
      claudeOpts._perfT0 = t0;
      // Pass previous worker state for reuse
      if (session._adapterWorkerState) {
        claudeOpts._workerState = session._adapterWorkerState;
        session._adapterWorkerState = null;
      }
    }

    // Pick a model that belongs to the session's vendor. sm.currentModel is
    // shared project-wide, so a Codex session that last set it to
    // "gpt-5.4-mini" would otherwise leak into a Claude session in the same
    // project (or in another session that switches vendor to claude) and
    // Claude would reject the unknown model. We validate against the
    // session vendor's model list regardless of which vendor happens to be
    // the project's default adapter.
    var selectedProjectModel = sm.currentModel && sm.currentModel !== "default" ? sm.currentModel : null;
    var selectedSessionModel = session.model && session.model !== "default" ? session.model : null;
    var selectedLoopModel = session.loop && ls.model && ls.model !== "default" ? ls.model : null;
    var queryModel = selectedSessionModel || selectedLoopModel || selectedProjectModel || undefined;
    var sessionVendor = session.vendor || (adapter && adapter.vendor) || null;
    if (sessionVendor === "github-copilot") {
      var queryRouteId = copilotRouteIdForModel(queryModel);
      if (queryRouteId && session.providerRouteId !== queryRouteId) {
        session.providerRouteId = queryRouteId;
        try { sm.saveSessionFile(session); } catch (e) {}
        if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
      }
    }
    if (sessionVendor) {
      var vendorModels = getModelsForSession(session, sessionVendor);
      if (vendorModels.length > 0 && queryModel && !modelListContains(vendorModels, queryModel)) {
        var resolved = resolveModelInList(vendorModels, queryModel);
        queryModel = resolved || modelEntryValue(vendorModels[0]);
      } else if (vendorModels.length > 0 && !queryModel && session.providerRouteId) {
        queryModel = modelEntryValue(vendorModels[0]);
      }
    }
    // Guard against anything upstream having set queryModel to an object
    // (e.g. a cached ModelInfo leaked through). Always coerce to string id.
    if (queryModel && typeof queryModel !== "string") {
      queryModel = modelEntryValue(queryModel) || undefined;
    }

    if (sessionVendor === "github-copilot" && queryModel) {
      var finalQueryRouteId = copilotRouteIdForModel(queryModel);
      var queryStateChanged = false;
      if (session.model !== queryModel) {
        session.model = queryModel;
        queryStateChanged = true;
      }
      if (session.requestedModel !== queryModel) {
        session.requestedModel = queryModel;
        queryStateChanged = true;
      }
      if (session.verifiedModel && session.verifiedModel !== queryModel) {
        session.verifiedModel = null;
        session.modelVerificationSource = null;
        queryStateChanged = true;
      }
      if (finalQueryRouteId && session.providerRouteId !== finalQueryRouteId) {
        session.providerRouteId = finalQueryRouteId;
        queryStateChanged = true;
      }
      if (queryStateChanged) {
        try { sm.saveSessionFile(session); } catch (e) {}
        if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
        sendToSession(session, {
          type: "model_info",
          model: queryModel,
          models: getModelsForSession(session, sessionVendor),
          vendor: sessionVendor,
          providerRouteId: session.providerRouteId || null,
          requestedModel: session.requestedModel || queryModel,
          verifiedModel: session.verifiedModel || null,
          modelVerificationSource: session.modelVerificationSource || null,
          availableVendors: sm.availableVendors || [],
          installedVendors: sm.installedVendors || [],
          providerRoutes: sm.providerRoutes || listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []),
        });
      }
    }

    var codexConfig = getCodexConfig(sm, session);
    var mergedMcpServers = mergeMcpServers(getMcpServers(), getRemoteMcpServers) || undefined;

    if (shouldResetCopilotHandoffNativeSession()) {
      console.warn("[sdk-bridge] Resetting GitHub Copilot native session after handoff transcript was consumed: " + session.cliSessionId);
      session.cliSessionId = null;
      session.copilotHandoffNativeReset = true;
      try { sm.saveSessionFile(session); } catch (e) {}
      if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
    }

    // Derive an explicit session title for fresh queries so the SDK records
    // it at session creation and skips its own auto-generation. This also
    // lets us short-circuit autoGenerateTitle below for the common case.
    // Only applied to NEW sessions (no cliSessionId yet) — when resuming,
    // the SDK ignores Options.title in favor of the persisted title.
    var initialTitle = null;
    if (!session.cliSessionId && !session.titleManuallySet && !session.titleAutoGenerated) {
      if (session.title) {
        // Loop / scheduled / mate-seeded sessions arrive with a title already set.
        initialTitle = session.title;
      } else if (typeof text === "string") {
        // Derive a quick title from the user's first message.
        // Skip if too short to be meaningful — fall back to autoGenerateTitle.
        initialTitle = meaningfulTextTitle(text, 60);
      }
    }

    var queryOpts = {
      cwd: cwd,
      model: queryModel,
      effort: ls.effort || sm.currentEffort || undefined,
      title: initialTitle || undefined,
      toolPolicy: (session.permissionMode === "bypassPermissions" || codexConfig.approval === "never") ? "allow-all" : "ask",
      toolServers: mergedMcpServers,
      toolServerDescriptors: extractMcpDescriptors(mergedMcpServers) || undefined,
      resumeSessionId: session.cliSessionId || undefined,
      abortController: linuxUser ? undefined : session.abortController,
      canUseTool: function(toolName, input, toolOpts) {
        return handleCanUseTool(session, toolName, input, toolOpts);
      },
      onElicitation: function(request, elicitOpts) {
        return handleElicitation(session, request, elicitOpts);
      },
      onUserDialog: function(dialogRequest, dialogOpts) {
        return handleUserDialog(session, dialogRequest, dialogOpts);
      },
      callMcpTool: function(serverName, toolName, args) {
        return callMcpToolHandler(mergedMcpServers, serverName, toolName, args);
      },
      adapterOptions: {
        CLAUDE: claudeOpts,
        CODEX: {
          approvalPolicy: codexConfig.approval,
          sandboxMode: codexConfig.sandbox,
          webSearchMode: codexConfig.webSearch,
        },
      },
    };

    var handle;
    console.log("[sdk-bridge] calling adapter.createQuery... vendor=" + sessionAdapter.vendor);
    try {
      handle = await sessionAdapter.createQuery(queryOpts);
      console.log("[sdk-bridge] createQuery returned handle, vendor=" + sessionAdapter.vendor);
      // SDK accepted the explicit title — adopt it locally so the session
      // list reflects it immediately and autoGenerateTitle skips this
      // session (titleAutoGenerated gates re-trigger).
      if (initialTitle && !session.title) {
        session.title = initialTitle;
        session.titleAutoGenerated = true;
        sm.saveSessionFile(session);
        sm.broadcastSessionList();
      } else if (initialTitle && session.title === initialTitle) {
        session.titleAutoGenerated = true;
        sm.saveSessionFile(session);
      }
    } catch (e) {
      console.error("[sdk-bridge] Failed to create query for session " + session.localId + ":", e.message || e);
      console.error("[sdk-bridge] cliSessionId:", session.cliSessionId, "resume:", !!session.cliSessionId);
      console.error("[sdk-bridge] Stack:", e.stack || "(no stack)");
      session.isProcessing = false;
      onProcessingChanged();
      session.queryInstance = null;
      session.messageQueue = null;
      session.abortController = null;
      sendAndRecord(session, { type: "error", text: "Failed to start query: " + (e.message || e) });
      sendAndRecord(session, { type: "done", code: 1 });
      sm.broadcastSessionList();
      return;
    }

    // Store adapter worker state for reuse on next query
    if (handle._adapterState) {
      session._adapterWorkerState = handle._adapterState;
      // Keep session.worker reference for external code (sessions.js, project.js)
      // that needs to kill the worker on session destroy.
      if (handle._adapterState.worker) {
        session.worker = handle._adapterState.worker;
      }
    }

    // For worker path, create an abortController wrapper that delegates to handle.abort()
    if (linuxUser) {
      session.abortController = {
        abort: function() { handle.abort(); },
        signal: { aborted: false, addEventListener: function() {} },
      };
    }

    // Store QueryHandle on session for iteration and control.
    session.queryInstance = handle;

    // Push initial user message through the QueryHandle
    console.log("[sdk-bridge] pushing initial message via handle.pushMessage...");
    handle.pushMessage(text, images);
    console.log("[sdk-bridge] pushMessage done, starting processQueryStream...");

    // For single-turn sessions (Ralph Loop), end the message queue so the SDK
    // query finishes after processing the one message. Without this, the query
    // stream stays open forever waiting for more messages, and onQueryComplete
    // never fires.
    if (session.singleTurn) {
      handle.endInput();
    }

    session.lastActivityAt = Date.now();
    session.streamPromise = processQueryStream(session).catch(function(err) {
    });
  }

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
