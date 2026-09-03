var test = require("node:test");
var assert = require("node:assert/strict");
require("./helpers/isolated-clay-home");

var attachVendorReadiness = require("../lib/sdk-bridge-vendor-readiness").attachVendorReadiness;

test("vendor readiness deduplicates initialization and owns refresh discovery", async function () {
  var initCalls = 0;
  var refreshCalls = 0;
  var adapter = {
    vendor: "codex",
    init: async function (opts) {
      initCalls++;
      return {
        models: [{ value: initCalls === 1 ? "gpt-first" : "gpt-refreshed" }],
        capabilities: { linuxUser: opts.linuxUser || null },
      };
    },
    refreshCredential: async function (opts) {
      refreshCalls++;
      assert.strictEqual(opts.linuxUser, "owner-a");
    },
  };
  var sm = { installedVendors: ["codex"] };
  var readiness = attachVendorReadiness({
    adapters: { codex: adapter },
    sm: sm,
    cwd: "/tmp/readiness",
    slug: "readiness",
  });

  var initial = await Promise.all([
    readiness.ensure("codex", "owner-a"),
    readiness.ensure("codex", "owner-a"),
  ]);

  assert.strictEqual(initial[0].adapter, adapter);
  assert.strictEqual(initCalls, 1);
  assert.deepStrictEqual(sm.modelsByVendor.codex, [{ value: "gpt-first" }]);
  assert.deepStrictEqual(sm.capabilitiesByVendor.codex, { linuxUser: "owner-a" });
  assert.strictEqual(sm.providerVerificationByVendor.codex.status, "ready");
  assert.strictEqual(sm.providerVerificationByVendor.codex.modelCount, 1);

  await readiness.refresh("codex", "owner-a");
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(initCalls, 2);
  assert.deepStrictEqual(sm.modelsByVendor.codex, [{ value: "gpt-refreshed" }]);
  assert.strictEqual(sm.providerVerificationByVendor.codex.status, "ready");
});

test("vendor readiness records a failed runtime handshake without claiming readiness", async function () {
  var sm = { installedVendors: ["qwen"] };
  var readiness = attachVendorReadiness({
    adapters: {
      qwen: {
        init: async function () { throw new Error("Authentication required; please log in"); },
      },
    },
    sm: sm,
    cwd: "/tmp/readiness-error",
    slug: "readiness-error",
  });

  await assert.rejects(readiness.ensure("qwen"), /Authentication required/);
  assert.strictEqual(sm.providerVerificationByVendor.qwen.status, "error");
  assert.match(sm.providerVerificationByVendor.qwen.error, /please log in/);
  assert.strictEqual(sm.providerVerificationByVendor.qwen.modelCount, 0);
});

// Regression: the Codex adapter reports its hardcoded seed table as `models`
// whenever `model/list` fails, indistinguishably from a live catalog. Readiness
// persists whatever it is handed as last-known-good and marks the route
// verified, so one failed discovery used to replace a real catalog -- dropping
// any model the seed does not name -- and forge live-discovery provenance,
// which also defeated the fail-closed seed check in provider-routes.js.
test("a seed substitution never overwrites a live Codex catalog or verifies the route", async function () {
  var modelCatalogCache = require("../lib/model-catalog-cache");
  var fallbackCodexModels = require("../lib/codex-models").fallbackCodexModels;

  var live = [{ value: "gpt-5.6-sol" }, { value: "gpt-5.7-preview" }];
  assert.strictEqual(modelCatalogCache.rememberModels("codex", live), true);

  // Adapter that failed model/list and is honestly reporting the substitution.
  var sm = { installedVendors: ["codex"] };
  var readiness = attachVendorReadiness({
    adapters: {
      codex: {
        vendor: "codex",
        init: async function () {
          return { models: fallbackCodexModels(), modelsProvenance: "fallback-seed", capabilities: {} };
        },
      },
    },
    sm: sm,
    cwd: "/tmp/readiness-seed",
    slug: "readiness-seed",
  });

  await readiness.ensure("codex");

  assert.deepStrictEqual(modelCatalogCache.cachedModels("codex"), live,
    "the persisted last-known-good catalog must be untouched by the seed");
  assert.deepStrictEqual(sm.modelsByVendor.codex, live,
    "the picker must replay the real catalog, not the seed");
  assert.strictEqual(modelCatalogCache.cachedCatalog("codex").provenance, "live-discovery",
    "provenance must still record real live discovery");
  assert.ok(!sm.verifiedModelsByRoute || !sm.verifiedModelsByRoute["codex-openai"],
    "a seed substitution must not mark the route catalog verified");
});
