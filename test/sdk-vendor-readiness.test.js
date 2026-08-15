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

  await readiness.refresh("codex", "owner-a");
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(initCalls, 2);
  assert.deepStrictEqual(sm.modelsByVendor.codex, [{ value: "gpt-refreshed" }]);
});
