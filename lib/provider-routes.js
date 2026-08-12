var ROUTES = [
  {
    id: "claude-anthropic",
    vendor: "claude",
    provider: "anthropic",
    modelFamily: "claude",
    label: "Claude via Anthropic",
    description: "Use your Claude subscription directly.",
    executable: true,
  },
  {
    id: "codex-openai",
    vendor: "codex",
    provider: "openai",
    modelFamily: "gpt",
    label: "Codex via OpenAI",
    description: "Use your ChatGPT/OpenAI Codex session.",
    executable: true,
    defaultModel: "gpt-5.5",
  },
  {
    id: "claude-github-copilot",
    vendor: "github-copilot",
    provider: "github-copilot",
    modelFamily: "claude",
    label: "Claude via GitHub Copilot",
    description: "Fallback route for Claude-family models through GitHub Copilot CLI.",
    executable: true,
    defaultModel: "claude-opus-4.8",
    setup: "GitHub Copilot CLI is not installed. Install it with npm install -g @github/copilot, then run copilot login.",
  },
  {
    id: "codex-github-copilot",
    vendor: "github-copilot",
    provider: "github-copilot",
    modelFamily: "gpt",
    label: "Codex via GitHub Copilot",
    description: "Fallback route for Codex/GPT coding models through GitHub Copilot CLI.",
    executable: true,
    defaultModel: "gpt-5.5",
    setup: "GitHub Copilot CLI is not installed. Install it with npm install -g @github/copilot, then run copilot login.",
  },
];

var PROVIDER_MODELS = {
  "github-copilot": [
    "auto",
    "claude-sonnet-4.6",
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4.8",
    "claude-opus-4.7",
    "claude-opus-4.6",
    "claude-opus-4.6-fast",
    "claude-opus-4.5",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.2",
    "gpt-5.4-mini",
    "gpt-5-mini",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
  ],
};

var providerHealth = require("./provider-health");
var modelCatalogCache = require("./model-catalog-cache");
var claudeModelProbe = require("./claude-model-probe");
var copilotEntitlements = require("./yoke/adapters/github-copilot-entitlements");

function cloneRoute(route) {
  return Object.assign({}, route);
}

function listProviderRoutes(availableVendors, installedVendors) {
  var available = availableVendors || [];
  var installed = installedVendors || [];
  var result = [];
  for (var i = 0; i < ROUTES.length; i++) {
    var route = cloneRoute(ROUTES[i]);
    route.available = route.executable && available.indexOf(route.vendor) !== -1;
    route.installed = route.executable ? installed.indexOf(route.vendor) !== -1 : false;
    route.enabled = !!(route.available && route.installed);
    // Route decoration intentionally ignores model-scoped quota failures. A
    // Fable rejection must not paint the entire native Claude route unhealthy;
    // candidate selection checks the exact route + model below.
    route.health = providerHealth.getRouteHealth(route.vendor, route.id, null).state;
    var catalog = verifiedCatalogForRoute(route);
    route.catalogVerified = catalog.models.length > 0;
    route.catalogSource = catalog.source;
    result.push(route);
  }
  return result;
}

function routeForVendor(vendor) {
  for (var i = 0; i < ROUTES.length; i++) {
    if (ROUTES[i].vendor === vendor && ROUTES[i].executable) return cloneRoute(ROUTES[i]);
  }
  return null;
}

function routeForId(id) {
  for (var i = 0; i < ROUTES.length; i++) {
    if (ROUTES[i].id === id) return cloneRoute(ROUTES[i]);
  }
  return null;
}

function knownModelsForProvider(provider) {
  if (provider === "github-copilot") {
    var snapshot = copilotEntitlements.currentCopilotEntitlements();
    if (snapshot && Array.isArray(snapshot.models) && snapshot.models.length > 0) return snapshot.models.slice();
  }
  var models = PROVIDER_MODELS[provider] || [];
  return models.slice();
}

function hasLiveModelsForProvider(provider) {
  return provider === "github-copilot" && copilotEntitlements.hasTrustedCopilotEntitlements();
}

function modelMatchesFamily(model, family) {
  if (!model || !family) return true;
  if (family === "claude") {
    return model.indexOf("claude-") === 0 || /^(fable|opus|sonnet|haiku)(?:\[|$)/.test(model);
  }
  if (family === "gpt") return model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1;
  return true;
}

function knownModelsForRoute(route) {
  if (!route || !route.provider) return [];
  var models = knownModelsForProvider(route.provider);
  if (!route.modelFamily) return models;
  var result = [];
  for (var i = 0; i < models.length; i++) {
    if (modelMatchesFamily(models[i], route.modelFamily)) result.push(models[i]);
  }
  return result;
}

function concreteModelCatalog(models, family) {
  var values = [];
  var entries = [];
  var seen = {};
  var hasMetadata = false;
  for (var i = 0; i < (models || []).length; i++) {
    var entry = models[i];
    var value = typeof entry === "string" ? entry : (entry && (entry.value || entry.model || entry.id || entry.name) || "");
    if (!value || value === "default" || value === "best" || value === "auto") continue;
    value = String(value);
    if (!modelMatchesFamily(value.toLowerCase(), family)) continue;
    if (seen[value]) continue;
    seen[value] = true;
    values.push(value);
    if (entry && typeof entry === "object") {
      hasMetadata = true;
      entries.push(Object.assign({}, entry, { value: value }));
    } else {
      entries.push({ value: value });
    }
  }
  var result = { models: values };
  if (hasMetadata) result.entries = entries;
  return result;
}

function concreteModels(models, family) {
  return concreteModelCatalog(models, family).models;
}

function catalogFromMap(map, routeId) {
  if (!map || !Object.prototype.hasOwnProperty.call(map, routeId)) return null;
  var entry = map[routeId];
  if (Array.isArray(entry)) return { models: entry, source: "live" };
  if (entry && entry.verified !== false && Array.isArray(entry.models)) {
    return { models: entry.models, source: entry.source || "live" };
  }
  return { models: [], source: null };
}

function catalogFromRuntimeRoutes(route, state) {
  var routes = Array.isArray(state.providerRoutes) ? state.providerRoutes : [];
  for (var ri = 0; ri < routes.length; ri++) {
    var matching = routes[ri] && routes[ri].id === route.id ? routes[ri] : null;
    var legacyInjected = matching && typeof matching.catalogVerified === "undefined" &&
      !matching.provider && !matching.modelFamily;
    if (matching && (matching.catalogVerified === true || legacyInjected)) {
      var liveModels = state.modelsByVendor && state.modelsByVendor[route.vendor] || [];
      // providerRoutes can be decorated from the durable catalog before a
      // browser connection warms modelsByVendor. An empty runtime list is no
      // route-specific evidence; fall through to the durable verified catalog
      // instead of shadowing it with an empty injected result.
      if (concreteModels(liveModels, route.modelFamily).length === 0) return null;
      return { models: liveModels, source: matching.catalogSource || "live" };
    }
  }
  return null;
}

function injectedCatalog(route, state) {
  if (!state || !route) return null;
  var direct = catalogFromMap(state.verifiedModelsByRoute, route.id);
  if (direct) return direct;
  var described = catalogFromMap(state.modelCatalogsByRoute, route.id);
  if (described) return described;
  return catalogFromRuntimeRoutes(route, state);
}

function looksLikeStaticCodexSeed(models) {
  if (!Array.isArray(models) || models.length === 0) return false;
  for (var i = 0; i < models.length; i++) {
    var entry = models[i];
    if (!entry || typeof entry !== "object" || !entry.value ||
        typeof entry.displayName !== "string" || typeof entry.description !== "string" ||
        !Array.isArray(entry.supportedEffortLevels) ||
        typeof entry.defaultReasoningEffort !== "string" || entry.id || entry.model ||
        Object.prototype.hasOwnProperty.call(entry, "hidden") ||
        Object.prototype.hasOwnProperty.call(entry, "isDefault")) return false;
  }
  return true;
}

function verifiedNativeCatalog(route, models, source, provenance) {
  // Codex exposes its static seed through supportedModels() before live
  // model/list discovery. Older startup code could persist that seed as an
  // LKG catalog, so recognize the exact seed and fail closed. A direct live
  // route catalog remains authoritative even if today's live list happens to
  // contain the same model IDs.
  if (route.vendor === "codex" && source === "last-known-good" &&
      provenance !== "live-discovery" && looksLikeStaticCodexSeed(models)) {
    return { models: [], source: null };
  }
  var catalog = concreteModelCatalog(models || [], route.modelFamily);
  catalog.source = models && models.length ? source : null;
  return catalog;
}

function withProbedClaudeCapability(route, catalog, state) {
  if (!route || route.id !== "claude-anthropic") return catalog;
  var probeContext = state && state.capabilityProbeContextByRoute &&
    state.capabilityProbeContextByRoute[route.id] || {};
  var deps = Object.assign({}, probeContext, { routeId: route.id, background: false });
  var extras = claudeModelProbe.extraClaudeModels(catalog.models, deps);
  if (!extras.length) return catalog;
  var combined = concreteModelCatalog(
    (catalog.entries || catalog.models).concat(extras), route.modelFamily);
  combined.source = catalog.source ? catalog.source + "+exact-probe" : "exact-probe";
  return combined;
}

// Return only catalog entries backed by exact-route evidence. Native adapter
// discovery writes the per-vendor last-known-good cache before publishing the
// runtime list, and each native vendor currently has one executable route.
// Copilot is split into two routes, so its trusted live catalog is filtered by
// route family. Static fallback lists are deliberately never returned here.
function verifiedCatalogForRoute(route, state) {
  if (!route) return { models: [], source: null };
  var injected = injectedCatalog(route, state);
  if (injected) {
    return withProbedClaudeCapability(route,
      verifiedNativeCatalog(route, injected.models, injected.source), state);
  }
  if (route.provider === "github-copilot") {
    if (!copilotEntitlements.hasTrustedCopilotEntitlements()) return { models: [], source: null };
    var snapshot = copilotEntitlements.currentCopilotEntitlements();
    var copilotCatalog = concreteModelCatalog(snapshot && snapshot.models || [], route.modelFamily);
    copilotCatalog.source = snapshot && snapshot.source || "live";
    return copilotCatalog;
  }
  var cached = modelCatalogCache.cachedCatalog(route.vendor);
  return withProbedClaudeCapability(route,
    verifiedNativeCatalog(route, cached && cached.models || [], "last-known-good",
      cached && cached.provenance || null), state);
}

function verifiedModelsForRoute(route, state) {
  return verifiedCatalogForRoute(route, state).models;
}

function candidateHealth(route, model, opts) {
  if (!route) return providerHealth.getHealth("claude");
  return providerHealth.getRouteHealth(route.vendor, route.id, model, opts);
}

module.exports = {
  listProviderRoutes: listProviderRoutes,
  routeForId: routeForId,
  routeForVendor: routeForVendor,
  hasLiveModelsForProvider: hasLiveModelsForProvider,
  knownModelsForProvider: knownModelsForProvider,
  knownModelsForRoute: knownModelsForRoute,
  verifiedCatalogForRoute: verifiedCatalogForRoute,
  verifiedModelsForRoute: verifiedModelsForRoute,
  candidateHealth: candidateHealth,
};
