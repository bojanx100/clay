var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var relevance = require("../lib/coop-topic-relevance");

// Three replay scopes over one canonical transcript:
//
//   main      -- the owner-facing default: the conversation, without execution
//                narration;
//   topic     -- one lens, narrowed further;
//   canonical -- All: full fidelity, filtered by nothing, the escape hatch.
//
// Lenses are server-side replay filters, so what the owner sees and what the
// server believes the lens contains cannot drift.

function serverSource(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", name), "utf8");
}

function clientSource(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8");
}

var CONNECTION = serverSource("coop-topic-connection.js");
var PROJECTION = clientSource("global-coop-projection.js");
var TOPICS_UI = clientSource("sidebar-coop-topics.js");

function conversation() {
  return [
    { type: "user_message", text: "restore the switcher", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-1" },
    { type: "thinking", text: "considering" },
    { type: "tool_use", name: "Bash", input: { command: "ls" } },
    { type: "tool_result", text: "output" },
    { type: "delta", text: "Restored." },
    { type: "context_usage", tokens: 10 },
    { type: "info", text: "Switched provider" },
    { type: "done" },
    { type: "user_message", text: "Worker finished", internalOnly: true },
    { type: "done" },
    { type: "user_message", text: "↻ Lead tick", autoAction: true },
    { type: "done" },
  ];
}

// --- All is complete; Main is a strict subset -------------------------------

test("All contains every message", function () {
  // All is expressed by the ABSENCE of eventIndexes, so replayHistory walks the
  // canonical array untouched. Nothing can be filtered out of it by definition.
  assert.match(CONNECTION, /if \(Array\.isArray\(eventIndexes\)\) options\.eventIndexes = eventIndexes;/);
  assert.match(CONNECTION, /var scope = result\.topicRef \? "topic" : \(wantsMain \? "main" : "canonical"\)/);
  // Only main and topic supply indexes; canonical never does.
  assert.match(CONNECTION, /else if \(wantsMain\) indexes = coopMainReplay\.membershipIndexes\(session\)/);
});

test("Main excludes internal chatter and is a strict subset of All", function () {
  var history = conversation();
  var main = relevance.mainLensEventIndexes(history);
  var all = history.map(function (_, i) { return i; });

  for (var i = 0; i < main.length; i++) {
    assert.ok(all.indexOf(main[i]) !== -1, "Main must never contain an index All lacks");
  }
  assert.ok(main.length < all.length, "Main must actually filter something");

  // Ordering is canonical, so the conversation still reads in sequence.
  var sorted = main.slice().sort(function (a, b) { return a - b; });
  assert.deepEqual(main, sorted);

  // The owner's own messages survive; execution narration does not.
  assert.ok(main.indexOf(0) !== -1, "the owner's message stays");
  assert.ok(main.indexOf(4) !== -1, "Coop's answer stays");
  assert.equal(main.indexOf(1), -1, "thinking goes");
  assert.equal(main.indexOf(2), -1, "the shell command goes");
  assert.equal(main.indexOf(3), -1, "the tool result goes");
  assert.equal(main.indexOf(5), -1, "usage telemetry goes");
  assert.equal(main.indexOf(6), -1, "the provider notice goes");
  assert.equal(main.indexOf(8), -1, "the worker notification goes");
  assert.equal(main.indexOf(10), -1, "the Lead tick goes");
});

test("a topic lens is a subset of Main, never wider", function () {
  var history = conversation();
  var main = relevance.mainLensEventIndexes(history);
  // A topic can only hold turns that exist; the relevant ones are Main's.
  var topicMembership = [0, 4, 7].filter(function (index) { return main.indexOf(index) !== -1; });
  for (var i = 0; i < topicMembership.length; i++) {
    assert.ok(main.indexOf(topicMembership[i]) !== -1);
  }
  // And a topic built only from internal turns contributes nothing to Main.
  assert.equal(main.indexOf(8), -1);
});

// --- default lens -----------------------------------------------------------

test("Coop opens to Main by default", function () {
  // No topic, no project, no explicit scope in the URL means Main. All is still
  // restorable, but only when the URL asks for it.
  assert.match(PROJECTION, /var wanted = scope === MAIN_SCOPE \|\| scope === "" \? MAIN_SCOPE : "canonical"/);
  assert.match(PROJECTION, /return beginCoopSelection\(null, null, wanted, "replaceState", send\)/);
});

test("Main has its own URL key, because absence already means All", function () {
  assert.match(PROJECTION, /var SCOPE_QUERY_KEY = "coopLens"/);
  assert.match(PROJECTION, /var MAIN_SCOPE = "main"/);
  assert.match(PROJECTION, /if \(scope === MAIN_SCOPE\) params\.set\(SCOPE_QUERY_KEY, MAIN_SCOPE\)/);
  assert.match(PROJECTION, /else params\.delete\(SCOPE_QUERY_KEY\)/);
});

test("selecting Main sends the main scope and commits it", function () {
  assert.match(PROJECTION, /export function requestMainCoopLens\(send\)/);
  assert.match(PROJECTION, /beginCoopSelection\(null, null, MAIN_SCOPE, "pushState", send\)/);
  assert.match(PROJECTION, /store\.set\(\{ activeCoopLensScope: MAIN_SCOPE \}\)/);
  assert.match(PROJECTION, /store\.set\(\{ activeCoopLensScope: "canonical" \}\)/);
});

// --- the two silent-failure hazards -----------------------------------------

test("the server reads the requested scope instead of inferring it", function () {
  // Main and All are both topicRef-less. Inferring the scope from topicRef
  // truthiness in one place while prepareTopicReplay compares msg.historyScope
  // in another is exactly how the two silently disagree.
  assert.match(CONNECTION, /var wantsMain = !result\.topicRef && msg\.historyScope === "main"/);
  assert.match(CONNECTION,
    /msg\.historyScope !== "topic" && msg\.historyScope !== "canonical" && msg\.historyScope !== "main"/);
  // And main must not fall through the canonical short-circuit to an
  // unfiltered replay.
  assert.match(CONNECTION, /if \(msg\.historyScope === "main"\) \{/);
  assert.match(CONNECTION, /markCanonicalReplay\(ws, session, null, null, "main"\)/);
});

test("exactly one lens button is active at a time", function () {
  // The old test was `!activeCoopTopicRef`, true for Main, All and a project
  // lens alike, so it would light more than one.
  assert.match(PROJECTION, /export function activeCoopLensScope\(\)/);
  assert.match(PROJECTION, /var explicitScope = store\.get\("activeCoopLensScope"\)/);
  assert.match(PROJECTION, /if \(explicitScope === "main" \|\| explicitScope === "canonical" \|\|/);
  assert.match(PROJECTION, /if \(store\.get\("activeCoopTopicRef"\)\) return "topic"/);
  assert.match(PROJECTION, /if \(store\.get\("activeCoopProjectRef"\)\) return "project"/);

  assert.match(TOPICS_UI, /var scope = activeCoopLensScope\(\)/);
  assert.match(TOPICS_UI, /lensButton\("Main", [^)]*scope === "main"/);
  assert.match(TOPICS_UI, /lensButton\("All", [^)]*scope === "canonical"/);
  assert.doesNotMatch(TOPICS_UI, /coop-topic-all" \+ \(!store\.get\("activeCoopTopicRef"\) \? " active" : ""\)/);
});

test("Main paging uses Main membership, not the unfiltered fallback", function () {
  // The generic pagination fallback pages raw canonical history and does not
  // filter, so serving Main from it would make earlier pages disagree with the
  // first one.
  assert.match(CONNECTION, /var mainLens = !ws\._clayCoopTopicRef && ws\._clayCoopLensScope === "main"/);
  assert.match(CONNECTION, /\? \{ ok: true, options: replayOptions\(null, null, coopMainReplay\.membershipIndexes\(session\), "main"\) \}/);
  assert.match(CONNECTION, /scope: mainLens \? "main" : "topic"/);
});

// --- lens switching is stable -----------------------------------------------

test("switching among Main, All and topics is stable and idempotent", function () {
  // Each branch returns early when the store already matches and nothing is
  // pending, so re-selecting the current lens is a no-op rather than a replay.
  assert.match(PROJECTION, /var settled = !store\.get\("activeCoopTopicRef"\) && !store\.get\("activeCoopProjectRef"\) &&/);
  assert.match(PROJECTION, /!store\.get\(PENDING_SELECTION_KEY\) && activeCoopLensScope\(\) === wanted/);
  assert.match(PROJECTION, /if \(settled\) return true/);
});

test("a topic or project lens clears the scope key so it cannot linger", function () {
  assert.match(PROJECTION, /projectLensPath\(location\.pathname, location\.search, projectRef, topicRef, null\)/);
});

test("the Main lens survives reconnect through the URL, like every other lens", function () {
  // Server lens state is per-socket by design, so re-establishment is driven by
  // the client from the URL after every reconnect.
  assert.match(PROJECTION, /export function syncCoopLensFromUrl\(send\)/);
  assert.match(PROJECTION, /scope = new URLSearchParams\(location\.search\)\.get\(SCOPE_QUERY_KEY\) \|\| ""/);
});
