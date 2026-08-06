var { modelCapabilityTier } = require("./model-capability");
var {
  listProviderRoutes,
  routeForId,
  verifiedCatalogForRoute,
  candidateHealth,
} = require("./provider-routes");

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

function routingPolicy(sm, task) {
  var base = sm && (sm.workerRoutingPolicy || sm.adaptiveRoutingPolicy) || {};
  return Object.assign({}, base, task && task.routingOverrides || {});
}

function classifyTask(task, policy) {
  var explicit = String(task && task.difficulty || "").toLowerCase();
  var text = taskText(task);
  var phase = phaseForTask(task, text);
  var phaseFloors = Object.assign({}, DEFAULT_PHASE_FLOORS, policy && policy.phaseFloors || {});
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
  return { tier: tier, capabilityFloor: floor, phase: phase, reason: reason };
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
  var installed = Array.isArray(sm.installedVendors) && sm.installedVendors.length
    ? sm.installedVendors
    : (sm.availableVendors || []);
  var routes = Array.isArray(sm.providerRoutes) && sm.providerRoutes.length
    ? sm.providerRoutes
    : listProviderRoutes(sm.availableVendors || [], installed);
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
  return { models: catalog.models, source: catalog.source };
}

function defaultModelBonus(sm, route, model) {
  var defaults = sm.defaultModelsByVendor || {};
  if (defaults[route.vendor] === model) return -0.25;
  return 0;
}

function buildCandidates(sm, parentSession, task, classification, policy) {
  var routes = configuredRoutes(sm);
  var routeOrder = policy.routeOrder || DEFAULT_ROUTE_ORDER;
  var frontierOrder = policy.frontierRouteOrder || DEFAULT_FRONTIER_ROUTE_ORDER;
  var candidates = [];
  for (var i = 0; i < routes.length; i++) {
    var route = routes[i];
    if (!pinnedRouteMatches(task, route)) continue;
    var catalog = candidateModels(sm, route);
    for (var j = 0; j < catalog.models.length; j++) {
      var model = modelValue(catalog.models[j]);
      if (!model || task.modelPinned && model !== task.model) continue;
      var tier = capabilityTier(model, policy);
      if (tier === null || tier < classification.capabilityFloor) continue;
      var health = candidateHealth(route, model);
      if (health.state === "unhealthy") continue;
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
        routeRank: classification.capabilityFloor === 4 ? frontierRank : normalRank,
        order: i * 1000 + j,
      });
    }
  }
  candidates.sort(function (a, b) {
    if (classification.capabilityFloor === 4 && a.routeRank !== b.routeRank) return a.routeRank - b.routeRank;
    if (a.health !== b.health) return a.health === "healthy" ? -1 : 1;
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (a.capabilityTier !== b.capabilityTier) return a.capabilityTier - b.capabilityTier;
    if (a.routeRank !== b.routeRank) return a.routeRank - b.routeRank;
    return a.order - b.order;
  });
  return candidates;
}

function unavailableDecision(sm, parentSession, task, classification) {
  var requestedRoute = task.providerRouteId && routeForId(task.providerRouteId);
  return {
    provider: task.provider || parentSession.vendor || sm.defaultVendor || "claude",
    providerRouteId: requestedRoute && requestedRoute.id || task.providerRouteId || parentSession.providerRouteId || null,
    model: task.model || null,
    tier: task.providerPinned || task.modelPinned ? "pinned" : classification.tier,
    phase: classification.phase,
    capabilityFloor: classification.capabilityFloor,
    blocked: true,
    rationale: classification.reason + " No healthy candidate was present in an exact-route verified catalog.",
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

function selectedDecision(best, candidates, task, classification) {
  var pinned = task.providerPinned || task.modelPinned;
  var rationale = (pinned ? "Owner provider/model pin constrained routing. " : classification.reason + " ") +
    "Selected " + best.model + " on " + best.route.label +
    " from the " + best.catalogSource + " catalog (capability " + best.capabilityTier +
    ", cost rank " + best.cost + ").";
  return {
    provider: best.route.vendor,
    providerRouteId: best.route.id,
    model: best.model,
    tier: pinned ? "pinned" : classification.tier,
    phase: classification.phase,
    capabilityFloor: classification.capabilityFloor,
    capabilityTier: best.capabilityTier,
    costRank: best.cost,
    catalogSource: best.catalogSource,
    candidateCount: candidates.length,
    blocked: false,
    rationale: rationale,
  };
}

function selectWorkerRoute(sm, parentSession, task) {
  sm = sm || {};
  parentSession = parentSession || {};
  task = task || {};
  var policy = routingPolicy(sm, task);
  var classification = classifyTask(task, policy);
  // Unit-level orchestration harnesses created before provider inventory was
  // introduced have no vendor, route, or catalog fields at all. Production
  // project managers always expose availableVendors from session defaults, so
  // keep this narrow compatibility seam out of real routing decisions.
  if (!hasProviderInventory(sm)) return syntheticManagerDecision(sm, parentSession, task, classification);
  var candidates = buildCandidates(sm, parentSession, task, classification, policy);
  if (!candidates.length) return unavailableDecision(sm, parentSession, task, classification);
  return selectedDecision(candidates[0], candidates, task, classification);
}

function prepareWorkerSession(sm, parentSession, task, storageId) {
  var decision = selectWorkerRoute(sm, parentSession, task);
  task.routingTier = decision.tier;
  task.routingPhase = decision.phase;
  task.routingCapabilityFloor = decision.capabilityFloor;
  task.routingRationale = decision.rationale;
  task.routingBlocked = !!decision.blocked;
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
  buildCandidates: buildCandidates,
  capabilityTier: capabilityTier,
  classifyTask: classifyTask,
  modelCost: modelCost,
  prepareWorkerSession: prepareWorkerSession,
  selectWorkerRoute: selectWorkerRoute,
};
