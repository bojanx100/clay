var { CODEX_DEFAULTS } = require("./codex-defaults");
var {
  automationForClaudePermission,
  automationForCodexConfig,
} = require("./automation-modes");
var { withClaudeFallbackModels } = require("./claude-defaults");
var { listProviderRoutes } = require("./provider-routes");
var yoke = require("./yoke");

function attachProjectSessionsSettings(ctx) {
  var slug = ctx.slug;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var opts = ctx.opts;
  var getSessionForWs = ctx.getSessionForWs;
  var sendConfigForSession = ctx.sendConfigForSession;
  var applyAutomationModeToSession = ctx.applyAutomationModeToSession;
  var copilotRouteIdForModel = ctx.copilotRouteIdForModel;
  var isKnownCodexSession = ctx.isKnownCodexSession;

  function configState(modeFallback, effortFallback) {
    return {
      type: "config_state",
      model: sm.currentModel || "",
      mode: sm.currentPermissionMode || modeFallback || "default",
      effort: sm.currentEffort || effortFallback || "medium",
      betas: sm.currentBetas || [],
      thinking: sm.currentThinking || "adaptive",
      thinkingBudget: sm.currentThinkingBudget || 10000,
    };
  }

  function handleSettingsMessage(ws, msg) {
    if (msg.type === "set_model" && msg.model) {
      var session = getSessionForWs(ws);
      if (session) {
        session.model = msg.model;
        session.requestedModel = msg.model;
        session.verifiedModel = null;
        session.modelVerificationSource = null;
        if (session.vendor === "github-copilot") {
          var modelRouteId = copilotRouteIdForModel(msg.model);
          if (modelRouteId) session.providerRouteId = modelRouteId;
        }
        try { sm.saveSessionFile(session); } catch (e) {}
        sm.broadcastSessionList();
        sdk.setModel(session, msg.model);
      }
      return true;
    }

    if (msg.type === "reload_skills") {
      var session = getSessionForWs(ws);
      if (session && sdk.reloadSkills) {
        sdk.reloadSkills(session);
      }
      return true;
    }

    if (msg.type === "set_mcp_permission_mode_override" && msg.serverName) {
      var session = getSessionForWs(ws);
      if (session && sdk.setMcpPermissionModeOverride) {
        // mode: "default" | "auto" | null (null clears the override)
        var mcpMode = (msg.mode === "auto" || msg.mode === "default") ? msg.mode : null;
        sdk.setMcpPermissionModeOverride(session, msg.serverName, mcpMode);
      }
      return true;
    }

    if (msg.type === "set_vendor" && msg.vendor) {
      if (!yoke.getVendorInfo(msg.vendor)) return true;
      var vendorSession = getSessionForWs(ws);
      if (vendorSession) {
        // Refuse to rebind vendor on a session that is already bound to a
        // different CLI (cliSessionId is vendor-specific). This prevents a
        // stale client-side vendor state from clobbering the persisted vendor
        // on page reload / server restart.
        var canCorrectCodex = msg.vendor === "codex" && isKnownCodexSession(vendorSession);
        var alreadyBound = vendorSession.cliSessionId && vendorSession.vendor && vendorSession.vendor !== msg.vendor && !canCorrectCodex;
        if (alreadyBound) {
          console.warn("[project] set_vendor ignored: session " + vendorSession.localId +
            " is bound to '" + vendorSession.vendor + "', refused rebind to '" + msg.vendor + "'");
        } else {
          vendorSession.vendor = msg.vendor;
          // Clear the shared model so the next query uses the vendor's default
          // instead of leaking the previous vendor's model into a fresh session.
          if (sm.currentModel) {
            sm.currentModel = "";
          }
          sm.saveSessionFile(vendorSession);
          sm.broadcastSessionList();
        }
      }
      if (msg.vendor) {
        var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[msg.vendor]) || [];
        if (msg.vendor === "claude") vendorModels = withClaudeFallbackModels(vendorModels);
        sendTo(ws, {
          type: "model_info",
          model: "",
          models: vendorModels,
          vendor: msg.vendor,
          availableVendors: sm.availableVendors || [],
          installedVendors: sm.installedVendors || [],
          providerRoutes: sm.providerRoutes || listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []),
        });
        sendConfigForSession(ws, vendorSession);
      }
      return true;
    }

    if (msg.type === "set_server_default_model" && msg.model) {
      var serverModelVendor = yoke.getVendorInfo(msg.vendor) ? msg.vendor : "claude";
      if (typeof opts.onSetServerDefaultModel === "function") {
        opts.onSetServerDefaultModel(msg.model, serverModelVendor);
      }
      sm.defaultModelsByVendor = sm.defaultModelsByVendor || {};
      sm.defaultModelsByVendor[serverModelVendor] = msg.model;
      sm.serverDefaultModelsByVendor = sm.serverDefaultModelsByVendor || {};
      sm.serverDefaultModelsByVendor[serverModelVendor] = msg.model;
      var session = getSessionForWs(ws);
      if (session && (session.vendor || "claude") === serverModelVendor) {
        session.model = msg.model;
        try { sm.saveSessionFile(session); } catch (e) {}
        sdk.setModel(session, msg.model);
      }
      return true;
    }

    if (msg.type === "set_project_default_model" && msg.model) {
      var modelVendor = yoke.getVendorInfo(msg.vendor) ? msg.vendor : "claude";
      if (typeof opts.onSetProjectDefaultModel === "function") {
        opts.onSetProjectDefaultModel(slug, msg.model, modelVendor);
      }
      sm.defaultModelsByVendor = sm.defaultModelsByVendor || {};
      sm.defaultModelsByVendor[modelVendor] = msg.model;
      var session = getSessionForWs(ws);
      if (session && (session.vendor || "claude") === modelVendor) {
        session.model = msg.model;
        try { sm.saveSessionFile(session); } catch (e) {}
        sdk.setModel(session, msg.model);
      }
      return true;
    }

    if (msg.type === "get_project_auto_continue_comparable") {
      var comparableState = { enabled: true };
      if (typeof opts.onGetProjectAutoContinueComparable === "function") {
        comparableState = opts.onGetProjectAutoContinueComparable(slug) || comparableState;
      }
      sendTo(ws, {
        type: "project_auto_continue_comparable",
        slug: slug,
        enabled: comparableState.enabled !== false,
      });
      return true;
    }

    if (msg.type === "set_project_auto_continue_comparable") {
      var comparableResult = { ok: false, enabled: true, error: "Not supported" };
      if (typeof opts.onSetProjectAutoContinueComparable === "function") {
        comparableResult = opts.onSetProjectAutoContinueComparable(slug, msg.enabled) || comparableResult;
      }
      sendTo(ws, {
        type: "set_project_auto_continue_comparable_result",
        slug: slug,
        ok: !!comparableResult.ok,
        enabled: comparableResult.enabled !== false,
        error: comparableResult.error || null,
      });
      return true;
    }

    if (msg.type === "set_permission_mode" && msg.mode) {
      sm.currentPermissionMode = msg.mode;
      var session = getSessionForWs(ws);
      if (session) {
        session.permissionMode = msg.mode;
        session.automationMode = automationForClaudePermission(msg.mode);
        session.dangerouslySkipPermissions = msg.mode === "bypassPermissions";
        if (session.vendor === "claude" || !session.vendor) sdk.setPermissionMode(session, msg.mode);
        sm.saveSessionFile(session);
      }
      sendConfigForSession(ws, session);
      return true;
    }

    if (msg.type === "set_automation_mode" && msg.mode) {
      var autoSession = getSessionForWs(ws);
      if (!autoSession) return true;
      applyAutomationModeToSession(autoSession, msg.mode);
      sm.saveSessionFile(autoSession);
      sm.broadcastSessionList();
      if ((autoSession.vendor || "claude") === "claude") {
        sdk.setPermissionMode(autoSession, autoSession.permissionMode || "default");
      }
      sendConfigForSession(ws, autoSession);
      return true;
    }

    if (msg.type === "set_server_default_mode" && msg.mode) {
      if (typeof opts.onSetServerDefaultMode === "function") {
        opts.onSetServerDefaultMode(msg.mode);
      }
      sm._savedDefaultMode = msg.mode;
      sm.serverDefaultMode = msg.mode;
      sm.currentPermissionMode = msg.mode;
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setPermissionMode(session, msg.mode);
      }
      send(configState(sm.currentPermissionMode, "medium"));
      return true;
    }

    if (msg.type === "set_project_default_mode" && msg.mode) {
      if (typeof opts.onSetProjectDefaultMode === "function") {
        opts.onSetProjectDefaultMode(slug, msg.mode);
      }
      sm.currentPermissionMode = msg.mode;
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setPermissionMode(session, msg.mode);
      }
      send(configState(sm.currentPermissionMode, "medium"));
      return true;
    }

    if (msg.type === "set_effort" && msg.effort) {
      sm.currentEffort = msg.effort;
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setEffort(session, msg.effort);
      }
      send(configState("default", sm.currentEffort));
      return true;
    }

    if (msg.type === "set_server_default_effort" && msg.effort) {
      if (typeof opts.onSetServerDefaultEffort === "function") {
        opts.onSetServerDefaultEffort(msg.effort);
      }
      sm.serverDefaultEffort = msg.effort;
      sm.currentEffort = msg.effort;
      send(configState("default", sm.currentEffort));
      return true;
    }

    if (msg.type === "set_project_default_effort" && msg.effort) {
      if (typeof opts.onSetProjectDefaultEffort === "function") {
        opts.onSetProjectDefaultEffort(slug, msg.effort);
      }
      sm.currentEffort = msg.effort;
      send(configState("default", sm.currentEffort));
      return true;
    }

    if (msg.type === "set_betas") {
      sm.currentBetas = msg.betas || [];
      send(configState("default", "medium"));
      return true;
    }

    if (msg.type === "set_thinking") {
      sm.currentThinking = msg.thinking || "adaptive";
      if (msg.budgetTokens) sm.currentThinkingBudget = msg.budgetTokens;
      send(configState("default", "medium"));
      return true;
    }

    if (msg.type === "set_codex_approval") {
      sm.codexApproval = msg.approval || CODEX_DEFAULTS.approval;
      var approvalSession = getSessionForWs(ws);
      if (approvalSession) {
        approvalSession.codexApproval = sm.codexApproval;
        approvalSession.automationMode = automationForCodexConfig(approvalSession.codexApproval, approvalSession.codexSandbox || sm.codexSandbox || CODEX_DEFAULTS.sandbox);
        sm.saveSessionFile(approvalSession);
        sm.broadcastSessionList();
      }
      sendConfigForSession(ws, approvalSession);
      return true;
    }

    if (msg.type === "set_codex_sandbox") {
      sm.codexSandbox = msg.sandbox || CODEX_DEFAULTS.sandbox;
      var sandboxSession = getSessionForWs(ws);
      if (sandboxSession) {
        sandboxSession.codexSandbox = sm.codexSandbox;
        sandboxSession.automationMode = automationForCodexConfig(sandboxSession.codexApproval || sm.codexApproval || CODEX_DEFAULTS.approval, sandboxSession.codexSandbox);
        sm.saveSessionFile(sandboxSession);
        sm.broadcastSessionList();
      }
      sendConfigForSession(ws, sandboxSession);
      return true;
    }

    if (msg.type === "set_codex_websearch") {
      sm.codexWebSearch = msg.webSearch || CODEX_DEFAULTS.webSearch;
      var webSearchSession = getSessionForWs(ws);
      if (webSearchSession) {
        webSearchSession.codexWebSearch = sm.codexWebSearch;
        sm.saveSessionFile(webSearchSession);
        sm.broadcastSessionList();
      }
      sendConfigForSession(ws, webSearchSession);
      return true;
    }

    if (msg.type === "set_project_default_codex_config") {
      sm.codexApproval = msg.approval || CODEX_DEFAULTS.approval;
      sm.codexSandbox = msg.sandbox || CODEX_DEFAULTS.sandbox;
      sm.codexWebSearch = msg.webSearch || CODEX_DEFAULTS.webSearch;
      if (typeof opts.onSetProjectCodexDefaults === "function") {
        opts.onSetProjectCodexDefaults(slug, {
          approval: sm.codexApproval,
          sandbox: sm.codexSandbox,
          webSearch: sm.codexWebSearch,
        });
      }
      var codexDefaultsSession = getSessionForWs(ws);
      if (codexDefaultsSession && (codexDefaultsSession.vendor || "claude") === "codex") {
        codexDefaultsSession.codexApproval = sm.codexApproval;
        codexDefaultsSession.codexSandbox = sm.codexSandbox;
        codexDefaultsSession.codexWebSearch = sm.codexWebSearch;
        codexDefaultsSession.automationMode = automationForCodexConfig(sm.codexApproval, sm.codexSandbox);
        sm.saveSessionFile(codexDefaultsSession);
        sm.broadcastSessionList();
      }
      sendConfigForSession(ws, codexDefaultsSession);
      return true;
    }

    if (msg.type === "set_server_default_codex_config") {
      sm.codexApproval = msg.approval || CODEX_DEFAULTS.approval;
      sm.codexSandbox = msg.sandbox || CODEX_DEFAULTS.sandbox;
      sm.codexWebSearch = msg.webSearch || CODEX_DEFAULTS.webSearch;
      sm.serverDefaultCodexConfig = {
        approval: sm.codexApproval,
        sandbox: sm.codexSandbox,
        webSearch: sm.codexWebSearch,
      };
      if (typeof opts.onSetServerCodexDefaults === "function") {
        opts.onSetServerCodexDefaults(sm.serverDefaultCodexConfig);
      }
      var serverCodexDefaultsSession = getSessionForWs(ws);
      if (serverCodexDefaultsSession && (serverCodexDefaultsSession.vendor || "claude") === "codex") {
        serverCodexDefaultsSession.codexApproval = sm.codexApproval;
        serverCodexDefaultsSession.codexSandbox = sm.codexSandbox;
        serverCodexDefaultsSession.codexWebSearch = sm.codexWebSearch;
        serverCodexDefaultsSession.automationMode = automationForCodexConfig(sm.codexApproval, sm.codexSandbox);
        sm.saveSessionFile(serverCodexDefaultsSession);
        sm.broadcastSessionList();
      }
      sendConfigForSession(ws, serverCodexDefaultsSession);
      return true;
    }

    return false;
  }

  return {
    handleSettingsMessage: handleSettingsMessage,
  };
}

module.exports = { attachProjectSessionsSettings: attachProjectSessionsSettings };
