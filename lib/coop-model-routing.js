// Runtime adapter for the pure canonical Coop model policy. Generic project
// provider routing stays in project-provider-failover; this module owns the
// only Coop-specific session mutations and fallback candidate shape.
var coopModelPolicy = require("./coop-model-policy");
var routeForId = require("./provider-routes").routeForId;

function routeAvailable(sm, designation) {
  var routes = Array.isArray(sm && sm.providerRoutes) ? sm.providerRoutes : [];
  for (var i = 0; i < routes.length; i++) {
    if (!routes[i] || routes[i].id !== designation.providerRouteId) continue;
    if (typeof routes[i].enabled === "boolean") return routes[i].enabled;
  }
  var available = sm && sm.availableVendors;
  var installed = sm && sm.installedVendors;
  if (Array.isArray(available) && available.indexOf(designation.vendor) === -1) return false;
  if (Array.isArray(installed) && installed.indexOf(designation.vendor) === -1) return false;
  var models = sm && sm.modelsByVendor && sm.modelsByVendor[designation.vendor];
  if (Array.isArray(models) && models.length > 0) {
    for (var mi = 0; mi < models.length; mi++) {
      var model = typeof models[mi] === "string" ? models[mi] :
        models[mi] && (models[mi].value || models[mi].model || models[mi].id);
      if (coopModelPolicy.modelMatches(designation, model)) return true;
    }
    return false;
  }
  return true;
}

function policyOptions(sm, extra) {
  return Object.assign({
    routeAvailable: function (designation) {
      return routeAvailable(sm, designation);
    },
  }, extra || {});
}

function currentDesignation(session, activeModel) {
  var model = activeModel(session);
  if (!session || !session.vendor || !session.providerRouteId || !model) return null;
  return coopModelPolicy.designationForTarget({
    vendor: session.vendor,
    providerRouteId: session.providerRouteId,
    model: model,
  });
}

function selectReplacement(sm, session, activeModel) {
  var current = currentDesignation(session, activeModel);
  return coopModelPolicy.selectRoute(
    coopModelPolicy.purposeForSession(session),
    policyOptions(sm, {
      excludeDesignationId: current && current.id || null,
    }));
}

function fallbackCandidates(sm, session, activeModel) {
  var decision = selectReplacement(sm, session, activeModel);
  if (!decision.ok) return [];
  var route = routeForId(decision.providerRouteId);
  if (!route) return [];
  return [{
    route: route,
    targetModel: decision.model,
    sourceModel: activeModel(session),
    sourceTier: 4,
    targetTier: 4,
    capabilityFloor: 4,
    catalogSource: "coop-top-tier-policy",
    mode: "top-tier-only",
    score: 0,
    routeRank: 0,
    familyMatch: 0,
    freeAllowancePotential: false,
    order: 0,
  }];
}

function resolveSwitchTarget(sm, session, target) {
  if (!coopModelPolicy.appliesToSession(session)) return null;
  return coopModelPolicy.resolveTarget(target, policyOptions(sm));
}

function attachRuntime(input) {
  var sm = input.sm;
  var switcher = input.switcher;
  var activeModel = input.activeModel;

  function recordUnavailable(session, decision) {
    var result = decision && decision.ok === false ? decision : {
      code: coopModelPolicy.UNAVAILABLE_CODE,
      reason: coopModelPolicy.UNAVAILABLE_CODE,
      message: "Coop is unavailable: no designated top-tier route is healthy. " +
        "Clay will not fall back to a degraded or lower-tier model.",
    };
    if (sm && typeof sm.sendAndRecord === "function") {
      sm.sendAndRecord(session, {
        type: "coop_route_unavailable",
        code: result.code,
        reason: result.reason,
        text: result.message,
      });
    }
    return result;
  }

  function directInitialBindingAllowed(session) {
    if (!session || session.cliSessionId) return false;
    var history = Array.isArray(session.history) ? session.history : [];
    for (var i = 0; i < history.length; i++) {
      if (history[i] && history[i].type !== "user_message") return false;
    }
    return true;
  }

  function syncIncarnationRoute(session, decision) {
    if (!session.coopIncarnation) return;
    session.coopIncarnation.vendor = decision.vendor;
    session.coopIncarnation.providerRouteId = decision.providerRouteId;
    session.coopIncarnation.model = decision.model;
    session.coopIncarnation.updatedAt = Date.now();
  }

  function bindInitialRoute(session, decision) {
    session.vendor = decision.vendor;
    session.providerRouteId = decision.providerRouteId;
    session.model = decision.model;
    session.requestedModel = decision.model;
    session.verifiedModel = null;
    session.modelVerificationSource = null;
    syncIncarnationRoute(session, decision);
    sm.currentModel = "";
    try { sm.saveSessionFile(session, { durable: true }); } catch (error) {}
    if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
    return decision;
  }

  function failedActivation(session, result) {
    return recordUnavailable(session, {
      ok: false,
      code: coopModelPolicy.UNAVAILABLE_CODE,
      reason: coopModelPolicy.UNAVAILABLE_CODE,
      message: "Coop is unavailable: a healthy designated top-tier route could not be activated (" +
        String(result && (result.message || result.reason) || "unknown switch error") + "). " +
        "Clay will not fall back to a degraded or lower-tier model.",
    });
  }

  function ensureRoute(session) {
    if (!coopModelPolicy.appliesToSession(session)) return { ok: true, scoped: false };
    var current = coopModelPolicy.currentSessionRoute(session, policyOptions(sm));
    if (current.ok) return current;
    var decision = selectReplacement(sm, session, activeModel);
    if (!decision.ok) return recordUnavailable(session, decision);
    if (directInitialBindingAllowed(session)) return bindInitialRoute(session, decision);
    var result = switcher.executeProviderSwitch({
      session: session,
      targetVendor: decision.vendor,
      targetRouteId: decision.providerRouteId,
      targetModel: decision.model,
      trigger: "coop-policy",
      initiatedBy: { source: "coop-top-tier-policy", userId: null },
      preserveQueuedMessages: true,
      preserveScheduledMessages: true,
      allowWhileProcessing: true,
      forceFresh: true,
    });
    if (!result.ok) return failedActivation(session, result);
    return decision;
  }

  function currentSelection(session) {
    return coopModelPolicy.selectRoute(
      coopModelPolicy.purposeForSession(session), policyOptions(sm));
  }

  return {
    ensureRoute: ensureRoute,
    recordUnavailable: recordUnavailable,
    currentSelection: currentSelection,
  };
}

module.exports = {
  attachRuntime: attachRuntime,
  fallbackCandidates: fallbackCandidates,
  resolveSwitchTarget: resolveSwitchTarget,
  modelMatches: coopModelPolicy.modelMatches,
};
