var { withClaudeFallbackModels } = require("./claude-defaults");
var { listProviderRoutes } = require("./provider-routes");
var { attachProviderSwitch } = require("./provider-switch");
var yoke = require("./yoke");

function attachProjectSessionsHandoff(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var imagesDir = ctx.imagesDir || null;
  var adapters = ctx.adapters || {};
  var clayPort = ctx.clayPort || null;
  var clayTls = ctx.clayTls || false;
  var clayAuthToken = ctx.clayAuthToken || "";
  var sm = ctx.sm;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var usersModule = ctx.usersModule;
  var getSessionForWs = ctx.getSessionForWs;
  var cancelScheduledMessage = ctx.cancelScheduledMessage;
  var clearPendingQueuedMessages = ctx.clearPendingQueuedMessages;
  var sendConfigForSession = ctx.sendConfigForSession;

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

  function refreshVendorState(ws) {
    (async function () {
      var linuxUser = ws && ws._clayUser && ws._clayUser.linuxUser ? ws._clayUser.linuxUser : undefined;
      yoke.invalidateAuthCache();
      var installed = installedVendorList(linuxUser);
      for (var i = 0; i < installed.length; i++) {
        var vendor = installed[i];
        var refreshOpts = {
          cwd: cwd,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
          linuxUser: linuxUser,
        };
        if (adapters[vendor]) {
          // A completed device login updates the credential on disk. Reclaim
          // an idle Codex app-server so the next session starts with that
          // exact credential home; never interrupt a concurrent live turn.
          if (vendor === "codex" && typeof adapters[vendor].refreshCredential === "function") {
            await adapters[vendor].refreshCredential(refreshOpts);
          }
          if (typeof adapters[vendor].init === "function") await adapters[vendor].init(refreshOpts);
          continue;
        }
        await yoke.lazyCreateAdapter(adapters, vendor, {
          cwd: refreshOpts.cwd,
          clayPort: refreshOpts.clayPort,
          clayTls: refreshOpts.clayTls,
          clayAuthToken: refreshOpts.clayAuthToken,
          slug: refreshOpts.slug,
          linuxUser: refreshOpts.linuxUser,
        });
      }
      sm.availableVendors = Object.keys(adapters);
      sm.installedVendors = installed;
      sm.providerRoutes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
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
      sendTo(ws, { type: "toast", level: "info", message: "Vendor status refreshed" });
    })().catch(function (e) {
      sendTo(ws, { type: "toast", level: "warn", message: "Vendor refresh failed", detail: e.message || String(e) });
    });
  }

  function handleHandoffMessage(ws, msg) {
    if (msg.type === "refresh_vendors") {
      refreshVendorState(ws);
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
