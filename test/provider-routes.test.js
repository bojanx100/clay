var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var routes = require("../lib/provider-routes");
var { fallbackCodexModels } = require("../lib/codex-models");

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
