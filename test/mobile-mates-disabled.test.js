var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

// Owner evidence: mobile Chat rendered the mates Buzz and Arch on a server where
// mates are disabled.
//
// Mates are opt-in. users-preferences.js stores the decision as `matesEnabled`
// and treats only the literal true as on; the daemon default is off. Mobile was
// gating the chips on `isMultiUserMode`, so any multi-user server rendered mates
// regardless of the flag, and the cached mate list kept them on screen across a
// reconnect or restart that had already turned them off.

function source(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8");
}

var MOBILE = source("sidebar-mobile.js");

test("mobile reads the authoritative mates flag, not the multi-user flag", function () {
  assert.match(MOBILE, /function mobileMatesEnabled\(\)/);
  assert.match(MOBILE, /store\.get\('matesEnabled'\) === true/);
  // The old gate is gone: multi-user alone must never authorise mate chips.
  assert.doesNotMatch(MOBILE, /store\.get\('isMultiUserMode'\) \? getCachedMates\(\) : \[\]/);
});

test("only the literal true enables mates, matching the opt-in contract", function () {
  // users-preferences.js: "opt-in, not opt-out ... only the literal true".
  // A truthy-but-not-true value (undefined, 1, "yes") must not enable them.
  var prefs = fs.readFileSync(path.join(__dirname, "..", "lib", "users-preferences.js"), "utf8");
  assert.match(prefs, /opt-in, not opt-out/);
  assert.match(MOBILE, /store\.get\('matesEnabled'\) === true/);
  assert.doesNotMatch(MOBILE, /store\.get\('matesEnabled'\) !== false/);
});

test("the chip list is derived through the gate, never from the cache directly", function () {
  assert.match(MOBILE, /function visibleMobileChatMates\(\)/);
  assert.match(MOBILE, /if \(!mobileMatesEnabled\(\)\) return \[\];/);
  var render = MOBILE.slice(
    MOBILE.indexOf("function renderSheetSessions(listEl)"),
    MOBILE.indexOf("// Helper: create a mobile session item element")
  );
  assert.ok(render.length > 0);
  assert.match(render, /visibleMobileChatMates\(\)\.sort\(/);
  // The chat sheet must not reach past the gate into the cache.
  assert.doesNotMatch(render, /getCachedMates\(\)/);
});

test("the flag is read per render, so reconnect and restart cannot serve a stale answer", function () {
  // mobileMatesEnabled() reads the store on each call rather than caching a
  // module-level boolean captured at load.
  var fn = MOBILE.slice(MOBILE.indexOf("function mobileMatesEnabled()"));
  fn = fn.slice(0, fn.indexOf("\n}"));
  assert.match(fn, /return store\.get\('matesEnabled'\) === true && !!store\.get\('isMultiUserMode'\);/);
  assert.doesNotMatch(MOBILE, /var\s+mobileMatesEnabledCache/);
});

test("an open sheet drops stale mate rows when the flag goes false", function () {
  // refreshMobileChatChips runs on every session-list update, reconnect and
  // projection rerender. With mates off it removes the rows instead of only
  // restyling them.
  var fn = MOBILE.slice(
    MOBILE.indexOf("function refreshMobileChatChips(sheet)"),
    MOBILE.indexOf("function renderMobileChatSessions(")
  );
  assert.ok(fn.length > 0);
  assert.match(fn, /if \(!mobileMatesEnabled\(\)\) \{/);
  assert.match(fn, /chips\[d\]\.dataset\.type === "mate" && chips\[d\]\.parentNode/);
  assert.match(fn, /removeChild\(chips\[d\]\)/);
  // Removing the last chip must not leave an empty strip above the session list.
  assert.match(fn, /emptyBar\.children\.length === 0/);
  // The removal branch returns before the restyle loop.
  assert.ok(fn.indexOf("removeChild(chips[d])") < fn.indexOf("updateMobileChatChipActive"));
});

test("a flag flip repaints the open sheet immediately", function () {
  var sub = MOBILE.slice(MOBILE.indexOf("store.subscribe(function (state, previous) {"));
  sub = sub.slice(0, sub.indexOf("});"));
  assert.match(sub, /state\.matesEnabled !== previous\.matesEnabled/);
  assert.match(sub, /state\.isMultiUserMode !== previous\.isMultiUserMode/);
  assert.match(sub, /state\.cachedMatesList !== previous\.cachedMatesList/);
  assert.match(sub, /refreshMobileChatSheet\(\)/);
});

test("the client defaults to mates off until the profile says otherwise", function () {
  // So a cold start or a reconnect that has not yet fetched the profile renders
  // no mates, rather than rendering them and retracting them.
  var appSource = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "app.js"), "utf8");
  assert.match(appSource, /matesEnabled: false,/);
  var profile = source("profile.js");
  assert.match(profile, /var matesOn = data\.matesEnabled === true;/);
  assert.match(profile, /store\.set\(\{ matesEnabled: matesOn \}\)/);
});

// --- Previously accepted behaviour that must not regress -------------------

test("the project switcher and its Projects control are untouched", function () {
  var index = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "index.html"), "utf8");
  assert.match(index, /id="mobile-sheet-projects-btn"/);
  assert.match(index, /id="mobile-sheet-back-btn"/);
  assert.match(MOBILE, /function updateMobileSheetNav\(type\)/);
  assert.match(MOBILE, /projectsBtn\.hidden = type !== "sessions"/);
  assert.match(MOBILE, /function renderSheetProjects\(listEl\)/);
  // Still exactly one project-switch producer.
  assert.doesNotMatch(MOBILE, /dataset\.type = "project"/);
});

test("mate DM navigation still works when mates are enabled", function () {
  var render = MOBILE.slice(
    MOBILE.indexOf("function renderSheetSessions(listEl)"),
    MOBILE.indexOf("// Helper: create a mobile session item element")
  );
  assert.match(render, /chip\.dataset\.type = "mate"/);
  assert.match(render, /if \(chip\.dataset\.type === "mate"\)/);
  assert.match(render, /renderSessionsForContext\("mate", null, chip\.dataset\.mateId\)/);
  assert.match(render, /if \(chips\.length > 0\) listEl\.appendChild\(filterBar\)/);
});
