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

test("Workspace group disclosure state uses server preferences, not browser storage", function () {
  var collapse = read("lib/public/modules/workspace-group-collapse.js");
  var sections = read("lib/public/modules/workspace-panel-sections.js");
  var panel = read("lib/public/modules/workspace-panel.js");
  assert.match(collapse, /api\/user\/workspace-group-states/);
  assert.doesNotMatch(collapse, /localStorage/);
  assert.match(sections, /data-workspace-group-toggle/);
  assert.match(sections, /workspace-context/);
  assert.match(sections, /workspace-environment/);
  assert.match(sections, /workspace-linked-work/);
  assert.match(panel, /workspace-session-screenshots/);
});

test("Workspace Tasks tab uses accessible sections and keeps completed work collapsed", function () {
  var panel = read("lib/public/modules/workspace-panel.js");
  var tasks = read("lib/public/modules/workspace-tasks-view.js");
  var css = read("lib/public/css/workspace.css");
  assert.match(panel, /workspaceTabsHtml/);
  assert.match(tasks, /role="tablist"/);
  assert.match(tasks, /role="tab"/);
  assert.match(tasks, /<details class="ws-task-section ws-task-completed"/);
  assert.match(tasks, /Waiting to be started/);
  assert.match(tasks, /data-workspace-task-session/);
  assert.match(css, /\.ws-task-row/);
  assert.match(css, /\.ws-task-status-blocked/);
});

test("Owner Workspace keeps Tasks reachable through the Coop ledger renderer", function () {
  var panel = read("lib/public/modules/workspace-panel.js");
  var owner = read("lib/public/modules/workspace-coop-owner.js");
  assert.match(panel, /onTabSelect/);
  assert.match(panel, /workspace_tasks_get/);
  assert.match(owner, /workspaceTabsHtml\(selectedTab\)/);
  assert.match(owner, /workspaceTasksHtml\(input\.tasks \|\| ownerTasks\)/);
  assert.match(owner, /wireWorkspaceTaskLinks\(tabPanel/);
});
