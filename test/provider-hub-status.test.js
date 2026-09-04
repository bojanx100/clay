var test = require("node:test");
var assert = require("node:assert/strict");
require("./helpers/isolated-clay-home");

var buildProviderHubStatus = require("../lib/provider-hub-status").buildProviderHubStatus;
var registry = require("../lib/yoke/vendor-registry").VENDOR_REGISTRY;

function byVendor(snapshot, vendor) {
  for (var i = 0; i < snapshot.providers.length; i++) {
    if (snapshot.providers[i].vendor === vendor) return snapshot.providers[i];
  }
  return null;
}

test("provider hub distinguishes CLI presence from verified account readiness", function () {
  var snapshot = buildProviderHubStatus({
    registry: registry,
    installed: { claude: true, qwen: true, kimi: false },
    auth: { claude: false, qwen: true },
    platform: "darwin",
    sm: {
      availableVendors: ["claude", "qwen"],
      installedVendors: ["claude", "qwen"],
      modelsByVendor: {},
    },
  });

  assert.strictEqual(byVendor(snapshot, "claude").state, "login-required");
  assert.strictEqual(byVendor(snapshot, "qwen").state, "installed");
  assert.strictEqual(byVendor(snapshot, "qwen").authenticated, null);
  assert.strictEqual(byVendor(snapshot, "qwen").ready, false);
  assert.strictEqual(byVendor(snapshot, "kimi").state, "missing");
  assert.match(byVendor(snapshot, "kimi").installCommand, /code\.kimi\.com\/install\.sh/);
});

test("provider hub marks a provider ready only after runtime and model verification", function () {
  var snapshot = buildProviderHubStatus({
    registry: { qwen: registry.qwen },
    installed: { qwen: true },
    auth: { qwen: true },
    platform: "linux",
    sm: {
      availableVendors: ["qwen"],
      installedVendors: ["qwen"],
      modelsByVendor: { qwen: ["auto"] },
      verifiedModelsByRoute: {
        "qwen-alibaba": { models: ["auto"], verified: true, source: "live-initialization" },
      },
      providerVerificationByVendor: {
        qwen: { status: "ready", checkedAt: 100, modelCount: 1 },
      },
    },
  });
  var qwen = byVendor(snapshot, "qwen");

  assert.strictEqual(qwen.state, "ready");
  assert.strictEqual(qwen.ready, true);
  assert.strictEqual(qwen.steps.cli, true);
  assert.strictEqual(qwen.steps.login, true);
  assert.strictEqual(qwen.steps.models, true);
  assert.strictEqual(qwen.steps.ready, true);
  assert.deepStrictEqual(qwen.routeIds, ["qwen-alibaba"]);
});

test("provider hub exposes authentication errors and OS-user isolation honestly", function () {
  var authSnapshot = buildProviderHubStatus({
    registry: { grok: registry.grok },
    installed: { grok: true },
    auth: { grok: true },
    platform: "linux",
    sm: {
      availableVendors: ["grok"],
      installedVendors: ["grok"],
      providerVerificationByVendor: {
        grok: { status: "error", error: "Authentication required; please log in" },
      },
    },
  });
  var isolatedSnapshot = buildProviderHubStatus({
    registry: { opencode: registry.opencode },
    installed: { opencode: true },
    auth: { opencode: true },
    linuxUser: "owner-a",
    platform: "linux",
    sm: {
      availableVendors: ["opencode"],
      installedVendors: [],
    },
  });

  assert.strictEqual(byVendor(authSnapshot, "grok").state, "login-required");
  assert.strictEqual(byVendor(authSnapshot, "grok").authenticated, false);
  assert.strictEqual(byVendor(isolatedSnapshot, "opencode").state, "unsupported");
  assert.strictEqual(byVendor(isolatedSnapshot, "opencode").supported, false);
});
