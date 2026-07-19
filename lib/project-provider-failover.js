var crypto = require("crypto");
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

function modelDisplayName(model) {
  var value = String(model || "");
  var lower = value.toLowerCase();
  if (!value) return "the fallback model";
  if (lower === "best" || lower.indexOf("fable") !== -1) return "Fable 5";
  if (lower === "gpt-5.6-sol") return "GPT-5.6 Sol";
  if (lower === "gpt-5.6-terra") return "GPT-5.6 Terra";
  if (lower === "gpt-5.6-luna") return "GPT-5.6 Luna";
  var claudeMatch = lower.match(/^claude-(opus|sonnet|haiku)-(\d+)[.-](\d+)/);
  if (claudeMatch) {
    return claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1) + " " + claudeMatch[2] + "." + claudeMatch[3];
  }
  return value;
}

function capabilityComparison(sourceModel, targetModel) {
  var sourceTier = modelCapabilityTier(sourceModel);
  var targetTier = modelCapabilityTier(targetModel);
  var requiresConfirmation = sourceTier !== null && (targetTier === null || targetTier < sourceTier);
  return {
    sourceTier: sourceTier,
    targetTier: targetTier,
    requiresConfirmation: requiresConfirmation,
    downgradeSteps: sourceTier !== null && targetTier !== null && targetTier < sourceTier ? sourceTier - targetTier : 0,
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
    var score = 0;
    if (health === providerHealth.DEGRADED) score += 100;
    if (currentFamily && route.modelFamily !== currentFamily) score += 10;
    if (comparison.requiresConfirmation) score += 20 + comparison.downgradeSteps;
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

  function requestDowngradeConfirmation(session, candidate, failure) {
    if (session._providerFailoverConfirmation) return true;
    var requestId = crypto.randomUUID();
    var sourceModel = candidate.sourceModel;
    var targetModel = candidate.targetModel;
    var sourceLabel = modelDisplayName(sourceModel);
    var targetLabel = modelDisplayName(targetModel);
    var routeLabel = candidate.route.label || candidate.route.vendor;
    var comparison = candidate.comparison;
    var reason = comparison.targetTier === null
      ? "Clay cannot verify that " + targetLabel + " matches the capability of " + sourceLabel + "."
      : targetLabel + " is a lower-capability model than " + sourceLabel + " for demanding work.";

    if (!session.pendingUserDialogs) session.pendingUserDialogs = {};
    session._providerFailoverConfirmation = {
      requestId: requestId,
      sourceVendor: session.vendor || "claude",
      sourceModel: sourceModel,
      targetRouteId: candidate.route.id,
    };
    session.pendingUserDialogs[requestId] = {
      request: { dialogKind: "Model downgrade protection" },
      resolve: function (response) {
        var pending = session._providerFailoverConfirmation;
        session._providerFailoverConfirmation = null;
        var approved = response && response.behavior === "completed" && response.result === "continue";
        if (!approved) {
          sm.sendAndRecord(session, {
            type: "info",
            text: "Automatic continuation remains paused. Restore " + sourceLabel + " or switch providers manually when you are ready.",
          });
          return;
        }
        if (!pending || session.destroying || (session.vendor || "claude") !== pending.sourceVendor || activeModel(session) !== pending.sourceModel) {
          sm.sendAndRecord(session, {
            type: "info",
            text: "The session provider or model changed while confirmation was pending, so Clay did not apply the fallback.",
          });
          return;
        }
        if (providerHealth.getHealth(candidate.route.vendor).state === providerHealth.UNHEALTHY) {
          failoverAndContinue(session, failure);
          return;
        }
        session._providerFailoverInProgress = true;
        try {
          continueOnCandidate(session, candidate, failure);
        } finally {
          session._providerFailoverInProgress = false;
        }
      },
    };
    sm.sendAndRecord(session, {
      type: "user_dialog_request",
      requestId: requestId,
      dialogKind: "Model downgrade protection",
      payload: {
        title: "Continue on a lower-capability model?",
        message: sourceLabel + " became unavailable. " + reason + " Continue on " + routeLabel + " with the existing handoff context?",
        options: [{ label: "Continue with " + targetLabel, value: "continue" }],
        cancelLabel: "Keep paused",
      },
      toolUseId: null,
    });
    return true;
  }

  function failoverAndContinue(session, failure) {
    if (!session || session.destroying || session._providerFailoverInProgress) return false;
    if (session._providerFailoverConfirmation) return true;
    var candidates = fallbackCandidates(sm, session, switcher);
    if (candidates.length === 0) {
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: "Clay could not continue automatically because no healthy fallback provider is available. Configure Codex or GitHub Copilot, or restore access to the current provider.",
      });
      return false;
    }

    var candidate = candidates[0];
    if (candidate.comparison.requiresConfirmation) {
      return requestDowngradeConfirmation(session, candidate, failure);
    }

    session._providerFailoverInProgress = true;
    try {
      return continueOnCandidate(session, candidate, failure);
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
  modelDisplayName: modelDisplayName,
  CONTINUE_PROMPT: CONTINUE_PROMPT,
};
