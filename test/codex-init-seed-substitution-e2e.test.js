var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

// Isolate ~/.clay (model catalog) before anything requires the cache module.
var isolatedHome = require("./helpers/isolated-clay-home");
// Isolate ~/.codex too: codex.js init() runs migrateModelsCache against the
// real per-user Codex cache path, which may WRITE. Point it at an empty temp
// dir so the migration finds nothing and never touches live state.
var isolatedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-test-codex-home-"));
process.env.CODEX_HOME = isolatedCodexHome;
process.on("exit", function () {
  try { fs.rmSync(isolatedCodexHome, { recursive: true, force: true }); } catch (e) {}
});

var APP_SERVER_PATH = require.resolve("../lib/yoke/codex-app-server");
var CODEX_ADAPTER_PATH = require.resolve("../lib/yoke/adapters/codex");

// codex.js destructures CodexAppServer at module load, so a fake installed in
// the require cache before it loads is the whole injection. This lets the REAL
// init() path run in-process -- spawning no codex binary, making no network
// call -- which is the only way to exercise the actual seed-substitution branch
// rather than a stubbed adapter.init() that returns models directly.
function withFakeAppServer(sendImpl, body) {
  var savedAppServer = require.cache[APP_SERVER_PATH];
  delete require.cache[CODEX_ADAPTER_PATH];

  function FakeCodexAppServer() {
    this.started = false;
  }
  FakeCodexAppServer.prototype.start = function () {
    this.started = true;
    return Promise.resolve();
  };
  FakeCodexAppServer.prototype.send = function (method, params, timeoutMs) {
    return sendImpl(method, params, timeoutMs);
  };
  FakeCodexAppServer.prototype.notify = function () {};
  FakeCodexAppServer.prototype.stop = function () { return Promise.resolve(); };
  FakeCodexAppServer.prototype.kill = function () {};

  require.cache[APP_SERVER_PATH] = {
    id: APP_SERVER_PATH,
    filename: APP_SERVER_PATH,
    loaded: true,
    exports: { CodexAppServer: FakeCodexAppServer },
  };

  var adapterModule = require(CODEX_ADAPTER_PATH);
  return Promise.resolve()
    .then(function () { return body(adapterModule); })
    .finally(function () {
      if (savedAppServer) require.cache[APP_SERVER_PATH] = savedAppServer;
      else delete require.cache[APP_SERVER_PATH];
      delete require.cache[CODEX_ADAPTER_PATH];
    });
}

function initAdapter(adapterModule, slug) {
  var adapter = adapterModule.createCodexCoreAdapter({ cwd: isolatedHome, slug: slug });
  return adapter.init({ cwd: isolatedHome, slug: slug }).then(function (ready) {
    return { adapter: adapter, ready: ready };
  });
}

// A real `model/list` failure is the trigger the whole fix exists for: the
// adapter substitutes its hardcoded seed, and if that substitution is reported
// as a live catalog, readiness persists it as last-known-good and drops every
// real model the seed does not name.
test("init() reports a seed substitution honestly when model/list fails", function () {
  return withFakeAppServer(function (method) {
    if (method === "model/list") return Promise.reject(new Error("model/list timed out"));
    return Promise.resolve({});
  }, function (adapterModule) {
    return initAdapter(adapterModule, "e2e-modellist-fails").then(function (r) {
      assert.equal(r.ready.modelsProvenance, "fallback-seed",
        "a failed model/list must be reported as a seed substitution, not live discovery");
      assert.equal(r.adapter.modelsProvenance(), "fallback-seed",
        "the accessor used by the supportedModels() path must agree");
      assert.ok(r.ready.models.length > 0, "the seed must still be offered so cold start works");
    });
  });
});

test("init() reports a real model/list result as live discovery", function () {
  var live = [
    { id: "gpt-5.6-sol", model: "gpt-5.6-sol" },
    { id: "gpt-5.7-preview", model: "gpt-5.7-preview" },
  ];
  return withFakeAppServer(function (method) {
    if (method === "model/list") return Promise.resolve({ data: live, nextCursor: null });
    return Promise.resolve({});
  }, function (adapterModule) {
    return initAdapter(adapterModule, "e2e-modellist-ok").then(function (r) {
      assert.equal(r.ready.modelsProvenance, "live-discovery",
        "a real model/list result must be reported as live discovery");
      var values = r.ready.models.map(function (m) { return m.value || m.id; });
      assert.ok(values.indexOf("gpt-5.7-preview") !== -1,
        "a model only the live catalog knows about must survive into the ready response");
    });
  });
});

// The full chain: real init() -> readiness -> persisted catalog cache. This is
// what proves a failed model/list cannot drop a real model from the picker.
test("a failed model/list cannot clobber a previously discovered live catalog", function () {
  var modelCatalogCache = require("../lib/model-catalog-cache");
  var attachVendorReadiness = require("../lib/sdk-bridge-vendor-readiness").attachVendorReadiness;

  var live = [{ value: "gpt-5.6-sol" }, { value: "gpt-5.7-preview" }];
  assert.equal(modelCatalogCache.rememberModels("codex", live), true,
    "seed the cache with a real live catalog");

  return withFakeAppServer(function (method) {
    if (method === "model/list") return Promise.reject(new Error("model/list timed out"));
    return Promise.resolve({});
  }, function (adapterModule) {
    var adapter = adapterModule.createCodexCoreAdapter({ cwd: isolatedHome, slug: "e2e-chain" });
    var sm = { installedVendors: ["codex"] };
    var readiness = attachVendorReadiness({
      adapters: { codex: adapter },
      sm: sm,
      cwd: isolatedHome,
      slug: "e2e-chain",
    });
    return readiness.ensure("codex").then(function () {
      assert.deepEqual(modelCatalogCache.cachedModels("codex"), live,
        "the real catalog must survive a failed model/list");
      assert.equal(modelCatalogCache.cachedCatalog("codex").provenance, "live-discovery",
        "provenance must still record genuine live discovery");
      assert.deepEqual(sm.modelsByVendor.codex, live,
        "the picker must replay the real catalog rather than the seed");
      assert.ok(!sm.verifiedModelsByRoute || !sm.verifiedModelsByRoute["codex-openai"],
        "a seed substitution must not mark the route catalog verified");
    });
  });
});
