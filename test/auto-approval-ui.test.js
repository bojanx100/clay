var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

var root = path.join(__dirname, "..");
var html = fs.readFileSync(path.join(root, "lib/public/index.html"), "utf8");
var panels = fs.readFileSync(path.join(root, "lib/public/modules/app-panels.js"), "utf8");
var menus = fs.readFileSync(path.join(root, "lib/public/css/menus.css"), "utf8");

test("auto-approval control is adjacent to the model control and exposes keyboard semantics", function () {
  assert.ok(html.indexOf('id="auto-approval-wrap"') > html.indexOf('id="config-chip-wrap"'),
    "the compact authorization control follows the model selector in the input header");
  assert.match(html, /id="auto-approval-popover"[^>]*role="dialog"[^>]*aria-labelledby="auto-approval-title"/);
  assert.match(html, /id="auto-approval-project-toggle"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /id="auto-approval-projects"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /auto-approval-global-toggle|auto-approval-disable|auto-approval-overrides/,
    "the owner-facing panel contains no global or per-item approval controls");
  assert.match(html, /Loading current authorization…/,
    "opening state explains that project approval data is still loading");
  assert.match(html, /Destructive, spending, permission, secret, and approval-system changes still require an owner approval/,
    "the safety exception remains visible after the panel simplification");
  assert.match(menus, /#auto-approval-chip:focus-visible/,
    "every control has an explicit keyboard focus treatment");
});

test("the client renders only canonical project cards and keeps the popup bounded on mobile", async function () {
  var panel = await import(pathToFileURL(path.join(root, "lib/public/modules/auto-approval-panel.js")).href);
  var rows = panel.projectApprovalPresentation({ projects: [
    { projectRef: { projectId: "a-project" }, label: "A very long project name that still remains owner-readable on a narrow display", hasOverride: false,
      effective: { enabled: false }, taskId: "hidden-task", sessionId: "hidden-session" },
    { projectRef: { projectId: "a-project" }, label: "Duplicate alias", hasOverride: true, effective: { enabled: true } },
    { projectRef: { projectId: "b-project" }, label: "Dashboard", hasOverride: true, effective: { enabled: true } },
  ] });
  assert.deepEqual(rows.map(function (row) { return [row.name, row.statusLabel, row.sourceLabel]; }), [
    ["A very long project name that still remains owner-readable on a narrow display", "Approval required", "Default policy"],
    ["Dashboard", "Automatic approval on", "Project setting"],
  ]);
  assert.equal(rows[0].actionLabel, "Turn automatic approval on");
  assert.equal(rows[1].actionLabel, "Turn automatic approval off");
  assert.deepEqual(panel.projectApprovalPresentation({ projects: [] }), [],
    "an empty project list has no phantom approval entry");
  assert.doesNotMatch(JSON.stringify(rows), /hidden-task|hidden-session/,
    "presentation never carries task or session details into project cards");
  assert.match(panels, /projectApprovalPresentation\(state\)/);
  assert.match(menus, /@media \(max-width: 768px\)[\s\S]*#auto-approval-popover[\s\S]*position: fixed/);
  assert.match(menus, /max-height: min\(420px, calc\(100dvh - var\(--safe-bottom, 0px\) - 196px\)\)/);
  assert.match(menus, /\.auto-approval-project-name[^}]*overflow-wrap: anywhere/);
  assert.match(menus, /\.auto-approval-project-action[^}]*min-height: 44px/);
});

test("the client sends only project-scoped auto-approval controls", function () {
  assert.match(panels, /function renderAutoApproval\(\)/);
  assert.match(panels, /function setToggleState\(button, checked, label, disabled\)/);
  assert.match(panels, /setAttribute\("aria-checked", checked \? "true" : "false"\)/);
  assert.match(panels, /type: "set_auto_approval_project"/);
  assert.match(panels, /type: "clear_auto_approval_project_override"/);
  assert.match(panels, /type: "get_auto_approval_state"/);
  assert.doesNotMatch(panels, /type: "set_auto_approval_global"/);
});
