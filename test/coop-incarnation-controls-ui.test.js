var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

test("the shared desktop/mobile config surface exposes all three Coop controls", function () {
  var html = read("lib/public/index.html");
  var module = read("lib/public/modules/coop-incarnation-controls.js");
  var panels = read("lib/public/modules/app-panels.js");

  assert.match(html, /id="config-coop-restart-btn"[^>]*>Restart<\/button>/);
  assert.match(html, /id="config-switch-vendor-btn"/);
  assert.match(html, /id="config-model-section-label"/);
  assert.match(module, /'SWITCH MODEL'/);
  assert.match(module, /type: 'coop_incarnation_restart'/);
  assert.match(module, /showConfirm\(/);
  assert.match(panels, /switchVendorBtn\.textContent = "Switch provider"/);
  assert.doesNotMatch(module, /restart_daemon|restartDaemon|server_restart/);
});

test("Coop control results are routed through the session message dispatcher", function () {
  var messages = read("lib/public/modules/app-messages-sessions.js");
  assert.match(messages, /coop_incarnation_result: handleCoopIncarnationResult/);
});
