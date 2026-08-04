var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("mobile chat filter pins the Lead project before ordinary projects", function () {
  var mobileSidebarPath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js");
  var leadSidebarPath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-lead.js");
  var source = fs.readFileSync(mobileSidebarPath, "utf8");
  var leadSource = fs.readFileSync(leadSidebarPath, "utf8");
  var start = source.indexOf("function renderSheetSessions(listEl)");
  var end = source.indexOf("// Helper: create a mobile session item element", start);
  var renderSource = source.slice(start, end);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(renderSource, /var leadProject = findLeadProject\(getCachedProjectList\(\)\)/);
  assert.match(renderSource, /chips\.push\(buildProjectChip\(leadProject, false, null\)\)/);
  assert.ok(
    renderSource.indexOf("chips.push(buildProjectChip(leadProject, false, null))") <
      renderSource.indexOf("var grouped = groupProjects(getCachedProjectList())")
  );
  assert.match(renderSource, /decorateMobileLeadChatChip\(chip, p\)/);
  assert.match(leadSource, /chip\.classList\.add\("lead-chip"\)/);
  assert.match(leadSource, /appendLeadBadge\(chip, "mobile-chat-chip-lead-badge"\)/);
});
