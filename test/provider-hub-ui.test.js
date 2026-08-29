var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("AI Provider settings render the server registry instead of a hard-coded vendor shortlist", function () {
  var moduleSource = source("lib/public/modules/server-settings-providers.js");
  var legacySource = source("lib/public/modules/server-settings.js");
  var html = source("lib/public/index.html");

  assert.match(moduleSource, /snapshot\.providers/);
  assert.match(moduleSource, /CLI[\s\S]+Account[\s\S]+Models[\s\S]+Ready/);
  assert.match(moduleSource, /economical[\s\S]+balanced[\s\S]+quality/);
  assert.doesNotMatch(legacySource, /var vendors = \["claude", "codex", "github-copilot"\]/);
  assert.match(html, /id="settings-provider-list"/);
  assert.match(html, /Only routes that pass Clay's runtime and model checks/);
});

test("provider setup uses confirmation and the generic supervised terminal modal", function () {
  var providerSource = source("lib/public/modules/server-settings-providers.js");
  var terminalMessages = source("lib/public/modules/app-messages-terminals.js");
  var modalSource = source("lib/public/modules/tui-attention.js");
  var terminalManager = source("lib/terminal-manager.js");

  assert.match(providerSource, /showConfirm\([\s\S]+Run installer/);
  assert.match(providerSource, /pendingProviderSetup/);
  assert.match(terminalMessages, /setupDisplayName: _ps\.displayName/);
  assert.match(modalSource, /modalSetupVendor/);
  assert.doesNotMatch(modalSource, /modalLoginVendor/);
  assert.match(terminalManager, /type: "term_exited", id: id, exitCode: session\.exitCode/);
});
