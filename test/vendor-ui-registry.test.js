var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("client vendor presentation maps are hydrated from server registry data", async function () {
  var ui = await import("../lib/public/modules/vendor-ui.js");
  ui.applyVendorRegistry({
    codex: {
      displayName: "Codex Test",
      avatar: "/test-codex.png",
      homepage: "https://example.test/codex",
    },
    claude: {
      displayName: "Claude Test",
      avatar: "/test-claude.png",
      homepage: "https://example.test/claude",
    },
  });

  assert.deepStrictEqual(ui.VENDOR_ORDER, ["codex", "claude"]);
  assert.deepStrictEqual(ui.VENDOR_NAMES, { codex: "Codex Test", claude: "Claude Test" });
  assert.deepStrictEqual(ui.VENDOR_AVATARS, { codex: "/test-codex.png", claude: "/test-claude.png" });
  assert.deepStrictEqual(ui.VENDOR_HOMEPAGES, {
    codex: "https://example.test/codex",
    claude: "https://example.test/claude",
  });
});

test("provider lists put verified working vendors first with stable readiness tiers", async function () {
  var ui = await import("../lib/public/modules/vendor-ui.js");
  ui.applyVendorRegistry({
    antigravity: { displayName: "Antigravity" },
    "github-copilot": { displayName: "GitHub Copilot" },
    codex: { displayName: "Codex" },
    kimi: { displayName: "Kimi" },
    claude: { displayName: "Claude" },
  });
  var providers = [
    { vendor: "antigravity", state: "missing", installed: false, ready: false },
    { vendor: "github-copilot", state: "installed", installed: true, ready: false },
    { vendor: "codex", state: "ready", installed: true, ready: true },
    { vendor: "kimi", state: "verifying", installed: true, ready: false },
    { vendor: "claude", state: "ready", installed: true, ready: true },
  ];
  var expected = ["codex", "claude", "kimi", "github-copilot", "antigravity"];

  assert.deepStrictEqual(ui.sortProvidersByReadiness(providers).map(function (provider) {
    return provider.vendor;
  }), expected);

  ui.applyProviderReadiness(providers);
  assert.deepStrictEqual(ui.VENDOR_ORDER, expected);

  var routes = providers.map(function (provider) {
    return { vendor: provider.vendor, label: provider.vendor };
  });
  assert.deepStrictEqual(ui.sortProviderRoutesByReadiness(routes, providers).map(function (route) {
    return route.vendor;
  }), expected);

  assert.match(source("lib/public/modules/app-messages.js"), /get_provider_status/);
  assert.match(source("lib/public/modules/server-settings-providers.js"),
    /applyProviderReadiness\(normalized\.providers\)/);
  assert.match(source("lib/public/modules/app-panels.js"),
    /sortProviderRoutesByReadiness\(getProviderRoutesForMenu\(\), providerStatus\.providers/);
  assert.match(source("lib/public/modules/sidebar-sessions-top-actions.js"), /VENDOR_ORDER/);
  assert.match(source("lib/public/modules/sidebar-mobile.js"), /VENDOR_ORDER/);
});
