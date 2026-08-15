var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function source(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8");
}

async function loadIdentity() {
  return import(modulePath("coop-identity.js"));
}

// --- Identity: "Lead" is a power mode, never an owner-facing persona ---------

test("the Coop project always renders the Coop identity, whatever the candidate", async function () {
  var id = await loadIdentity();
  // Every producer that used to win over Coop: a session title, the project
  // name, a stale localStorage cache, and the historical "Lead" name.
  assert.equal(id.coopHeaderTitle("lead", "Lead", "Lead"), "Coop");
  assert.equal(id.coopHeaderTitle("lead", "LEAD", "Clay"), "Coop");
  assert.equal(id.coopHeaderTitle("lead", "Lead nightly metrics", "Clay"), "Coop");
  assert.equal(id.coopHeaderTitle("lead", "Coop conversation architecture", ""), "Coop");
  assert.equal(id.coopHeaderTitle("lead", "", ""), "Coop");
  assert.equal(id.coopHeaderTitle("lead", null, null), "Coop");
});

test("Coop identity survives slug casing and padding from URL or cache", async function () {
  var id = await loadIdentity();
  assert.equal(id.coopHeaderTitle("LEAD", "Lead", null), "Coop");
  assert.equal(id.coopHeaderTitle("  lead  ", "Lead", null), "Coop");
  assert.ok(id.isCoopProjectSlug("lead"));
  assert.ok(id.isCoopProjectSlug("Lead"));
  assert.ok(!id.isCoopProjectSlug("clay"));
  assert.ok(!id.isCoopProjectSlug(""));
  assert.ok(!id.isCoopProjectSlug(null));
});

test("ordinary projects keep their own titles and are never renamed to Coop", async function () {
  var id = await loadIdentity();
  assert.equal(id.coopHeaderTitle("clay", "Restore mobile switcher", "Clay"), "Restore mobile switcher");
  assert.equal(id.coopHeaderTitle("clay", "", "Clay"), "Clay");
  assert.equal(id.coopHeaderTitle("clay", null, null), "Clay");
  // A project that happens to be named Lead is still not the Coop project.
  assert.equal(id.coopHeaderTitle("leadgen", "Lead", null), "Lead");
});

// --- Topic titles: canonical metadata, never a snapshot or an internal id ----

test("internal topic identifiers are never treated as owner-facing titles", async function () {
  var id = await loadIdentity();
  // The generated key shape, and any candidate that is this topic's own id.
  assert.ok(id.isInternalTopicIdentifier("auto-ce35aa04133c89ab5193456b", ""));
  assert.ok(id.isInternalTopicIdentifier("AUTO-CE35AA04133C89AB5193456B", ""));
  assert.ok(id.isInternalTopicIdentifier("some-topic", "some-topic"));
  assert.ok(id.isInternalTopicIdentifier("coop-conversation-architecture", "coop-conversation-architecture"));
  assert.ok(id.isInternalTopicIdentifier("", ""));
  assert.ok(id.isInternalTopicIdentifier(null, ""));
  assert.ok(!id.isInternalTopicIdentifier("Queued-message recovery", "queued-message-recovery"));
  assert.ok(!id.isInternalTopicIdentifier("Coop conversation architecture", "coop-conversation-architecture"));
});

test("lowercase hyphenated titles are titles, not identifiers", async function () {
  var id = await loadIdentity();
  // A general "looks like a slug" test would swallow all of these and show the
  // owner "Untitled topic" instead of the name they chose. Only an exact id
  // match or the generated auto-<hex> key counts as an identifier.
  var realTitles = ["follow-up", "post-mortem", "q3-planning", "e2e-tests", "auto-scaling", "back-end"];
  for (var i = 0; i < realTitles.length; i++) {
    assert.ok(!id.isInternalTopicIdentifier(realTitles[i], "some-other-id"),
      realTitles[i] + " must be treated as a real title");
    assert.equal(id.canonicalTopicTitle(
      { topicRef: { topicId: "some-other-id" }, title: realTitles[i] }, ""), realTitles[i]);
  }
  // The generated key is exactly "auto-" + 24 hex chars (see automaticTopicId in
  // lib/coop-topic-classification.js). Shorter "auto-" strings are real titles.
  assert.ok(id.isInternalTopicIdentifier("auto-ce35aa04133c89ab5193456b", ""));
  assert.ok(!id.isInternalTopicIdentifier("auto-deadbeef", ""));
  assert.ok(!id.isInternalTopicIdentifier("auto-scaling", ""));
  assert.equal(id.canonicalTopicTitle({ topicRef: { topicId: "x" }, title: "auto-deadbeef" }, ""), "auto-deadbeef");
});

test("an unresolved canonical record still cannot leak the id it was asked for", async function () {
  var id = await loadIdentity();
  // Between a tap and the next projection push the record is null, so the
  // exact-id check has nothing to compare against unless the caller supplies
  // the id it is already holding on the lens ref.
  assert.equal(id.canonicalTopicTitle(null, "coop-conversation-architecture", "coop-conversation-architecture"),
    id.UNTITLED_TOPIC);
  // A real title still survives when the id is passed alongside it.
  assert.equal(id.canonicalTopicTitle(null, "Coop conversation architecture", "coop-conversation-architecture"),
    "Coop conversation architecture");
  assert.equal(id.canonicalTopicTitle(null, "follow-up", "auto-aa11bb22cc33dd44ee55ff66"), "follow-up");
});

test("the canonical record names the topic, not the click-time snapshot", async function () {
  var id = await loadIdentity();
  var topic = {
    topicRef: { topicId: "coop-conversation-architecture" },
    title: "Coop conversation architecture",
  };
  // A stale snapshot from before a rename must not win.
  assert.equal(id.canonicalTopicTitle(topic, "Stale snapshot title"), "Coop conversation architecture");
  assert.equal(id.canonicalTopicTitle(topic, ""), "Coop conversation architecture");
});

test("a missing canonical record falls back to the snapshot, then to a neutral label", async function () {
  var id = await loadIdentity();
  // Between the tap and the next projection push the record may not be resolvable.
  assert.equal(id.canonicalTopicTitle(null, "Queued-message recovery"), "Queued-message recovery");
  // But an id-shaped snapshot is not a title, so it degrades instead of leaking.
  assert.equal(id.canonicalTopicTitle(null, "auto-16009768de45d7073b3c960d"), id.UNTITLED_TOPIC);
  assert.equal(id.canonicalTopicTitle(null, ""), id.UNTITLED_TOPIC);
  assert.equal(id.canonicalTopicTitle(null, null), id.UNTITLED_TOPIC);
});

test("a record whose title is its own id degrades rather than showing the id", async function () {
  var id = await loadIdentity();
  var leaked = {
    topicRef: { topicId: "coop-conversation-architecture" },
    title: "coop-conversation-architecture",
  };
  assert.equal(id.canonicalTopicTitle(leaked, ""), id.UNTITLED_TOPIC);
  // A usable snapshot is still better than nothing.
  assert.equal(id.canonicalTopicTitle(leaked, "Coop conversation architecture"), "Coop conversation architecture");
});

test("topic refs are read through every identity key shape the projection uses", async function () {
  var id = await loadIdentity();
  assert.equal(id.topicIdOf({ topicId: "a" }), "a");
  assert.equal(id.topicIdOf({ topicKey: "b" }), "b");
  assert.equal(id.topicIdOf({ id: "c" }), "c");
  assert.equal(id.topicIdOf({ key: "d" }), "d");
  assert.equal(id.topicIdOf(null), "");
});

// --- Wiring: every header producer must go through the rule ------------------

test("every header-title producer routes through the one applier", function () {
  // Six paths could write #header-title, each from its own source. Any one of
  // them landing after a topic selection reverted the heading to "Coop", so the
  // rule cannot live in the call sites -- they all delegate.
  var appSource = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "app.js"), "utf8");
  assert.match(appSource, /projectName = coopHeaderTitle\(currentSlug, _cachedProjectName, _cachedProjectName\)/);

  var messages = source("app-messages.js");
  assert.match(messages, /applyCoopChatHeader\(store\.get\('projectName'\), "Clay"\)/);
  assert.doesNotMatch(messages, /headerTitleEl\.textContent = _infoTitle/);

  var sessions = source("app-messages-sessions.js");
  assert.match(sessions, /applyCoopChatHeader\(msg\.title, "Clay"\)/);
  assert.doesNotMatch(sessions, /headerTitleEl\.textContent = headerTitle/);
  assert.doesNotMatch(sessions, /headerTitleEl\.textContent = msg\.coopHome \? "Coop"/);

  var sidebar = source("sidebar.js");
  assert.match(sidebar, /applyCoopChatHeader\(sessionTitle, ctx\.projectName\)/);
  assert.doesNotMatch(sidebar, /ctx\.headerTitleEl\.textContent = headerTitle/);
  assert.doesNotMatch(sidebar, /textContent = sessionTitle \|\| ctx\.projectName \|\| "Clay"/);

  // The applier is the only module that writes the element.
  var header = source("coop-header.js");
  assert.match(header, /el\.textContent = title/);
});

test("the applier repaints on every input the heading derives from", function () {
  var header = source("coop-header.js");
  var sub = header.slice(header.indexOf("store.subscribe("));
  assert.match(sub, /state\.activeCoopLens !== previous\.activeCoopLens/);
  assert.match(sub, /state\.activeCoopTopicRef !== previous\.activeCoopTopicRef/);
  assert.match(sub, /state\.currentSlug !== previous\.currentSlug/);
  // Delayed projection delivery: a lens restored from a URL or history entry can
  // precede the projection that carries its canonical title.
  assert.match(sub, /state\.coopProjectionVersion !== previous\.coopProjectionVersion/);
  assert.match(sub, /applyCoopChatHeader\(state\.activeSessionTitle, state\.projectName\)/);
});

test("a mate DM keeps its own header instead of being repainted at all", function () {
  // updatePageTitle runs on every session-list render, and the applier runs on
  // every store change, so both have to bail out in DM mode or they would erase
  // the mate's name a moment after app-messages-dm.js set it.
  var sidebar = source("sidebar.js");
  var fn = sidebar.slice(sidebar.indexOf("export function updatePageTitle()"));
  fn = fn.slice(0, fn.indexOf("\n}"));
  assert.match(fn, /if \(!!store\.get\('dmMode'\) \|\| document\.body\.classList\.contains\("mate-dm-active"\)\) return;/);
  var guardAt = fn.indexOf('classList.contains("mate-dm-active")) return;');
  assert.ok(guardAt !== -1);
  assert.ok(guardAt < fn.indexOf("applyCoopChatHeader"));
  assert.ok(guardAt < fn.indexOf("tbProjectName.textContent"));
  assert.ok(guardAt < fn.indexOf("document.title ="));

  var header = source("coop-header.js");
  assert.match(header, /function inMateDm\(\)/);
  assert.match(header, /if \(inMateDm\(\)\) return null;/);
});

test("no other writer can repaint a Lead identity after connect", function () {
  // updateProjectList runs right after the info handler and writes the title bar
  // from the server's project title, which for the Coop project is whatever the
  // server sends.
  var projects = source("app-projects.js");
  assert.match(projects, /import \{ coopHeaderTitle \} from '\.\/coop-identity\.js'/);
  assert.match(projects, /name = coopHeaderTitle\(store\.get\('currentSlug'\)/);
  assert.match(projects, /updateTitleBarProjectIdentity\(store\.get\('projectName'\), null\)/);
  assert.doesNotMatch(projects, /var updatedName = cachedProjects\[pi\]\.title \|\| cachedProjects\[pi\]\.project;/);

  // The rename control writes arbitrary text straight into the header, and would
  // rename the canonical Coop session underneath it.
  var header = source("app-header.js");
  assert.match(header, /import \{ isCoopProjectSlug \} from '\.\/coop-identity\.js'/);
  assert.match(header, /if \(isCoopProjectSlug\(store\.get\('currentSlug'\)\)\) return;/);
});

test("a projection-only rename repaints the lens caption", function () {
  // The projection is module-local. Without a store signal, a rename that
  // arrives with no other state change leaves the caption stale.
  var projection = source("global-coop-projection.js");
  assert.match(projection, /store\.set\(\{ coopProjectionVersion: \(store\.get\("coopProjectionVersion"\) \|\| 0\) \+ 1 \}\)/);
  var state = source("coop-conversation-state.js");
  assert.match(state, /state\.coopProjectionVersion !== previous\.coopProjectionVersion/);
});

test("the Thread action cannot expose an internal identifier", function () {
  var close = source("sidebar-coop-topic-close.js");
  assert.match(close, /import \{ canonicalTopicTitle \} from '\.\/coop-identity\.js'/);
  assert.match(close, /var title = topic \? canonicalTopicTitle\(topic, "Thread"\) : "Thread"/);
  assert.doesNotMatch(close, /var title = topic && topic\.title \|\| "Thread"/);
});

test("topic rows render the canonical title rather than the raw projection field", function () {
  var topics = source("sidebar-coop-topics.js");
  assert.match(topics, /import \{ canonicalTopicTitle \} from '\.\/coop-identity\.js'/);
  assert.match(topics, /title\.textContent = canonicalTopicTitle\(topic, ""\)/);
  assert.match(topics, /var parts = \[canonicalTopicTitle\(topic, ""\)/);
  // The unguarded passthrough is gone from both the row and its aria-label.
  assert.doesNotMatch(topics, /text\(topic\.title, "Untitled topic"\)/);
});

test("the composer lens names a Thread as a Thread, resolved canonically", function () {
  var state = source("coop-conversation-state.js");
  assert.match(state, /import \{ activeCoopLensDisplay \} from '\.\/global-coop-projection\.js'/);
  assert.match(state, /lens: activeCoopLensDisplay\(\)/);
  assert.match(state, /lens\.kind === "topic" \? "Thread: " : "Project: "/);
  // A topic used to be captioned as a project, from a stale snapshot.
  assert.doesNotMatch(state, /"Project: " \+ model\.projectTitle/);
  assert.doesNotMatch(state, /projectTitle: store\.get\("activeCoopLens"\)/);
});
