var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var modelsCache = require("../lib/codex-models-cache");
var CodexAppServer = require("../lib/yoke/codex-app-server").CodexAppServer;

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

function nativeModelFixture() {
  return {
    slug: "clay-cache-schema-probe",
    display_name: "Clay Cache Schema Probe",
    description: "Regression fixture for a version-matched legacy cache entry.",
    default_reasoning_level: "low",
    supported_reasoning_levels: [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    model_messages: {
      instructions_template: "fixture",
      instructions_variables: null,
      approvals: null,
      collaboration_modes: null,
      auto_review: null,
      permissions: null,
      multi_agent: null,
    },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10000 },
    supports_image_detail_original: false,
    context_window: 100000,
    max_context_window: 100000,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    tool_mode: null,
    multi_agent_version: null,
  };
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

test("the bundled Codex runtime reads the migrated fresh legacy cache entry", async function(t) {
  var cachePath = createCachePath(t);
  var cacheHome = path.dirname(cachePath);
  fs.writeFileSync(cachePath, JSON.stringify({
    fetched_at: new Date().toISOString(),
    etag: "clay-regression-fixture",
    client_version: "0.152.1",
    models: [nativeModelFixture()],
  }));
  assert.strictEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")).models[0].supports_parallel_tool_calls,
    undefined);
  assert.deepStrictEqual(modelsCache.migrateModelsCache(cachePath), {
    migrated: true,
    defaulted: 1,
    reason: "migrated",
  });

  var server = new CodexAppServer(null, {
    cwd: process.cwd(),
    env: { CODEX_HOME: cacheHome },
  });
  var stderr = "";
  t.after(function() { server.stop(); });

  await server.start();
  server.proc.stderr.on("data", function(chunk) { stderr += chunk.toString(); });
  await server.send("initialize", {
    clientInfo: { name: "clay-cache-regression", title: "Clay Cache Regression", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  }, 10000);
  server.notify("initialized", {});
  var result = await server.send("model/list", { includeHidden: false, limit: 100 }, 10000);

  assert.ok(result.data.some(function(model) { return model.id === "clay-cache-schema-probe"; }));
  assert.doesNotMatch(stderr, /missing field `supports_parallel_tool_calls`/);
});
