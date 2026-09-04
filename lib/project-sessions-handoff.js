var { withClaudeFallbackModels } = require("./claude-defaults");
var { buildProviderHubStatus } = require("./provider-hub-status");
var { listProviderRoutes } = require("./provider-routes");
var { attachProviderSwitch } = require("./provider-switch");
var yoke = require("./yoke");

function attachProjectSessionsHandoff(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var imagesDir = ctx.imagesDir || null;
  var adapters = ctx.adapters || {};
  var sdk = ctx.sdk;
  var sm = ctx.sm;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var usersModule = ctx.usersModule;
  var getSessionForWs = ctx.getSessionForWs;
  var cancelScheduledMessage = ctx.cancelScheduledMessage;
  var clearPendingQueuedMessages = ctx.clearPendingQueuedMessages;
  var sendConfigForSession = ctx.sendConfigForSession;
  var providerRefreshTimeoutMs = Number(ctx.providerRefreshTimeoutMs) || 20000;

  // The switch executor is a standalone module so the WS handler here, the
  // /switch chat command, and (later) the outage failover all share one code
  // path — the single producer of vendor_switched entries.
  var switcher = attachProviderSwitch({
    cwd: cwd,
    imagesDir: imagesDir,
    sm: sm,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendConfigForSession: sendConfigForSession,
    cancelScheduledMessage: cancelScheduledMessage,
    clearPendingQueuedMessages: clearPendingQueuedMessages,
  });

  function installedVendorList(linuxUser) {
    var installed = yoke.checkInstalled();
    var names = Object.keys(installed);
    var result = [];
    for (var i = 0; i < names.length; i++) {
      var info = yoke.getVendorInfo(names[i]);
      if (installed[names[i]] && !(linuxUser && info && info.osUserIsolation === false)) result.push(names[i]);
    }
    return result;
  }

  function providerStatus(ws) {
    var linuxUser = ws && ws._clayUser && ws._clayUser.linuxUser ? ws._clayUser.linuxUser : undefined;
    var installed = yoke.checkInstalled();
    var auth = yoke.checkAuth({ linuxUser: linuxUser });
    sm.installedVendors = installedVendorList(linuxUser);
    sm.providerRoutes = listProviderRoutes(
      sm.availableVendors || Object.keys(adapters), sm.installedVendors || [], sm);
    return buildProviderHubStatus({
      registry: yoke.VENDOR_REGISTRY,
      installed: installed,
      auth: auth,
      linuxUser: linuxUser,
      platform: process.platform,
      sm: sm,
    });
  }

  function sendProviderStatus(ws) {
    sendTo(ws, Object.assign({ type: "provider_status" }, providerStatus(ws)));
  }

  function boundedProviderRefresh(promise, vendor) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("Timed out while verifying " + vendor + "."));
      }, providerRefreshTimeoutMs);
      Promise.resolve(promise).then(function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function refreshVendorState(ws, requestedVendor) {
    (async function () {
      var linuxUser = ws && ws._clayUser && ws._clayUser.linuxUser ? ws._clayUser.linuxUser : undefined;
      var installed = installedVendorList(linuxUser);
      var failures = [];
      if (requestedVendor && installed.indexOf(requestedVendor) === -1) {
        sendProviderStatus(ws);
        sendTo(ws, { type: "toast", level: "warn", message: "Install this provider before verifying it" });
        return;
      }
      if (sdk && typeof sdk.refreshVendor === "function") {
        sm.providerVerificationByVendor = sm.providerVerificationByVendor || {};
        for (var vi = 0; vi < installed.length; vi++) {
          if (requestedVendor && installed[vi] !== requestedVendor) continue;
          sm.providerVerificationByVendor[installed[vi]] = {
            status: "verifying",
            checkedAt: Date.now(),
            modelCount: 0,
            error: "",
          };
        }
        sendProviderStatus(ws);
      }
      for (var i = 0; i < installed.length; i++) {
        var vendor = installed[i];
        if (requestedVendor && vendor !== requestedVendor) continue;
        if (sdk && typeof sdk.refreshVendor === "function") {
          try {
            var refreshPromise = sdk.refreshVendor(vendor, linuxUser);
            await boundedProviderRefresh(refreshPromise, vendor);
            sendProviderStatus(ws);
          } catch (error) {
            var currentVerification = sm.providerVerificationByVendor && sm.providerVerificationByVendor[vendor];
            if (!currentVerification || currentVerification.status === "verifying") {
              sm.providerVerificationByVendor = sm.providerVerificationByVendor || {};
              sm.providerVerificationByVendor[vendor] = {
                status: "error",
                checkedAt: Date.now(),
                modelCount: 0,
                error: error && error.message || String(error),
              };
            }
            failures.push({ vendor: vendor, error: error && error.message || String(error) });
          }
        }
      }
      sm.availableVendors = Object.keys(adapters);
      sm.installedVendors = installed;
      sm.providerRoutes = listProviderRoutes(
        sm.availableVendors || [], sm.installedVendors || [], sm);
      var currentVendor = (getSessionForWs(ws) && getSessionForWs(ws).vendor) || sm.defaultVendor || "claude";
      var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[currentVendor]) || [];
      if (currentVendor === "claude") vendorModels = withClaudeFallbackModels(vendorModels);
      sendTo(ws, {
        type: "model_info",
        model: "",
        models: vendorModels,
        vendor: currentVendor,
        availableVendors: sm.availableVendors || [],
        installedVendors: sm.installedVendors || [],
        providerRoutes: sm.providerRoutes || [],
      });
      sendProviderStatus(ws);
      if (failures.length) {
        sendTo(ws, {
          type: "toast",
          level: "warn",
          message: failures.length + " provider" + (failures.length === 1 ? "" : "s") + " could not be verified",
          detail: failures.map(function (failure) { return failure.vendor + ": " + failure.error; }).join("; "),
        });
      } else {
        sendTo(ws, {
          type: "toast",
          level: "info",
          message: requestedVendor ? "Provider verified" : "Provider status refreshed",
        });
      }
    })().catch(function (e) {
      sendProviderStatus(ws);
      sendTo(ws, { type: "toast", level: "warn", message: "Provider refresh failed", detail: e.message || String(e) });
    });
  }

  function handleHandoffMessage(ws, msg) {
    if (msg.type === "get_provider_status") {
      sendProviderStatus(ws);
      return true;
    }

    if (msg.type === "refresh_vendors") {
      refreshVendorState(ws);
      return true;
    }

    if (msg.type === "refresh_provider") {
      if (!msg.vendor || !yoke.getVendorInfo(msg.vendor)) return true;
      refreshVendorState(ws, msg.vendor);
      return true;
    }

    if (msg.type === "handoff_session") {
      var sourceSession = null;
      if (typeof msg.sessionId === "number") {
        sourceSession = sm.sessions.get(msg.sessionId);
        if (sourceSession && usersModule.isMultiUser() && ws._clayUser) {
          if (!usersModule.canAccessSession(ws._clayUser.id, sourceSession, { visibility: "public" })) return true;
        }
      } else {
        sourceSession = getSessionForWs(ws);
      }
      if (!sourceSession || !msg.targetVendor) return true;

      // The config popover and sidebar switchers historically sent the
      // session's current model in targetModel. That value describes the
      // source route, not an explicit choice from the target route's catalog.
      // Ignore it for those UI actions so the shared switcher can preserve an
      // exact same-family model or select the target route's verified default.
      var targetModel = typeof msg.targetModel === "string" ? msg.targetModel : null;
      if (msg.source === "config-popup" || msg.source === "sidebar-menu") targetModel = null;

      var result = switcher.executeProviderSwitch({
        session: sourceSession,
        targetVendor: msg.targetVendor,
        targetRouteId: msg.targetRouteId || null,
        targetModel: targetModel,
        trigger: "manual",
        initiatedBy: {
          source: typeof msg.source === "string" ? msg.source : "unknown",
          userId: (ws && ws._clayUser && ws._clayUser.id) || null,
        },
      });
      if (result.ok) {
        sendConfigForSession(ws, sourceSession);
        sendTo(ws, { type: "toast", level: "info", message: "Switched to " + result.label + " - context will be passed on your next message" });
      } else if (result.reason !== "same-target" && result.message) {
        sendTo(ws, { type: "toast", level: "warn", message: result.message, detail: result.detail });
      }
      return true;
    }

    return false;
  }

  return {
    handleHandoffMessage: handleHandoffMessage,
    handleSwitchCommand: switcher.handleSwitchCommand,
    executeProviderSwitch: switcher.executeProviderSwitch,
    normalizeSessionRouteModel: switcher.normalizeSessionRouteModel,
    modelsForRoute: switcher.modelsForRoute,
    resolveSwitchTargetRoute: switcher.resolveSwitchTargetRoute,
    suggestionForRoute: switcher.suggestionForRoute,
    copilotRouteIdForModel: switcher.copilotRouteIdForModel,
  };
}

module.exports = { attachProjectSessionsHandoff: attachProjectSessionsHandoff };
