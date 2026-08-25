var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

test("Workspace presents the live environment as its primary status card", function () {
  var sections = read("lib/public/modules/workspace-panel-sections.js");
  var css = read("lib/public/css/workspace.css");
  assert.match(sections, /ws-env-title/);
  assert.match(sections, /Detected from chat, a terminal, or another tool/);
  assert.match(sections, /Managed outside Workspace/);
  assert.match(sections, /liveUiControlsHtml/);
  assert.match(sections, /dev\.tailscaleUrl/);
  assert.match(sections, /ws-env-tailscale/);
  assert.match(css, /\.ws-env-beacon/);
  assert.match(css, /\.ws-env-tailscale/);
  assert.match(css, /prefers-reduced-motion/);
});

test("Live UI controls are not wired as development server actions", function () {
  var panel = read("lib/public/modules/workspace-panel.js");
  assert.match(panel, /querySelectorAll\("\.ws-devbtn\[data-dev\]"\)/);
  assert.match(panel, /source: "workspace-dev-control"/);
});

test("Workspace panel modules stay below the client module size limit", function () {
  var panelLines = read("lib/public/modules/workspace-panel.js").split("\n").length;
  var sectionLines = read("lib/public/modules/workspace-panel-sections.js").split("\n").length;
  assert.ok(panelLines < 500, "workspace-panel.js must stay below 500 lines");
  assert.ok(sectionLines < 500, "workspace-panel-sections.js must stay below 500 lines");
});
