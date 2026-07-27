var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

test("Workspace exposes Live UI through dedicated client modules", function () {
  var workspace = read("lib/public/modules/workspace-panel.js");
  var sections = read("lib/public/modules/workspace-panel-sections.js");
  var messages = read("lib/public/modules/app-messages.js");
  var bridge = read("lib/public/modules/app-misc.js");
  assert.match(sections, /liveUiControlsHtml/);
  assert.match(workspace, /wireLiveUiControls/);
  assert.match(messages, /handleLiveUiMessage/);
  assert.match(bridge, /clay_live_ui_relay/);
  assert.match(bridge, /clay_live_ui_server_event/);
});

test("extension picker publishes visible sessions and pins its request", function () {
  var picker = read("lib/public/modules/live-ui-extension-picker.js");
  var messages = read("lib/public/modules/live-ui-messages.js");
  assert.match(picker, /getCachedSessions/);
  assert.match(picker, /clay_live_ui_identity/);
  assert.match(picker, /clay_live_ui_picker_pair_request/);
  assert.match(picker, /type: "switch_session"/);
  assert.match(picker, /type: "browser_tab_list"/);
  assert.match(picker, /type: "live_ui_request_pair"/);
  assert.match(messages, /forwardLiveUiPickerState/);
  assert.doesNotMatch(picker, /localStorage/);
  assert.ok(picker.split("\n").length < 500);
});

test("Live UI preferences remain server or session state, never localStorage", function () {
  var liveUi = read("lib/public/modules/live-ui.js");
  var liveUiMessages = read("lib/public/modules/live-ui-messages.js");
  assert.doesNotMatch(liveUi, /localStorage/);
  assert.doesNotMatch(liveUiMessages, /localStorage/);
  assert.match(liveUi, /live_ui_request_pair/);
  assert.match(liveUi, /control\.unpair/);
  assert.match(liveUi, /Live UI ended after Clay restarted/);
  assert.match(liveUi, /transientPairingError \? "paired"/);
});
