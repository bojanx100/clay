var { withClaudeFallbackModels } = require("./claude-defaults");
var { fallbackCodexModels } = require("./codex-models");
var { routeForId, knownModelsForProvider, knownModelsForRoute } = require("./provider-routes");

function attachBridgeModels(ctx) {
  var sm = ctx.sm;
  var send = ctx.send;
  var adapter = ctx.adapter;

  function getModelsForVendor(vendor) {
    if (vendor && sm.modelsByVendor && Array.isArray(sm.modelsByVendor[vendor]) && sm.modelsByVendor[vendor].length > 0) {
      if (vendor === "claude") return withClaudeFallbackModels(sm.modelsByVendor[vendor]);
      return sm.modelsByVendor[vendor];
    }
    if (vendor === "claude") return withClaudeFallbackModels([]);
    if (vendor === "codex") return fallbackCodexModels();
    return sm.availableModels || [];
  }

  function getModelsForSession(session, vendor) {
    if (vendor === "github-copilot") {
      var copilotModels = knownModelsForProvider("github-copilot");
      if (copilotModels.length > 0) return copilotModels;
    }
    if (session && session.providerRouteId) {
      var route = routeForId(session.providerRouteId);
      var routeModels = knownModelsForRoute(route);
      if (routeModels.length > 0) return routeModels;
    }
    return getModelsForVendor(vendor);
  }

  function copilotRouteIdForModel(model) {
    if (!model) return null;
    if (model.indexOf("claude-") === 0) return "claude-github-copilot";
    if (model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1) return "codex-github-copilot";
    return null;
  }

  function modelEntryValue(entry) {
    if (!entry) return "";
    if (typeof entry === "string") return entry;
    return entry.value || entry.model || entry.id || "";
  }

  function canonicalModelId(modelId) {
    return modelEntryValue(modelId).toLowerCase().replace(/[-.]/g, "");
  }

  function modelListContains(list, modelId) {
    if (!list || !modelId) return false;
    var wanted = canonicalModelId(modelId);
    for (var mi = 0; mi < list.length; mi++) {
      if (canonicalModelId(list[mi]) === wanted) return true;
    }
    return false;
  }

  function resolveModelInList(list, modelId) {
    if (!list || !modelId) return null;
    var lc = modelId.toLowerCase();
    var wanted = canonicalModelId(modelId);
    for (var mi = 0; mi < list.length; mi++) {
      var val = modelEntryValue(list[mi]);
      if (val === modelId || canonicalModelId(val) === wanted) return val;
    }
    for (var mi2 = 0; mi2 < list.length; mi2++) {
      var fuzzyVal = modelEntryValue(list[mi2]);
      if (!fuzzyVal || fuzzyVal === "default") continue;
      var vlc = fuzzyVal.toLowerCase();
      if (vlc.indexOf(lc) !== -1 || lc.indexOf(vlc) !== -1) return fuzzyVal;
    }
    return null;
  }

  function sendModelInfoForVendor(vendor, model, session) {
    var msg = {
      type: "model_info",
      model: model || "",
      models: getModelsForSession(session, vendor),
      vendor: vendor || (adapter && adapter.vendor) || "claude",
      providerRouteId: (session && session.providerRouteId) || null,
      requestedModel: (session && (session.requestedModel || session.model)) || model || null,
      verifiedModel: (session && session.verifiedModel) || null,
      modelVerificationSource: (session && session.modelVerificationSource) || null,
      availableVendors: sm.availableVendors || [],
      installedVendors: sm.installedVendors || [],
      providerRoutes: sm.providerRoutes || [],
    };
    if (session) {
      sm.sendToSession(session, msg);
    } else {
      send(msg);
    }
  }

  return {
    getModelsForVendor: getModelsForVendor,
    getModelsForSession: getModelsForSession,
    copilotRouteIdForModel: copilotRouteIdForModel,
    modelEntryValue: modelEntryValue,
    modelListContains: modelListContains,
    resolveModelInList: resolveModelInList,
    sendModelInfoForVendor: sendModelInfoForVendor,
  };
}

module.exports = { attachBridgeModels: attachBridgeModels };
