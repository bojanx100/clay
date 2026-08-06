var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var routes = require("../lib/provider-routes");
var { fallbackCodexModels } = require("../lib/codex-models");
var modelCatalogCache = require("../lib/model-catalog-cache");

test("a persisted cold-start Codex seed is not treated as a verified catalog", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-provider-routes-"));
  var cachePath = path.join(root, "model-catalog.json");
  var previousPath = process.env.CLAY_MODEL_CATALOG_PATH;
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    vendors: {
      codex: { models: fallbackCodexModels(), savedAt: new Date().toISOString() },
    },
  }));
  process.env.CLAY_MODEL_CATALOG_PATH = cachePath;
  try {
    var route = routes.routeForId("codex-openai");
    assert.deepStrictEqual(routes.verifiedCatalogForRoute(route), { models: [], source: null });
    var staleSeed = fallbackCodexModels();
    staleSeed[0].value = "gpt-older-static-seed";
    fs.writeFileSync(cachePath, JSON.stringify({
      version: 1,
      vendors: { codex: { models: staleSeed, savedAt: new Date().toISOString() } },
    }));
    assert.deepStrictEqual(routes.verifiedCatalogForRoute(route), { models: [], source: null },
      "an older static seed must not become verified after the fallback table changes");
    var live = routes.verifiedCatalogForRoute(route, {
      verifiedModelsByRoute: {
        "codex-openai": { models: fallbackCodexModels(), source: "live" },
      },
    });
    assert.strictEqual(live.models.length, fallbackCodexModels().length,
      "an explicit live route catalog remains authoritative");
  } finally {
    if (previousPath === undefined) delete process.env.CLAY_MODEL_CATALOG_PATH;
    else process.env.CLAY_MODEL_CATALOG_PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native Claude route merges only positive exact-probe evidence", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-provider-routes-probe-"));
  var cachePath = path.join(root, "model-catalog.json");
  var previousPath = process.env.CLAY_MODEL_CATALOG_PATH;
  process.env.CLAY_MODEL_CATALOG_PATH = cachePath;
  var context = {
    accountKey: "account-a",
    routeId: "claude-anthropic",
    sdkVersion: "sdk-a",
    backendVersion: "backend-a",
    model: "claude-opus-5",
  };
  var state = {
    verifiedModelsByRoute: {
      "claude-anthropic": { models: ["claude-opus-4.8"], source: "live" },
    },
    capabilityProbeContextByRoute: {
      "claude-anthropic": {
        accountKey: context.accountKey,
        sdkVersion: context.sdkVersion,
        backendVersion: context.backendVersion,
      },
    },
  };
  try {
    var route = routes.routeForId("claude-anthropic");
    assert.deepStrictEqual(routes.verifiedCatalogForRoute(route, state), {
      models: ["claude-opus-4.8"],
      source: "live",
    });
    modelCatalogCache.rememberCapability(context, {
      available: true,
      definitive: true,
      reason: "exact-probe-success",
      resolvedModel: "claude-opus-5",
    });
    assert.deepStrictEqual(routes.verifiedCatalogForRoute(route, state), {
      models: ["claude-opus-4.8", "claude-opus-5"],
      source: "live+exact-probe",
    });
    state.verifiedModelsByRoute["claude-anthropic"].models.push("claude-opus-5");
    assert.deepStrictEqual(routes.verifiedCatalogForRoute(route, state), {
      models: ["claude-opus-4.8", "claude-opus-5"],
      source: "live",
    }, "eventual native advertisement supersedes the special-case evidence path");
  } finally {
    if (previousPath === undefined) delete process.env.CLAY_MODEL_CATALOG_PATH;
    else process.env.CLAY_MODEL_CATALOG_PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
