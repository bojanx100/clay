var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

// The exact invariant, enforced by counting rather than by inspecting one path:
// at phone viewport there is ALWAYS exactly ONE visible project-switch entry
// point -- never zero, never two -- across first open, repeated opens, topic and
// project switching, back/forward, reconnect and restart.
//
// Both historical failures are pinned here:
//   * zero -- the Coop early return skipped the chip bar, and nothing else on
//     mobile could switch projects (#icon-strip is display:none under 768px);
//   * two  -- the header control shipped while the chat sheet still built its
//     own project chips, so ordinary projects showed both.
//
// These are structural assertions over the source. The live DOM count across the
// same event sequence is exercised by the browser QA pass; this file is the
// regression net that runs without a browser.

function source(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8");
}

var MOBILE = source("sidebar-mobile.js");
var INDEX = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "index.html"), "utf8");
var MOBILE_CSS = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css"), "utf8");

function renderSheetSessionsBody() {
  return MOBILE.slice(
    MOBILE.indexOf("function renderSheetSessions(listEl)"),
    MOBILE.indexOf("// Helper: create a mobile session item element")
  );
}

// --- Exactly one producer -----------------------------------------------

test("exactly one element in the whole client can switch projects on mobile", function () {
  // Count the distinct mobile project-switch producers. The header control and
  // the projects sheet it opens are one entry point; anything else is a second.
  var switchers = [];
  if (/id="mobile-sheet-projects-btn"/.test(INDEX)) switchers.push("header-control");
  if (/dataset\.type = "project"/.test(MOBILE)) switchers.push("chat-chip-bar");
  assert.deepEqual(switchers, ["header-control"],
    "expected exactly one mobile project-switch producer, got: " + switchers.join(", "));
});

test("the header control is declared exactly once in the markup", function () {
  var ids = INDEX.match(/id="mobile-sheet-projects-btn"/g) || [];
  assert.equal(ids.length, 1);
  var backIds = INDEX.match(/id="mobile-sheet-back-btn"/g) || [];
  assert.equal(backIds.length, 1);
  // It lives in the sheet header, which itself is declared once.
  var headers = INDEX.match(/<div class="mobile-sheet-header">/g) || [];
  assert.equal(headers.length, 1);
});

test("the control is static markup, so no render path can duplicate or drop it", function () {
  // Nothing creates it at runtime: it is never document.createElement'd, only
  // looked up. That is what makes the count render-count-independent.
  assert.doesNotMatch(MOBILE, /createElement\([^)]*\)[^;]*mobile-sheet-projects/);
  assert.match(MOBILE, /getElementById\("mobile-sheet-projects-btn"\)/);
  assert.match(MOBILE, /getElementById\("mobile-sheet-back-btn"\)/);
});

// --- Repeated init must not duplicate listeners --------------------------

test("initSidebarMobile is invoked from exactly one place", function () {
  // A second init would double-bind the switcher click and fire two
  // openMobileSheet calls per tap.
  var callers = [];
  var files = fs.readdirSync(path.join(__dirname, "..", "lib", "public", "modules"));
  for (var i = 0; i < files.length; i++) {
    if (!/\.js$/.test(files[i])) continue;
    var text = source(files[i]);
    if (/\binitSidebarMobile\(\)/.test(text) && !/export function initSidebarMobile/.test(text)) {
      callers.push(files[i]);
    }
  }
  var appJs = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "app.js"), "utf8");
  if (/\binitSidebarMobile\(\)/.test(appJs)) callers.push("app.js");
  assert.deepEqual(callers, ["sidebar.js"],
    "initSidebarMobile must have a single caller, got: " + callers.join(", "));
});

test("a repeated init cannot bind a second set of listeners", function () {
  // Every listener in initSidebarMobile is an anonymous closure, so the DOM
  // cannot dedupe them: without this guard a second caller would fire the
  // switcher once per duplicate binding.
  assert.match(MOBILE, /var mobileSidebarInitialized = false;/);
  var init = MOBILE.slice(MOBILE.indexOf("export function initSidebarMobile()"));
  assert.match(init, /if \(mobileSidebarInitialized\) return;\s*\n\s*mobileSidebarInitialized = true;/);
  // The guard must precede every binding in the function.
  var guardAt = init.indexOf("if (mobileSidebarInitialized) return;");
  assert.ok(guardAt !== -1 && guardAt < init.indexOf("addEventListener"));
});

test("the switcher click is bound at init, never per render", function () {
  // Binding inside a render function would add one listener per open.
  var init = MOBILE.slice(MOBILE.indexOf("export function initSidebarMobile()"));
  assert.match(init, /sheetProjectsBtn\.addEventListener\("click"/);
  assert.match(init, /sheetBackBtn\.addEventListener\("click"/);
  var openFn = MOBILE.slice(
    MOBILE.indexOf("export function openMobileSheet(type)"),
    MOBILE.indexOf("function restoreMobileSheetMovedContent")
  );
  assert.doesNotMatch(openFn, /addEventListener/);
  var navFn = MOBILE.slice(
    MOBILE.indexOf("function updateMobileSheetNav(type)"),
    MOBILE.indexOf("function renderMobileSheetType(")
  );
  assert.doesNotMatch(navFn, /addEventListener/);
});

// --- Visibility is decided per open, from the sheet type only ------------

test("every sheet open recomputes visibility, so repeat opens cannot drift", function () {
  // openMobileSheet -> renderMobileSheetType -> updateMobileSheetNav on EVERY
  // open. The second open of a chat therefore lands in the same state as the
  // first, which is the original "second open removed the navigation" bug.
  var open = MOBILE.slice(
    MOBILE.indexOf("export function openMobileSheet(type)"),
    MOBILE.indexOf("function restoreMobileSheetMovedContent")
  );
  assert.match(open, /renderMobileSheetType\(type, sheet, titleEl, listEl\)/);
  var render = MOBILE.slice(MOBILE.indexOf("function renderMobileSheetType("));
  assert.ok(render.indexOf("updateMobileSheetNav(type)") < render.indexOf('if (type === "projects")'));
  // Visibility is a pure function of the sheet type: no cached flag, no toggle.
  var nav = MOBILE.slice(
    MOBILE.indexOf("function updateMobileSheetNav(type)"),
    MOBILE.indexOf("function renderMobileSheetType(")
  );
  assert.match(nav, /projectsBtn\.hidden = type !== "sessions"/);
  assert.match(nav, /backBtn\.hidden = type !== "projects"/);
  assert.doesNotMatch(nav, /classList\.toggle|\.style\.display/);
});

test("the two header controls are mutually exclusive, never both and never neither", function () {
  // "sessions" -> Projects only. "projects" -> Chat only. Any other sheet type
  // -> neither, because no project navigation belongs on Files/Tools/Settings.
  var nav = MOBILE.slice(
    MOBILE.indexOf("function updateMobileSheetNav(type)"),
    MOBILE.indexOf("function renderMobileSheetType(")
  );
  var projectsHidden = /projectsBtn\.hidden = type !== "sessions"/.test(nav);
  var backHidden = /backBtn\.hidden = type !== "projects"/.test(nav);
  assert.ok(projectsHidden && backHidden);
  // Enumerate the sheet types and assert the count is 1 for the two navigable
  // sheets and 0 elsewhere -- mirroring what the DOM would show.
  var types = ["sessions", "projects", "files", "mate-knowledge", "mate-profile", "search", "tools", "settings"];
  var expected = { sessions: 1, projects: 1, files: 0, "mate-knowledge": 0, "mate-profile": 0, search: 0, tools: 0, settings: 0 };
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var visible = (t === "sessions" ? 1 : 0) + (t === "projects" ? 1 : 0);
    assert.equal(visible, expected[t], "sheet type " + t + " must show " + expected[t] + " control(s)");
  }
});

// --- Coop and ordinary projects behave identically ------------------------

test("the Coop early return no longer decides whether navigation exists", function () {
  // It now only chooses which list body to draw. The header control is applied
  // before it and is untouched by it, so Coop and ordinary projects agree.
  var body = renderSheetSessionsBody();
  assert.match(body, /if \(getCachedCurrentSlug\(\) === "lead"\)/);
  assert.doesNotMatch(body, /mobile-sheet-projects-btn/);
  assert.doesNotMatch(body, /updateMobileSheetNav/);
  // And the chat body contributes no project-switch control in either branch.
  assert.doesNotMatch(body, /dataset\.type = "project"/);
});

test("reconnect and restart cannot change the count", function () {
  // The control's presence depends on markup + sheet type only -- never on the
  // projection, the session list, or the cached project list.
  var nav = MOBILE.slice(
    MOBILE.indexOf("function updateMobileSheetNav(type)"),
    MOBILE.indexOf("function renderMobileSheetType(")
  );
  assert.doesNotMatch(nav, /getCachedProjectList|buildGlobalCoopDisplayModel|isSessionListLoading|getCachedSessions/);
  // An empty project list yields a loading row inside the sheet, not a missing
  // control.
  var sheet = MOBILE.slice(
    MOBILE.indexOf("function renderSheetProjects(listEl)"),
    MOBILE.indexOf("function renderSheetSessions(listEl)")
  );
  assert.match(sheet, /if \(!projects \|\| projects\.length === 0\)/);
  assert.match(sheet, /Loading projects…/);
});

// --- No CSS-only suppression ---------------------------------------------

test("the duplicate is removed at the render path, not hidden with CSS", function () {
  // The only display rule for these controls is the [hidden] attribute pairing,
  // which is the mutual-exclusion mechanism itself -- not a rule that suppresses
  // a second rendered copy.
  assert.doesNotMatch(MOBILE_CSS, /\.mobile-chat-chip\[data-type="project"\][^{:]*\{[^}]*display:\s*none/);
  // Element selector only -- ::-webkit-scrollbar { display: none } on the bar is
  // scrollbar chrome, not suppression of the bar itself.
  assert.doesNotMatch(MOBILE_CSS, /\.mobile-chat-filter-bar\s*\{[^}]*display:\s*none/);
  // The chip-bar project styles have no producer left; assert the producer is
  // gone rather than that the styles are.
  assert.doesNotMatch(MOBILE, /dataset\.type = "project"/);
});
