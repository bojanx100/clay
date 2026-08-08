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

function userMessage(text, extra) {
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
    { type: "thinking", text: "considering" },
    { type: "tool_use", name: "Bash", input: { command: "ls" } },
    { type: "tool_result", text: "a b c" },
    { type: "delta", text: "Restored it." },
    { type: "context_usage", tokens: 10 },
    { type: "info", text: "Switched provider" },
    { type: "done" },
  ];
  var main = relevance.mainLensEventIndexes(history);
  assert.deepEqual(main, [0, 4, 7]);
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
  assert.ok(!relevance.isOperationalEvent({ type: "user_message" }));
  assert.ok(!relevance.isOperationalEvent({ type: "delta" }));
  assert.ok(!relevance.isOperationalEvent(null));
  // digest_checkpoint is already skipped by sessions-history; keep agreement.
  assert.ok(relevance.isInternalHistoryItem({ type: "digest_checkpoint" }));
});
