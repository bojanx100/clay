var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var modelsCache = require("../lib/codex-models-cache");

function cacheFixture() {
  return {
    fetched_at: "2026-08-28T08:00:00Z",
    client_version: "0.146.0",
    models: [
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra" },
      { slug: "gpt-5.6-sol", supports_parallel_tool_calls: true },
    ],
  };
}

function createCachePath(t) {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-model-cache-"));
  t.after(function() { fs.rmSync(temp, { recursive: true, force: true }); });
  return path.join(temp, "models_cache.json");
}

test("migrates a legacy Codex models cache without changing known capabilities", function(t) {
  var cachePath = createCachePath(t);
  fs.writeFileSync(cachePath, JSON.stringify(cacheFixture(), null, 2));

  var migration = modelsCache.migrateModelsCache(cachePath);
  var migrated = JSON.parse(fs.readFileSync(cachePath, "utf8"));

  assert.deepStrictEqual(migration, { migrated: true, defaulted: 1, reason: "migrated" });
  assert.strictEqual(migrated.client_version, "0.146.0");
  assert.strictEqual(migrated.models[0].supports_parallel_tool_calls, false);
  assert.strictEqual(migrated.models[1].supports_parallel_tool_calls, true);

  var secondMigration = modelsCache.migrateModelsCache(cachePath);
  assert.deepStrictEqual(secondMigration, { migrated: false, defaulted: 0, reason: "current" });
});

test("leaves malformed and unknown Codex model-cache shapes for Codex to report", function(t) {
  var cachePath = createCachePath(t);
  fs.writeFileSync(cachePath, "{ invalid json");
  assert.deepStrictEqual(modelsCache.migrateModelsCache(cachePath), {
    migrated: false,
    defaulted: 0,
    reason: "invalid",
  });

  fs.writeFileSync(cachePath, JSON.stringify({ version: 99, models: {} }));
  assert.deepStrictEqual(modelsCache.migrateModelsCache(cachePath), {
    migrated: false,
    defaulted: 0,
    reason: "current",
  });
});

test("uses the exact per-user Codex cache path", function() {
  assert.strictEqual(modelsCache.modelsCachePath("/tmp/codex-user"),
    path.join("/tmp/codex-user", ".codex", "models_cache.json"));
  assert.strictEqual(modelsCache.modelsCachePath(""), null);
  assert.strictEqual(modelsCache.modelsCachePath("/ignored", { CODEX_HOME: "/tmp/custom-codex" }),
    path.join("/tmp/custom-codex", "models_cache.json"));
});
