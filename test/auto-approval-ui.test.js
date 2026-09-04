var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

var root = path.join(__dirname, "..");
var html = fs.readFileSync(path.join(root, "lib/public/index.html"), "utf8");
var panels = fs.readFileSync(path.join(root, "lib/public/modules/app-panels.js"), "utf8");
var menus = fs.readFileSync(path.join(root, "lib/public/css/menus.css"), "utf8");

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
  return value;
}

test("the footer trigger is neutral and the popup contains only Coop project controls", function () {
  assert.ok(html.indexOf('id="auto-approval-wrap"') > html.indexOf('id="config-chip-wrap"'),
    "the compact owner control follows the model selector in the footer");
  assert.match(html, /id="auto-approval-chip-label">Approvals</,
    "the trigger never summarizes mixed project settings as On or Off");
  assert.doesNotMatch(html, /Approvals?: (?:On|Off)/,
    "the misleading aggregate state is absent from the markup");
  assert.match(html, /id="auto-approval-popover"[^>]*role="dialog"[^>]*aria-labelledby="auto-approval-title"/);
  assert.match(html, /id="auto-approval-title"[^>]*>Project approvals</,
    "the compact popup title uses sentence case");
  assert.match(html, /id="auto-approval-projects"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /auto-approval-project-toggle"|auto-approval-inherit|THIS PROJECT|PROJECTS/,
    "ordinary-project controls and redundant popup chrome are removed");
  assert.match(panels, /store\.get\("currentSlug"\) !== "lead" \|\| !panel/,
    "the client hides the control unless the confirmed Coop presentation is active");
  assert.match(panels, /coopApprovalPresentation\(autoApprovalData\)/,
    "the renderer uses the scope guard before it reveals the control");
  assert.match(menus, /#auto-approval-chip:focus-visible, \.auto-approval-project-toggle:focus-visible/,
    "both the trigger and each compact switch retain visible keyboard focus");
});

test("Coop rows preserve mixed stored state and opening the popup is read-only", async function () {
  var panel = await import(pathToFileURL(path.join(root, "lib/public/modules/auto-approval-panel.js")).href);
  var source = deepFreeze({
    scope: "coop",
    state: {
      projects: [
        { projectRef: { projectId: "clay" }, label: "Clay", effective: { enabled: true } },
        { projectRef: { projectId: "webapp" }, label: "Webapp", effective: { enabled: false } },
        { projectRef: { projectId: "urban-stay" }, label: "Urban Stay", effective: { enabled: true } },
      ],
    },
  });
  var presentation = panel.coopApprovalPresentation(source);
  assert.deepEqual(presentation.projects.map(function (row) {
    return [row.name, row.enabled, row.toggleLabel, row.toggleName];
  }), [
    ["Clay", true, "On", "Automatic approval for Clay"],
    ["Webapp", false, "Off", "Automatic approval for Webapp"],
    ["Urban Stay", true, "On", "Automatic approval for Urban Stay"],
  ], "each row exposes its own effective setting instead of an aggregate status");
  assert.equal(panel.coopApprovalPresentation({ scope: "project", state: source.state }), null,
    "an ordinary project payload can never render the owner approval panel");
  assert.deepEqual(source.state.projects.map(function (project) {
    return project.effective.enabled;
  }), [true, false, true], "rendering did not mutate any stored setting");
});

test("each compact On/Off switch sends only its own typed project update", async function () {
  var panel = await import(pathToFileURL(path.join(root, "lib/public/modules/auto-approval-panel.js")).href);
  var rows = panel.projectApprovalPresentation({ projects: [
    { projectRef: { projectId: "clay" }, label: "Clay", effective: { enabled: true } },
    { projectRef: { projectId: "webapp" }, label: "Webapp", effective: { enabled: false } },
  ] });
  assert.deepEqual(panel.projectApprovalChange(rows[0]), {
    type: "set_auto_approval_project", projectRef: { projectId: "clay" }, enabled: false,
  });
  assert.deepEqual(panel.projectApprovalChange(rows[1]), {
    type: "set_auto_approval_project", projectRef: { projectId: "webapp" }, enabled: true,
  });
  assert.deepEqual(rows.map(function (row) { return row.enabled; }), [true, false],
    "building an update leaves every rendered row unchanged");
  assert.equal(panel.projectApprovalChange({ enabled: true }), null,
    "a row without a canonical ProjectRef cannot issue a broad update");
  assert.match(panels, /button\.setAttribute\("role", "switch"\)/);
  assert.match(panels, /button\.setAttribute\("aria-checked", project\.enabled \? "true" : "false"\)/);
  assert.match(panels, /var change = projectApprovalChange\(row\);/);
  assert.doesNotMatch(panels, /type: "set_auto_approval_global"|clear_auto_approval_project_override/,
    "the popup can only send a per-project typed update");
});

test("the narrow popup keeps each On/Off control compact and reachable", function () {
  assert.match(menus, /@media \(max-width: 768px\)[\s\S]*#auto-approval-popover[\s\S]*position: fixed/);
  assert.match(menus, /max-height: min\(420px, calc\(100dvh - var\(--safe-bottom, 0px\) - 196px\)\)/);
  assert.match(menus, /\.auto-approval-project \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(menus, /\.auto-approval-project-toggle \{[\s\S]*min-height: 44px[\s\S]*min-width: 52px/);
  assert.match(menus, /\.auto-approval-project-name \{[^}]*overflow-wrap: anywhere/);
  assert.doesNotMatch(menus, /auto-approval-project-action/,
    "the old long-form action buttons are gone from narrow and wide layouts");
});
