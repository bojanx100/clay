var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

// Phones hide #icon-strip entirely, so the mobile sheet header is the owner's
// only route between projects. These tests pin the four things that had to hold
// for the regression to be fixed and stay fixed:
//
//   1. the control exists in static markup, so it cannot be erased by a
//      projection that is empty, loading, or mid-reconnect;
//   2. it is offered from the chat/topic sheet (mobile Coop home, a selected
//      topic, and a selected project all render that same sheet);
//   3. it is touch-sized and visible at a phone viewport;
//   4. the Coop early-return that removed the old switcher did not also remove
//      the compact project-grouped topic list it was introduced to protect.

function repoFile(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

function source(name) {
  return repoFile(path.join("lib", "public", "modules", name));
}

var INDEX = repoFile(path.join("lib", "public", "index.html"));
var MOBILE_CSS = repoFile(path.join("lib", "public", "css", "mobile-nav.css"));
var MOBILE_JS = source("sidebar-mobile.js");

// --- 1. Static markup, immune to projection state ---------------------------

test("the switcher lives in the sheet header markup, not in a data-driven render", function () {
  var header = INDEX.slice(
    INDEX.indexOf('<div class="mobile-sheet-header">'),
    INDEX.indexOf('<div class="mobile-sheet-list">')
  );
  assert.ok(header.length > 0, "mobile sheet header must exist");
  assert.match(header, /id="mobile-sheet-projects-btn"/);
  assert.match(header, /id="mobile-sheet-back-btn"/);
  // Labelled, not icon-only, so it reads as a switcher at a glance.
  assert.match(header, /aria-label="Switch project"/);
  assert.match(header, /mobile-sheet-projects-label">Projects</);
  assert.match(header, /aria-label="Back to chat"/);
  // Both start hidden; visibility is decided per sheet type at render time.
  assert.match(header, /id="mobile-sheet-projects-btn"[^>]*hidden/);
  assert.match(header, /id="mobile-sheet-back-btn"[^>]*hidden/);
  // The close control the sheet already had must survive alongside them.
  assert.match(header, /class="mobile-sheet-close"/);
});

test("the switcher is bound once at init, so later renders cannot orphan it", function () {
  assert.match(MOBILE_JS, /getElementById\("mobile-sheet-projects-btn"\)/);
  assert.match(MOBILE_JS, /sheetProjectsBtn\.addEventListener\("click", function \(\) \{ openMobileSheet\("projects"\); \}\)/);
  assert.match(MOBILE_JS, /sheetBackBtn\.addEventListener\("click", function \(\) \{ openMobileSheet\("sessions"\); \}\)/);
  // Bound inside init, not inside a per-render helper.
  var init = MOBILE_JS.slice(MOBILE_JS.indexOf("export function initSidebarMobile()"));
  assert.ok(init.indexOf('getElementById("mobile-sheet-projects-btn")') !== -1);
});

// --- 2. Offered from the chat/topic sheet in every Coop state ----------------

test("the Projects control is offered from the chat sheet and hidden elsewhere", function () {
  var nav = MOBILE_JS.slice(
    MOBILE_JS.indexOf("function updateMobileSheetNav(type)"),
    MOBILE_JS.indexOf("function renderMobileSheetType(")
  );
  assert.ok(nav.length > 0, "updateMobileSheetNav must exist");
  assert.match(nav, /projectsBtn\.hidden = type !== "sessions"/);
  assert.match(nav, /backBtn\.hidden = type !== "projects"/);
  // Applied on every sheet render, before the body of any specific type.
  var render = MOBILE_JS.slice(MOBILE_JS.indexOf("function renderMobileSheetType("));
  assert.ok(render.indexOf("updateMobileSheetNav(type)") < render.indexOf('if (type === "projects")'));
});

test("mobile Coop home, a selected topic, and a selected project share one sheet", function () {
  // All three states render the "sessions" sheet, so pinning the control to
  // that sheet covers all three. Coop home short-circuits to the topic list.
  var renderSessions = MOBILE_JS.slice(
    MOBILE_JS.indexOf("function renderSheetSessions(listEl)"),
    MOBILE_JS.indexOf("// Helper: create a mobile session item element")
  );
  assert.ok(renderSessions.length > 0);
  assert.match(renderSessions, /if \(getCachedCurrentSlug\(\) === "lead"\)/);
  assert.match(renderSessions, /renderMobileSessionsInto\(listEl\)/);
  // The tab bar entry point still opens that same sheet.
  assert.match(MOBILE_JS, /openMobileSheet\("sessions"\)/);
});

test("the projects sheet lists Coop and project families, and says so while loading", function () {
  var sheet = MOBILE_JS.slice(
    MOBILE_JS.indexOf("function renderSheetProjects(listEl)"),
    MOBILE_JS.indexOf("function renderSheetSessions(listEl)")
  );
  assert.ok(sheet.length > 0);
  // Empty list is "not loaded yet", not "you have no projects".
  assert.match(sheet, /if \(!projects \|\| projects\.length === 0\)/);
  assert.match(sheet, /Loading projects…/);
  // Coop is pinned first, then each ordinary project family is represented by
  // its parent. Worktrees are branches in the title-bar switcher, not duplicate
  // project rows in this sheet.
  assert.ok(sheet.indexOf("createMobileLeadProjectItem") < sheet.indexOf("filterLeadProjects(projects)"));
  assert.match(sheet, /parentProjects\(visibleProjects\)/);
  assert.match(sheet, /aggregateFamily\(p, family\.worktrees\)/);
  // Tapping Coop switches and dismisses, same as any project row.
  assert.match(sheet, /if \(switchProject\) switchProject\(slug\)/);
  assert.match(sheet, /buildMobileProjectRow\(display, false\)/);
  assert.doesNotMatch(sheet, /buildMobileProjectRow\([^\n]+, true\)/);
});

test("the projects sheet renders only the ACL-filtered family list", function () {
  // getCachedProjectList() is the server's per-user filtered list, the same one
  // the desktop icon strip renders; the sheet must not widen it.
  var sheet = MOBILE_JS.slice(
    MOBILE_JS.indexOf("function renderSheetProjects(listEl)"),
    MOBILE_JS.indexOf("function renderSheetSessions(listEl)")
  );
  assert.match(sheet, /var projects = getCachedProjectList\(\)/);
  assert.doesNotMatch(sheet, /getCachedProjects\(\)/);

  assert.match(sheet, /filterLeadProjects\(projects\)/);
  assert.match(sheet, /familyOf\(visibleProjects, getCachedCurrentSlug\(\)\)/);
  assert.doesNotMatch(sheet, /localStorage/);
});

// --- 3. Visible and touch-sized at a phone viewport -------------------------

test("the switcher is styled inside the phone breakpoint and meets the touch minimum", function () {
  var breakpoint = MOBILE_CSS.indexOf("@media (max-width: 768px)");
  var styleAt = MOBILE_CSS.indexOf(".mobile-sheet-projects,");
  assert.ok(breakpoint !== -1 && styleAt > breakpoint, "switcher styles must be inside the mobile breakpoint");

  var block = MOBILE_CSS.slice(styleAt, MOBILE_CSS.indexOf(".mobile-project-empty"));
  assert.match(block, /height: 32px/);
  assert.match(block, /padding: 0 12px/);
  // ::after widens the hit area to the 44px touch minimum (32 + 6 + 6).
  assert.match(block, /inset: -6px -4px/);
  // Accent-tinted rather than a bare glyph, so it is visible against the sheet.
  assert.match(block, /background: rgba\(var\(--accent-rgb\), 0\.1\)/);
  // The hidden attribute must actually hide a flex button.
  assert.match(block, /\.mobile-sheet-projects\[hidden\],\s*\n\s*\.mobile-sheet-back\[hidden\] \{\s*\n\s*display: none;/);
});

test("mobile still hides the desktop icon strip, so the sheet control is load-bearing", function () {
  var iconStrip = repoFile(path.join("lib", "public", "css", "icon-strip.css"));
  assert.match(iconStrip, /@media \(max-width: 768px\) \{\s*\n\s*#icon-strip \{\s*\n\s*display: none;/);
});

// --- 4. The already-closed sidebar behaviour must stay closed ---------------

test("the compact project-grouped topic list and its controls are preserved", function () {
  var topics = source("sidebar-coop-topics.js");
  // One shared render path for desktop and mobile.
  assert.match(topics, /export function renderCoopTopicSections\(container, model, options\)/);
  // All/topic routing.
  assert.match(topics, /requestAllCoopTopics\)/);
  assert.match(topics, /requestMainCoopLens\)/);
  assert.match(topics, /onSelect\(sendUserAction\)/);
  assert.match(topics, /requestCoopTopic\(topic, sendUserAction\)/);
  // Thread rows remain navigation-only; lifecycle language is handled in the
  // selected Thread while other empty wrappers stay omitted.
  assert.doesNotMatch(topics, /createTopicMenu|sidebar-coop-topic-close/);
  assert.match(topics, /createTopicLinksExpander\(topic, options\)/);
  assert.match(topics, /if \(items\.length === 0 && opts\.allowEmpty !== true\) return 0/);
  // The project coordinator hierarchy uses the same shared render path.
  assert.match(topics, /function appendProjectSection\(container, section, options\)/);
});

test("drilling out of the chat sheet stops the chat sheet's live refresh", function () {
  // refreshMobileChatSheet and the auto-launch listener both repaint the sheet
  // list from session data; leaving the flag set would repaint session rows
  // over the projects list the owner just opened.
  assert.match(MOBILE_JS, /if \(type !== "sessions"\) mobileChatSheetOpen = false/);
  var render = MOBILE_JS.slice(MOBILE_JS.indexOf("function renderMobileSheetType("));
  assert.ok(render.indexOf('if (type !== "sessions") mobileChatSheetOpen = false') < render.indexOf('if (type === "projects")'));
});

test("an open projects sheet repaints when the project list finally lands", function () {
  // Opening the switcher before the first list arrives shows "Loading projects…".
  // Nothing else repaints that sheet: it is not store-driven, and drilling in
  // clears mobileChatSheetOpen so the chat refresh path cannot help either.
  var projects = source("sidebar-projects.js");
  assert.match(projects, /window\.dispatchEvent\(new CustomEvent\("clay:project-list-updated"\)\)/);
  // renderIconStrip also runs on DM transitions, home-hub changes, and
  // attention refreshes. Rebuilding an open sheet on those would drop focus
  // mid-interaction for no new data, so the event is change-gated.
  assert.match(projects, /function projectListSignature\(projects, currentSlug\)/);
  assert.match(projects, /var listChanged = listSignature !== cachedProjectListSignature/);
  assert.match(projects, /if \(listChanged && typeof window !== "undefined"/);
  // Announced as an event because sidebar-mobile imports sidebar-projects; a
  // direct call would be a cycle.
  assert.doesNotMatch(projects, /from '\.\/sidebar-mobile\.js'/);

  assert.match(MOBILE_JS, /window\.addEventListener\("clay:project-list-updated"/);
  var listener = MOBILE_JS.slice(
    MOBILE_JS.indexOf('window.addEventListener("clay:project-list-updated"'),
    MOBILE_JS.indexOf("export function setMobileSheetMateData")
  );
  assert.match(listener, /titleEl\.textContent !== "Projects"/);
  assert.match(listener, /renderSheetProjects\(listEl\)/);
  // Must not repaint a closed sheet.
  assert.match(listener, /sheet\.classList\.contains\("hidden"\)/);
});

test("mobile back/close semantics are unchanged", function () {
  assert.match(MOBILE_JS, /sheetBackdrop\.addEventListener\("click", closeMobileSheet\)/);
  assert.match(MOBILE_JS, /sheetCloseBtn\.addEventListener\("click", closeMobileSheet\)/);
  // Drag-to-dismiss handle still wired.
  assert.match(MOBILE_JS, /mobileSheet\.querySelector\("\.mobile-sheet-handle"\)/);
});
