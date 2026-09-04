var { buildHandoffContextFromHistory } = require("./handoff-context");

function attachSessionHandoff(ctx) {
  var cwd = ctx.cwd;

  function recoverMissingHandoffContext(history) {
    if (!Array.isArray(history)) return null;
    var switchIndex = -1;
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].type === "vendor_switched") {
        switchIndex = i;
        break;
      }
    }
    if (switchIndex < 0) return null;
    return buildHandoffContextFromHistory(history.slice(0, switchIndex), {
      fromVendor: "this Clay session before the current thread was persisted",
      toVendor: "the current vendor",
      sourceLabel: "this Clay session before the current thread was persisted",
      cwd: cwd,
    });
  }

  function hasVendorResponseSinceLastSwitch(history) {
    if (!Array.isArray(history)) return false;
    var switchIndex = -1;
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].type === "vendor_switched") { switchIndex = i; break; }
    }
    if (switchIndex < 0) return false;
    for (var j = switchIndex + 1; j < history.length; j++) {
      var t = history[j] && history[j].type;
      if (t === "delta" || t === "thinking_delta" || t === "tool_start" || t === "tool_executing") return true;
    }
    return false;
  }

  function shouldRecoverMissingHandoffContext(session) {
    if (!session || !session.vendor) return false;
    if (session.vendor === "claude") return false;
    if (session.handoffContextConsumed) return false;
    if (hasVendorResponseSinceLastSwitch(session.history)) return false;
    return true;
  }

  function handoffTurnBudgetForVendor(vendor) {
    return vendor === "github-copilot" ? 1 : 4;
  }

  function inferCurrentVendorFromHistory(history, fallbackVendor) {
    var vendor = fallbackVendor || null;
    if (!Array.isArray(history)) return vendor;
    for (var i = 0; i < history.length; i++) {
      var item = history[i];
      if (item && item.type === "vendor_switched" && item.toVendor) {
        vendor = item.toVendor;
      }
    }
    return vendor;
  }

  function inferCurrentProviderRouteFromHistory(history, fallbackRouteId) {
    var routeId = fallbackRouteId || null;
    if (!Array.isArray(history)) return routeId;
    for (var i = 0; i < history.length; i++) {
      var item = history[i];
      if (item && item.type === "vendor_switched" && item.targetRouteId) {
        routeId = item.targetRouteId;
      }
    }
    return routeId;
  }

  function inferCurrentModelFromHistory(history, fallbackModel) {
    var model = fallbackModel || null;
    if (!Array.isArray(history)) return model;
    for (var i = 0; i < history.length; i++) {
      var item = history[i];
      if (item && item.type === "vendor_switched" && item.targetModel) {
        model = item.targetModel;
      }
    }
    return model;
  }

  function inferCliSessionIdAfterLastHandoff(history) {
    if (!Array.isArray(history)) return null;
    var switchIndex = -1;
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].type === "vendor_switched") {
        switchIndex = i;
        break;
      }
    }
    if (switchIndex < 0) return null;
    var cliSessionId = null;
    for (var j = switchIndex + 1; j < history.length; j++) {
      if (history[j] && history[j].type === "session_id" && history[j].cliSessionId) {
        cliSessionId = history[j].cliSessionId;
      }
    }
    return cliSessionId;
  }

  return {
    recoverMissingHandoffContext: recoverMissingHandoffContext,
    hasVendorResponseSinceLastSwitch: hasVendorResponseSinceLastSwitch,
    shouldRecoverMissingHandoffContext: shouldRecoverMissingHandoffContext,
    handoffTurnBudgetForVendor: handoffTurnBudgetForVendor,
    inferCurrentVendorFromHistory: inferCurrentVendorFromHistory,
    inferCurrentProviderRouteFromHistory: inferCurrentProviderRouteFromHistory,
    inferCurrentModelFromHistory: inferCurrentModelFromHistory,
    inferCliSessionIdAfterLastHandoff: inferCliSessionIdAfterLastHandoff,
  };
}

module.exports = {
  attachSessionHandoff: attachSessionHandoff,
};
