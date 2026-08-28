var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

// Main is a server replay scope, so lens selection and reconnect already arrive
// filtered. Live streaming does not go through replay: during an active turn
// the server pushes every event to every viewer. Without live classification
// Main would be clean on entry and fill with execution narration as Coop
// worked -- clean eventually rather than continuously.

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function clientSource(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8");
}

async function loadRelevance() {
  return import(modulePath("coop-lens-relevance.js"));
}

// --- live classification ----------------------------------------------------

test("conversational blocks are owner-relevant live", async function () {
  var lens = await loadRelevance();
  assert.equal(lens.messageRelevance({
    type: "user_message", text: "restore it",
    from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-1",
  }), "owner");
  assert.equal(lens.messageRelevance({ type: "delta", text: "working on it" }), "owner");
  assert.equal(lens.messageRelevance({ type: "delta_replace", text: "done" }), "owner");
  assert.equal(lens.messageRelevance({ type: "result", text: "done" }), "owner");
  assert.equal(lens.messageRelevance({ type: "done" }), "owner");
  // Genuine questions and blockers are owner business, not narration.
  assert.equal(lens.messageRelevance({ type: "ask_user", question: "which branch?" }), "owner");
  assert.equal(lens.messageRelevance({ type: "needs_input" }), "owner");
  assert.equal(lens.messageRelevance({ type: "error", text: "build failed" }), "owner");
});

test("tool, shell and thinking blocks are internal live", async function () {
  var lens = await loadRelevance();
  assert.ok(lens.isInternalMessage({ type: "tool_use", name: "Bash", input: { command: "ls" } }));
  assert.ok(lens.isInternalMessage({ type: "tool_result", text: "output" }));
  assert.ok(lens.isInternalMessage({ type: "mcp_tool_call" }));
  assert.ok(lens.isInternalMessage({ type: "thinking", text: "considering" }));
  assert.ok(lens.isInternalMessage({ type: "subagent_activity" }));
  assert.ok(lens.isInternalMessage({ type: "permission_request" }));
});

test("routing, provider and telemetry status blocks are internal live", async function () {
  var lens = await loadRelevance();
  // Every provider/routing/binding/recovery notice arrives as bare `info`.
  assert.ok(lens.isInternalMessage({ type: "info", text: "Switched provider" }));
  assert.ok(lens.isInternalMessage({ type: "context_usage" }));
  assert.ok(lens.isInternalMessage({ type: "rate_limit_usage" }));
  assert.ok(lens.isInternalMessage({ type: "model_info" }));
  assert.ok(lens.isInternalMessage({ type: "sdk_notification" }));
  assert.ok(lens.isInternalMessage({ type: "orchestration_tasks_state" }));
});

test("the live Lead tick is internal, recognised by flag not by label text", async function () {
  var lens = await loadRelevance();
  // It reaches the client as an ordinary user_message whose text is a label.
  assert.ok(lens.isInternalMessage({ type: "user_message", text: "↻ Lead tick", autoAction: true }));
  // Matching the label text would rot the moment the label changes. The rule is
  // provenance: an owner who types those exact words is still the owner, and
  // their message carries the markers the injected prompt never has.
  assert.ok(!lens.isInternalMessage({
    type: "user_message", text: "↻ Lead tick",
    from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-1",
  }));
  // And the injected prompt is internal even with no flag at all, which is the
  // shape 198 real records in the owner's transcript actually have.
  assert.ok(lens.isInternalMessage({ type: "user_message", text: "↻ Lead tick" }));
});

test("repeated internal Lead ticks coalesce live while owner messages stay deliverable", async function () {
  var lens = await loadRelevance();
  var tracker = lens.createTurnRelevanceTracker();
  var running = { type: "delta", text: "Running the tick; I'll report only if the state changes." };
  var unchanged = { type: "delta", text: "No state change. The worker remains active." };
  var tick = { type: "user_message", text: "↻ Lead tick", autoAction: true };

  assert.equal(tracker.relevance(tick), "internal");
  assert.equal(tracker.relevance(running), "owner");
  assert.equal(tracker.relevance(unchanged), "owner");
  assert.equal(tracker.relevance({ type: "done" }), "internal");

  assert.equal(tracker.relevance(tick), "internal");
  assert.equal(tracker.relevance(running), "internal");
  assert.equal(tracker.relevance(unchanged), "internal");
  assert.equal(tracker.relevance({ type: "done" }), "internal");

  assert.equal(tracker.relevance({
    type: "user_message", text: "send this user message",
    from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-1",
  }), "owner");
  assert.equal(tracker.relevance({ type: "delta", text: "Delivered." }), "owner");
  assert.equal(tracker.relevance({ type: "done" }), "owner");
});

test("worker fan-in is internal live", async function () {
  var lens = await loadRelevance();
  assert.ok(lens.isInternalMessage({
    type: "user_message", text: "Worker finished",
    synthetic: true, origin: { kind: "task-notification" }, internalOnly: true,
  }));
  assert.ok(lens.isInternalMessage({ type: "user_message", text: "x", internalOnly: true }));
});

test("an unknown live type stays visible rather than vanishing", async function () {
  var lens = await loadRelevance();
  // Denylist, not allowlist: a new operational type leaking into Main is a
  // visible annoyance; a new conversational type disappearing is lost content.
  assert.equal(lens.messageRelevance({ type: "some_future_owner_type", text: "x" }), "owner");
});

test("the live vocabulary matches the replay vocabulary", async function () {
  // Two predicates that disagree would make Main differ before and after a
  // reconnect, which is exactly the discontinuity this must not have.
  var lens = await loadRelevance();
  var server = require("../lib/coop-topic-relevance");
  var types = Object.keys(server.OPERATIONAL_EVENT_TYPES);
  for (var i = 0; i < types.length; i++) {
    assert.ok(lens.isInternalMessage({ type: types[i] }),
      types[i] + " is operational on replay and must be internal live too");
  }
  // And the shared flag-based rules agree.
  var flagged = [
    { type: "user_message", internalOnly: true },
    { type: "user_message", autoAction: true },
    { type: "user_message", synthetic: true, origin: { kind: "task-notification" } },
  ];
  for (var f = 0; f < flagged.length; f++) {
    assert.ok(lens.isInternalMessage(flagged[f]));
    assert.ok(server.isInternalHistoryItem(flagged[f]));
  }
});

test("live disclosure projection agrees with replay and repairs split assistant deltas", async function () {
  var lens = await loadRelevance();
  var server = require("../lib/coop-topic-relevance");
  var disclosure = server.LEAD_AUTHORITY_DISCLOSURES[0];
  assert.deepEqual(lens.LEAD_AUTHORITY_DISCLOSURES, server.LEAD_AUTHORITY_DISCLOSURES,
    "the client and replay paths share the exact, deliberately narrow fallback contract");

  var projector = lens.createMainAuthorityDisclosureProjector();
  var first = projector.project({ type: "delta", text: "Useful status.\n\n" + disclosure.slice(0, 43) });
  assert.equal(first.type, "delta", "ordinary streaming stays append-only until the exact sentence is complete");
  var completed = projector.project({
    type: "delta",
    text: disclosure.slice(43) + "\n\nThe owner-facing blocker remains visible.",
  });
  assert.equal(completed.type, "delta_replace");
  assert.equal(completed.text.indexOf(disclosure), -1);
  assert.match(completed.text, /Useful status/);
  assert.match(completed.text, /owner-facing blocker remains visible/);

  projector.project({ type: "done" });
  var ownerQuote = { type: "user_message", text: disclosure, from: "owner-1", clientMessageId: "quote-1" };
  assert.equal(projector.project(ownerQuote), ownerQuote,
    "the exact sentence in a genuine owner message is not suppression evidence");
});

// --- wiring: classified at dispatch, marked at the one appender -------------

test("every block is classified before it renders", function () {
  var messages = clientSource("app-messages.js");
  assert.match(messages, /setCurrentBlockRelevance\(turnRelevanceTracker\.relevance\(msg\)\)/);
  // Before any handler runs, so every block the message produces is marked.
  var dispatch = messages.slice(messages.indexOf("export function processMessage(msg)"));
  assert.ok(dispatch.indexOf("setCurrentBlockRelevance(turnRelevanceTracker.relevance(msg))") <
    dispatch.indexOf("if (handleLiveUiMessage(msg)) return;"));
  assert.match(dispatch, /turnRelevanceTracker\.reset\(\)/);

  var rendering = clientSource("app-rendering.js");
  assert.match(rendering, /export function setCurrentBlockRelevance\(relevance\)/);
  assert.match(rendering, /el\.dataset\.coopRelevance = currentBlockRelevance/);
});

// --- the flat-child invariants the owner named ------------------------------

test("classification marks blocks and never drops, wraps or reorders them", function () {
  var rendering = clientSource("app-rendering.js");
  var fn = rendering.slice(rendering.indexOf("export function addToMessages(el)"));
  fn = fn.slice(0, fn.indexOf("\n}"));

  // Marking happens; no early return can skip an append.
  assert.match(fn, /if \(!el\.dataset\.coopRelevance\) el\.dataset\.coopRelevance = currentBlockRelevance;/);
  assert.doesNotMatch(fn, /coopRelevance[^\n]*\breturn\b/);

  // The five mechanisms that assume a flat ordered child list are untouched.
  assert.match(fn, /el\.dataset\.clayTs = String\(currentMsgTs\)/);
  assert.match(fn, /el\.dataset\.historyIndex = String\(currentHistoryIndex\)/);
  assert.match(fn, /messagesEl\.insertBefore\(el, prependAnchor\)/);
  assert.match(fn, /messagesEl\.appendChild\(el\)/);
  assert.match(fn, /messagesEl\.appendChild\(_sme\)/);
  assert.match(fn, /messagesEl\.appendChild\(_pte\)/);
  assert.match(fn, /messagesEl\.appendChild\(activityEl\)/);
});

test("filtering is a direct-child rule, so nested structure is never disturbed", function () {
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "messages.css"), "utf8");
  // Direct child, so a tool item inside a tool group is governed by its group
  // rather than being hidden independently and stranding the group header.
  assert.match(css, /#messages\[data-coop-lens="main"\] > \[data-coop-relevance="internal"\] \{\s*\n\s*display: none;/);
  // No rule hides the whole transcript or the re-pinned transient elements.
  assert.doesNotMatch(css, /#messages\[data-coop-lens="main"\] \{\s*\n\s*display: none/);
});

test("vendor dividers still sort by timestamp across the full child list", function () {
  var messages = clientSource("app-messages.js");
  // The divider walks messagesEl.children; hidden blocks are still children, so
  // its timestamp-ordered insert is unaffected by the lens.
  assert.match(messages, /var children = messagesEl\.children;/);
  assert.match(messages, /var childTs = Number\(children\[ci\]\.dataset \? children\[ci\]\.dataset\.clayTs : 0\)/);
  assert.match(messages, /messagesEl\.insertBefore\(divider, children\[ci\]\)/);
});

test("grouping, pagination renumbering and cursors still see every block", function () {
  var rendering = clientSource("app-rendering.js");
  // Grouping reads lastElementChild; a hidden block is still the last child, so
  // grouping stays consistent between lenses.
  assert.match(rendering, /getMessagesEl\(\)\.lastElementChild/);

  var header = clientSource("app-header.js");
  // Renumbering walks every [data-turn] regardless of lens.
  assert.match(header, /querySelectorAll\("\[data-turn\]"\)/);

  var cursors = clientSource("app-cursors.js");
  assert.match(cursors, /\[data-turn\]/);
});

// --- lens switching ---------------------------------------------------------

test("the lens is one attribute, so switching cannot duplicate or lose blocks", function () {
  var header = clientSource("coop-header.js");
  assert.match(header, /export function applyCoopLensAttribute\(\)/);
  assert.match(header, /if \(el\.dataset\.coopLens !== scope\) el\.dataset\.coopLens = scope;/);
  // Switching only rewrites that attribute -- it never re-renders, re-fetches
  // or removes transcript blocks, so no discontinuity and no duplicates.
  var fn = header.slice(header.indexOf("export function applyCoopLensAttribute()"));
  fn = fn.slice(0, fn.indexOf("\n}"));
  assert.doesNotMatch(fn, /innerHTML|removeChild|appendChild|replaceChildren/);
});

test("the lens attribute follows every scope change", function () {
  var header = clientSource("coop-header.js");
  var sub = header.slice(header.indexOf("store.subscribe("));
  assert.match(sub, /state\.activeCoopLensScope !== previous\.activeCoopLensScope/);
  assert.match(sub, /state\.activeCoopTopicRef !== previous\.activeCoopTopicRef/);
  assert.match(sub, /state\.activeCoopProjectRef !== previous\.activeCoopProjectRef/);
  assert.match(sub, /state\.currentSlug !== previous\.currentSlug/);
  assert.match(header, /applyCoopLensAttribute\(\);\n  if \(inMateDm\(\)\) return null;/);
});

test("only Coop filters; an ordinary project transcript is never touched", function () {
  var header = clientSource("coop-header.js");
  assert.match(header,
    /var scope = isCoopProjectSlug\(store\.get\('currentSlug'\)\) \? activeCoopLensScope\(\) : "";/);
  // With no lens attribute the CSS rule cannot match, so ordinary projects show
  // every block exactly as before.
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "messages.css"), "utf8");
  assert.match(css, /#messages\[data-coop-lens="main"\]/);
});

test("All shows everything live, including what Main filters", function () {
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "messages.css"), "utf8");
  // The only hiding rule is scoped to the main lens, so under All (and under a
  // topic lens, whose membership the server already filtered) nothing is hidden.
  var hidingRules = css.match(/#messages\[data-coop-lens="[^"]+"\][^{]*\{[^}]*display:\s*none/g) || [];
  assert.equal(hidingRules.length, 1);
  assert.match(hidingRules[0], /data-coop-lens="main"/);
});
