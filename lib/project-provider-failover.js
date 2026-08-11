var { attachProviderSwitch } = require("./provider-switch");
var { capabilityComparison, modelCapabilityTier } = require("./model-capability");
var { capabilityTier, modelCost } = require("./adaptive-worker-routing");
var { listProviderRoutes, routeForId, verifiedCatalogForRoute, candidateHealth } = require("./provider-routes");
var providerHealth = require("./provider-health");
var handoffState = require("./handoff-state");
var { recordRecoveryEvent } = require("./recovery-log");
var { isLimitFailure } = require("./sdk-provider-failover-signals");

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

function failoverPolicy(sm) {
  return sm && (sm.workerRoutingPolicy || sm.adaptiveRoutingPolicy) || {};
}

function fallbackContext(sm, session) {
  var policy = failoverPolicy(sm);
  var sourceModel = activeModel(session);
  var sourceTier = capabilityTier(sourceModel, policy);
  if (!sourceModel || sourceTier === null) return null;
  var capabilityFloor = sourceTier === 4 ? 4 : Math.min(sourceTier || 2, 2);
  return {
    policy: policy,
    sourceModel: sourceModel,
    sourceTier: sourceTier,
    capabilityFloor: capabilityFloor,
    currentRouteId: session && session.providerRouteId || null,
    currentFamily: routeFamilyForSession(session),
    routeOrder: capabilityFloor === 4
      ? (policy.frontierRouteOrder || ["claude-anthropic", "claude-github-copilot", "codex-openai", "codex-github-copilot"])
      : (policy.routeOrder || ["codex-openai", "codex-github-copilot", "claude-anthropic", "claude-github-copilot"]),
  };
}

function candidateForModel(route, targetModel, routeIndex, modelIndex, context, catalogSource) {
  var targetTier = capabilityTier(targetModel, context.policy);
  if (targetTier === null || targetTier < context.capabilityFloor) return null;
  var health = candidateHealth(route, targetModel).state;
  if (health === providerHealth.UNHEALTHY) return null;
  var routeRank = context.routeOrder.indexOf(route.id);
  if (routeRank === -1) routeRank = context.routeOrder.length;
  var routeCost = context.policy.routeCosts && Number(context.policy.routeCosts[route.id]) || 0;
  var score = modelCost(targetModel, targetTier, context.policy) + routeCost;
  if (health === providerHealth.DEGRADED) score += 100;
  return {
    route: route,
    targetModel: targetModel,
    sourceModel: context.sourceModel,
    sourceTier: context.sourceTier,
    targetTier: targetTier,
    capabilityFloor: context.capabilityFloor,
    catalogSource: catalogSource,
    mode: context.sourceTier === 4 ? "capability-preserving" : (targetTier < context.sourceTier ? "demotion" : "capability-preserving"),
    score: score,
    routeRank: routeRank,
    familyMatch: context.currentFamily && route.modelFamily === context.currentFamily ? 0 : 1,
    order: routeIndex * 1000 + modelIndex,
  };
}

function candidatesForRoute(sm, route, routeIndex, context) {
  var candidates = [];
  if (!route.enabled || route.id === context.currentRouteId) return candidates;
  var catalog = verifiedCatalogForRoute(route, sm);
  for (var i = 0; i < catalog.models.length; i++) {
    var candidate = candidateForModel(route, catalog.models[i], routeIndex, i, context, catalog.source);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function compareFallbackCandidates(context, a, b) {
  if (context.capabilityFloor === 4 && a.routeRank !== b.routeRank) return a.routeRank - b.routeRank;
  if (a.score !== b.score) return a.score - b.score;
  if (a.familyMatch !== b.familyMatch) return a.familyMatch - b.familyMatch;
  if (a.routeRank !== b.routeRank) return a.routeRank - b.routeRank;
  return a.order - b.order;
}

function fallbackCandidates(sm, session, switcher) {
  var context = fallbackContext(sm, session);
  if (!context) return [];
  var routes = Array.isArray(sm.providerRoutes) && sm.providerRoutes.length
    ? sm.providerRoutes
    : listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
  var candidates = [];
  for (var i = 0; i < routes.length; i++) {
    candidates = candidates.concat(candidatesForRoute(sm, routes[i], i, context));
  }
  candidates.sort(function (a, b) {
    return compareFallbackCandidates(context, a, b);
  });
  return candidates;
}

function fallbackRoutes(sm, session, switcher) {
  return fallbackCandidates(sm, session, switcher).map(function (candidate) { return candidate.route; });
}

function firstPresent(values, fallback) {
  for (var i = 0; i < values.length; i++) {
    if (values[i] !== null && values[i] !== undefined && values[i] !== "") return values[i];
  }
  return fallback;
}

function failoverKeyFor(session, failure) {
  var fromVendor = firstPresent([failure && failure.vendor, session && session.vendor], "claude");
  return [
    firstPresent([session && session.storageId, session && session.localId], "unknown-session"),
    firstPresent([failure && failure.providerRouteId, session && session.providerRouteId], fromVendor),
    firstPresent([failure && failure.model, activeModel(session)], "default"),
    firstPresent([failure && failure.reason], "provider-unavailable"),
    firstPresent([failure && failure.resetsAt], "unknown-reset"),
  ].join("|");
}

function completedFailover(session, failoverKey) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].type === "vendor_switched" && history[i].failoverKey === failoverKey) {
      return { entry: history[i], index: i };
    }
  }
  return null;
}

function continuationRecorded(session, switchIndex) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = switchIndex + 1; i < history.length; i++) {
    if (history[i] && (history[i].type === "scheduled_message_queued" ||
        history[i].type === "scheduled_message_sent")) return true;
  }
  return false;
}

function cannotQueueFailover(session) {
  return !session || session.destroying || session._providerFailoverQueued;
}

function cannotRunFailover(session) {
  return !session || session.destroying || session._providerFailoverInProgress;
}

function failoverWindowExpired(session, now) {
  return !session._providerFailoverWindowStart ||
    (now - session._providerFailoverWindowStart) > FAILOVER_WINDOW_MS;
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

  function scheduleDurableContinuation(session, label) {
    if (typeof scheduledMessages.restoreScheduledMessageTimers !== "function") return false;
    scheduledMessages.scheduleMessage(
      session,
      "continue",
      Date.now(),
      CONTINUE_PROMPT,
      "↻ Continuing on " + label,
      { autoAction: true }
    );
    return true;
  }

  function resumeCompletedFailover(session, failure) {
    var completed = completedFailover(session, failoverKeyFor(session, failure));
    if (!completed) return null;
    if (continuationRecorded(session, completed.index)) return true;
    var label = completed.entry.targetRouteLabel || completed.entry.toVendor || "the fallback provider";
    if (scheduleDurableContinuation(session, label)) {
      recordEvent({
        kind: "provider_failover_continuation_recovered",
        sessionId: session.localId,
        failoverKey: completed.entry.failoverKey,
        targetRouteId: completed.entry.targetRouteId || null,
      });
    }
    return true;
  }

  function continueOnCandidate(session, candidate, failure) {
    var target = candidate.route;
    var fromVendor = session.vendor || "claude";
    var failoverKey = failoverKeyFor(session, failure);
    var result = switcher.executeProviderSwitch({
      session: session,
      targetVendor: target.vendor,
      targetRouteId: target.id,
      targetModel: candidate.targetModel || null,
      trigger: "provider-failure",
      initiatedBy: { source: "provider-failover", userId: null },
      preserveQueuedMessages: true,
      idempotencyKey: failoverKey,
      routingRationale: candidate.mode + ": tier " + candidate.sourceTier + " -> " + candidate.targetTier +
        " via " + target.id + " from " + candidate.catalogSource + " catalog",
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
      targetModel: candidate.targetModel,
      sourceTier: candidate.sourceTier,
      targetTier: candidate.targetTier,
      routingMode: candidate.mode,
      catalogSource: candidate.catalogSource,
      failoverKey: failoverKey,
      reason: failure && failure.reason ? failure.reason : "provider-unavailable",
    });

    var label = result.label || target.label || target.vendor;
    var continued;
    if (scheduleDurableContinuation(session, label)) continued = true;
    else {
      continued = scheduledMessages.continueAfterProviderSwitch(
        session,
        CONTINUE_PROMPT,
        "↻ Continuing on " + label,
        label
      );
    }
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
    // A reset time only applies to a limit-shaped failure. Reading the
    // session's rate-limit fields for a connectivity or stream failure
    // resurrects a stale reset from an unrelated earlier limit and parks the
    // session for hours over a blip.
    var limitFailure = isLimitFailure(failure);
    if (!resetsAt && limitFailure) {
      resetsAt = session.rateLimitResetsAt || session.rateLimitLastResetsAt || null;
      if (!resetsAt && session.scheduledMessage) resetsAt = session.scheduledMessage.resetsAt || null;
    }
    resetsAt = Number(resetsAt);
    if (!isFinite(resetsAt) || resetsAt <= Date.now()) {
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: limitFailure
          ? "Clay stayed on the current provider, but the provider did not report a future reset time. Send a message after access is restored to continue."
          : "Clay stayed on the current provider after a connection failure and has no fallback available. Send a message to retry.",
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
    if (cannotRunFailover(session)) return false;
    var resumed = resumeCompletedFailover(session, failure);
    if (resumed !== null) return resumed;
    if (!getComparableFailoverSetting(session)) {
      return scheduleAfterProviderReset(session, failure);
    }
    // Reset the hop budget after a quiet window; a burst of failovers within
    // the window is the ping-pong we want to stop.
    var now = Date.now();
    if (failoverWindowExpired(session, now)) {
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
    if (cannotQueueFailover(session)) return false;
    // Warm the git-state cache off the event loop now, so the synchronous
    // handoff-state collection during the imminent switch reads the snapshot
    // instead of blocking the daemon on git.
    try { handoffState.warmGitStateCache(ctx.cwd); } catch (e) {}
    failure = Object.assign({}, failure || {});
    // Same gate as scheduleAfterProviderReset: recordProviderFailure already
    // decided a non-limit failure has no reset time, and that decision must
    // survive the hop through the failover queue.
    if (!failure.resetsAt && isLimitFailure(failure)) {
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
