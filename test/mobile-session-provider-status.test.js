var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("mobile processing dots use provider colors and pulse", function () {
  var cssPath = path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css");
  var css = fs.readFileSync(cssPath, "utf8");

  assert.match(css, /\.mobile-session-processing\.codex\s*\{[^}]*background:\s*#4a9eff/s);
  assert.match(css, /\.mobile-session-processing\.claude\s*\{[^}]*background:\s*#da7756/s);
  assert.match(css, /\.mobile-session-processing\s*\{[^}]*animation:\s*vendor-dot-pulse/s);
});

test("mobile session activity targets the rendered processing dot", function () {
  var faviconPath = path.join(__dirname, "..", "lib", "public", "modules", "app-favicon.js");
  var mobileSidebarPath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js");
  var faviconSource = fs.readFileSync(faviconPath, "utf8");
  var mobileSidebarSource = fs.readFileSync(mobileSidebarPath, "utf8");

  assert.match(faviconSource, /\.mobile-session-item\.active \.mobile-session-processing/);
  assert.match(faviconSource, /\.mobile-session-item\[data-session-id=/);
  assert.doesNotMatch(faviconSource, /\.mobile-session-dot/);
  assert.match(mobileSidebarSource, /dot\.className = "mobile-session-processing " \+ getSessionProviderColorClass\(s\)/);
  assert.match(mobileSidebarSource, /el\.dataset\.sessionId = s\.id/);
});

test("provider color classification follows routed AI family", async function () {
  var providerUi = await import("../lib/public/modules/provider-route-ui.js");
  var vendorUi = await import("../lib/public/modules/vendor-ui.js");
  vendorUi.applyVendorRegistry({
    claude: { displayName: "Claude", avatar: "/claude-code-avatar.png" },
    codex: { displayName: "Codex", avatar: "/codex-avatar.png" },
    kimi: { displayName: "Kimi Code", avatar: "/kimi-avatar.svg" },
  });

  assert.equal(providerUi.providerShortName("claude", null, "claude-opus-4-6"), "Claude");
  assert.equal(providerUi.providerShortName("codex", null, "gpt-5.6-codex"), "Codex");
  assert.equal(providerUi.providerShortName("github-copilot", "claude-github-copilot", ""), "Claude");
  assert.equal(providerUi.providerShortName("github-copilot", "codex-github-copilot", ""), "Codex");
  assert.equal(providerUi.providerShortName("kimi", "kimi-moonshot", "auto"), "Kimi Code");
  assert.equal(providerUi.providerAvatar("kimi", "kimi-moonshot", "auto"), "/kimi-avatar.svg");
});
