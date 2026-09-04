var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

// Redirect the catalog file into a per-run temp path so tests never touch
// ~/.clay. Set before requiring the module (module reads the env at call time).
var TMP = path.join(os.tmpdir(), "clay-model-catalog-test-" + process.pid);
process.env.CLAY_MODEL_CATALOG_PATH = path.join(TMP, "catalog.json");
var cache = require("../lib/model-catalog-cache");
var fallbackCodexModels = require("../lib/codex-models").fallbackCodexModels;

function reset() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

test("isAuthoritative rejects empty and meta-only lists, accepts concrete", function () {
  assert.strictEqual(cache.isAuthoritative([]), false);
  assert.strictEqual(cache.isAuthoritative(null), false);
  assert.strictEqual(cache.isAuthoritative(["default", "best"]), false);
  assert.strictEqual(cache.isAuthoritative([{ value: "auto" }]), false);
  assert.strictEqual(cache.isAuthoritative(["claude-opus-5"]), true);
  assert.strictEqual(cache.isAuthoritative([{ value: "gpt-5.6-sol" }]), true);
  // A meta selector alongside a concrete model is still authoritative.
  assert.strictEqual(cache.isAuthoritative(["default", "claude-opus-5"]), true);
});

test("rememberModels + cachedModels round-trip; other vendors stay null", function () {
  reset();
  var models = [{ value: "claude-opus-5" }, { value: "claude-fable-5" }];
  assert.strictEqual(cache.rememberModels("claude", models), true);
  assert.deepStrictEqual(cache.cachedModels("claude"), models);
  assert.strictEqual(cache.cachedCatalog("claude").provenance, "live-discovery");
  assert.strictEqual(cache.cachedModels("codex"), null);
  reset();
});

test("rememberModels refuses to overwrite a good cache with an empty/meta guess", function () {
  reset();
  var good = [{ value: "gpt-5.6-sol" }];
  cache.rememberModels("codex", good);
  assert.strictEqual(cache.rememberModels("codex", []), false);
  assert.strictEqual(cache.rememberModels("codex", ["auto"]), false);
  // Good cache is intact.
  assert.deepStrictEqual(cache.cachedModels("codex"), good);
  reset();
});

test("applyDiscovery precedence: live authoritative > cache > raw discovery", function () {
  reset();
  // Cold start, no cache: empty discovery returns as-is (caller applies seed).
  assert.deepStrictEqual(cache.applyDiscovery("claude", []), []);

  // Live authoritative wins and is persisted for next time.
  var live = ["claude-opus-5", "claude-fable-5"];
  assert.deepStrictEqual(cache.applyDiscovery("claude", live), live);
  assert.deepStrictEqual(cache.cachedModels("claude"), live);

  // Later discovery comes back empty (offline) -> last-known-good replayed.
  assert.deepStrictEqual(cache.applyDiscovery("claude", []), live);
  // Meta-only discovery also falls through to the cache.
  assert.deepStrictEqual(cache.applyDiscovery("claude", ["default"]), live);
  reset();
});

test("corrupt or absent catalog file is treated as no cache, never throws", function () {
  reset();
  assert.strictEqual(cache.cachedModels("claude"), null); // absent
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(process.env.CLAY_MODEL_CATALOG_PATH, "{ not valid json");
  assert.strictEqual(cache.cachedModels("claude"), null); // corrupt
  // A fresh authoritative write recovers cleanly over the corrupt file.
  assert.strictEqual(cache.rememberModels("claude", ["claude-opus-5"]), true);
  assert.deepStrictEqual(cache.cachedModels("claude"), ["claude-opus-5"]);
  reset();
});

test("multiple vendors coexist in one catalog file", function () {
  reset();
  cache.rememberModels("claude", ["claude-opus-5"]);
  cache.rememberModels("codex", [{ value: "gpt-5.6-sol" }]);
  assert.deepStrictEqual(cache.cachedModels("claude"), ["claude-opus-5"]);
  assert.deepStrictEqual(cache.cachedModels("codex"), [{ value: "gpt-5.6-sol" }]);
  reset();
});

test("capability evidence is scoped to account, route, versions, and model", function () {
  reset();
  var context = {
    accountKey: "account-a",
    routeId: "claude-anthropic",
    sdkVersion: "sdk-a",
    backendVersion: "backend-a",
    model: "claude-opus-5",
  };
  assert.strictEqual(cache.rememberCapability(context, {
    available: true,
    definitive: true,
    reason: "exact-probe-success",
    resolvedModel: "claude-opus-5",
  }), true);
  assert.strictEqual(cache.cachedCapability(context).available, true);
  assert.strictEqual(cache.cachedCapability(Object.assign({}, context, { accountKey: "account-b" })), null);
  assert.strictEqual(cache.cachedCapability(Object.assign({}, context, { routeId: "claude-other" })), null);
  assert.strictEqual(cache.cachedCapability(Object.assign({}, context, { sdkVersion: "sdk-b" })), null);
  assert.strictEqual(cache.cachedCapability(Object.assign({}, context, { backendVersion: "backend-b" })), null);
  assert.strictEqual(cache.cachedCapability(Object.assign({}, context, { model: "claude-opus-4-8" })), null);
  reset();
});

test("transient probe attempts preserve definitive capability evidence", function () {
  reset();
  var context = {
    accountKey: "account-a",
    routeId: "claude-anthropic",
    sdkVersion: "sdk-a",
    backendVersion: "backend-a",
    model: "claude-opus-5",
  };
  cache.rememberCapability(context, {
    available: true,
    definitive: true,
    reason: "exact-probe-success",
    resolvedModel: "claude-opus-5",
  });
  cache.rememberCapability(context, {
    available: false,
    definitive: false,
    reason: "rate-or-quota",
  });
  var stored = cache.cachedCapability(context);
  assert.strictEqual(stored.available, true);
  assert.strictEqual(stored.definitive, true);
  assert.strictEqual(stored.lastAttempt.reason, "rate-or-quota");
  reset();
});

// Regression: the Codex adapter substitutes its hardcoded seed table for a live
// catalog whenever `model/list` fails (lib/yoke/adapters/codex.js), and the
// substitution is invisible in the returned shape. Recording it as
// last-known-good silently drops every real model the seed does not name.
test("the Codex static seed is never recorded as last-known-good", function () {
  reset();
  var live = [
    { value: "gpt-5.6-sol" },
    { value: "gpt-5.7-preview" },
  ];
  assert.strictEqual(cache.rememberModels("codex", live), true);
  // Simulates codex.js falling back to fallbackCodexModels() after a failed
  // model/list. The seed is "authoritative" by shape, so nothing but explicit
  // seed detection stops it.
  assert.strictEqual(cache.rememberModels("codex", fallbackCodexModels()), false,
    "the seed must not overwrite a real live catalog");
  assert.deepStrictEqual(cache.cachedModels("codex"), live,
    "the newly released model must survive a failed model/list");
  reset();
});

test("applyDiscovery prefers a cached live catalog over the Codex seed", function () {
  reset();
  var live = [{ value: "gpt-5.6-sol" }, { value: "gpt-5.7-preview" }];
  cache.rememberModels("codex", live);
  assert.deepStrictEqual(cache.applyDiscovery("codex", fallbackCodexModels()), live,
    "a seed substitution must replay the last-known-good catalog instead");
  // With no cache at all the seed is still the honest cold-start answer.
  reset();
  assert.deepStrictEqual(
    cache.applyDiscovery("codex", fallbackCodexModels()).map(function (m) { return m.value; }),
    fallbackCodexModels().map(function (m) { return m.value; }),
    "cold start with no cache still yields the seed");
  reset();
});

test("a degraded-provenance list never overwrites a live-discovery catalog", function () {
  reset();
  cache.rememberModels("codex", [{ value: "gpt-5.7-preview" }]);
  assert.strictEqual(
    cache.rememberModels("codex", [{ value: "gpt-4-legacy" }], "fallback-seed"), false,
    "a caller that admits its list is degraded must not clobber proven live data");
  assert.deepStrictEqual(cache.cachedModels("codex"), [{ value: "gpt-5.7-preview" }]);
  // With no prior live catalog a degraded list is better than nothing, but it
  // must be stored with honest provenance so downstream guards can see it.
  reset();
  assert.strictEqual(
    cache.rememberModels("codex", [{ value: "gpt-4-legacy" }], "fallback-seed"), true);
  assert.strictEqual(cache.cachedCatalog("codex").provenance, "fallback-seed");
  reset();
});
