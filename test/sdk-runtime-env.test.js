var test = require("node:test");
var assert = require("node:assert/strict");
var createSDKBridge = require("../lib/sdk-bridge").createSDKBridge;

test("environment refresh retires idle provider runtimes without interrupting active turns", async function () {
  var shutdownCalls = 0;
  var session = { queryInstance: { active: true } };
  var adapter = {
    vendor: "codex",
    shutdownIfIdle: function () { shutdownCalls++; return Promise.resolve(true); },
  };
  var bridge = createSDKBridge({
    cwd: process.cwd(),
    slug: "runtime-env-test",
    sessionManager: {
      sessions: new Map([[1, session]]),
      modelsByVendor: {},
      installedVendors: [],
      capabilitiesByVendor: {},
    },
    send: function () {},
    adapter: adapter,
    adapters: { codex: adapter },
  });

  assert.equal(bridge.refreshEnvironmentRuntime(), true);
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(shutdownCalls, 0, "saving settings does not interrupt an active provider turn");

  session.queryInstance = null;
  bridge.refreshEnvironmentRuntime();
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(shutdownCalls, 1, "the idle runtime is retired so its replacement reads the new values");
});
