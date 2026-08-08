var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function source(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8");
}

// The mobile chat sheet used to build its own row of project chips. That was a
// second project switcher stacked under the header control, and because the
// whole bar was skipped in Coop it also produced the opposite failure there:
// no switcher at all. Project navigation now has exactly one owner on mobile --
// the sheet header control and the Projects sheet it opens.

test("the mobile chat sheet no longer builds a second project switcher", function () {
  var mobile = source("sidebar-mobile.js");
  var render = mobile.slice(
    mobile.indexOf("function renderSheetSessions(listEl)"),
    mobile.indexOf("// Helper: create a mobile session item element")
  );
  assert.ok(render.length > 0, "renderSheetSessions must exist");
  assert.doesNotMatch(render, /buildProjectChip/);
  assert.doesNotMatch(render, /dataset\.type = "project"/);
  assert.doesNotMatch(render, /switchProject/);
  assert.doesNotMatch(render, /groupProjects\(getCachedProjectList\(\)\)/);
  assert.doesNotMatch(render, /mobile-chat-chip-wt-toggle/);
});

test("the chat sheet's chip bar carries mates only, and vanishes when empty", function () {
  var mobile = source("sidebar-mobile.js");
  var render = mobile.slice(
    mobile.indexOf("function renderSheetSessions(listEl)"),
    mobile.indexOf("// Helper: create a mobile session item element")
  );
  assert.match(render, /chip\.dataset\.type = "mate"/);
  assert.match(render, /if \(chip\.dataset\.type === "mate"\)/);
  assert.match(render, /if \(chips\.length > 0\) listEl\.appendChild\(filterBar\)/);
  // The chip refresh path must not look for project chips any more.
  assert.match(mobile, /function updateMobileChatChipActive\(chip, currentDmUserId\)/);
  assert.doesNotMatch(mobile, /chip\.dataset\.type === "project" && chip\.dataset\.slug === currentSlug/);
});

test("Coop is pinned first in the one surface that switches projects", function () {
  // The ordering guarantee this file used to make about the Lead chip now lives
  // in the projects sheet, which is the single entry point.
  var mobile = source("sidebar-mobile.js");
  var sheet = mobile.slice(
    mobile.indexOf("function renderSheetProjects(listEl)"),
    mobile.indexOf("function renderSheetSessions(listEl)")
  );
  assert.ok(sheet.length > 0);
  assert.match(sheet, /var leadProject = findLeadProject\(projects\)/);
  assert.ok(sheet.indexOf("createMobileLeadProjectItem") < sheet.indexOf("groupProjects(filterLeadProjects(projects))"));

  var lead = source("sidebar-lead.js");
  assert.match(lead, /mobile-project-item mobile-lead-project-item/);
  // The row is still pinned and still distinguishable by its own class, but it
  // no longer carries a "Lead" badge: that is Coop's internal power mode, not a
  // name the owner should ever read. Ordering is what this test guards; the
  // identity is asserted below.
  assert.ok(lead.indexOf("appendLeadBadge") === -1, "the owner-facing Lead badge is gone");
  // Rendered literals only -- prose about the internal mode is fine and useful.
  assert.ok(lead.indexOf('textContent = "Lead"') === -1, "no literal Lead identity may be rendered");
  assert.match(lead, /COOP_IDENTITY/);
});

test("no owner-facing surface renders the internal Lead identity", function () {
  // "Lead" is a routing/capability mode. Every producer the owner can see must
  // name the product "Coop", including when project metadata is missing or
  // stale -- the fallback used to be the literal internal name.
  ["sidebar-lead.js", "sidebar-sessions-model.js", "sidebar-mobile-coordinators.js"]
    .forEach(function (file) {
      var text = source(file);
      assert.ok(text.indexOf('label: "Lead"') === -1, file + " must not label a section Lead");
      assert.ok(text.indexOf('textContent = "Lead"') === -1, file + " must not render Lead");
    });
  var lead = source("sidebar-lead.js");
  assert.match(lead, /\|\| COOP_IDENTITY;/, "the fallback identity is Coop, not Lead");
});
