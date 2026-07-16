var { withClaudeFallbackModels } = require("./claude-defaults");
var { fallbackCodexModels } = require("./codex-models");
var { listProviderRoutes, routeForId, knownModelsForProvider, knownModelsForRoute } = require("./provider-routes");
var yoke = require("./yoke");

function attachProjectVendorModels(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var sm = ctx.sm;
  var adapters = ctx.adapters;
  var sendTo = ctx.sendTo;
  var getSessionForWs = ctx.getSessionForWs;
  var serverPort = ctx.serverPort;
  var serverTls = ctx.serverTls;
  var serverAuthToken = ctx.serverAuthToken;

  async function sendVendorModels(ws, msg) {
    var requestedRoute = msg.providerRouteId ? routeForId(msg.providerRouteId) : null;
    if (msg.vendor) {
      try {
        var vendorAdapter = adapters[msg.vendor] || null;
        if (!vendorAdapter) {
          vendorAdapter = await yoke.lazyCreateAdapter(adapters, msg.vendor, {
            cwd: cwd,
            clayPort: serverPort,
            clayTls: serverTls,
            clayAuthToken: serverAuthToken,
            slug: slug,
          });
        } else if ((!sm.modelsByVendor || !sm.modelsByVendor[msg.vendor]) && typeof vendorAdapter.init === "function") {
          try {
            await vendorAdapter.init({
              cwd: cwd,
              clayPort: serverPort,
              clayTls: serverTls,
              clayAuthToken: serverAuthToken,
              slug: slug,
            });
          } catch (e) {
            console.error("[project] " + msg.vendor + " init failed (continuing to model list):", e.message || e);
          }
        }
        if (vendorAdapter) {
          sm.availableVendors = Object.keys(adapters);
          sm.modelsByVendor = sm.modelsByVendor || {};
          if (!sm.modelsByVendor[msg.vendor] && typeof vendorAdapter.supportedModels === "function") {
            var discoveredModels = await vendorAdapter.supportedModels();
            sm.modelsByVendor[msg.vendor] = msg.vendor === "claude" ? withClaudeFallbackModels(discoveredModels) : discoveredModels;
          }
        }
      } catch (e) {
        console.error("[project] get_vendor_models lazy init failed for " + msg.vendor + ":", e.message || e);
      }
    }

    var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[msg.vendor]) || [];
    if (msg.vendor === "claude") vendorModels = withClaudeFallbackModels(vendorModels);
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
