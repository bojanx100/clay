var { attachProviderSwitch } = require("./provider-switch");
var { capabilityComparison, modelCapabilityTier } = require("./model-capability");
var { listProviderRoutes, routeForId, hasLiveModelsForProvider } = require("./provider-routes");
var providerHealth = require("./provider-health");
var handoffState = require("./handoff-state");
var { recordRecoveryEvent } = require("./recovery-log");

var CONTINUE_PROMPT = "The previous provider could not continue because it became unavailable. Continue the interrupted work from the Clay handoff context. Do not restart from scratch, do not ask for confirmation, and do not treat provider error text as the user's task.";

// Bound consecutive automatic failovers within a rolling window so two
// unhealthy providers can't ping-pong a session forever (A->B->A->...), each
// hop firing a CONTINUE_PROMPT and burning tokens. The window resets after a
// quiet stretch, so legitimate failovers spread over time are still allowed.
var MAX_CONSECUTIVE_FAILOVERS = 5;
var FAILOVER_WINDOW_MS = 5 * 60 * 1000;

function activeModel(session) {
  if (!session) return "";
  if (session.vendor === "github-copilot") return session.verifiedModel || "";
  return session.verifiedModel || session.requestedModel || session.model || "";
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
    if (route.vendor === "github-copilot" && !hasLiveModelsForProvider(route.provider)) continue;
    var health = providerHealth.getHealth(route.vendor).state;
    if (health === providerHealth.UNHEALTHY) continue;
    // Model choice is delegated to the SAME suggestion logic /provider uses,
    // so an automatic failover always lands on exactly the model a manual
    // /provider to that route would have picked (exact/equivalent match
    // first, else the lowest comparable-or-stronger tier). No suggestion
    // means no safe model on that route — skip it.
    var suggestion = switcher && typeof switcher.suggestionForRoute === "function"
      ? switcher.suggestionForRoute(route, session)
      : null;
    if (!suggestion || !suggestion.model) continue;
    var comparison = capabilityComparison(sourceModel, suggestion.model);
    if (!comparison.comparable) continue;
    var score = 0;
    if (health === providerHealth.DEGRADED) score += 100;
    if (currentFamily && route.modelFamily !== currentFamily) score += 10;
    candidates.push({
      route: route,
      targetModel: suggestion.model,
      sourceModel: sourceModel,
      comparison: comparison,
      match: suggestion.match,
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
  var prepareFallbackProviders = ctx.prepareFallbackProviders || null;
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
    // Reset the hop budget after a quiet window; a burst of failovers within
    // the window is the ping-pong we want to stop.
    var now = Date.now();
    if (!session._providerFailoverWindowStart ||
        (now - session._providerFailoverWindowStart) > FAILOVER_WINDOW_MS) {
      session._providerFailoverWindowStart = now;
      session._providerFailoverHops = 0;
    }
    if ((session._providerFailoverHops || 0) >= MAX_CONSECUTIVE_FAILOVERS) {
      recordEvent({
        kind: "provider_failover_budget_exhausted",
        sessionId: session.localId,
        hops: session._providerFailoverHops || 0,
      });
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: "Clay stopped automatic provider switching after " + (session._providerFailoverHops || 0) +
          " consecutive failovers. Send a message to continue or switch providers manually.",
      });
      return false;
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
      if (continued) {
        session._providerFailoverHops = (session._providerFailoverHops || 0) + 1;
      } else if ((session.vendor || "claude") === sourceVendor) {
        return scheduleAfterProviderReset(session, failure);
      }
      return continued;
    } finally {
      session._providerFailoverInProgress = false;
    }
  }

  function queueFailover(session, failure) {
    if (!session || session.destroying || session._providerFailoverQueued) return false;
    // Warm the git-state cache off the event loop now, so the synchronous
    // handoff-state collection during the imminent switch reads the snapshot
    // instead of blocking the daemon on git.
    try { handoffState.warmGitStateCache(ctx.cwd); } catch (e) {}
    failure = Object.assign({}, failure || {});
    if (!failure.resetsAt) {
      failure.resetsAt = session.rateLimitResetsAt || session.rateLimitLastResetsAt || null;
    }
    // The failover path owns recovery from this point. Leaving the reset on
    // the session lets the old stream's finally block schedule a second,
    // same-provider continuation before fallback selection completes.
    session.rateLimitResetsAt = null;
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
      if (oldQueryAttached || session.isProcessing) {
        session.rateLimitResetsAt = failure.resetsAt || null;
        session._providerFailoverQueued = false;
        session._providerFailoverClosing = false;
        session.isProcessing = false;
        onProcessingChanged();
        sm.sendAndRecord(session, {
          type: "info",
          variant: "warning",
          text: "Clay could not detach the unavailable provider safely. Send a message to retry or switch providers manually.",
        });
        return;
      }
      session._providerFailoverClosing = false;
      if (!prepareFallbackProviders) {
        session._providerFailoverQueued = false;
        failoverAndContinue(session, failure);
        return;
      }
      var prepared;
      try {
        prepared = prepareFallbackProviders(session);
      } catch (err) {
        prepared = Promise.reject(err);
      }
      Promise.resolve(prepared).catch(function (err) {
        console.warn("[project] Could not finish fallback provider discovery: " + (err && err.message ? err.message : err));
      }).then(function () {
        session._providerFailoverQueued = false;
        if (!session.destroying) failoverAndContinue(session, failure);
      }).catch(function (err) {
        // failoverAndContinue rethrows out of its try/finally; keep it from
        // becoming an unhandled rejection and leave the session recoverable.
        session._providerFailoverQueued = false;
        console.warn("[project] Provider failover continuation failed: " + (err && err.message ? err.message : err));
      });
    }
    session._providerFailoverTimer = setTimeout(finishFailover, 0);
    return true;
  }

  return {
    failoverAndContinue: failoverAndContinue,
    queueFailover: queueFailover,
    fallbackRoutes: function (session) { return fallbackRoutes(sm, session, switcher); },
    switcher: switcher,
  };
}

module.exports = {
  attachProjectProviderFailover: attachProjectProviderFailover,
  fallbackRoutes: fallbackRoutes,
  modelCapabilityTier: modelCapabilityTier,
  capabilityComparison: capabilityComparison,
  CONTINUE_PROMPT: CONTINUE_PROMPT,
};
