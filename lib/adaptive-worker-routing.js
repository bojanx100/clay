var { modelCapabilityTier } = require("./model-capability");
var {
  routeForId,
  verifiedCatalogForRoute,
  candidateHealth,
} = require("./provider-routes");
var reconcileProviderRoutes =
  require("./provider-route-readiness").reconcileProviderRoutes;
var routingPolicyModule = require("./provider-routing-policy");

var FRONTIER_TASK_PATTERN = /\b(architecture|architectural|security|secure|vulnerability|exploit|threat model|cross[- ]cutting|race condition|deadlock|data loss|migration|root cause|complex refactor|difficult debugging|performance regression|product strategy|design system)\b/i;
var STRONG_TASK_PATTERN = /\b(debug|investigat|refactor|review|audit|performance|integration|provider|routing|persistence|recovery|failover)\b/i;
var ROUTINE_TASK_PATTERN = /\b(copy|docs?|documentation|rename|format|lint|style|typo|small edit|mechanical|test coverage|add tests?|simple|routine)\b/i;

var PHASE_RULES = [
  { phase: "design", re: /\b(architect|design|strategy|trade[- ]?off|product decision|threat model)\b/i },
  { phase: "verification", re: /\b(review|audit|qa|verify|test|regression|benchmark)\b/i },
  { phase: "debugging", re: /\b(debug|root cause|investigat|crash|failure|broken|race condition|deadlock)\b/i },
  { phase: "documentation", re: /\b(docs?|documentation|readme|copy|comment|typo)\b/i },
];

var DEFAULT_PHASE_FLOORS = {
  design: 4,
  verification: 2,
  debugging: 3,
  documentation: 1,
  implementation: 2,
};

var DEFAULT_FRONTIER_ROUTE_ORDER = [
  "claude-anthropic",
  "claude-github-copilot",
  "codex-openai",
  "codex-github-copilot",
];

var DEFAULT_ROUTE_ORDER = [
  "codex-openai",
  "codex-github-copilot",
  "claude-anthropic",
  "claude-github-copilot",
];

function taskText(task) {
  return [
    task && task.title,
    task && task.objective,
    task && task.context,
    task && task.acceptanceCriteria,
  ].join(" ");
}

function phaseForTask(task, text) {
  var explicit = String(task && task.phase || "").toLowerCase();
  if (DEFAULT_PHASE_FLOORS[explicit]) return explicit;
  for (var i = 0; i < PHASE_RULES.length; i++) {
    if (PHASE_RULES[i].re.test(text)) return PHASE_RULES[i].phase;
  }
  return "implementation";
}

function clampedFloor(value, fallback) {
  var number = Number(value);
  if (!isFinite(number) || number < 1 || number > 4) return fallback;
  return Math.floor(number);
}

function explicitCapabilityFloor(task) {
  if (!task || !Object.prototype.hasOwnProperty.call(task, "capabilityFloor")) return null;
  return clampedFloor(task.capabilityFloor, null);
}

function routingPolicy(sm, task) {
  var base = sm && (sm.workerRoutingPolicy || sm.adaptiveRoutingPolicy) || {};
  var policy = Object.assign({}, base, task && task.routingOverrides || {});
  var requested = task && task.routingProfile || sm && sm.providerRoutingProfile || policy.profile;
  policy.profile = routingPolicyModule.normalizeRoutingProfile(requested);
  return policy;
}

function classifyTask(task, policy) {
  var explicit = String(task && task.difficulty || "").toLowerCase();
  var text = taskText(task);
  var phase = phaseForTask(task, text);
  var phaseFloors = Object.assign({}, DEFAULT_PHASE_FLOORS, policy && policy.phaseFloors || {});
  var hardCapabilityFloor = explicitCapabilityFloor(task);
  var floor = clampedFloor(task && task.capabilityFloor, clampedFloor(phaseFloors[phase], 2));
  var reason = "Task phase " + phase + " requires capability tier " + floor + ".";

  if (FRONTIER_TASK_PATTERN.test(text)) {
    floor = Math.max(floor, 4);
    reason = "Task signals difficult reasoning, debugging, security, or architecture work.";
  } else if (explicit === "strong" || STRONG_TASK_PATTERN.test(text)) {
    floor = Math.max(floor, 3);
    reason = explicit === "strong"
      ? "Coordinator explicitly classified the task as strong."
      : "Task signals strong debugging, review, integration, or recovery work.";
  } else if (explicit === "routine" || ROUTINE_TASK_PATTERN.test(text)) {
    floor = Math.min(floor, phase === "verification" ? 2 : 1);
    reason = explicit === "routine"
      ? "Coordinator explicitly classified the task as routine."
      : "Task is bounded, routine, or mechanical work.";
  }

  // Keep the durable orchestration tier vocabulary backward compatible;
  // routingCapabilityFloor carries the precise 1..4 policy decision.
  var tier = floor >= 3 ? "strong" : "routine";
  return {
    tier: tier,
    capabilityFloor: floor,
    hardCapabilityFloor: hardCapabilityFloor,
    phase: phase,
    reason: reason,
  };
}

function modelValue(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.model || model.id || model.name || "";
}

function approvedFrontierModel(model, policy) {
  var approved = policy && policy.approvedFrontierModels || ["claude-opus-5"];
  var value = String(model || "").toLowerCase();
  for (var i = 0; i < approved.length; i++) {
    if (value === String(approved[i] || "").toLowerCase()) return true;
  }
  return false;
}

function capabilityTier(model, policy) {
  if (approvedFrontierModel(model, policy)) return 4;
  return modelCapabilityTier(model);
}

function containsAny(value, needles) {
  for (var i = 0; i < needles.length; i++) {
    if (value.indexOf(needles[i]) !== -1) return true;
  }
  return false;
}

function modelCost(model, tier, policy) {
  var configured = policy && policy.modelCosts || {};
  if (typeof configured[model] === "number") return configured[model];
  var value = String(model || "").toLowerCase();
  if (containsAny(value, ["mini", "spark", "haiku"])) return 10;
  if (containsAny(value, ["luna", "sonnet", "gpt-5.4"])) return 20;
  if (containsAny(value, ["terra", "opus", "gpt-5.5"])) return 30;
  if (value.indexOf("sol") !== -1) return 40;
  if (value.indexOf("fable") !== -1) return 45;
  return 10 + (tier || 4) * 10;
}

function configuredRoutes(sm) {
  var routes = reconcileProviderRoutes(sm);
  return routes.filter(function (route) { return route && route.enabled; });
}

function pinnedRouteMatches(task, route) {
  if (task.providerRouteId && route.id !== task.providerRouteId) return false;
  if (!task.providerPinned) return true;
  return route.vendor === task.provider || route.id === task.provider;
}

function orderIndex(value, order) {
  var index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

function candidateModels(sm, route) {
  var catalog = verifiedCatalogForRoute(route, sm);
  return { models: catalog.models, entries: catalog.entries, source: catalog.source };
}

function catalogEntries(catalog) {
  if (Array.isArray(catalog.entries) && catalog.entries.length) return catalog.entries;
  return catalog.models || [];
}

function resolvedModelValue(entry) {
  if (!entry || typeof entry !== "object") return "";
  return typeof entry.resolvedModel === "string" ? entry.resolvedModel : "";
}

function exactEntry(entries, wanted, valueForEntry) {
  for (var i = 0; i < entries.length; i++) {
    if (valueForEntry(entries[i]) === wanted) return entries[i];
  }
  return null;
}

function resolvePinnedEntry(catalog, pin) {
  var entries = catalogEntries(catalog);
  var selectable = exactEntry(entries, pin, modelValue);
  if (selectable) return selectable;
  var resolved = exactEntry(entries, pin, resolvedModelValue);
  if (resolved) return resolved;
  if (pin !== "fable") return null;
  return exactEntry(entries, "claude-fable-5", modelValue) ||
    exactEntry(entries, "claude-fable-5", resolvedModelValue);
}

function defaultModelBonus(sm, route, model) {
  var defaults = sm.defaultModelsByVendor || {};
  if (defaults[route.vendor] === model) return -0.25;
  return 0;
}

function addDiagnosticRejection(diagnostics, reason) {
  if (diagnostics.rejections.indexOf(reason) === -1) diagnostics.rejections.push(reason);
}

function createDiagnostics(task, classification) {
  return {
    requestedModel: task.modelPinned ? task.model || null : null,
    selectedToken: null,
    catalogVerification: null,
    catalogSource: null,
    advertisement: null,
    health: null,
    capability: null,
    capabilityTier: null,
    hardCapabilityFloor: classification.hardCapabilityFloor,
    inferredCapabilityFloor: classification.capabilityFloor,
    matchingRouteCount: 0,
    verifiedCatalogCount: 0,
    unverifiedCatalogCount: 0,
    advertisedCount: 0,
    capabilityMismatchCount: 0,
    capabilityEligibleCount: 0,
    unhealthyEligibleCount: 0,
    healthStates: [],
    rejections: [],
  };
}

function noteDiagnosticHealth(diagnostics, state) {
  if (diagnostics.healthStates.indexOf(state) === -1) diagnostics.healthStates.push(state);
  if (state === "healthy" || diagnostics.health === null) diagnostics.health = state;
  else if (state === "degraded" && diagnostics.health === "unhealthy") diagnostics.health = state;
}

function finalizeDiagnostics(diagnostics, task) {
  if (diagnostics.verifiedCatalogCount > 0) diagnostics.catalogVerification = "verified";
  else if (diagnostics.unverifiedCatalogCount > 0) diagnostics.catalogVerification = "unverified";
  if (task.modelPinned) {
    if (diagnostics.advertisedCount > 0) diagnostics.advertisement = "advertised";
    else if (diagnostics.verifiedCatalogCount > 0) diagnostics.advertisement = "not_advertised";
  }
  if (diagnostics.capabilityEligibleCount > 0) diagnostics.capability = "eligible";
  else if (diagnostics.capabilityMismatchCount > 0) diagnostics.capability = "capability_mismatch";
  return diagnostics;
}

function candidateCapabilityFloor(task, classification) {
  if (task.modelPinned) return classification.hardCapabilityFloor;
  return classification.capabilityFloor;
}

function buildCandidates(sm, parentSession, task, classification, policy, diagnostics) {
  diagnostics = diagnostics || createDiagnostics(task, classification);
  var routes = configuredRoutes(sm);
  var routeOrder = policy.routeOrder || DEFAULT_ROUTE_ORDER;
  var frontierOrder = policy.frontierRouteOrder || DEFAULT_FRONTIER_ROUTE_ORDER;
  var candidates = [];
  for (var i = 0; i < routes.length; i++) {
    var route = routes[i];
    if (!pinnedRouteMatches(task, route)) continue;
    diagnostics.matchingRouteCount++;
    var catalog = candidateModels(sm, route);
    var entries = catalogEntries(catalog);
    if (!entries.length) {
      diagnostics.unverifiedCatalogCount++;
      addDiagnosticRejection(diagnostics, "unverified");
      continue;
    }
    diagnostics.verifiedCatalogCount++;
    if (!diagnostics.catalogSource) diagnostics.catalogSource = catalog.source;
    if (task.modelPinned) {
      var pinnedEntry = resolvePinnedEntry(catalog, task.model);
      if (!pinnedEntry) {
        addDiagnosticRejection(diagnostics, "not_advertised");
        continue;
      }
      diagnostics.advertisedCount++;
      entries = [pinnedEntry];
    }
    for (var j = 0; j < entries.length; j++) {
      var model = modelValue(entries[j]);
      if (!model) continue;
      var tier = capabilityTier(model, policy);
      if (tier === null && typeof route.defaultCapabilityTier === "number") {
        tier = route.defaultCapabilityTier;
      }
      var health = candidateHealth(route, model);
      var floor = candidateCapabilityFloor(task, classification);
      var capabilityEligible = tier !== null && (floor === null || tier >= floor);
      if (task.modelPinned && floor === null) capabilityEligible = true;
      if (task.modelPinned) {
        diagnostics.selectedToken = model;
        diagnostics.capabilityTier = tier;
      }
      noteDiagnosticHealth(diagnostics, health.state);
      if (!capabilityEligible) {
        diagnostics.capabilityMismatchCount++;
        addDiagnosticRejection(diagnostics, "capability_mismatch");
        continue;
      }
      diagnostics.capabilityEligibleCount++;
      if (health.state === "unhealthy") {
        diagnostics.unhealthyEligibleCount++;
        addDiagnosticRejection(diagnostics, "unhealthy");
        continue;
      }
      var routeCost = policy.routeCosts && Number(policy.routeCosts[route.id]) || 0;
      var cost = modelCost(model, tier, policy) + routeCost + defaultModelBonus(sm, route, model);
      var frontierRank = orderIndex(route.id, frontierOrder);
      var normalRank = orderIndex(route.id, routeOrder);
      candidates.push({
        route: route,
        model: model,
        capabilityTier: tier,
        health: health.state,
        catalogSource: catalog.source,
        cost: cost,
        freeAllowancePotential: !!route.freeAllowancePotential,
        routeRank: classification.capabilityFloor === 4 ? frontierRank : normalRank,
        order: i * 1000 + j,
      });
    }
  }
  candidates.sort(function (a, b) {
    if (classification.capabilityFloor === 4 && a.routeRank !== b.routeRank) return a.routeRank - b.routeRank;
    if (a.health !== b.health) return a.health === "healthy" ? -1 : 1;
    if (policy.profile === "free-endurance" &&
        a.freeAllowancePotential !== b.freeAllowancePotential) {
      return a.freeAllowancePotential ? -1 : 1;
    }
    if (policy.profile === "best-available" &&
        a.capabilityTier !== b.capabilityTier) {
      return b.capabilityTier - a.capabilityTier;
    }
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (a.capabilityTier !== b.capabilityTier) return a.capabilityTier - b.capabilityTier;
    if (a.routeRank !== b.routeRank) return a.routeRank - b.routeRank;
    return a.order - b.order;
  });
  finalizeDiagnostics(diagnostics, task);
  return candidates;
}

function unavailableDecision(sm, parentSession, task, classification, diagnostics) {
  var requestedRoute = task.providerRouteId && routeForId(task.providerRouteId);
  var detail = "No healthy candidate was present in an exact-route verified catalog.";
  var blockedReason = "no_healthy_candidate";
  if (diagnostics.verifiedCatalogCount === 0 && diagnostics.unverifiedCatalogCount > 0) {
    detail = "No enabled matching route has a verified model catalog.";
    blockedReason = "catalog_unverified";
  } else if (task.modelPinned && diagnostics.advertisedCount === 0) {
    detail = "Pinned model " + task.model +
      " is not advertised by an enabled exact-route verified catalog.";
    blockedReason = "model_not_advertised";
  } else if (diagnostics.capabilityEligibleCount === 0 &&
      diagnostics.capabilityMismatchCount > 0) {
    var requiredFloor = task.modelPinned ? diagnostics.hardCapabilityFloor :
      diagnostics.inferredCapabilityFloor;
    detail = task.modelPinned
      ? "Pinned model " + task.model + " resolves to advertised selectable token " +
        diagnostics.selectedToken + " at capability tier " + diagnostics.capabilityTier +
        ", below explicit capability floor " + requiredFloor + "."
      : "Advertised candidates do not satisfy capability floor " + requiredFloor + ".";
    blockedReason = "capability_mismatch";
  } else if (diagnostics.unhealthyEligibleCount > 0) {
    detail = task.modelPinned
      ? "Pinned model " + task.model + " resolves to advertised selectable token " +
        diagnostics.selectedToken + ", but that candidate is unhealthy."
      : "All capability-eligible advertised candidates are unhealthy.";
    blockedReason = "candidate_unhealthy";
  }
  return {
    provider: task.provider || parentSession.vendor || sm.defaultVendor || "claude",
    providerRouteId: requestedRoute && requestedRoute.id || task.providerRouteId || parentSession.providerRouteId || null,
    model: task.model || null,
    tier: task.providerPinned || task.modelPinned ? "pinned" : classification.tier,
    phase: classification.phase,
    capabilityFloor: classification.capabilityFloor,
    hardCapabilityFloor: classification.hardCapabilityFloor,
    blocked: true,
    blockedReason: blockedReason,
    diagnostics: diagnostics,
    rationale: classification.reason + " " + detail,
  };
}

function hasProviderInventory(sm) {
  return Array.isArray(sm.availableVendors) || Array.isArray(sm.providerRoutes) || !!sm.modelsByVendor;
}

function syntheticManagerDecision(sm, parentSession, task, classification) {
  return {
    provider: task.provider || parentSession.vendor || sm.defaultVendor || "claude",
    providerRouteId: task.providerRouteId || parentSession.providerRouteId || null,
    model: task.model || parentSession.model || parentSession.requestedModel || null,
    tier: task.providerPinned || task.modelPinned ? "pinned" : classification.tier,
    phase: classification.phase,
    capabilityFloor: classification.capabilityFloor,
    blocked: false,
    rationale: classification.reason + " Retained the coordinator route because this synthetic manager has no provider inventory.",
  };
}

function selectedDecision(best, candidates, task, classification, diagnostics) {
  var pinned = task.providerPinned || task.modelPinned;
  var pinReason = "Owner provider/model pin constrained routing. ";
  if (task.modelPinned && classification.hardCapabilityFloor === null) {
    pinReason += "No explicit hard capability floor was supplied, so the model pin remained eligible. ";
  }
  var rationale = (pinned ? pinReason : classification.reason + " ") +
    "Selected " + best.model + " on " + best.route.label +
    " from the " + best.catalogSource + " catalog using the " +
    (task.routingProfile || "configured") + " routing policy (capability " +
    best.capabilityTier + ", cost rank " + best.cost + ").";
  return {
    provider: best.route.vendor,
    providerRouteId: best.route.id,
    model: best.model,
    tier: pinned ? "pinned" : classification.tier,
    phase: classification.phase,
    capabilityFloor: classification.capabilityFloor,
    hardCapabilityFloor: classification.hardCapabilityFloor,
    capabilityTier: best.capabilityTier,
    costRank: best.cost,
    routingProfile: task.routingProfile || null,
    catalogSource: best.catalogSource,
    candidateCount: candidates.length,
    blocked: false,
    diagnostics: diagnostics,
    rationale: rationale,
  };
}

function selectWorkerRoute(sm, parentSession, task) {
  sm = sm || {};
  parentSession = parentSession || {};
  task = task || {};
  var policy = routingPolicy(sm, task);
  task.routingProfile = policy.profile;
  var classification = classifyTask(task, policy);
  // Unit-level orchestration harnesses created before provider inventory was
  // introduced have no vendor, route, or catalog fields at all. Production
  // project managers always expose availableVendors from session defaults, so
  // keep this narrow compatibility seam out of real routing decisions.
  if (!hasProviderInventory(sm)) return syntheticManagerDecision(sm, parentSession, task, classification);
  var diagnostics = createDiagnostics(task, classification);
  var candidates = buildCandidates(sm, parentSession, task, classification, policy, diagnostics);
  if (!candidates.length) return unavailableDecision(sm, parentSession, task, classification, diagnostics);
  return selectedDecision(candidates[0], candidates, task, classification, diagnostics);
}

function prepareWorkerSession(sm, parentSession, task, storageId) {
  var decision = selectWorkerRoute(sm, parentSession, task);
  task.routingTier = decision.tier;
  task.routingPhase = decision.phase;
  task.routingCapabilityFloor = decision.capabilityFloor;
  task.routingRationale = decision.rationale;
  task.routingBlocked = !!decision.blocked;
  task.routingBlockedReason = decision.blockedReason || null;
  task.routingDiagnostics = decision.diagnostics || null;
  if (decision.blocked) throw new Error(decision.rationale);
  task.provider = decision.provider;
  task.providerRouteId = decision.providerRouteId;
  task.model = decision.model;
  return {
    storageId: storageId,
    ownerId: parentSession.ownerId || null,
    vendor: decision.provider,
    providerRouteId: decision.providerRouteId,
    model: decision.model,
    permissionMode: parentSession.permissionMode || null,
    automationMode: parentSession.automationMode || null,
    codexApproval: parentSession.codexApproval || null,
    codexSandbox: parentSession.codexSandbox || null,
    codexWebSearch: parentSession.codexWebSearch || null,
    mode: "gui",
  };
}

module.exports = {
  ROUTING_PROFILES: routingPolicyModule.ROUTING_PROFILES,
  buildCandidates: buildCandidates,
  capabilityTier: capabilityTier,
  classifyTask: classifyTask,
  modelCost: modelCost,
  prepareWorkerSession: prepareWorkerSession,
  selectWorkerRoute: selectWorkerRoute,
};
