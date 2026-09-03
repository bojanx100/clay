var test = require("node:test");
var assert = require("node:assert/strict");

var codexModels = require("../lib/codex-models");
var createCodexCoreAdapter = require("../lib/yoke/adapters/codex").createCodexCoreAdapter;

// The Codex adapter substitutes its hardcoded seed table for a live catalog
// whenever `model/list` fails or has not run yet. Downstream persists whatever
// it is handed as last-known-good (lib/sdk-bridge-vendor-readiness.js ->
// lib/model-catalog-cache.js), so the substitution has to be labelled honestly
// or a single failed discovery replaces a real catalog and drops every model
// the seed does not name.

test("resolveCodexCatalog labels a real discovery as live", function () {
  var live = [{ value: "gpt-5.6-sol" }, { value: "gpt-5.7-preview" }];
  var resolved = codexModels.resolveCodexCatalog(live);
  assert.equal(resolved.provenance, "live-discovery");
  assert.deepEqual(resolved.models, live, "a live list must be passed through untouched");
  assert.ok(resolved.defaultModel, "a default model must be chosen");
});

test("resolveCodexCatalog labels every no-discovery case as a seed substitution", function () {
  var seedValues = codexModels.fallbackCodexModels().map(function (m) { return m.value; });
  // A failed model/list yields [], a not-yet-run one yields null/undefined.
  var noDiscovery = [[], null, undefined];
  for (var i = 0; i < noDiscovery.length; i++) {
    var resolved = codexModels.resolveCodexCatalog(noDiscovery[i]);
    assert.equal(resolved.provenance, "fallback-seed",
      "input " + JSON.stringify(noDiscovery[i]) + " must be labelled a seed substitution");
    assert.deepEqual(resolved.models.map(function (m) { return m.value; }), seedValues,
      "the seed table must be what stands in");
  }
});

test("the seed substitution returns a copy, so a caller cannot mutate the seed table", function () {
  var first = codexModels.resolveCodexCatalog(null);
  first.models[0].value = "mutated-by-caller";
  var second = codexModels.resolveCodexCatalog(null);
  assert.notEqual(second.models[0].value, "mutated-by-caller",
    "the shared CODEX_FALLBACK_MODELS table must not be reachable through the result");
});

// Drives the REAL adapter, not a stub. Constructing it spawns no process and
// makes no network call, so the provenance wiring is observable directly. This
// is what stops the label and the substitution from drifting apart in a future
// refactor.
test("a freshly constructed Codex adapter reports its catalog as a seed, not live", function () {
  var adapter = createCodexCoreAdapter({ cwd: "/tmp/codex-provenance", slug: "provenance" });
  assert.equal(typeof adapter.modelsProvenance, "function",
    "the adapter must expose provenance for the supportedModels() path, which returns a bare array");
  assert.equal(adapter.modelsProvenance(), "fallback-seed",
    "before any live model/list, the adapter must not claim live discovery");
});

test("a freshly constructed Codex adapter still offers the seed as selectable models", function () {
  var adapter = createCodexCoreAdapter({ cwd: "/tmp/codex-provenance-2", slug: "provenance-2" });
  return adapter.supportedModels().then(function (models) {
    assert.ok(Array.isArray(models) && models.length > 0,
      "the seed must remain usable for cold start even though it is not authoritative");
    assert.deepEqual(models.map(function (m) { return m.value; }),
      codexModels.fallbackCodexModels().map(function (m) { return m.value; }));
  });
});
