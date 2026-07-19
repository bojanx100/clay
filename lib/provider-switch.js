// Provider Switch — the single executor for cross-provider session switches.
//
// Extracted from project-sessions-handoff.js so every trigger path — the WS
// `handoff_session` message, the `/switch` chat command, and (later) the
// outage failover — runs the exact same code and produces the same persisted
// `vendor_switched` entry. Models and users may REQUEST a switch; only this
// executor PERFORMS one.
//
// The executor is transport-agnostic: it mutates session state, records the
// switch entry, and pushes it into the session's chat stream, then returns a
// structured { ok, reason, message, detail } result. Caller-specific feedback
// (toasts, config resends) stays with the caller.

var crypto = require("crypto");
var { withClaudeFallbackModels } = require("./claude-defaults");
var { buildHandoffContext } = require("./handoff-context");
var handoffPackage = require("./handoff-package");
var handoffStateModule = require("./handoff-state");
var { listProviderRoutes, routeForId, routeForVendor, knownModelsForProvider, knownModelsForRoute } = require("./provider-routes");
var tombstones = require("./tombstones");

function attachProviderSwitch(ctx) {
  var cwd = ctx.cwd;
  var imagesDir = ctx.imagesDir || null;
  var sm = ctx.sm;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var sendConfigForSession = ctx.sendConfigForSession;
  var cancelScheduledMessage = ctx.cancelScheduledMessage;
  var clearPendingQueuedMessages = ctx.clearPendingQueuedMessages;

  // --- Model/route resolution helpers (moved from project-sessions-handoff) ---

  function modelEntryValue(model) {
    if (!model) return "";
    if (typeof model === "string") return model;
    return model.value || model.model || model.id || "";
  }

  function canonicalModelId(model) {
    return modelEntryValue(model).toLowerCase().replace(/[-.]/g, "");
  }

  function resolveModelForVendor(vendor, model, provider) {
    if (!vendor || !model) return null;
    var models = (sm.modelsByVendor && sm.modelsByVendor[vendor]) || [];
    if (provider) {
      var knownModels = knownModelsForProvider(provider);
      if (knownModels.length > 0) {
        var combined = models.slice();
        var seen = {};
        for (var mi = 0; mi < combined.length; mi++) {
          seen[canonicalModelId(combined[mi])] = true;
        }
        for (var ki = 0; ki < knownModels.length; ki++) {
          var known = knownModels[ki];
          if (!seen[canonicalModelId(known)]) combined.push(known);
        }
        models = combined;
      }
    }
    if (vendor === "claude") models = withClaudeFallbackModels(models);
    var wanted = canonicalModelId(model);
    for (var i = 0; i < models.length; i++) {
      var value = modelEntryValue(models[i]);
      if (value === model || canonicalModelId(value) === wanted) return value;
    }
    return null;
  }

  function vendorHasModel(vendor, model, provider) {
    return !!resolveModelForVendor(vendor, model, provider);
  }

  function modelsForRoute(route, vendor) {
    var list = (sm.modelsByVendor && sm.modelsByVendor[vendor]) || [];
    if (route) {
      var known = vendor === "github-copilot" ? knownModelsForProvider(route.provider) : knownModelsForRoute(route);
      if (known.length > 0) list = known;
    }
    if (vendor === "claude") list = withClaudeFallbackModels(list);
    return list;
  }

  function modelMatchesRouteFamily(model, targetRoute) {
    if (!model || !targetRoute || !targetRoute.modelFamily) return true;
    if (model === "auto" || model === "default") return false;
    if (targetRoute.modelFamily === "claude") return model.indexOf("claude-") === 0;
    if (targetRoute.modelFamily === "gpt") return model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1;
    return true;
  }

  function familyForModel(model) {
    if (!model) return "";
    if (model.indexOf("claude-") === 0) return "claude";
    if (model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1) return "gpt";
    return "";
  }

  function familyForRouteId(routeId) {
    var route = routeId ? routeForId(routeId) : null;
    return route && route.modelFamily ? route.modelFamily : "";
  }

  function sourceModelForHandoff(sourceSession) {
    if (!sourceSession) return null;
    var sourceModel = sourceSession.verifiedModel || sourceSession.requestedModel || sourceSession.model || null;
    if (!sourceModel || sourceModel === "default") return null;
    var currentRoute = sourceSession.providerRouteId ? routeForId(sourceSession.providerRouteId) : null;
    if (currentRoute && !modelMatchesRouteFamily(sourceModel, currentRoute)) return null;
    return sourceModel;
  }

  function routeForHandoffTarget(toVendor, sourceSession, requestedRouteId, requestedModel) {
    if (requestedRouteId) return routeForId(requestedRouteId);
    if (toVendor !== "github-copilot") return routeForVendor(toVendor);
    var sourceModel = sourceModelForHandoff(sourceSession) || requestedModel || "";
    var family = familyForModel(sourceModel);
    if (!family) family = familyForRouteId((sourceSession && sourceSession.providerRouteId) || null);
    if (!family && sourceSession && sourceSession.vendor === "claude") family = "claude";
    if (!family && sourceSession && sourceSession.vendor === "codex") family = "gpt";
    if (family === "claude") return routeForId("claude-github-copilot");
    return routeForId("codex-github-copilot");
  }

  function copilotRouteIdForModel(model) {
    var family = familyForModel(model);
    if (family === "claude") return "claude-github-copilot";
    if (family === "gpt") return "codex-github-copilot";
    return null;
  }

  function familyDefaultVendor(targetRoute) {
    if (!targetRoute) return null;
    if (targetRoute.modelFamily === "gpt") return "codex";
    if (targetRoute.modelFamily === "claude") return "claude";
    return targetRoute.vendor;
  }

  function routeDefaultCandidates(targetRoute) {
    var candidates = [];
    if (!targetRoute) return candidates;
    var familyVendor = familyDefaultVendor(targetRoute);
    if (familyVendor && sm.serverDefaultModelsByVendor && sm.serverDefaultModelsByVendor[familyVendor]) candidates.push(sm.serverDefaultModelsByVendor[familyVendor]);
    if (sm.serverDefaultModelsByVendor && sm.serverDefaultModelsByVendor[targetRoute.vendor]) candidates.push(sm.serverDefaultModelsByVendor[targetRoute.vendor]);
    if (familyVendor && sm.defaultModelsByVendor && sm.defaultModelsByVendor[familyVendor]) candidates.push(sm.defaultModelsByVendor[familyVendor]);
    if (sm.defaultModelsByVendor && sm.defaultModelsByVendor[targetRoute.vendor]) candidates.push(sm.defaultModelsByVendor[targetRoute.vendor]);
    if (targetRoute.defaultModel) candidates.push(targetRoute.defaultModel);
    if (targetRoute.vendor === "claude") candidates.push("default");
    return candidates;
  }

  function defaultModelForRoute(targetRoute) {
    var candidates = routeDefaultCandidates(targetRoute);
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!candidate) continue;
      if (!modelMatchesRouteFamily(candidate, targetRoute)) continue;
      var resolved = resolveModelForVendor(targetRoute.vendor, candidate, targetRoute.provider);
      if (resolved) return resolved;
    }
    if (targetRoute && targetRoute.vendor === "claude") return "default";
    return null;
  }

  function modelForHandoff(sourceSession, targetRoute, requestedModel) {
    var preferredModel = requestedModel && requestedModel !== "default" ? requestedModel : null;
    if (preferredModel && targetRoute && modelMatchesRouteFamily(preferredModel, targetRoute)) {
      var resolvedPreferred = resolveModelForVendor(targetRoute.vendor, preferredModel, targetRoute.provider);
      if (resolvedPreferred) return resolvedPreferred;
    }
    var sourceModel = sourceModelForHandoff(sourceSession);
    var currentModel = sourceModel && sourceModel !== "default" ? sourceModel : null;
    if (currentModel && targetRoute && modelMatchesRouteFamily(currentModel, targetRoute)) {
      var resolvedCurrent = resolveModelForVendor(targetRoute.vendor, currentModel, targetRoute.provider);
      if (resolvedCurrent) return resolvedCurrent;
    }
    if (targetRoute) return defaultModelForRoute(targetRoute);
    return currentModel;
  }

  function normalizeSessionRouteModel(session) {
    if (!session || !session.providerRouteId) return;
    var route = routeForId(session.providerRouteId);
    if (!route) return;
    var defaultModel = defaultModelForRoute(route);
    if (!defaultModel) return;
    var model = session.model && session.model !== "default" ? session.model : null;
    if (model && modelMatchesRouteFamily(model, route) && vendorHasModel(route.vendor, model, route.provider)) return;
    session.model = defaultModel;
  }

  function hasUnclosedScheduledMessage(session) {
    if (!session || !Array.isArray(session.history)) return false;
    for (var i = session.history.length - 1; i >= 0; i--) {
      var item = session.history[i];
      if (!item) continue;
      if (item.type === "scheduled_message_sent" || item.type === "scheduled_message_cancelled" || item.type === "vendor_switched") return false;
      if (item.type === "scheduled_message_queued") return true;
    }
    return false;
  }

  // --- The switch executor ---

  // Execute a provider switch on `session`. params:
  //   session, targetVendor          - required
  //   targetRouteId, targetModel     - optional overrides
  //   trigger                        - "manual" (default) | "outage"
  //   initiatedBy                    - { source, userId }
  //   allowWhileProcessing           - internal: skip the isProcessing guard.
  //                                    Reserved for the outage failover path,
  //                                    which switches AFTER rolling back to a
  //                                    turn boundary. Nothing sets it yet.
  // Returns { ok, reason, message, detail, route, label }. Guards return
  // ok:false with a user-displayable message; how it is surfaced (toast vs
  // persisted info notice) is the caller's choice.
  function executeProviderSwitch(params) {
    var session = params && params.session;
    var toVendor = params && params.targetVendor;
    if (!session || !toVendor) return { ok: false, reason: "bad-params" };
    var fromVendor = session.vendor || "claude";
    var requestedTargetModel = typeof params.targetModel === "string" ? params.targetModel : null;
    var targetRoute = routeForHandoffTarget(toVendor, session, params.targetRouteId || null, requestedTargetModel);
    if (params.targetRouteId && (!targetRoute || targetRoute.vendor !== toVendor)) {
      return { ok: false, reason: "route-unavailable", message: "Provider route is not available" };
    }
    if (fromVendor === toVendor && (!targetRoute || session.providerRouteId === targetRoute.id)) {
      return { ok: false, reason: "same-target" };
    }
    var availableVendors = sm.availableVendors || [];
    if (availableVendors.indexOf(toVendor) === -1) {
      var routeLabel = toVendor;
      var routeSetup = "Clay does not have a runnable adapter for that provider yet.";
      var routes = sm.providerRoutes || listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
      for (var ri = 0; ri < routes.length; ri++) {
        if (routes[ri].vendor === toVendor) {
          routeLabel = routes[ri].label || routeLabel;
          routeSetup = routes[ri].setup || routeSetup;
          break;
        }
      }
      return { ok: false, reason: "vendor-unavailable", message: routeLabel + " is not available", detail: routeSetup };
    }
    if (session.isProcessing && !params.allowWhileProcessing) {
      return { ok: false, reason: "processing", message: "Stop the current task before switching vendor" };
    }
    if (session.scheduledMessage && typeof cancelScheduledMessage === "function") {
      cancelScheduledMessage(session);
    } else if (hasUnclosedScheduledMessage(session)) {
      session.rateLimitAutoContinuePending = false;
      sm.sendAndRecord(session, { type: "scheduled_message_cancelled" });
    }

    var targetModel = targetRoute ? modelForHandoff(session, targetRoute, requestedTargetModel) : null;

    // Ensure a stable storageId BEFORE building the package (it keys the
    // package directory).
    var previousCliSessionId = session.cliSessionId || null;
    var fromRouteId = session.providerRouteId || null;
    if (!session.storageId) {
      session.storageId = previousCliSessionId || ("handoff-" + crypto.randomUUID());
    }

    // Handoff package: the COMPLETE transcript + conversation images +
    // workspace state, written inside the project so the new vendor's agent
    // (sandboxed or not) can read them on demand. The inline context then
    // only needs the recent tail plus a pointer. Falls back to the full
    // inline transcript when the package write fails (e.g. read-only disk).
    // Situational state (git, tasks, plan docs, original goal) is collected
    // once and shared with both the package and the brief.
    var sharedHandoffState = handoffStateModule.collectHandoffState({
      cwd: cwd,
      history: session.history,
    });
    var pkgInfo = handoffPackage.writeHandoffPackage({
      cwd: cwd,
      imagesDir: imagesDir,
      session: session,
      fromVendor: fromVendor,
      toVendor: toVendor,
      targetModel: targetModel,
      handoffState: sharedHandoffState,
    });
    var handoffTranscript = buildHandoffContext(session, {
      fromVendor: fromVendor,
      toVendor: toVendor,
      cwd: cwd,
      imagesDir: imagesDir,
      targetRouteLabel: targetRoute ? targetRoute.label : null,
      targetModel: targetModel,
      packageInfo: pkgInfo,
      handoffState: sharedHandoffState,
      maxChars: pkgInfo ? 60000 : undefined,
    });

    // Switch vendor in-place: reset the CLI session so the new vendor starts fresh,
    // keep display history, and stash the transcript for context injection on next send.
    session.vendor = toVendor;
    if (targetRoute) {
      session.providerRouteId = targetRoute.id;
      if (targetModel) {
        session.model = targetModel;
        session.requestedModel = targetModel;
        session.verifiedModel = null;
        session.modelVerificationSource = null;
        sm.currentModel = "";
      }
    }
    session.mode = "gui"; // Codex and future vendors are always GUI
    session.cliSessionId = null; // let the new vendor's adapter assign a fresh session ID
    if (handoffTranscript) {
      session.handoffContext = handoffTranscript;
      session.handoffContextTurnsRemaining = toVendor === "github-copilot" ? 1 : 4;
    }
    clearPendingQueuedMessages(session);
    sendToSession(session.localId, { type: "queued_user_messages_cleared" });
    if (previousCliSessionId) {
      try { tombstones.add(previousCliSessionId); } catch (e) {}
    }

    // Force-close any live query so its processQueryStream finally-block
    // nulls out session.queryInstance before the next send. Without this
    // the idle Claude process stays alive and pushMessage routes to it
    // instead of startQuery picking the new vendor's adapter.
    if (session.queryInstance && typeof session.queryInstance.close === "function") {
      try { session.queryInstance.close(); } catch (e) {}
    } else if (session.messageQueue && typeof session.messageQueue.end === "function") {
      try { session.messageQueue.end(); } catch (e) {}
    }
    session.queryInstance = null;
    session.messageQueue = null;

    // Record who/what triggered this switch. This executor is the single
    // producer of vendor_switched — every trigger path (UI message, /switch
    // command, outage failover) routes through here, so `trigger` +
    // `initiatedBy` make "I didn't switch this" diagnosable.
    var trigger = params.trigger || "manual";
    var initiatedBy = params.initiatedBy || { source: "unknown", userId: null };
    console.log("[handoff] session " + session.localId + ": " + fromVendor +
      " -> " + toVendor + " (trigger=" + trigger + ", source=" + (initiatedBy.source || "unknown") +
      ", user=" + (initiatedBy.userId || "n/a") + ")");
    var switchEntry = {
      type: "vendor_switched",
      fromVendor: fromVendor,
      toVendor: toVendor,
      fromRouteId: fromRouteId,
      targetRouteId: targetRoute ? targetRoute.id : null,
      targetRouteLabel: targetRoute ? targetRoute.label : null,
      targetModel: session.model || null,
      targetModels: modelsForRoute(targetRoute, toVendor),
      trigger: trigger,
      tier: "brief", // Tier-1 context brief; a richer tier is a later slice
      initiatedBy: initiatedBy,
      _ts: Date.now(),
    };
    session.history.push(switchEntry);
    sm.appendToSessionFile(session, switchEntry);
    sm.saveSessionFile(session);
    sm.broadcastSessionList();

    // Show a divider in the chat
    sendToSession(session.localId, switchEntry);
    return {
      ok: true,
      reason: null,
      route: targetRoute,
      toVendor: toVendor,
      label: (targetRoute && targetRoute.label) || toVendor,
    };
  }

  // --- The /switch chat command ---

  // Detect a "/switch [target]" chat message. Returns null when the text is
  // not a switch command, { list: true } for a bare /switch, and
  // { target: "<rest>" } otherwise.
  function parseSwitchCommand(text) {
    if (typeof text !== "string") return null;
    var trimmed = text.trim();
    if (!/^\/switch(\s|$)/i.test(trimmed)) return null;
    var rest = trimmed.replace(/^\/switch\s*/i, "").trim();
    if (!rest) return { list: true };
    return { target: rest };
  }

  // Resolve a /switch target token to a provider route: exact route id,
  // vendor alias, or route-label prefix (case-insensitive).
  function resolveSwitchTargetRoute(token, session) {
    var t = String(token || "").trim().toLowerCase();
    if (!t) return null;
    var direct = routeForId(t);
    if (direct) return direct;
    if (t === "claude" || t === "anthropic") return routeForId("claude-anthropic");
    if (t === "codex" || t === "openai") return routeForId("codex-openai");
    if (t === "copilot" || t === "github-copilot" || t === "github copilot") {
      return routeForHandoffTarget("github-copilot", session, null, null);
    }
    var routes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
    for (var i = 0; i < routes.length; i++) {
      var label = String(routes[i].label || "").toLowerCase();
      if (label && label.indexOf(t) === 0) return routeForId(routes[i].id);
    }
    return null;
  }

  // Human-readable list of switch targets with availability + health, used by
  // the bare /switch command and unknown-target replies.
  function switchTargetsSummary(session) {
    var routes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
    var currentRouteId = (session && session.providerRouteId) || null;
    var currentVendor = (session && session.vendor) || "claude";
    var lines = [];
    for (var i = 0; i < routes.length; i++) {
      var route = routes[i];
      var isCurrent = currentRouteId ? route.id === currentRouteId : route.vendor === currentVendor;
      var status = isCurrent ? "current" : (route.enabled ? "available" : "not installed");
      if (route.health && route.health !== "healthy") status += ", " + route.health;
      lines.push("- " + route.id + " (" + route.label + ") — " + status);
    }
    return "Switch provider with /switch <target> (claude, codex, copilot, or a route id):\n" + lines.join("\n");
  }

  // Handle a "/switch ..." chat message end-to-end. Returns true when the
  // text was a switch command (the message must NOT be forwarded to the
  // model), false otherwise.
  function handleSwitchCommand(ws, session, text) {
    var parsed = parseSwitchCommand(text);
    if (!parsed) return false;
    if (!session) return true;
    if (parsed.list) {
      sm.sendAndRecord(session, { type: "info", text: switchTargetsSummary(session) });
      return true;
    }
    var route = resolveSwitchTargetRoute(parsed.target, session);
    if (!route) {
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: "Unknown switch target \"" + parsed.target + "\".\n" + switchTargetsSummary(session),
      });
      return true;
    }
    var result = executeProviderSwitch({
      session: session,
      targetVendor: route.vendor,
      targetRouteId: route.id,
      trigger: "manual",
      initiatedBy: { source: "chat-command", userId: (ws && ws._clayUser && ws._clayUser.id) || null },
    });
    if (result.ok) {
      if (typeof sendConfigForSession === "function") sendConfigForSession(ws, session);
      if (typeof sendTo === "function") {
        sendTo(ws, { type: "toast", level: "info", message: "Switched to " + result.label + " - context will be passed on your next message" });
      }
    } else if (result.reason === "same-target") {
      sm.sendAndRecord(session, { type: "info", text: "Already on " + (route.label || route.vendor) + " — no switch needed." });
    } else if (result.message) {
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: result.message + (result.detail ? " — " + result.detail : ""),
      });
    }
    return true;
  }

  return {
    executeProviderSwitch: executeProviderSwitch,
    parseSwitchCommand: parseSwitchCommand,
    resolveSwitchTargetRoute: resolveSwitchTargetRoute,
    switchTargetsSummary: switchTargetsSummary,
    handleSwitchCommand: handleSwitchCommand,
    routeForHandoffTarget: routeForHandoffTarget,
    modelForHandoff: modelForHandoff,
    modelsForRoute: modelsForRoute,
    normalizeSessionRouteModel: normalizeSessionRouteModel,
    copilotRouteIdForModel: copilotRouteIdForModel,
  };
}

module.exports = { attachProviderSwitch: attachProviderSwitch };
