var { withClaudeFallbackModels } = require("./claude-defaults");
var { fallbackCodexModels } = require("./codex-models");
var claudeModelProbe = require("./claude-model-probe");
var { listProviderRoutes, routeForId, knownModelsForProvider, knownModelsForRoute } = require("./provider-routes");

function attachProjectVendorModels(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendTo = ctx.sendTo;
  var getSessionForWs = ctx.getSessionForWs;

  async function sendVendorModels(ws, msg) {
    var linuxUser = ws && ws._clayUser && ws._clayUser.linuxUser ? ws._clayUser.linuxUser : undefined;
    var requestedRoute = msg.providerRouteId ? routeForId(msg.providerRouteId) : null;
    if (msg.vendor) {
      try {
        if (sdk && typeof sdk.prepareVendor === "function") {
          await sdk.prepareVendor(msg.vendor, linuxUser);
        }
      } catch (e) {
        console.error("[project] get_vendor_models readiness failed for " + msg.vendor + ":", e.message || e);
      }
    }

    var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[msg.vendor]) || [];
    if (msg.vendor === "claude") {
      vendorModels = withClaudeFallbackModels(vendorModels);
      // Offer unadvertised-but-serveable models (e.g. Opus 5) the SDK init
      // handshake doesn't list. extraClaudeModels only returns ones this account
      // has been probed to actually run, and refreshes stale verdicts in the
      // background — so nothing is offered that would error on select.
      var claudeExtras = claudeModelProbe.extraClaudeModels(vendorModels);
      if (claudeExtras.length) vendorModels = claudeModelProbe.mergeExtras(vendorModels, claudeExtras);
    }
    if (msg.vendor === "codex" && vendorModels.length === 0) vendorModels = fallbackCodexModels();
    if (msg.vendor === "github-copilot") {
      var copilotModels = knownModelsForProvider("github-copilot");
      if (copilotModels.length > 0) vendorModels = copilotModels;
    } else if (requestedRoute) {
      var routeModels = knownModelsForRoute(requestedRoute);
      if (routeModels.length > 0) vendorModels = routeModels;
    }
    var firstModel = vendorModels[0] || "";
    var defaultModel = typeof firstModel === "string" ? firstModel : (firstModel.value || "");

    function modelListContains(candidate) {
      if (!candidate) return false;
      for (var li = 0; li < vendorModels.length; li++) {
        var value = typeof vendorModels[li] === "string" ? vendorModels[li] : (vendorModels[li].value || vendorModels[li].model || vendorModels[li].id || "");
        if (value === candidate) return true;
      }
      return false;
    }

    var modelToSend = defaultModel;
    var activeForModels = getSessionForWs(ws);
    if (activeForModels && activeForModels.providerRouteId === msg.providerRouteId && modelListContains(activeForModels.model)) {
      modelToSend = activeForModels.model;
    } else if (sm.defaultModelsByVendor && sm.defaultModelsByVendor[msg.vendor] && modelListContains(sm.defaultModelsByVendor[msg.vendor])) {
      modelToSend = sm.defaultModelsByVendor[msg.vendor];
    }
    if (sm.currentModel && (!sm.defaultModelsByVendor || !sm.defaultModelsByVendor[msg.vendor])) {
      for (var mi = 0; mi < vendorModels.length; mi++) {
        var mv = typeof vendorModels[mi] === "string" ? vendorModels[mi] : (vendorModels[mi].value || "");
        if (mv === sm.currentModel) {
          modelToSend = sm.currentModel;
          break;
        }
      }
    }
    sendTo(ws, {
      type: "model_info",
      model: modelToSend,
      models: vendorModels,
      vendor: msg.vendor,
      capabilities: (sm.capabilitiesByVendor && sm.capabilitiesByVendor[msg.vendor]) || {},
      providerRouteId: msg.providerRouteId || null,
      availableVendors: sm.availableVendors || [],
      installedVendors: sm.installedVendors || [],
      providerRoutes: sm.providerRoutes || listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []),
    });
  }

  function handleMessage(ws, msg) {
    if (!msg || msg.type !== "get_vendor_models") return false;
    sendVendorModels(ws, msg);
    return true;
  }

  return {
    handleMessage: handleMessage,
  };
}

module.exports = {
  attachProjectVendorModels: attachProjectVendorModels,
};
