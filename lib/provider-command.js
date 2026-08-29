var { capabilityComparison, modelCapabilityTier } = require("./model-capability");
var { listProviderRoutes, routeForId } = require("./provider-routes");

function attachProviderCommand(ctx) {
  var sm = ctx.sm;
  var sendTo = ctx.sendTo;
  var sendConfigForSession = ctx.sendConfigForSession;
  var executeProviderSwitch = ctx.executeProviderSwitch;
  var modelForHandoff = ctx.modelForHandoff;
  var modelMatchesRouteFamily = ctx.modelMatchesRouteFamily;
  var modelsForRoute = ctx.modelsForRoute;
  var resolveModelForVendor = ctx.resolveModelForVendor;
  var routeForHandoffTarget = ctx.routeForHandoffTarget;

  function modelEntryValue(model) {
    if (!model) return "";
    if (typeof model === "string") return model;
    return model.value || model.model || model.id || "";
  }

  function canonicalModelId(model) {
    return modelEntryValue(model).toLowerCase().replace(/[-._]/g, "");
  }

  function equivalentModel(sourceModel, targetModel) {
    var source = String(sourceModel || "").toLowerCase();
    var target = String(targetModel || "").toLowerCase();
    if (!source || !target) return false;
    if (canonicalModelId(source) === canonicalModelId(target)) return true;
    var sourceFable = source === "best" || source.indexOf("fable") !== -1;
    var targetFable = target === "best" || target.indexOf("fable") !== -1;
    return sourceFable && targetFable;
  }

  function activeModel(session) {
    if (!session) return "";
    if (session.vendor === "github-copilot") return session.verifiedModel || "";
    return session.verifiedModel || session.requestedModel || session.model || "";
  }

  function parseCommand(text) {
    if (typeof text !== "string") return null;
    var trimmed = text.trim();
    var match = trimmed.match(/^\/(switch|provider)(?:\s+(.*))?$/i);
    if (!match) return null;
    var target = String(match[2] || "").trim();
    return { command: match[1].toLowerCase(), list: !target, target: target || null };
  }

  function parseSwitchCommand(text) {
    var parsed = parseCommand(text);
    if (!parsed || parsed.command !== "switch") return null;
    return parsed.list ? { list: true } : { target: parsed.target };
  }

  function parseProviderCommand(text) {
    var parsed = parseCommand(text);
    if (!parsed || parsed.command !== "provider") return null;
    return parsed.list ? { list: true } : { target: parsed.target };
  }

  // `routeForId`/`routeForVendor`/`routeForHandoffTarget` all return raw clones
  // of the static ROUTES table, which carries no availability at all --
  // `available`, `installed` and `enabled` exist only on the decorated copies
  // `listProviderRoutes` builds. Every consumer of a resolved route reads
  // `route.enabled`, so an undecorated route reads `undefined`, which is falsy:
  // the switch-request tool answered "is not available on this machine" for
  // every target on every machine, and `/provider` reported "not installed" for
  // routes that were installed. Decorating here fixes all of them at once
  // without discarding route-specific fields the resolvers added.
  function decorateResolvedRoute(route) {
    if (!route || !route.id) return route;
    var decorated = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || [], sm);
    for (var i = 0; i < decorated.length; i++) {
      if (decorated[i].id !== route.id) continue;
      return Object.assign({}, route, {
        available: decorated[i].available,
        installed: decorated[i].installed,
        enabled: decorated[i].enabled,
        health: decorated[i].health,
        catalogVerified: decorated[i].catalogVerified,
        catalogSource: decorated[i].catalogSource,
      });
    }
    return route;
  }

  function resolveTargetRoute(token, session) {
    var target = String(token || "").trim().toLowerCase();
    if (!target) return null;
    var direct = routeForId(target);
    if (direct) return decorateResolvedRoute(direct);
    if (target === "claude" || target === "anthropic") return decorateResolvedRoute(routeForId("claude-anthropic"));
    if (target === "codex" || target === "openai") return decorateResolvedRoute(routeForId("codex-openai"));
    if (target === "copilot" || target === "github-copilot" || target === "github copilot") {
      return decorateResolvedRoute(routeForHandoffTarget("github-copilot", session, null, null));
    }
    var routes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || [], sm);
    for (var i = 0; i < routes.length; i++) {
      var label = String(routes[i].label || "").toLowerCase();
      if (label && label.indexOf(target) === 0) return decorateResolvedRoute(routeForId(routes[i].id));
    }
    return null;
  }

  function candidateModels(route, session) {
    var candidates = [];
    var seen = {};

    function add(model) {
      var value = modelEntryValue(model);
      var key = canonicalModelId(value);
      if (!value || value === "auto" || value === "default" || seen[key]) return;
      seen[key] = true;
      candidates.push(value);
    }

    add(modelForHandoff(session, route, null));
    var models = modelsForRoute(route, route.vendor) || [];
    for (var i = 0; i < models.length; i++) add(models[i]);
    return candidates;
  }

  // "default" and "auto" are sentinels, not models: they mean "whatever this
  // provider picks". They have no capability tier, so comparing them against a
  // target model always reported incomparable and the caller refused to switch.
  function isSentinelModel(model) {
    var value = String(model || "").trim().toLowerCase();
    return !value || value === "auto" || value === "default";
  }

  function suggestionForRoute(route, session) {
    var sourceModel = activeModel(session);
    if (!route) return { model: null, match: "unknown", sourceModel: sourceModel };
    // A session that pinned no concrete model has nothing to compare, so the
    // honest target is the route's own default rather than "no comparable
    // model". Without this, a session left on "default" could never switch
    // provider at all.
    if (isSentinelModel(sourceModel)) {
      var defaults = candidateModels(route, session);
      if (defaults.length > 0) {
        return { model: defaults[0], match: "default", sourceModel: sourceModel };
      }
      return { model: null, match: "unknown", sourceModel: sourceModel };
    }
    var exact = modelMatchesRouteFamily(sourceModel, route) ? resolveModelForVendor(route.vendor, sourceModel, route.provider) : null;
    if (exact && equivalentModel(sourceModel, exact)) {
      return { model: exact, match: "exact", sourceModel: sourceModel };
    }
    var candidates = candidateModels(route, session);
    var sourceTier = modelCapabilityTier(sourceModel);
    var best = null;
    var bestTier = null;
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (equivalentModel(sourceModel, candidate)) {
        return { model: candidate, match: "exact", sourceModel: sourceModel };
      }
      var comparison = capabilityComparison(sourceModel, candidate);
      if (!comparison.comparable) continue;
      if (best === null || comparison.targetTier < bestTier) {
        best = candidate;
        bestTier = comparison.targetTier;
      }
    }
    if (best) return { model: best, match: "comparable", sourceModel: sourceModel, sourceTier: sourceTier, targetTier: bestTier };
    return { model: null, match: sourceTier === null ? "unknown" : "none", sourceModel: sourceModel };
  }

  function targetStatus(route, session, smart) {
    var currentRouteId = session && session.providerRouteId;
    var currentVendor = (session && session.vendor) || "claude";
    var current = currentRouteId ? route.id === currentRouteId : route.vendor === currentVendor;
    var status = current ? "current" : (route.enabled ? "available" : "not installed");
    if (route.health && route.health !== "healthy") status += ", " + route.health;
    if (!smart || !route.enabled) return status;
    var suggestion = suggestionForRoute(route, session);
    if (suggestion.model) status += "; " + suggestion.model + " (" + suggestion.match + ")";
    else if (suggestion.match === "unknown") status += "; current model cannot be verified";
    else status += "; no comparable model";
    return status;
  }

  function targetsSummary(session, smart) {
    var routes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || [], sm);
    var lines = [];
    for (var i = 0; i < routes.length; i++) {
      lines.push("- " + routes[i].id + " (" + routes[i].label + ") — " + targetStatus(routes[i], session, smart));
    }
    var intro = smart
      ? "Switch provider without downgrading with /provider <target> (claude, codex, copilot, or a route id):"
      : "Switch provider with /switch <target> (claude, codex, copilot, or a route id):";
    return intro + "\n" + lines.join("\n");
  }

  function recordUnknown(session, parsed, smart) {
    sm.sendAndRecord(session, {
      type: "info",
      variant: "warning",
      text: "Unknown " + (smart ? "provider" : "switch") + " target \"" + parsed.target + "\".\n" + targetsSummary(session, smart),
    });
  }

  function recordNoComparable(session, route, suggestion) {
    var source = suggestion.sourceModel ? " for " + suggestion.sourceModel : "";
    var reason = suggestion.match === "unknown"
      ? "Clay cannot verify the current model, so it cannot choose a safe equivalent"
      : "No exact or comparable model" + source + " is available";
    sm.sendAndRecord(session, {
      type: "info",
      variant: "warning",
      text: reason + " on " + route.label + ". Use /switch " + route.id + " only if you intentionally accept that provider's default model.",
    });
  }

  function finishSwitch(ws, session, route, result, suggestion) {
    if (result.ok) {
      if (typeof sendConfigForSession === "function") sendConfigForSession(ws, session);
      if (typeof sendTo === "function") {
        var modelText = suggestion && suggestion.model ? " using " + suggestion.model + " (" + suggestion.match + ")" : "";
        sendTo(ws, { type: "toast", level: "info", message: "Switched to " + result.label + modelText + " - context will be passed on your next message" });
      }
    } else if (result.reason === "same-target") {
      sm.sendAndRecord(session, { type: "info", text: "Already on " + (route.label || route.vendor) + " — no switch needed." });
    } else if (result.message) {
      sm.sendAndRecord(session, { type: "info", variant: "warning", text: result.message + (result.detail ? " — " + result.detail : "") });
    }
  }

  function handleCommand(ws, session, text) {
    var parsed = parseCommand(text);
    if (!parsed) return false;
    if (!session) return true;
    var smart = parsed.command === "provider";
    if (parsed.list) {
      sm.sendAndRecord(session, { type: "info", text: targetsSummary(session, smart) });
      return true;
    }
    var route = resolveTargetRoute(parsed.target, session);
    if (!route) {
      recordUnknown(session, parsed, smart);
      return true;
    }
    var suggestion = smart ? suggestionForRoute(route, session) : null;
    if (smart && !suggestion.model) {
      recordNoComparable(session, route, suggestion);
      return true;
    }
    var result = executeProviderSwitch({
      session: session,
      targetVendor: route.vendor,
      targetRouteId: route.id,
      targetModel: suggestion ? suggestion.model : null,
      trigger: "manual",
      initiatedBy: { source: smart ? "provider-command" : "chat-command", userId: (ws && ws._clayUser && ws._clayUser.id) || null },
    });
    finishSwitch(ws, session, route, result, suggestion);
    return true;
  }

  return {
    handleCommand: handleCommand,
    parseProviderCommand: parseProviderCommand,
    parseSwitchCommand: parseSwitchCommand,
    resolveTargetRoute: resolveTargetRoute,
    suggestionForRoute: suggestionForRoute,
    targetsSummary: targetsSummary,
  };
}

module.exports = { attachProviderCommand: attachProviderCommand };
