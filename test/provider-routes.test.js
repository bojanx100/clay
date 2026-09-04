var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
require("./helpers/isolated-clay-home");

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
    var liveLastKnownGood = [{ value: "gpt-5.6-sol" }];
    fs.writeFileSync(cachePath, JSON.stringify({
      version: 1,
      vendors: { codex: { models: liveLastKnownGood, savedAt: new Date().toISOString() } },
    }));
    assert.deepStrictEqual(routes.verifiedCatalogForRoute(route), {
      models: ["gpt-5.6-sol"],
      entries: [{ value: "gpt-5.6-sol" }],
      source: "last-known-good",
    }, "a value-only live catalog must remain verified across a cold start");
    var richLiveModels = fallbackCodexModels();
    for (var mi = 0; mi < richLiveModels.length; mi++) {
      richLiveModels[mi] = Object.assign({}, richLiveModels[mi], {
        id: richLiveModels[mi].value,
        model: richLiveModels[mi].value,
        hidden: false,
        isDefault: mi === 0,
      });
    }
    fs.writeFileSync(cachePath, JSON.stringify({
      version: 2,
      vendors: { codex: { models: richLiveModels, savedAt: new Date().toISOString() } },
    }));
    assert.strictEqual(routes.verifiedCatalogForRoute(route).models.length, richLiveModels.length,
      "a legacy rich live catalog remains verified even when its IDs match the fallback set");
    // RETRACTED: this previously asserted "explicit live-discovery provenance
    // supersedes fallback-set equality", i.e. that persisting the seed through
    // rememberModels() should overwrite the rich live catalog. That trust was
    // the defect: adapters/codex.js substitutes the seed on any failed
    // model/list, so the substitution could forge live-discovery provenance
    // and drop real models from the picker. rememberModels() now rejects the
    // seed by identity. The old assertion also could not fail -- richLiveModels
    // is derived from fallbackCodexModels(), so both sides were length 7 either
    // way -- so it is replaced with a discriminating check on the entries.
    assert.strictEqual(modelCatalogCache.rememberModels("codex", fallbackCodexModels()), false,
      "the static seed must never be recorded as a last-known-good catalog");
    var afterSeed = routes.verifiedCatalogForRoute(route);
    assert.strictEqual(afterSeed.models.length, richLiveModels.length,
      "the rich live catalog must survive a seed substitution");
    assert.ok(afterSeed.entries.every(function (entry) { return !!entry.id; }),
      "the surviving entries must be the rich live ones, not the seed");
    var unwarmed = routes.verifiedCatalogForRoute(route, {
      providerRoutes: [{
        id: "codex-openai",
        provider: "openai",
        modelFamily: "gpt",
        catalogVerified: true,
        catalogSource: "last-known-good",
      }],
      modelsByVendor: {},
    });
    assert.strictEqual(unwarmed.models.length, fallbackCodexModels().length,
      "an unwarmed runtime list must not shadow the verified cold-start catalog");
    assert.strictEqual(unwarmed.source, "last-known-good");
    var warmedFromLastKnownGood = routes.verifiedCatalogForRoute(route, {
      providerRoutes: [{
        id: "codex-openai",
        provider: "openai",
        modelFamily: "gpt",
        catalogVerified: true,
        catalogSource: "last-known-good",
      }],
      modelsByVendor: { codex: fallbackCodexModels() },
    });
    assert.strictEqual(warmedFromLastKnownGood.models.length, fallbackCodexModels().length,
      "a runtime copy must not discard durable live-discovery provenance");
    assert.strictEqual(warmedFromLastKnownGood.source, "last-known-good");
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
      entries: [{ value: "claude-opus-4.8" }, {
        value: "claude-opus-5",
        displayName: "Opus 5",
        description: "For complex tasks.",
      }],
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

test("verified catalogs preserve selectable and resolved model metadata", function () {
  var route = routes.routeForId("claude-anthropic");
  var catalog = routes.verifiedCatalogForRoute(route, {
    verifiedModelsByRoute: {
      "claude-anthropic": {
        models: [{
          value: "claude-fable-5[1m]",
          resolvedModel: "claude-fable-5",
          displayName: "Fable",
        }],
        source: "live",
      },
    },
  });

  assert.deepStrictEqual(catalog.models, ["claude-fable-5[1m]"]);
  assert.deepStrictEqual(catalog.entries, [{
    value: "claude-fable-5[1m]",
    resolvedModel: "claude-fable-5",
    displayName: "Fable",
  }]);
  assert.strictEqual(catalog.source, "live");
});
