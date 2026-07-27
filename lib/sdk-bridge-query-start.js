var usersModule = require("./users");
var { getCodexConfig } = require("./codex-defaults");
var { withClaudeFallbackModels } = require("./claude-defaults");
var { claudePermissionForAutomation } = require("./automation-modes");
var { listProviderRoutes } = require("./provider-routes");
var { meaningfulTextTitle } = require("./text-title");
var { claudeWorkerAgents, visibleWorkerPrompt } = require("./provider-agent-pipeline");
var { extractMcpDescriptors, callMcpToolHandler } = require("./sdk-bridge-mcp");

function attachBridgeQueryStart(ctx) {
  var adapters = ctx.adapters;
  var adapter = ctx.adapter;
  var cwd = ctx.cwd;
  var dangerouslySkipPermissions = ctx.dangerouslySkipPermissions;
  var clayPort = ctx.clayPort;
  var clayTls = ctx.clayTls;
  var clayAuthToken = ctx.clayAuthToken;
  var slug = ctx.slug;
  var isMate = !!ctx.isMate;
  var sm = ctx.sm;
  var send = ctx.send;
  var sendToSession = ctx.sendToSession;
  var sendAndRecord = ctx.sendAndRecord;
  var onProcessingChanged = ctx.onProcessingChanged;
  var ensureLinuxUserProjectDir = ctx.ensureLinuxUserProjectDir;
  var getFreshAuthState = ctx.getFreshAuthState;
  var logAuthDecision = ctx.logAuthDecision;
  var getVendorDisplayName = ctx.getVendorDisplayName;
  var getLoginCommand = ctx.getLoginCommand;
  var notifyAuthRequired = ctx.notifyAuthRequired;
  var copilotRouteIdForModel = ctx.copilotRouteIdForModel;
  var getModelsForSession = ctx.getModelsForSession;
  var modelListContains = ctx.modelListContains;
  var resolveModelInList = ctx.resolveModelInList;
  var modelEntryValue = ctx.modelEntryValue;
  var mergeMcpServers = ctx.mergeMcpServers;
  var getMcpServers = ctx.getMcpServers;
  var getRemoteMcpServers = ctx.getRemoteMcpServers;
  var handleCanUseTool = ctx.handleCanUseTool;
  var handleElicitation = ctx.handleElicitation;
  var handleUserDialog = ctx.handleUserDialog;
  var processQueryStream = ctx.processQueryStream;
  var vendorReadyPromises = {};

  async function prepareVendor(vendor, linuxUser) {
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

  function ensureVendorReady(vendor, linuxUser) {
    if (!vendor) return Promise.resolve(null);
    if (adapters[vendor] && sm.modelsByVendor && sm.modelsByVendor[vendor]) {
      return Promise.resolve(adapters[vendor]);
    }
    var readinessKey = vendor + "|" + (linuxUser || "");
    if (vendorReadyPromises[readinessKey]) return vendorReadyPromises[readinessKey];
    vendorReadyPromises[readinessKey] = Promise.resolve().then(function () {
      return prepareVendor(vendor, linuxUser);
    }).finally(function () {
      delete vendorReadyPromises[readinessKey];
    });
    return vendorReadyPromises[readinessKey];
  }

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

    if (session.vendor && !adapters[session.vendor]) {
      var lazyAdapter = await ensureVendorReady(session.vendor, linuxUser);
      if (lazyAdapter) {
        console.log("[sdk-bridge] Lazy adapter created for " + session.vendor);
      }
    } else if (session.vendor) {
      await ensureVendorReady(session.vendor, linuxUser);
    }
    if (session.vendor && !adapters[session.vendor]) {
      var freshAuth = getFreshAuthState();
      logAuthDecision("pre-auth-required", session, null, freshAuth);
      if (freshAuth[session.vendor]) {
        var recoveredAdapter = await ensureVendorReady(session.vendor, linuxUser);
        if (recoveredAdapter) {
          console.log("[sdk-bridge] Auth recheck recovered adapter for " + session.vendor);
        }
      }
    }
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
      }
      sendAndRecord(session, { type: "done", code: 1 });
      return;
    }

    var sessionAdapter = (session.vendor && adapters[session.vendor]) || adapter;
    console.log("[sdk-bridge] startQuery: vendor=" + sessionAdapter.vendor + " session=" + session.localId + " text=" + (text || "").substring(0, 50));
    session.lastLinuxUser = linuxUser || null;
    var t0 = session._queryStartTs || Date.now();

    if (session._workerExitPromise) {
      var exitWait = session._workerExitPromise;
      session._workerExitPromise = null;
      await Promise.race([
        exitWait,
        new Promise(function(resolve) { setTimeout(resolve, 3000); }),
      ]);
    }

    if (linuxUser) {
      ensureLinuxUserProjectDir(linuxUser, session);
    }

    session.blocks = {};
    session.sentToolResults = {};
    session.activeTaskToolIds = {};
    session.pendingElicitations = {};
    session.streamedText = false;
    session.responsePreview = "";
    session._turnDoneSent = false;

    if (!linuxUser) {
      session.abortController = new AbortController();
    }

    var claudeOpts = {
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      enableFileCheckpointing: true,
      extraArgs: { "replay-user-messages": null },
      promptSuggestions: true,
      agentProgressSummaries: true,
      agents: claudeWorkerAgents(),
    };

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
    if (session.acceptEditsAfterStart) delete session.acceptEditsAfterStart;
    if (session.cliSessionId && session.lastRewindUuid) {
      claudeOpts.resumeSessionAt = session.lastRewindUuid;
      delete session.lastRewindUuid;
      sm.saveSessionFile(session);
    }

    if (linuxUser) {
      claudeOpts.linuxUser = linuxUser;
      claudeOpts.singleTurn = !!session.singleTurn;
      claudeOpts.originalHome = require("./config").REAL_HOME || null;
      claudeOpts.projectPath = session.cwd || null;
      claudeOpts._perfT0 = t0;
      if (session._adapterWorkerState) {
        claudeOpts._workerState = session._adapterWorkerState;
        session._adapterWorkerState = null;
      }
    }

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

    var initialTitle = null;
    if (!session.cliSessionId && !session.titleManuallySet && !session.titleAutoGenerated) {
      if (session.title) {
        initialTitle = session.title;
      } else if (typeof text === "string") {
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
    if (!isMate && !session.orchestrationParent) {
      queryOpts.systemPrompt = visibleWorkerPrompt(
        session.storageId || session.cliSessionId || session.localId
      );
    }

    var handle;
    console.log("[sdk-bridge] calling adapter.createQuery... vendor=" + sessionAdapter.vendor);
    try {
      handle = await sessionAdapter.createQuery(queryOpts);
      console.log("[sdk-bridge] createQuery returned handle, vendor=" + sessionAdapter.vendor);
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

    if (handle._adapterState) {
      session._adapterWorkerState = handle._adapterState;
      if (handle._adapterState.worker) {
        session.worker = handle._adapterState.worker;
      }
    }

    if (linuxUser) {
      session.abortController = {
        abort: function() { handle.abort(); },
        signal: { aborted: false, addEventListener: function() {} },
      };
    }

    session.queryInstance = handle;
    console.log("[sdk-bridge] pushing initial message via handle.pushMessage...");
    handle.pushMessage(text, images);
    console.log("[sdk-bridge] pushMessage done, starting processQueryStream...");

    if (session.singleTurn) {
      handle.endInput();
    }

    session.lastActivityAt = Date.now();
    session.streamPromise = processQueryStream(session).catch(function(err) {
    });
  }

  return {
    ensureVendorReady: ensureVendorReady,
    startQuery: startQuery,
  };
}

module.exports = { attachBridgeQueryStart: attachBridgeQueryStart };
