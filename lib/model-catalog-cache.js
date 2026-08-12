// Persisted last-known-good per-vendor model catalogs.
//
// The hardcoded speculative lists (claude-defaults.js CLAUDE_SPECULATIVE_MODELS,
// codex-models.js CODEX_FALLBACK_MODELS) are static guesses that go stale the
// moment a vendor ships a new model — which is how a just-released model can be
// missing from the picker until someone hand-edits those tables. This module
// records the real, authoritative model list every time live discovery
// (supportedModels()) returns one, and replays it when discovery is
// unavailable (startup race, offline, failed fetch). Precedence at the
// discovery seam becomes: live authoritative > last-known-good cache >
// hardcoded seed. The hardcoded lists survive only as the never-connected
// cold-start seed.
//
// Storage: ~/.clay/model-catalog.json (dev: model-catalog-dev.json), written
// atomically (tmp + rename). Override the path with CLAY_MODEL_CATALOG_PATH
// (used by tests). Corruption/absence is treated as "no cache", never an error.

var fs = require("fs");
var crypto = require("crypto");
var path = require("path");
var config = require("./config");

// Meta selectors ("default", "best", "auto") are routing aliases, not concrete
// models. A list containing only these (or empty) is NOT authoritative and must
// never be cached as last-known-good.
var META_VALUES = { "default": 1, "best": 1, "auto": 1 };

function catalogPath() {
  if (process.env.CLAY_MODEL_CATALOG_PATH) return process.env.CLAY_MODEL_CATALOG_PATH;
  return path.join(config.CONFIG_DIR, process.env.CLAY_DEV ? "model-catalog-dev.json" : "model-catalog.json");
}

function modelValue(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.model || model.id || model.name || "";
}

// A list is authoritative if it names at least one concrete model (a value that
// isn't a meta selector). Empty lists and meta-only lists are rejected so a
// stale guess never gets recorded as last-known-good.
function isAuthoritative(models) {
  if (!Array.isArray(models) || models.length === 0) return false;
  for (var i = 0; i < models.length; i++) {
    var v = modelValue(models[i]);
    if (v && !META_VALUES[v]) return true;
  }
  return false;
}

function readAll() {
  try {
    var parsed = JSON.parse(fs.readFileSync(catalogPath(), "utf8"));
    if (parsed && typeof parsed === "object") {
      if (!parsed.vendors || typeof parsed.vendors !== "object") parsed.vendors = {};
      if (!parsed.capabilities || typeof parsed.capabilities !== "object") parsed.capabilities = {};
      return parsed;
    }
  } catch (e) {}
  return { version: 3, vendors: {}, capabilities: {} };
}

function writeAll(all) {
  try {
    var p = catalogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    all.version = 3;
    var tmp = p + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, p);
    config.chmodSafe(p, 0o600);
    return true;
  } catch (e) {
    return false;
  }
}

// Cached last-known-good catalog for a vendor, including discovery provenance.
// Legacy files have no provenance; consumers must handle them conservatively.
function cachedCatalog(vendor) {
  if (!vendor) return null;
  var entry = readAll().vendors[vendor];
  if (entry && Array.isArray(entry.models) && entry.models.length) {
    return {
      models: entry.models.slice(),
      provenance: entry.provenance || null,
      savedAt: entry.savedAt || null,
    };
  }
  return null;
}

// Cached last-known-good model list for a vendor, or null when none recorded.
function cachedModels(vendor) {
  var catalog = cachedCatalog(vendor);
  return catalog ? catalog.models : null;
}

// Persist a vendor's authoritative model list as last-known-good. No-op
// (returns false) for empty or meta-only lists so a stale guess never
// overwrites a good cache. Never throws — a persistence failure must not break
// model discovery.
function rememberModels(vendor, models) {
  if (!vendor || !isAuthoritative(models)) return false;
  var all = readAll();
  all.vendors[vendor] = {
    models: models,
    provenance: "live-discovery",
    savedAt: new Date().toISOString(),
  };
  return writeAll(all);
}

function normalizedCapabilityContext(context) {
  context = context || {};
  return {
    accountKey: String(context.accountKey || "unknown-account"),
    routeId: String(context.routeId || "unknown-route"),
    sdkVersion: String(context.sdkVersion || "unknown-sdk"),
    backendVersion: String(context.backendVersion || "unknown-backend"),
    model: String(context.model || ""),
  };
}

// Capability evidence is deliberately scoped more narrowly than vendor health.
// A successful explicit-ID probe on one account, route, or backend version says
// nothing about another. Persist only a digest as the key; account credentials
// and other identifying material must never reach the catalog file.
function capabilityKey(context) {
  var normalized = normalizedCapabilityContext(context);
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function cachedCapability(context) {
  var entry = readAll().capabilities[capabilityKey(context)];
  if (!entry || typeof entry.available !== "boolean") return null;
  return Object.assign({}, entry);
}

// Record an exact-route probe. Transient quota, rate, timeout, and transport
// failures are attempts, not capability evidence: they may annotate a prior
// definitive verdict but never erase it. This keeps a proven model selectable
// while the route's separate health state cools down and recovers.
function rememberCapability(context, evidence) {
  context = normalizedCapabilityContext(context);
  evidence = evidence || {};
  if (!context.model) return false;
  var all = readAll();
  var key = capabilityKey(context);
  var previous = all.capabilities[key];
  var now = new Date().toISOString();
  var attempt = {
    available: !!evidence.available,
    definitive: !!evidence.definitive,
    reason: evidence.reason || null,
    resolvedModel: evidence.resolvedModel || null,
    attemptedAt: now,
  };
  if (!attempt.definitive && previous && previous.definitive) {
    previous.lastAttempt = attempt;
    all.capabilities[key] = previous;
  } else {
    all.capabilities[key] = Object.assign({
      accountScope: crypto.createHash("sha256").update(context.accountKey).digest("hex"),
      routeId: context.routeId,
      sdkVersion: context.sdkVersion,
      backendVersion: context.backendVersion,
      model: context.model,
    }, attempt, {
      verifiedAt: attempt.definitive ? now : null,
    });
  }
  return writeAll(all);
}

// Resolve which model list to store in sm.modelsByVendor given a fresh
// discovery result. Live authoritative wins (and is cached for next time);
// otherwise fall back to the cached last-known-good; otherwise return the
// (empty/meta) discovery as-is so the caller applies its hardcoded seed. Never
// returns the hardcoded list itself — that stays the caller's responsibility.
function applyDiscovery(vendor, discoveredModels) {
  if (isAuthoritative(discoveredModels)) {
    rememberModels(vendor, discoveredModels);
    return discoveredModels;
  }
  var cached = cachedModels(vendor);
  if (cached && cached.length) return cached;
  return discoveredModels;
}

module.exports = {
  isAuthoritative: isAuthoritative,
  cachedCatalog: cachedCatalog,
  cachedModels: cachedModels,
  rememberModels: rememberModels,
  applyDiscovery: applyDiscovery,
  catalogPath: catalogPath,
  capabilityKey: capabilityKey,
  cachedCapability: cachedCapability,
  rememberCapability: rememberCapability,
};
