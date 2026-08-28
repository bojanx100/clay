// Compatibility repair for the Codex CLI's on-disk model catalog.
//
// Codex 0.147 added `supports_parallel_tool_calls` to each cached model. Older
// valid catalogs do not carry it, so newer app-server processes fail before
// they can refresh the cache. A missing capability must be interpreted as the
// conservative false value; this helper intentionally leaves malformed or
// unknown cache shapes to Codex's normal error handling.

var fs = require("fs");
var path = require("path");

function modelsCachePath(homeDir, env) {
  if (env && typeof env.CODEX_HOME === "string" && env.CODEX_HOME) {
    return path.join(env.CODEX_HOME, "models_cache.json");
  }
  if (!homeDir || typeof homeDir !== "string") return null;
  return path.join(homeDir, ".codex", "models_cache.json");
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function defaultMissingParallelToolSupport(cache) {
  if (!cache || typeof cache !== "object" || !Array.isArray(cache.models)) return 0;
  var defaulted = 0;
  for (var i = 0; i < cache.models.length; i++) {
    var model = cache.models[i];
    if (!model || typeof model !== "object" || Array.isArray(model) ||
        hasOwn(model, "supports_parallel_tool_calls")) continue;
    model.supports_parallel_tool_calls = false;
    defaulted++;
  }
  return defaulted;
}

function writeAtomically(cachePath, cache, mode) {
  var tempPath = cachePath + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2) + "\n", {
      encoding: "utf8",
      mode: mode || 0o600,
    });
    fs.renameSync(tempPath, cachePath);
    try { fs.chmodSync(cachePath, mode || 0o600); } catch (e) {}
    return null;
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (cleanupError) {}
    return error;
  }
}

// Return structured diagnostics instead of throwing so a cache compatibility
// miss cannot prevent Codex startup. `invalid` deliberately does not rewrite
// the file: preserving a malformed cache makes the real Codex parse failure
// observable instead of masking it as a cache reset.
function migrateModelsCache(cachePath) {
  if (!cachePath) return { migrated: false, defaulted: 0, reason: "no_path" };
  var source;
  var stat;
  try {
    source = fs.readFileSync(cachePath, "utf8");
    stat = fs.statSync(cachePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return { migrated: false, defaulted: 0, reason: "absent" };
    return { migrated: false, defaulted: 0, reason: "read_failed", error: error };
  }

  var cache;
  try {
    cache = JSON.parse(source);
  } catch (error) {
    return { migrated: false, defaulted: 0, reason: "invalid" };
  }

  var defaulted = defaultMissingParallelToolSupport(cache);
  if (defaulted === 0) return { migrated: false, defaulted: 0, reason: "current" };
  var error = writeAtomically(cachePath, cache, stat.mode & 0o777);
  if (error) return { migrated: false, defaulted: 0, reason: "write_failed", error: error };
  return { migrated: true, defaulted: defaulted, reason: "migrated" };
}

module.exports = {
  modelsCachePath: modelsCachePath,
  defaultMissingParallelToolSupport: defaultMissingParallelToolSupport,
  migrateModelsCache: migrateModelsCache,
};
