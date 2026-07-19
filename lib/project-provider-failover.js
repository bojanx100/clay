var { attachProviderSwitch } = require("./provider-switch");
var { listProviderRoutes, routeForId } = require("./provider-routes");
var providerHealth = require("./provider-health");
var { recordRecoveryEvent } = require("./recovery-log");

var CONTINUE_PROMPT = "The previous provider could not continue because it became unavailable. Continue the interrupted work from the Clay handoff context. Do not restart from scratch, do not ask for confirmation, and do not treat provider error text as the user's task.";

function routeFamilyForSession(session) {
  var route = session && session.providerRouteId ? routeForId(session.providerRouteId) : null;
  if (route && route.modelFamily) return route.modelFamily;
  if (session && session.vendor === "claude") return "claude";
  if (session && session.vendor === "codex") return "gpt";
  return "";
}

function fallbackRoutes(sm, session) {
  var routes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
  var currentVendor = (session && session.vendor) || "claude";
  var currentFamily = routeFamilyForSession(session);
  var candidates = [];
  for (var i = 0; i < routes.length; i++) {
    var route = routes[i];
    if (!route.enabled || route.vendor === currentVendor) continue;
    var health = providerHealth.getHealth(route.vendor).state;
    if (health === providerHealth.UNHEALTHY) continue;
    var score = 0;
    if (health === providerHealth.DEGRADED) score += 100;
    if (currentFamily && route.modelFamily !== currentFamily) score += 10;
    candidates.push({ route: route, score: score, order: i });
  }
  candidates.sort(function (a, b) {
    if (a.score !== b.score) return a.score - b.score;
    return a.order - b.order;
  });
  return candidates.map(function (candidate) { return candidate.route; });
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

  function failoverAndContinue(session, failure) {
    if (!session || session.destroying || session._providerFailoverInProgress) return false;
    var routes = fallbackRoutes(sm, session);
    if (routes.length === 0) {
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: "Clay could not continue automatically because no healthy fallback provider is available. Configure Codex or GitHub Copilot, or restore access to the current provider.",
      });
      return false;
    }

    session._providerFailoverInProgress = true;
    try {
      var target = routes[0];
      var fromVendor = session.vendor || "claude";
      var result = switcher.executeProviderSwitch({
        session: session,
        targetVendor: target.vendor,
        targetRouteId: target.id,
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
    fallbackRoutes: function (session) { return fallbackRoutes(sm, session); },
  };
}

module.exports = {
  attachProjectProviderFailover: attachProjectProviderFailover,
  fallbackRoutes: fallbackRoutes,
  CONTINUE_PROMPT: CONTINUE_PROMPT,
};
