var { attachProviderSwitch } = require("./provider-switch");
var { listProviderRoutes, routeForId } = require("./provider-routes");
var providerHealth = require("./provider-health");
var { recordRecoveryEvent } = require("./recovery-log");

var CONTINUE_PROMPT = "The previous provider could not continue because it became unavailable. Continue the interrupted work from the Clay handoff context. Do not restart from scratch, do not ask for confirmation, and do not treat provider error text as the user's task.";

function activeModel(session) {
  if (!session) return "";
  return session.verifiedModel || session.requestedModel || session.model || "";
}

function modelCapabilityTier(model) {
  var value = String(model || "").toLowerCase().replace(/[_.]/g, "-");
  if (!value) return null;
  if (value === "best" || value.indexOf("fable") !== -1 || /^gpt-5-6-sol(?:-|$)/.test(value)) return 4;
  if (value.indexOf("haiku") !== -1 || value.indexOf("mini") !== -1 || value.indexOf("spark") !== -1) return 1;
  if (value.indexOf("opus") !== -1 || /^gpt-5-6-terra(?:-|$)/.test(value) || /^gpt-5-5(?:-|$)/.test(value) || value.indexOf("gemini-3-1-pro") !== -1) return 3;
  if (value.indexOf("sonnet") !== -1 || /^gpt-5-6-luna(?:-|$)/.test(value) || /^gpt-5-4(?:-|$)/.test(value) || value.indexOf("gemini-3-5-flash") !== -1) return 2;
  return null;
}

function capabilityComparison(sourceModel, targetModel) {
  var sourceTier = modelCapabilityTier(sourceModel);
  var targetTier = modelCapabilityTier(targetModel);
  var sameModel = !!sourceModel && !!targetModel && String(sourceModel).toLowerCase() === String(targetModel).toLowerCase();
  var comparable = sameModel || (sourceTier !== null && targetTier !== null && targetTier >= sourceTier);
  return {
    sourceTier: sourceTier,
    targetTier: targetTier,
    comparable: comparable,
  };
}

function routeFamilyForSession(session) {
  var route = session && session.providerRouteId ? routeForId(session.providerRouteId) : null;
  if (route && route.modelFamily) return route.modelFamily;
  if (session && session.vendor === "claude") return "claude";
  if (session && session.vendor === "codex") return "gpt";
  return "";
}

function fallbackCandidates(sm, session, switcher) {
  var routes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
  var currentVendor = (session && session.vendor) || "claude";
  var currentFamily = routeFamilyForSession(session);
  var sourceModel = activeModel(session);
  var candidates = [];
  for (var i = 0; i < routes.length; i++) {
    var route = routes[i];
    if (!route.enabled || route.vendor === currentVendor) continue;
    var health = providerHealth.getHealth(route.vendor).state;
    if (health === providerHealth.UNHEALTHY) continue;
    var targetModel = switcher ? switcher.modelForHandoff(session, route, null) : route.defaultModel;
    var comparison = capabilityComparison(sourceModel, targetModel);
    if (!comparison.comparable) continue;
    var score = 0;
    if (health === providerHealth.DEGRADED) score += 100;
    if (currentFamily && route.modelFamily !== currentFamily) score += 10;
    candidates.push({
      route: route,
      targetModel: targetModel,
      sourceModel: sourceModel,
      comparison: comparison,
      score: score,
      order: i,
    });
  }
  candidates.sort(function (a, b) {
    if (a.score !== b.score) return a.score - b.score;
    return a.order - b.order;
  });
  return candidates;
}

function fallbackRoutes(sm, session, switcher) {
  return fallbackCandidates(sm, session, switcher).map(function (candidate) { return candidate.route; });
}

function attachProjectProviderFailover(ctx) {
  var sm = ctx.sm;
  var scheduledMessages = ctx.scheduledMessages;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var getComparableFailoverSetting = ctx.getComparableFailoverSetting || function () { return true; };
  var recordEvent = ctx.recordRecoveryEvent || recordRecoveryEvent;
  var switcher = attachProviderSwitch({
    cwd: ctx.cwd,
    imagesDir: ctx.imagesDir || null,
    sm: sm,
    sendTo: ctx.sendTo || function () {},
    sendToSession: ctx.sendToSession,
    sendConfigForSession: function () {},
    cancelScheduledMessage: ctx.cancelScheduledMessage,
    clearPendingQueuedMessages: function () {},
  });

  function continueOnCandidate(session, candidate, failure) {
    var target = candidate.route;
    var fromVendor = session.vendor || "claude";
    var result = switcher.executeProviderSwitch({
      session: session,
      targetVendor: target.vendor,
      targetRouteId: target.id,
      targetModel: candidate.targetModel || null,
      trigger: "provider-failure",
      initiatedBy: { source: "provider-failover", userId: null },
      preserveQueuedMessages: true,
    });
    if (!result.ok) {
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: "Clay found a fallback provider but could not switch automatically: " + (result.message || result.reason || "unknown error") + ".",
      });
      return false;
    }

    recordEvent({
      kind: "provider_failover",
      sessionId: session.localId,
      fromVendor: fromVendor,
      toVendor: result.toVendor,
      targetRouteId: target.id,
      reason: failure && failure.reason ? failure.reason : "provider-unavailable",
    });

    var label = result.label || target.label || target.vendor;
    var continued = scheduledMessages.continueAfterProviderSwitch(
      session,
      CONTINUE_PROMPT,
      "↻ Continuing on " + label,
      label
    );
    if (!continued) {
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: "Clay switched to " + label + " but stopped because the automatic recovery budget is exhausted. Send a message to continue.",
      });
    }
    return continued;
  }

  function scheduleAfterProviderReset(session, failure) {
    var resetsAt = failure && failure.resetsAt ? failure.resetsAt : null;
    if (!resetsAt) resetsAt = session.rateLimitResetsAt || session.rateLimitLastResetsAt || null;
    if (!resetsAt && session.scheduledMessage) resetsAt = session.scheduledMessage.resetsAt || null;
    resetsAt = Number(resetsAt);
    if (!isFinite(resetsAt) || resetsAt <= Date.now()) {
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: "Clay stayed on the current provider, but the provider did not report a future reset time. Send a message after access is restored to continue.",
      });
      return false;
    }
    var sourceRoute = session.providerRouteId ? routeForId(session.providerRouteId) : null;
    var providerLabel = (sourceRoute && sourceRoute.label) || session.vendor || "the current provider";
    scheduledMessages.scheduleMessage(
      session,
      "continue",
      resetsAt,
      "The original provider limit has reset. Continue the interrupted work from where it stopped; do not restart from scratch.",
      "↻ Continuing on " + providerLabel + " after reset",
      { autoAction: true }
    );
    return true;
  }

  function failoverAndContinue(session, failure) {
    if (!session || session.destroying || session._providerFailoverInProgress) return false;
    if (!getComparableFailoverSetting(session)) {
      return scheduleAfterProviderReset(session, failure);
    }
    var candidates = fallbackCandidates(sm, session, switcher);
    if (candidates.length === 0) {
      return scheduleAfterProviderReset(session, failure);
    }

    var candidate = candidates[0];
    var sourceVendor = session.vendor || "claude";
    session._providerFailoverInProgress = true;
    try {
      var continued = continueOnCandidate(session, candidate, failure);
      if (!continued && (session.vendor || "claude") === sourceVendor) {
        return scheduleAfterProviderReset(session, failure);
      }
      return continued;
    } finally {
      session._providerFailoverInProgress = false;
    }
  }

  function queueFailover(session, failure) {
    if (!session || session.destroying || session._providerFailoverQueued) return false;
    session._providerFailoverQueued = true;
    session._providerFailoverClosing = true;
    var oldQuery = session.queryInstance || null;
    if (oldQuery && typeof oldQuery.close === "function") {
      try { oldQuery.close(); } catch (e) {}
    } else if (session.messageQueue && typeof session.messageQueue.end === "function") {
      try { session.messageQueue.end(); } catch (e) {}
    }
    var startedAt = Date.now();
    function finishFailover() {
      if (session.destroying) {
        session._providerFailoverQueued = false;
        session._providerFailoverClosing = false;
        return;
      }
      var oldQueryAttached = oldQuery && session.queryInstance === oldQuery;
      if ((oldQueryAttached || session.isProcessing) && (Date.now() - startedAt) < 5000) {
        session._providerFailoverTimer = setTimeout(finishFailover, 20);
        return;
      }
      session._providerFailoverTimer = null;
      session._providerFailoverQueued = false;
      session._providerFailoverClosing = false;
      if (oldQueryAttached || session.isProcessing) {
        session.isProcessing = false;
        onProcessingChanged();
        sm.sendAndRecord(session, {
          type: "info",
          variant: "warning",
          text: "Clay could not detach the unavailable provider safely. Send a message to retry or switch providers manually.",
        });
        return;
      }
      failoverAndContinue(session, failure);
    }
    session._providerFailoverTimer = setTimeout(finishFailover, 0);
    return true;
  }

  return {
    failoverAndContinue: failoverAndContinue,
    queueFailover: queueFailover,
    fallbackRoutes: function (session) { return fallbackRoutes(sm, session, switcher); },
  };
}

module.exports = {
  attachProjectProviderFailover: attachProjectProviderFailover,
  fallbackRoutes: fallbackRoutes,
  modelCapabilityTier: modelCapabilityTier,
  capabilityComparison: capabilityComparison,
  CONTINUE_PROMPT: CONTINUE_PROMPT,
};
