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
