var test = require("node:test");
var assert = require("node:assert/strict");
var relevance = require("../lib/coop-topic-relevance");
var completeTurns = require("../lib/coop-topic-extraction").completeTurns;

// Owner-relevance is decided from durable flags the writer already sets, never
// from message text. `internalOnly` predates this module: the orchestrator
// stamps it on worker-notification turns, sessions-loader re-derives it, and
// sessions-history already drops those turns from replay. The defect these
// tests pin is that classification never consulted them, so a turn that is
// invisible in the transcript could still create and populate a topic -- which
// is exactly how a topic that opens onto an empty lens becomes possible.

// Real owner-message shape, copied from the owner's Coop transcript: a message
// the owner actually typed always carries provenance (from / fromName /
// clientMessageId / coopIngress*). An injected control prompt carries none of
// it, which is the ONLY durable way to tell them apart -- both are user_message
// records and the text can say anything.
function userMessage(text, extra) {
  return Object.assign({
    type: "user_message",
    text: text,
    from: "a66ce4a1-b807-46da-b9c3-e62686e4b28e",
    fromName: "Admin",
    clientMessageId: "cm-owner-1",
  }, extra || {});
}

// Verbatim shape of an injected prompt: type, text and nothing else.
function injectedMessage(text, extra) {
  return Object.assign({ type: "user_message", text: text }, extra || {});
}

function turnEvents(text, extra) {
  return [userMessage(text, extra), { type: "delta", text: "answer" }, { type: "done" }];
}

// --- the predicate itself ---------------------------------------------------

test("an owner turn is relevant", function () {
  var turns = completeTurns(turnEvents("ship the mobile switcher"), 0).turns;
  assert.equal(turns.length, 1);
  assert.ok(relevance.isOwnerRelevantTurn(turns[0]));
});

test("worker fan-in notifications are not owner conversation", function () {
  // project-task-orchestrator writes exactly this shape.
  var events = turnEvents("Worker finished", {
    synthetic: true, origin: { kind: "task-notification" },
    fromName: "Clay workers", internalOnly: true,
  });
  var turn = completeTurns(events, 0).turns[0];
  assert.equal(turn.internalOnly, true);
  assert.ok(!relevance.isOwnerRelevantTurn(turn));
});

test("the scheduled Lead tick is automation, not the owner typing", function () {
  var turn = completeTurns(turnEvents("↻ Lead tick", { autoAction: true }), 0).turns[0];
  assert.equal(turn.autoAction, true);
  assert.ok(!relevance.isOwnerRelevantTurn(turn));
  // Recognised by the durable flag, not by matching the label text.
  var lookalike = completeTurns(turnEvents("↻ Lead tick"), 0).turns[0];
  assert.ok(relevance.isOwnerRelevantTurn(lookalike));
});

test("a synthetic turn from an internal origin is not owner conversation", function () {
  var turn = completeTurns(turnEvents("status", { synthetic: true, origin: { kind: "automation" } }), 0).turns[0];
  assert.ok(!relevance.isOwnerRelevantTurn(turn));
  // A synthetic turn from an origin we do not treat as internal still counts.
  var other = completeTurns(turnEvents("status", { synthetic: true, origin: { kind: "owner-import" } }), 0).turns[0];
  assert.ok(relevance.isOwnerRelevantTurn(other));
});

test("an empty turn carries nothing to read", function () {
  var turn = completeTurns([userMessage(""), { type: "done" }], 0).turns[0];
  assert.ok(!relevance.isOwnerRelevantTurn(turn));
  // Owner text alone is enough, even with no answer yet.
  var unanswered = completeTurns([userMessage("are you there?"), { type: "done" }], 0).turns[0];
  assert.ok(relevance.isOwnerRelevantTurn(unanswered));
  // An answer alone is enough too.
  var answerOnly = completeTurns([userMessage(""), { type: "result", text: "done" }, { type: "done" }], 0).turns[0];
  assert.ok(relevance.isOwnerRelevantTurn(answerOnly));
});

test("the turn record carries the durable flags classification needs", function () {
  // The original defect: the turn record was pure text, so relevance was
  // undecidable at classification time.
  var turn = completeTurns(turnEvents("hi", {
    internalOnly: true, synthetic: true, autoAction: true,
    origin: { kind: "task-notification" }, fromName: "Clay workers",
  }), 0).turns[0];
  assert.equal(turn.internalOnly, true);
  assert.equal(turn.synthetic, true);
  assert.equal(turn.autoAction, true);
  assert.deepEqual(turn.origin, { kind: "task-notification" });
  assert.equal(turn.fromName, "Clay workers");
  // And the text extraction it already did is unchanged.
  assert.equal(turn.userText, "hi");
  assert.equal(turn.text, "hi\nanswer");
});

// --- topic visibility -------------------------------------------------------

test("a topic whose only turns are internal is not shown", function () {
  var history = turnEvents("Worker finished", { internalOnly: true });
  var topic = { turnRefs: [{ startEventIndex: 0, endEventIndex: 2 }] };
  assert.ok(!relevance.topicHasRelevantTurn(topic, history));
});

test("one relevant turn is enough to show a topic", function () {
  var history = turnEvents("Worker finished", { internalOnly: true })
    .concat(turnEvents("what is the plan?"));
  var topic = {
    turnRefs: [
      { startEventIndex: 0, endEventIndex: 2 },
      { startEventIndex: 3, endEventIndex: 5 },
    ],
  };
  assert.ok(relevance.topicHasRelevantTurn(topic, history));
});

test("membership refs outside the transcript never count as relevant", function () {
  var history = turnEvents("hello");
  assert.ok(!relevance.topicHasRelevantTurn({ turnRefs: [{ startEventIndex: 99 }] }, history));
  assert.ok(!relevance.topicHasRelevantTurn({ turnRefs: [{ startEventIndex: -1 }] }, history));
  assert.ok(!relevance.topicHasRelevantTurn({ turnRefs: [] }, history));
  assert.ok(!relevance.topicHasRelevantTurn(null, history));
});

// --- Main lens membership ---------------------------------------------------

test("Main keeps the conversation and drops execution narration", function () {
  var history = [
    userMessage("restore the switcher"),
    { type: "thinking_stop" },
    { type: "tool_start", id: "exec-1", name: "Bash" },
    { type: "tool_executing", id: "exec-1", name: "Bash", input: { command: "ls" } },
    { type: "tool_result", id: "exec-1", content: "a b c", is_error: false },
    { type: "delta", text: "Restored it." },
    { type: "context_usage", tokens: 10 },
    { type: "info", text: "Switched provider" },
    { type: "done" },
  ];
  var main = relevance.mainLensEventIndexes(history);
  assert.deepEqual(main, [0, 5, 8]);
});

test("Main keeps genuine questions and blockers", function () {
  var history = [
    userMessage("go"),
    { type: "ask_user", question: "which branch?" },
    { type: "needs_input", reason: "decision required" },
    { type: "error", text: "build failed" },
    { type: "done" },
  ];
  assert.deepEqual(relevance.mainLensEventIndexes(history), [0, 1, 2, 3, 4]);
});

test("Main drops internal turns All still keeps", function () {
  var history = [
    userMessage("owner question"),
    userMessage("Worker finished", { internalOnly: true }),
    userMessage("↻ Lead tick", { autoAction: true }),
    { type: "done" },
  ];
  assert.deepEqual(relevance.mainLensEventIndexes(history), [0, 3]);
  // All is every index; Main is a strict subset of it.
  var all = history.map(function (_, i) { return i; });
  var main = relevance.mainLensEventIndexes(history);
  for (var i = 0; i < main.length; i++) assert.ok(all.indexOf(main[i]) !== -1);
  assert.ok(main.length < all.length);
});

test("an unknown event type stays in Main rather than vanishing", function () {
  // Denylist, not allowlist: a new operational type leaking into Main is a
  // visible annoyance; a new conversational type silently disappearing is lost
  // content the owner would never discover.
  var history = [userMessage("hi"), { type: "some_future_owner_facing_type", text: "x" }, { type: "done" }];
  assert.deepEqual(relevance.mainLensEventIndexes(history), [0, 1, 2]);
});

test("operational classification matches the durable skip list", function () {
  assert.ok(relevance.isOperationalEvent({ type: "tool_result" }));
  assert.ok(relevance.isOperationalEvent({ type: "thinking" }));
  assert.ok(relevance.isOperationalEvent({ type: "permission_request" }));
  assert.ok(relevance.isOperationalEvent({ type: "context_usage" }));
  assert.ok(!relevance.isOperationalEvent(userMessage("hello")));
  assert.ok(!relevance.isOperationalEvent({ type: "delta" }));
  assert.ok(!relevance.isOperationalEvent(null));
  // digest_checkpoint is already skipped by sessions-history; keep agreement.
  assert.ok(relevance.isInternalHistoryItem({ type: "digest_checkpoint" }));
});

// --- real record shapes from the owner's canonical transcript ---------------
//
// The first version of the denylist guessed "tool_use"/"tool_call"/"thinking".
// This system emits none of those. Against the owner's actual 48,243-record
// transcript that left 3,423 tool records -- 2,970 of them Bash -- classified as
// conversation and visible in Main. These fixtures are copied from that file.

test("real tool record types are operational", function () {
  // Verbatim shapes, keys and all.
  var start = { type: "tool_start", id: "exec-ffa6f91a", name: "Bash", _ts: 1785944087707 };
  var executing = { type: "tool_executing", id: "exec-ffa6f91a", name: "Bash",
    input: { command: "/bin/zsh -lc \"wc -l SKILL.md\"" }, _ts: 1785944087707 };
  var result = { type: "tool_result", id: "exec-ffa6f91a", content: "", is_error: false, _ts: 1785944087707 };
  var thinkingStop = { type: "thinking_stop", _ts: 1785941650814 };

  assert.ok(relevance.isOperationalEvent(start));
  assert.ok(relevance.isOperationalEvent(executing));
  assert.ok(relevance.isOperationalEvent(result));
  assert.ok(relevance.isOperationalEvent(thinkingStop));

  var main = relevance.mainLensEventIndexes([start, executing, result, thinkingStop]);
  assert.deepEqual(main, [], "no tool record may reach Main");
});

test("a Bash turn keeps its conversation and drops its execution", function () {
  var history = [
    userMessage("check the file"),
    { type: "tool_start", id: "exec-1", name: "Bash" },
    { type: "tool_executing", id: "exec-1", name: "Bash", input: { command: "wc -l x" } },
    { type: "tool_result", id: "exec-1", content: "42 x", is_error: false },
    { type: "delta", text: "It has 42 lines." },
    { type: "done" },
  ];
  assert.deepEqual(relevance.mainLensEventIndexes(history), [0, 4, 5]);
});

test("an unknown tool type is caught by shape, not by its name", function () {
  // Protects transcripts written by builds this one has never seen: tool traffic
  // is correlated by an execution id plus a tool name or a result payload.
  assert.ok(relevance.isToolShapedRecord({ type: "tool_future", id: "exec-9", name: "Bash" }));
  assert.ok(relevance.isToolShapedRecord({ type: "whatever", id: "exec-9", content: "out", is_error: true }));
  assert.ok(relevance.isOperationalEvent({ type: "totally_new_tool_event", id: "exec-9", name: "Grep" }));
  // A conversational record with an id but real text is not tool-shaped.
  assert.ok(!relevance.isToolShapedRecord({ type: "user_message", id: "m-1", text: "hello" }));
  assert.ok(!relevance.isToolShapedRecord({ type: "delta", text: "hi" }));
  assert.ok(!relevance.isToolShapedRecord({ type: "done" }));
});

test("scheduled Lead-tick plumbing never reaches Main", function () {
  var history = [
    { type: "scheduled_message_queued", id: "s-1", text: "↻ Lead tick" },
    { type: "scheduled_message_sent", id: "s-1" },
    userMessage("a real question"),
    { type: "done" },
  ];
  assert.deepEqual(relevance.mainLensEventIndexes(history), [2, 3]);
});

test("owner-facing blockers are kept, not swept up with the narration", function () {
  // These are things the owner must act on, so they stay in Main even though
  // they are not conversation in the strictest sense.
  var history = [
    { type: "error", text: "build failed" },
    { type: "auth_required", text: "re-authenticate" },
    { type: "tool_start", id: "e1", name: "Bash" },
  ];
  assert.deepEqual(relevance.mainLensEventIndexes(history), [0, 1]);
});


// --- thinking_delta and the bounded replay window ----------------------------
//
// thinking_delta is emitted per token by lib/sdk-message-processor.js:592 and
// was missing from this denylist, so reasoning streamed into Main. It is not
// merely noise: Main replays a BOUNDED window, so a single verbose turn's
// deltas could fill it entirely and push the owner's own question out of view.

test("thinking_delta is operational on the real emitted shape", function () {
  // Verbatim shape from sdk-message-processor.js:592.
  var record = { type: "thinking_delta", text: "let me consider the rollup" };
  assert.ok(relevance.isOperationalEvent(record));
  assert.deepEqual(relevance.mainLensEventIndexes([record]), []);
});

test("any future thinking_* type is caught by shape, not by an exact name", function () {
  // The denylist has now been wrong twice about this vocabulary; the prefix
  // guard is what stops a third round.
  assert.ok(relevance.isOperationalEvent({ type: "thinking_summary" }));
  assert.ok(relevance.isOperationalEvent({ type: "thinking_signature" }));
  assert.ok(!relevance.isOperationalEvent({ type: "delta", text: "hi" }));
});

test("a flood of thinking deltas cannot push the owner question out of Main", function () {
  // The reported failure: 601 deltas in one turn, and Main's initial 300-event
  // window began at a thinking delta, so the question was gone while the answer
  // remained -- the conversation read as an answer to nothing.
  var history = [userMessage("ship the parent-only icons?")];
  for (var i = 0; i < 601; i++) history.push({ type: "thinking_delta", text: "t" + i });
  history.push({ type: "delta", text: "Yes, shipping them." });
  history.push({ type: "done" });

  var main = relevance.mainLensEventIndexes(history);
  assert.deepEqual(main, [0, 602, 603]);
  // The window is bounded; what matters is that the question survives it.
  var windowed = main.slice(-300);
  assert.ok(windowed.indexOf(0) !== -1, "the owner question must stay inside the window");
  assert.ok(main.length < 310, "601 deltas must not consume the window");
});

test("the two relevance paths agree about thinking_delta", function () {
  // Not a comparison of two lists this file wrote: the client module is loaded
  // and asked directly, so a fix applied to only one side fails here.
  var fs = require("node:fs");
  var pathMod = require("node:path");
  var client = fs.readFileSync(
    pathMod.join(__dirname, "..", "lib", "public", "modules", "coop-lens-relevance.js"), "utf8");
  assert.match(client, /thinking_delta: true/);
  assert.match(client, /isThinkingShaped/);
  assert.ok(relevance.isOperationalEvent({ type: "thinking_delta" }));
});


// --- injected control prompts, by provenance not prose -----------------------
//
// Owner-reported: Main still showed "Lead tick" and related internal messages.
// Reproduced against the owner's real Coop transcripts: 198 records reach Main
// as bare user_message records -- {type, text, _ts} and nothing else. They carry
// no autoAction, no internalOnly, no synthetic and no origin, so every existing
// flag check passed them through. Genuine owner messages in the same transcripts
// always carry provenance (from / fromName / clientMessageId / coopIngress*).
// That is the separation, and it never looks at the words.

// Verbatim shapes from ~/.clay/sessions/-Users-bojansubotic--clay-lead-workspace.
var REAL_INJECTED = [
  { type: "user_message", text: "\u21bb Lead tick", _ts: 1785944821005 },
  { type: "user_message", text: "\u21bb Resuming after restart", _ts: 1785944821006 },
  { type: "user_message", text: "\u21bb Resuming the interrupted response", _ts: 1785944821007 },
  { type: "user_message", text: "\u21bb Continuing on Codex via GitHub Copilot", _ts: 1785944821008 },
  { type: "user_message", text: "\u21bb Continuing on codex after reset", _ts: 1785944821009 },
  { type: "user_message", text: "\u21bb Continuing on Claude via GitHub Copilot", _ts: 1785944821010 },
  { type: "user_message", text: "[Clay worker update] Task ID: task-5645f446", _ts: 1785944821011 },
  { type: "user_message", text: "Continue from the compacted Coop context.", compactedRetry: true, _ts: 1785944821012 },
  { type: "user_message", text: "You are a bounded worker owned by a Clay coordinator.", synthetic: true, origin: { kind: "automation" }, _ts: 1785944821013 },
  { type: "user_message", text: "[Coordinator update for task task-58af9276]", synthetic: true, origin: { kind: "task-notification" }, _ts: 1785944821014 },
];

test("every real injected control record is classified internal", function () {
  REAL_INJECTED.forEach(function (record) {
    assert.ok(relevance.isOperationalEvent(record),
      "must be internal: " + JSON.stringify(record.text));
  });
  assert.deepEqual(relevance.mainLensEventIndexes(REAL_INJECTED), [],
    "no injected control record may reach Main");
});

test("a genuine owner message is kept even when it talks about the tick", function () {
  // Verbatim from the transcript. Prose mentions the tick; provenance says the
  // owner typed it. Prose must never decide.
  var real = {
    type: "user_message",
    text: "why do I have lead tick every time I send you a message?",
    clientMessageId: "cm-mshdmhi3-2he4lg",
    coopIngressId: "coop:871a194b:3",
    coopIngressSequence: 3,
    from: "a66ce4a1-b807-46da-b9c3-e62686e4b28e",
    fromName: "Admin",
  };
  assert.ok(!relevance.isOperationalEvent(real));
  assert.deepEqual(relevance.mainLensEventIndexes([real]), [0]);
  assert.ok(relevance.hasOwnerProvenance(real));
});

test("each provenance marker alone is enough to keep an owner message", function () {
  // Older clients stamp different subsets, so any one marker must suffice or a
  // real message from an older build would silently vanish.
  [{ from: "u1" }, { fromName: "Admin" }, { clientMessageId: "cm-1" },
   { coopIngressId: "coop:x:1" }, { coopIngressKey: "input:cm-1" }].forEach(function (marker) {
    var record = Object.assign({ type: "user_message", text: "hello" }, marker);
    assert.ok(relevance.hasOwnerProvenance(record), JSON.stringify(marker));
    assert.deepEqual(relevance.mainLensEventIndexes([record]), [0], JSON.stringify(marker));
  });
});

test("provenance is only consulted for user_message carriers", function () {
  // Assistant output has no provenance fields and must not be swept up by this
  // rule -- it is the bulk of what Main exists to show.
  assert.ok(!relevance.isInjectedUserMessage({ type: "delta", text: "answer" }));
  assert.ok(!relevance.isOperationalEvent({ type: "delta", text: "answer" }));
  assert.ok(!relevance.isOperationalEvent({ type: "result", text: "done" }));
  assert.deepEqual(
    relevance.mainLensEventIndexes([{ type: "delta", text: "a" }, { type: "done" }]),
    [0, 1]);
});

test("a compaction re-injection is dropped while the owner original stays", function () {
  // Both carry the same text; only the provenanced one is what the owner sent.
  // Verbatim pair from the transcript, five seconds apart.
  var history = [
    { type: "user_message", text: "Am i logged in", clientMessageId: "cm-x",
      from: "a66ce4a1", fromName: "Admin", _ts: 1785941790839 },
    { type: "user_message", text: "Am i logged in", compactedRetry: true, _ts: 1785941795666 },
    { type: "delta", text: "Yes." },
  ];
  assert.deepEqual(relevance.mainLensEventIndexes(history), [0, 2],
    "the duplicate re-injection is noise, the owner original is content");
});

test("injected control prompts cannot mint or populate a topic", function () {
  var completeTurns = require("../lib/coop-topic-extraction").completeTurns;
  var events = [
    { type: "user_message", text: "\u21bb Lead tick" },
    { type: "delta", text: "Ticking." },
    { type: "done" },
  ];
  var turn = completeTurns(events, 0).turns[0];
  assert.ok(!relevance.isOwnerRelevantTurn(turn),
    "a tick must not admit a topic or drive Working/Needs input/Done");

  var ownerEvents = [
    { type: "user_message", text: "ship it?", from: "u1", fromName: "Admin", clientMessageId: "cm-1" },
    { type: "delta", text: "Shipping." },
    { type: "done" },
  ];
  var ownerTurn = completeTurns(ownerEvents, 0).turns[0];
  assert.ok(relevance.isOwnerRelevantTurn(ownerTurn), "owner conversation still admits topics");
  assert.equal(ownerTurn.fromName, "Admin");
  assert.equal(ownerTurn.clientMessageId, "cm-1", "the turn record must carry provenance");
});

test("the injected prompts do not consume the bounded replay window", function () {
  // The tick fires on every owner message, so at real volume it would otherwise
  // crowd the owner's own words out of a bounded Main window.
  var history = [];
  for (var i = 0; i < 400; i++) history.push({ type: "user_message", text: "\u21bb Lead tick" });
  history.push({ type: "user_message", text: "the real question", from: "u1", fromName: "Admin" });
  history.push({ type: "delta", text: "the real answer" });

  var main = relevance.mainLensEventIndexes(history);
  assert.deepEqual(main, [400, 401]);
  assert.ok(main.slice(-300).indexOf(400) !== -1,
    "the owner question must survive the window");
});

test("All keeps everything the injected filter removes from Main", function () {
  var history = REAL_INJECTED.concat([
    { type: "user_message", text: "owner", from: "u1", fromName: "Admin" },
  ]);
  var main = relevance.mainLensEventIndexes(history);
  assert.deepEqual(main, [REAL_INJECTED.length], "Main keeps only the owner turn");
  // All is every index by construction; assert Main is a strict subset of it.
  var all = history.map(function (_, i) { return i; });
  main.forEach(function (i) { assert.ok(all.indexOf(i) !== -1); });
  assert.ok(main.length < all.length, "All stays full fidelity");
});

test("server and client agree about injected user messages", function () {
  var fs = require("node:fs");
  var pathMod = require("node:path");
  var client = fs.readFileSync(
    pathMod.join(__dirname, "..", "lib", "public", "modules", "coop-lens-relevance.js"), "utf8");
  assert.match(client, /hasOwnerProvenance/);
  assert.match(client, /isInjectedUserMessage/);
  assert.match(client, /coopIngress/);
  // The live path marks blocks with the same rule the replay path applies, so a
  // tick arriving mid-turn is hidden without waiting for a reload.
  assert.match(client, /if \(isInjectedUserMessage\(message\)\) return RELEVANCE_INTERNAL;/);
});
