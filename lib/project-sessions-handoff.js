var crypto = require("crypto");
var { withClaudeFallbackModels } = require("./claude-defaults");
var { buildHandoffContext } = require("./handoff-context");
var handoffPackage = require("./handoff-package");
var { listProviderRoutes, routeForId, routeForVendor, knownModelsForProvider, knownModelsForRoute } = require("./provider-routes");
var tombstones = require("./tombstones");
var yoke = require("./yoke");

function attachProjectSessionsHandoff(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var imagesDir = ctx.imagesDir || null;
  var adapters = ctx.adapters || {};
  var clayPort = ctx.clayPort || null;
  var clayTls = ctx.clayTls || false;
  var clayAuthToken = ctx.clayAuthToken || "";
  var sm = ctx.sm;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var usersModule = ctx.usersModule;
  var getSessionForWs = ctx.getSessionForWs;
  var cancelScheduledMessage = ctx.cancelScheduledMessage;
  var clearPendingQueuedMessages = ctx.clearPendingQueuedMessages;
  var sendConfigForSession = ctx.sendConfigForSession;

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

  function installedVendorList() {
    var installed = yoke.checkInstalled();
    var names = Object.keys(installed);
    var result = [];
    for (var i = 0; i < names.length; i++) {
      if (installed[names[i]]) result.push(names[i]);
    }
    return result;
  }

  function refreshVendorState(ws) {
    (async function () {
      yoke.invalidateAuthCache();
      var installed = installedVendorList();
      for (var i = 0; i < installed.length; i++) {
        var vendor = installed[i];
        if (adapters[vendor]) continue;
        await yoke.lazyCreateAdapter(adapters, vendor, {
          cwd: cwd,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });
      }
      sm.availableVendors = Object.keys(adapters);
      sm.installedVendors = installed;
      sm.providerRoutes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
      var currentVendor = (getSessionForWs(ws) && getSessionForWs(ws).vendor) || sm.defaultVendor || "claude";
      var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[currentVendor]) || [];
      if (currentVendor === "claude") vendorModels = withClaudeFallbackModels(vendorModels);
      sendTo(ws, {
        type: "model_info",
        model: "",
        models: vendorModels,
        vendor: currentVendor,
        availableVendors: sm.availableVendors || [],
        installedVendors: sm.installedVendors || [],
        providerRoutes: sm.providerRoutes || [],
      });
      sendTo(ws, { type: "toast", level: "info", message: "Vendor status refreshed" });
    })().catch(function (e) {
      sendTo(ws, { type: "toast", level: "warn", message: "Vendor refresh failed", detail: e.message || String(e) });
    });
  }

  function handleHandoffMessage(ws, msg) {
    if (msg.type === "refresh_vendors") {
      refreshVendorState(ws);
      return true;
    }

    if (msg.type === "handoff_session") {
      var sourceSession = null;
      if (typeof msg.sessionId === "number") {
        sourceSession = sm.sessions.get(msg.sessionId);
        if (sourceSession && usersModule.isMultiUser() && ws._clayUser) {
          if (!usersModule.canAccessSession(ws._clayUser.id, sourceSession, { visibility: "public" })) return true;
        }
      } else {
        sourceSession = getSessionForWs(ws);
      }
      if (!sourceSession || !msg.targetVendor) return true;
      var fromVendor = sourceSession.vendor || "claude";
      var toVendor = msg.targetVendor;
      var requestedTargetModel = typeof msg.targetModel === "string" ? msg.targetModel : null;
      var targetRoute = routeForHandoffTarget(toVendor, sourceSession, msg.targetRouteId || null, requestedTargetModel);
      if (msg.targetRouteId && (!targetRoute || targetRoute.vendor !== toVendor)) {
        sendTo(ws, { type: "toast", level: "warn", message: "Provider route is not available" });
        return true;
      }
      if (fromVendor === toVendor && (!targetRoute || sourceSession.providerRouteId === targetRoute.id)) return true;
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
        sendTo(ws, { type: "toast", level: "warn", message: routeLabel + " is not available", detail: routeSetup });
        return true;
      }
      if (sourceSession.isProcessing) {
        sendTo(ws, { type: "toast", level: "warn", message: "Stop the current task before switching vendor" });
        return true;
      }
      if (sourceSession.scheduledMessage && typeof cancelScheduledMessage === "function") {
        cancelScheduledMessage(sourceSession);
      } else if (hasUnclosedScheduledMessage(sourceSession)) {
        sourceSession.rateLimitAutoContinuePending = false;
        sm.sendAndRecord(sourceSession, { type: "scheduled_message_cancelled" });
      }

      var targetModel = targetRoute ? modelForHandoff(sourceSession, targetRoute, requestedTargetModel) : null;

      // Ensure a stable storageId BEFORE building the package (it keys the
      // package directory).
      var previousCliSessionId = sourceSession.cliSessionId || null;
      var fromRouteId = sourceSession.providerRouteId || null;
      if (!sourceSession.storageId) {
        sourceSession.storageId = previousCliSessionId || ("handoff-" + crypto.randomUUID());
      }

      // Handoff package: the COMPLETE transcript + conversation images +
      // workspace state, written inside the project so the new vendor's agent
      // (sandboxed or not) can read them on demand. The inline context then
      // only needs the recent tail plus a pointer — instead of a 240KB
      // prepend that still lost images and old turns. Falls back to the full
      // inline transcript when the package write fails (e.g. read-only disk).
      var pkgInfo = handoffPackage.writeHandoffPackage({
        cwd: cwd,
        imagesDir: imagesDir,
        session: sourceSession,
        fromVendor: fromVendor,
        toVendor: toVendor,
        targetModel: targetModel,
      });
      var handoffTranscript = buildHandoffContext(sourceSession, {
        fromVendor: fromVendor,
        toVendor: toVendor,
        cwd: cwd,
        imagesDir: imagesDir,
        targetRouteLabel: targetRoute ? targetRoute.label : null,
        targetModel: targetModel,
        packageInfo: pkgInfo,
        maxChars: pkgInfo ? 60000 : undefined,
      });

      // Switch vendor in-place: reset the CLI session so the new vendor starts fresh,
      // keep display history, and stash the transcript for context injection on next send.
      sourceSession.vendor = toVendor;
      if (targetRoute) {
        sourceSession.providerRouteId = targetRoute.id;
        if (targetModel) {
          sourceSession.model = targetModel;
          sourceSession.requestedModel = targetModel;
          sourceSession.verifiedModel = null;
          sourceSession.modelVerificationSource = null;
          sm.currentModel = "";
        }
      }
      sourceSession.mode = "gui"; // Codex and future vendors are always GUI
      sourceSession.cliSessionId = null; // let the new vendor's adapter assign a fresh session ID
      if (handoffTranscript) {
        sourceSession.handoffContext = handoffTranscript;
        sourceSession.handoffContextTurnsRemaining = toVendor === "github-copilot" ? 1 : 4;
      }
      clearPendingQueuedMessages(sourceSession);
      sendToSession(sourceSession.localId, { type: "queued_user_messages_cleared" });
      if (previousCliSessionId) {
        try { tombstones.add(previousCliSessionId); } catch (e) {}
      }

      // Force-close any live query so its processQueryStream finally-block
      // nulls out session.queryInstance before the next send. Without this
      // the idle Claude process stays alive and pushMessage routes to it
      // instead of startQuery picking the new vendor's adapter.
      if (sourceSession.queryInstance && typeof sourceSession.queryInstance.close === "function") {
        try { sourceSession.queryInstance.close(); } catch (e) {}
      } else if (sourceSession.messageQueue && typeof sourceSession.messageQueue.end === "function") {
        try { sourceSession.messageQueue.end(); } catch (e) {}
      }
      sourceSession.queryInstance = null;
      sourceSession.messageQueue = null;

      // Record who/what triggered this handoff. Handoffs are manual-only (this
      // handler is the single producer of vendor_switched), so capturing the
      // source makes "I didn't switch this" diagnosable instead of a mystery.
      var handoffSource = typeof msg.source === "string" ? msg.source : "unknown";
      var handoffUserId = (ws && ws._clayUser && ws._clayUser.id) || null;
      console.log("[handoff] session " + sourceSession.localId + ": " + fromVendor +
        " -> " + toVendor + " (source=" + handoffSource + ", user=" + (handoffUserId || "n/a") + ")");
      var switchEntry = {
        type: "vendor_switched",
        fromVendor: fromVendor,
        toVendor: toVendor,
        fromRouteId: fromRouteId,
        targetRouteId: targetRoute ? targetRoute.id : null,
        targetRouteLabel: targetRoute ? targetRoute.label : null,
        targetModel: sourceSession.model || null,
        targetModels: modelsForRoute(targetRoute, toVendor),
        initiatedBy: { source: handoffSource, userId: handoffUserId },
        _ts: Date.now(),
      };
      sourceSession.history.push(switchEntry);
      sm.appendToSessionFile(sourceSession, switchEntry);
      sm.saveSessionFile(sourceSession);
      sm.broadcastSessionList();

      // Show a divider in the chat
      sendToSession(sourceSession.localId, switchEntry);
      sendConfigForSession(ws, sourceSession);
      sendTo(ws, { type: "toast", level: "info", message: "Switched to " + ((targetRoute && targetRoute.label) || toVendor) + " - context will be passed on your next message" });
      return true;
    }

    return false;
  }

  return {
    handleHandoffMessage: handleHandoffMessage,
    normalizeSessionRouteModel: normalizeSessionRouteModel,
    modelsForRoute: modelsForRoute,
    copilotRouteIdForModel: copilotRouteIdForModel,
  };
}

module.exports = { attachProjectSessionsHandoff: attachProjectSessionsHandoff };
