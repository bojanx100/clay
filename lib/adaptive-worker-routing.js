var { listProviderRoutes, routeForId } = require("./provider-routes");

var HARD_TASK_PATTERN = /\b(architecture|architectural|security|secure|vulnerability|exploit|threat model|cross[- ]cutting|race condition|deadlock|data loss|migration|root cause|complex refactor|difficult debugging|performance regression)\b/i;
var ROUTINE_TASK_PATTERN = /\b(copy|docs?|documentation|rename|format|lint|style|typo|small edit|mechanical|test coverage|add tests?|simple|routine)\b/i;

function modelValue(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.model || model.id || model.name || "";
}

function classifyTask(task) {
  var explicit = String(task && task.difficulty || "").toLowerCase();
  if (explicit === "strong" || explicit === "routine") {
    return { tier: explicit, reason: "Coordinator explicitly classified the task as " + explicit + "." };
  }
  var text = [
    task && task.title,
    task && task.objective,
    task && task.context,
    task && task.acceptanceCriteria,
  ].join(" ");
  if (HARD_TASK_PATTERN.test(text)) {
    return { tier: "strong", reason: "Task signals difficult reasoning, debugging, security, or architecture work." };
  }
  if (ROUTINE_TASK_PATTERN.test(text)) {
    return { tier: "routine", reason: "Task is bounded, routine, or mechanical work." };
  }
  return { tier: "routine", reason: "No high-complexity signals were found; start with an efficient worker." };
}

function modelScore(model, tier) {
  var value = String(model || "").toLowerCase();
  if (tier === "strong") {
    if (value.indexOf("sol") !== -1) return 120;
    if (value.indexOf("fable") !== -1) return 118;
    if (value.indexOf("opus") !== -1 || value === "best") return 115;
    if (value.indexOf("gpt-5.5") !== -1) return 108;
    if (value.indexOf("gpt-5.4") !== -1 && value.indexOf("mini") === -1) return 100;
    return 30;
  }
  if (value.indexOf("terra") !== -1) return 120;
  if (value.indexOf("sonnet") !== -1) return 118;
  if (value.indexOf("luna") !== -1) return 112;
  if (value.indexOf("mini") !== -1 || value.indexOf("spark") !== -1) return 110;
  if (value.indexOf("haiku") !== -1) return 108;
  if (value.indexOf("gpt-5.4") !== -1 || value.indexOf("gpt-5.5") !== -1) return 95;
  return 30;
}

function configuredRoutes(sm) {
  var installed = Array.isArray(sm.installedVendors) && sm.installedVendors.length
    ? sm.installedVendors
    : (sm.availableVendors || []);
  var routes = Array.isArray(sm.providerRoutes) && sm.providerRoutes.length
    ? sm.providerRoutes
    : listProviderRoutes(sm.availableVendors || [], installed);
  return routes.filter(function (route) {
    return route && route.enabled && route.health !== "unhealthy";
  });
}

function modelMatchesRoute(model, route) {
  var value = String(model || "").toLowerCase();
  if (route.modelFamily === "claude") return value.indexOf("claude-") === 0 || value === "best" || value === "default";
  if (route.modelFamily === "gpt") return value.indexOf("gpt-") === 0 || value.indexOf("codex") !== -1 || value === "auto";
  return true;
}

function modelsForRoute(sm, route) {
  var models = sm.modelsByVendor && sm.modelsByVendor[route.vendor];
  var result = [];
  if (Array.isArray(models)) {
    for (var i = 0; i < models.length; i++) {
      var value = modelValue(models[i]);
      if (value && modelMatchesRoute(value, route)) result.push(value);
    }
  }
  if (!result.length && route.defaultModel) result.push(route.defaultModel);
  return result;
}

function selectWorkerRoute(sm, parentSession, task) {
  var classification = classifyTask(task);
  var routes = configuredRoutes(sm);
  var best = null;
  for (var i = 0; i < routes.length; i++) {
    var route = routes[i];
    if (task.providerPinned && route.vendor !== task.provider && route.id !== task.provider) continue;
    var models = modelsForRoute(sm, route);
    for (var j = 0; j < models.length; j++) {
      if (task.modelPinned && models[j] !== task.model) continue;
      var score = modelScore(models[j], classification.tier);
      if (route.vendor === parentSession.vendor) score += 5;
      if (route.id === parentSession.providerRouteId) score += 2;
      var candidate = { route: route, model: models[j], score: score };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  if (!best) {
    var requestedRoute = task.providerRouteId && routeForId(task.providerRouteId);
    return {
      provider: task.provider || parentSession.vendor || sm.defaultVendor || "claude",
      providerRouteId: requestedRoute && requestedRoute.id || task.providerRouteId || parentSession.providerRouteId || null,
      model: task.model || parentSession.model || parentSession.requestedModel || null,
      tier: task.providerPinned || task.modelPinned ? "pinned" : classification.tier,
      rationale: task.providerPinned || task.modelPinned
        ? "Coordinator provider/model pin preserved, but it was not present in the available route catalog."
        : classification.reason + " No other configured route was available, so the coordinator route was retained.",
    };
  }
  return {
    provider: best.route.vendor,
    providerRouteId: best.route.id,
    model: best.model,
    tier: task.providerPinned || task.modelPinned ? "pinned" : classification.tier,
    rationale: (task.providerPinned || task.modelPinned
      ? "Coordinator provider/model pin constrained routing. "
      : classification.reason + " ") + "Selected " + best.model + " on " + best.route.label + ".",
  };
}

function prepareWorkerSession(sm, parentSession, task, storageId) {
  var decision = selectWorkerRoute(sm, parentSession, task);
  task.provider = decision.provider;
  task.providerRouteId = decision.providerRouteId;
  task.model = decision.model;
  task.routingTier = decision.tier;
  task.routingRationale = decision.rationale;
  return {
    storageId: storageId,
    ownerId: parentSession.ownerId || null,
    vendor: decision.provider || parentSession.vendor || sm.defaultVendor || "claude",
    providerRouteId: decision.providerRouteId || null,
    model: decision.model || parentSession.model || parentSession.requestedModel || null,
    permissionMode: parentSession.permissionMode || null,
    automationMode: parentSession.automationMode || null,
    codexApproval: parentSession.codexApproval || null,
    codexSandbox: parentSession.codexSandbox || null,
    codexWebSearch: parentSession.codexWebSearch || null,
    mode: "gui",
  };
}

module.exports = {
  classifyTask: classifyTask,
  prepareWorkerSession: prepareWorkerSession,
  selectWorkerRoute: selectWorkerRoute,
};
