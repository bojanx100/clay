// Canonical Coop model-context incarnation controls.
//
// Restart and route changes keep the permanent SessionRef and all durable
// owner/work state, but invalidate the previous runtime capability before the
// next provider turn. They never restart the Clay daemon.
var crypto = require("crypto");
var executionFence = require("./coop-control-fence");
var tombstones = require("./tombstones");

var VERSION = 1;

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

  function reply(ws, requestId, result) {
    ctx.sendTo(ws, Object.assign({
      type: "coop_incarnation_result",
      requestId: requestId == null ? null : String(requestId),
    }, result));
  }

  function targetFor(session, msg, action) {
    if (action === "restart") {
      return {
        vendor: session.vendor || "claude",
        routeId: routeIdFor(session, switcher),
        model: session.model || "default",
      };
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
      session.providerRouteId === target.routeId && session.model === target.model);
  }

  function failedRotation(session, before, previousFence, error) {
    try { restoreSnapshot(session, sm, before); }
    catch (rollbackError) {
      session._coopExecutionFence = previousFence;
      return { ok: false, code: "rollback_failed",
        message: rollbackError.message || "Failed to restore Coop incarnation." };
    }
    return { ok: false, code: "switch_failed",
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
        throw new Error(result && (result.message || result.reason) ||
          "route_postcondition_failed");
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

  function rotate(ws, session, msg, action) {
    var current = ensure(session);
    if (!current) return false;
    if (!isOwner(ctx, ws)) {
      reply(ws, msg.requestId, { ok: false, code: "access_denied" });
      return true;
    }
    if (session.isProcessing) {
      reply(ws, msg.requestId, { ok: false, code: "processing",
        message: "Wait for the current Coop turn to finish before changing its incarnation." });
      return true;
    }
    var target = targetFor(session, msg, action);
    if (!target || !target.model) {
      reply(ws, msg.requestId, { ok: false, code: "route_unavailable" });
      return true;
    }
    reply(ws, msg.requestId, executeRotation(ws, session, target, action, current));
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
