var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var root = path.join(__dirname, "..");
var html = fs.readFileSync(path.join(root, "lib/public/index.html"), "utf8");
var panels = fs.readFileSync(path.join(root, "lib/public/modules/app-panels.js"), "utf8");
var menus = fs.readFileSync(path.join(root, "lib/public/css/menus.css"), "utf8");

test("auto-approval control is adjacent to the model control and exposes keyboard semantics", function () {
  assert.ok(html.indexOf('id="auto-approval-wrap"') > html.indexOf('id="config-chip-wrap"'),
    "the compact authorization control follows the model selector in the input header");
  assert.match(html, /id="auto-approval-popover"[^>]*role="dialog"[^>]*aria-labelledby="auto-approval-title"/);
  assert.match(html, /id="auto-approval-global-toggle"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /id="auto-approval-project-toggle"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /id="auto-approval-disable"[^>]*>Disable now</);
  assert.match(menus, /#auto-approval-chip:focus-visible/,
    "every control has an explicit keyboard focus treatment");
});

test("the client renders scope state and sends only named auto-approval controls", function () {
  assert.match(panels, /function renderAutoApproval\(\)/);
  assert.match(panels, /function setToggleState\(button, checked, label, disabled\)/);
  assert.match(panels, /setAttribute\("aria-checked", checked \? "true" : "false"\)/);
  assert.match(panels, /type: "set_auto_approval_global"/);
  assert.match(panels, /type: "set_auto_approval_project"/);
  assert.match(panels, /type: "clear_auto_approval_project_override"/);
  assert.match(panels, /type: "get_auto_approval_state"/);
});
