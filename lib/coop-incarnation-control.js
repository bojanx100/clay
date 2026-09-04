// Canonical Coop model-context incarnation controls.
//
// Restart and route changes keep the permanent SessionRef and all durable
// owner/work state, but invalidate the previous runtime capability before the
// next provider turn. They never restart the Clay daemon.
var crypto = require("crypto");
var executionFence = require("./coop-control-fence");
var tombstones = require("./tombstones");
var createSessionIdleDefer = require("./session-idle-defer").createSessionIdleDefer;
var coopModelPolicy = require("./coop-model-policy");

var VERSION = 1;

// How long a queued incarnation change waits for Coop's turn to end before it
// is dropped. Matches the switch_provider approval wait.
var DEFER_IDLE_WAIT_MS = 10 * 60 * 1000;

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function routeIdFor(session, switcher) {
  if (session.providerRouteId) return session.providerRouteId;
  var route = switcher.resolveSwitchTargetRoute(session.vendor || "claude", session);
  return route && route.id || null;
}

function normalizedIncarnation(session, switcher) {
  var value = session && session.coopIncarnation;
  if (!value || value.version !== VERSION || !value.incarnationId ||
      !Number.isInteger(value.epoch) || value.epoch < 1) return null;
  return {
    version: VERSION,
    incarnationId: String(value.incarnationId),
    epoch: value.epoch,
    vendor: String(value.vendor || session.vendor || "claude"),
    providerRouteId: value.providerRouteId || routeIdFor(session, switcher),
    model: String(value.model || session.model || "default"),
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

function createIncarnation(session, switcher, epoch, routeId, model, vendor) {
  return {
    version: VERSION,
    incarnationId: "coop-incarnation-" + crypto.randomUUID(),
    epoch: epoch,
    vendor: vendor || session.vendor || "claude",
    providerRouteId: routeId || routeIdFor(session, switcher),
    model: model || session.model || "default",
    updatedAt: Date.now(),
  };
}

function fenceRefs(session) {
  return Object.freeze({
    executionId: "coop:" + String(session.storageId || session.cliSessionId || session.localId || "home"),
    incarnationId: session.coopIncarnation.incarnationId,
    epoch: session.coopIncarnation.epoch,
    role: "coordinator",
    authorityId: "canonical-coop",
  });
}

function createFence(session) {
  var refs = fenceRefs(session);
  function current() {
    var value = session.coopIncarnation;
    return !!(value && value.incarnationId === refs.incarnationId && value.epoch === refs.epoch);
  }
  function assertCurrent() {
    if (!current()) {
      var error = new Error("Stale canonical Coop incarnation rejected.");
      error.code = "COOP_CONTROL_FENCE_REJECTED";
      throw error;
    }
    return true;
  }
  return Object.freeze({
    refs: refs,
    abandon: function () { return false; },
    assert: function () { return assertCurrent(); },
    complete: function () { return assertCurrent(); },
    isCurrent: function () { return current(); },
    isIncarnationCurrent: function () { return current(); },
    markProviderStarted: function () { return assertCurrent(); },
  });
}

function attachRuntimeFence(session) {
  return executionFence.attachCoopFence(session, createFence(session));
}

function snapshot(session, sm) {
  return {
    session: {
      vendor: session.vendor,
      providerRouteId: session.providerRouteId,
      model: session.model,
      requestedModel: session.requestedModel,
      verifiedModel: session.verifiedModel,
      modelVerificationSource: session.modelVerificationSource,
      cliSessionId: session.cliSessionId,
      storageId: session.storageId,
      handoffContext: session.handoffContext,
      handoffContextTurnsRemaining: session.handoffContextTurnsRemaining,
      handoffContextRecovered: session.handoffContextRecovered,
      handoffContextConsumed: session.handoffContextConsumed,
      mode: session.mode,
      coopIncarnation: copy(session.coopIncarnation),
      historyLength: Array.isArray(session.history) ? session.history.length : 0,
    },
    currentModel: sm.currentModel,
  };
}

function restoreSnapshot(session, sm, before) {
  var state = before.session;
  var keys = Object.keys(state);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key === "historyLength") continue;
    if (state[key] === undefined) delete session[key];
    else session[key] = state[key];
  }
  if (Array.isArray(session.history)) session.history.splice(state.historyLength);
  sm.currentModel = before.currentModel;
  if (state.cliSessionId) tombstones.remove(state.cliSessionId);
  attachRuntimeFence(session);
  sm.saveSessionFile(session, { durable: true });
  sm.broadcastSessionList();
}

function isOwner(ctx, ws) {
  var check = ctx.isCoopTopicOwner || ctx.opts && ctx.opts.isCoopTopicOwner;
  return typeof check === "function" && check(ws) === true;
}

function isCanonical(session, slug) {
  return slug === "lead" && !!(session && session.coopHome);
}

function attachCoopIncarnationControl(ctx) {
  var sm = ctx.sm;
  var switcher = ctx.switcher;
  var idleDefer = createSessionIdleDefer({
    onReconciled: function () {
      if (sm && typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
    },
  });

  function ensure(session) {
    if (!isCanonical(session, ctx.slug)) return null;
    var current = normalizedIncarnation(session, switcher);
    if (!current) {
      current = createIncarnation(session, switcher, 1);
      session.coopIncarnation = current;
      sm.saveSessionFile(session, { durable: true });
    } else {
      session.coopIncarnation = current;
    }
    attachRuntimeFence(session);
    return current;
  }

  // A queued rotation can reply minutes after the request, by which time the
  // requesting socket may be gone. A dead socket must not turn a completed
  // rotation into an unhandled throw.
  function reply(ws, requestId, result) {
    try {
      ctx.sendTo(ws, Object.assign({
        type: "coop_incarnation_result",
        requestId: requestId == null ? null : String(requestId),
      }, result));
    } catch (error) {}
  }

  function targetFor(session, msg, action) {
    if (action === "restart") {
      var current = coopModelPolicy.currentSessionRoute(session);
      if (!current.ok) {
        current = coopModelPolicy.selectRoute(
          coopModelPolicy.purposeForSession(session));
      }
      return current.ok ? {
        vendor: current.vendor,
        routeId: current.providerRouteId,
        model: current.model,
      } : { policyDecision: current };
    }
    if (action === "model") {
      return {
        vendor: session.vendor || "claude",
        routeId: routeIdFor(session, switcher),
        model: String(msg.model || "").trim(),
      };
    }
    var route = switcher.resolveSwitchTargetRoute(msg.targetRouteId || msg.targetVendor, session);
    if (!route || route.vendor !== msg.targetVendor) return null;
    var suggestion = msg.targetModel ? { model: String(msg.targetModel) } :
      switcher.suggestionForRoute(route, session);
    return suggestion && suggestion.model ? {
      vendor: route.vendor,
      routeId: route.id,
      model: suggestion.model,
    } : null;
  }

  // route_unavailable covers two very different causes. Naming which one it is
  // keeps the owner from seeing a bare "could not change model context" toast.
  function routeUnavailableMessage(session, msg, action) {
    if (action === "model") return "Select a model before switching Coop's model context.";
    var requested = msg.targetRouteId || msg.targetVendor || "that provider";
    var route = switcher.resolveSwitchTargetRoute(msg.targetRouteId || msg.targetVendor, session);
    if (!route) return "Clay has no available route for " + requested + ".";
    if (route.vendor !== msg.targetVendor) {
      return "The route for " + requested + " does not match that provider.";
    }
    return "No model is available on " + (route.label || route.vendor) + " for Coop to switch to.";
  }

  function switchOptions(ws, session, target, action) {
    return {
      session: session,
      targetVendor: target.vendor,
      targetRouteId: target.routeId,
      targetModel: target.model,
      trigger: "coop-" + action,
      initiatedBy: { source: "coop-controls",
        userId: ws && ws._clayUser && ws._clayUser.id || null },
      preserveQueuedMessages: true,
      preserveScheduledMessages: true,
      forceFresh: true,
      reuseCurrentTarget: action === "restart",
    };
  }

  function exactSwitchApplied(session, target, result) {
    return !!(result && result.ok && session.vendor === target.vendor &&
      session.providerRouteId === target.routeId &&
      coopModelPolicy.modelMatches({ model: target.model }, session.model));
  }

  function failedRotation(session, before, previousFence, error) {
    try { restoreSnapshot(session, sm, before); }
    catch (rollbackError) {
      session._coopExecutionFence = previousFence;
      return { ok: false, code: "rollback_failed",
        message: rollbackError.message || "Failed to restore Coop incarnation." };
    }
    var code = error && (error.code === coopModelPolicy.UNAVAILABLE_CODE ||
      error.code === coopModelPolicy.REQUIRED_CODE) ? error.code : "switch_failed";
    return { ok: false, code: code,
      message: error.message || "Failed to change Coop incarnation." };
  }

  function executeRotation(ws, session, target, action, current) {
    var before = snapshot(session, sm);
    var previousFence = session._coopExecutionFence;
    session.coopIncarnation = createIncarnation(session, switcher,
      current.epoch + 1, target.routeId, target.model, target.vendor);
    try {
      var result = switcher.executeProviderSwitch(
        switchOptions(ws, session, target, action));
      if (!exactSwitchApplied(session, target, result)) {
        var switchError = new Error(result && (result.message || result.reason) ||
          "route_postcondition_failed");
        switchError.code = result && result.code || null;
        throw switchError;
      }
      attachRuntimeFence(session);
      sm.saveSessionFile(session, { durable: true });
      sm.broadcastSessionList();
      ctx.sendConfigForSession(ws, session);
      return {
        ok: true,
        action: action,
        incarnation: copy(session.coopIncarnation),
        sessionStorageId: session.storageId || session.cliSessionId || null,
      };
    } catch (error) {
      return failedRotation(session, before, previousFence, error);
    }
  }

  // Re-resolve the target and the current incarnation at APPLY time, not at
  // request time. A queued rotation must act on the session as it is when it
  // actually runs: the epoch it increments and the route it reuses can both
  // have moved while the turn it waited for was still streaming.
  function applyRotation(ws, session, msg, action) {
    var current = ensure(session);
    if (!current) {
      reply(ws, msg.requestId, { ok: false, code: "unavailable",
        message: "Coop's incarnation state is unavailable." });
      return;
    }
    var target = targetFor(session, msg, action);
    if (target && target.policyDecision) {
      reply(ws, msg.requestId, target.policyDecision);
      return;
    }
    if (!target || !target.model) {
      reply(ws, msg.requestId, { ok: false, code: "route_unavailable",
        message: routeUnavailableMessage(session, msg, action) });
      return;
    }
    reply(ws, msg.requestId, executeRotation(ws, session, target, action, current));
  }

  function queuedLabel(action) {
    if (action === "restart") return "Coop's model-context restart is queued";
    if (action === "model") return "Coop's model change is queued";
    return "Coop's provider change is queued";
  }

  // Queue the rotation for the end of the current turn instead of refusing it.
  // Refusing made the owner poll Coop by hand and re-issue the request, which
  // is exactly the loop this replaces. Only ONE rotation may be queued at a
  // time: two concurrent epoch bumps against the same session would race on
  // the fence, and the second request is far more likely to be an impatient
  // repeat than a genuinely different intent.
  //
  // The pending marker is intentionally transient. If the daemon restarts, the
  // queued rotation is dropped along with the runtime fence it would have
  // replaced, which is the correct outcome rather than a lost durable write.
  function queueRotation(ws, session, msg, action) {
    if (session._coopIncarnationDeferred) {
      reply(ws, msg.requestId, { ok: false, code: "already_queued",
        message: "A Coop incarnation change is already queued for the end of this turn." });
      return;
    }
    session._coopIncarnationDeferred = true;
    if (sm && typeof sm.sendAndRecord === "function") {
      sm.sendAndRecord(session, { type: "info",
        text: queuedLabel(action) + " and will apply automatically when the current turn ends." });
    }
    idleDefer.whenIdle(session, DEFER_IDLE_WAIT_MS, function (outcome) {
      session._coopIncarnationDeferred = false;
      if (outcome === "idle") {
        applyRotation(ws, session, msg, action);
        return;
      }
      reply(ws, msg.requestId, outcome === "destroyed" ?
        { ok: false, code: "session_gone",
          message: "Coop's session ended before the queued change could run." } :
        { ok: false, code: "processing",
          message: "Coop's turn did not finish within 10 minutes, so the queued change was " +
            "not applied. Request it again." });
    });
  }

  function rotate(ws, session, msg, action) {
    var current = ensure(session);
    if (!current) return false;
    if (!isOwner(ctx, ws)) {
      reply(ws, msg.requestId, { ok: false, code: "access_denied",
        message: "Only Coop's owner can change its model context." });
      return true;
    }
    // Validate before queueing so an impossible target is still refused now
    // rather than after a ten-minute wait.
    var target = targetFor(session, msg, action);
    if (target && target.policyDecision) {
      reply(ws, msg.requestId, target.policyDecision);
      return true;
    }
    if (!target || !target.model) {
      reply(ws, msg.requestId, { ok: false, code: "route_unavailable",
        message: routeUnavailableMessage(session, msg, action) });
      return true;
    }
    if (session.isProcessing) {
      queueRotation(ws, session, msg, action);
      return true;
    }
    applyRotation(ws, session, msg, action);
    return true;
  }

  function handle(ws, msg) {
    var action = msg && msg.type === "coop_incarnation_restart" ? "restart" :
      (msg && msg.type === "set_model" ? "model" :
        (msg && (msg.type === "handoff_session" || msg.type === "set_vendor") ? "provider" : ""));
    if (!action) return false;
    var session = typeof msg.sessionId === "number" ? sm.sessions.get(msg.sessionId) :
      ctx.getSessionForWs(ws);
    if (!isCanonical(session, ctx.slug)) return false;
    if (msg.type === "set_vendor") msg = Object.assign({}, msg, {
      targetVendor: msg.vendor,
      targetRouteId: null,
    });
    return rotate(ws, session, msg, action);
  }

  if (sm.sessions && typeof sm.sessions.forEach === "function") {
    sm.sessions.forEach(function (session) { ensure(session); });
  }
  return { ensure: ensure, handleMessage: handle };
}

module.exports = {
  attachCoopIncarnationControl: attachCoopIncarnationControl,
  attachRuntimeFence: attachRuntimeFence,
  createFence: createFence,
};
