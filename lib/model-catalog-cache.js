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
    if (parsed && typeof parsed === "object" && parsed.vendors && typeof parsed.vendors === "object") return parsed;
  } catch (e) {}
  return { version: 1, vendors: {} };
}

// Cached last-known-good model list for a vendor, or null when none recorded.
function cachedModels(vendor) {
  if (!vendor) return null;
  var entry = readAll().vendors[vendor];
  if (entry && Array.isArray(entry.models) && entry.models.length) return entry.models.slice();
  return null;
}

// Persist a vendor's authoritative model list as last-known-good. No-op
// (returns false) for empty or meta-only lists so a stale guess never
// overwrites a good cache. Never throws — a persistence failure must not break
// model discovery.
function rememberModels(vendor, models) {
  if (!vendor || !isAuthoritative(models)) return false;
  try {
    var p = catalogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    var all = readAll();
    all.vendors[vendor] = { models: models, savedAt: new Date().toISOString() };
    var tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, p);
    config.chmodSafe(p, 0o600);
    return true;
  } catch (e) {
    return false;
  }
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
  cachedModels: cachedModels,
  rememberModels: rememberModels,
  applyDiscovery: applyDiscovery,
  catalogPath: catalogPath,
};
