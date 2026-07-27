var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

test("Workspace exposes Live UI through dedicated client modules", function () {
  var workspace = read("lib/public/modules/workspace-panel.js");
  var messages = read("lib/public/modules/app-messages.js");
  var bridge = read("lib/public/modules/app-misc.js");
  assert.match(workspace, /liveUiControlsHtml/);
  assert.match(workspace, /wireLiveUiControls/);
  assert.match(messages, /handleLiveUiMessage/);
  assert.match(bridge, /clay_live_ui_relay/);
  assert.match(bridge, /clay_live_ui_server_event/);
});

test("Live UI preferences remain server or session state, never localStorage", function () {
  var liveUi = read("lib/public/modules/live-ui.js");
  var liveUiMessages = read("lib/public/modules/live-ui-messages.js");
  assert.doesNotMatch(liveUi, /localStorage/);
  assert.doesNotMatch(liveUiMessages, /localStorage/);
  assert.match(liveUi, /live_ui_request_pair/);
  assert.match(liveUi, /control\.unpair/);
});
