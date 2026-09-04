var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var replyAnchor = require("../lib/coop-topic-reply-anchor");
var relevance = require("../lib/coop-topic-relevance");
var projectUserMessageCoop = require("../lib/project-user-message-coop");

// The reply anchor is the logical parent of a message sent from a topic lens:
// the last owner-relevant record INSIDE that topic, not whatever happens to
// sit at the physical tail of canonical history. Canonical history is one
// append-only log shared by every topic and by general chat, so a message
// sent from Topic A always lands physically next to unrelated traffic. The
// anchor is the only thing that records "this message replies to Topic A's
// own conversation", and it must fail closed -- no anchor at all -- rather
// than ever guess and point at another topic's events. That is the exact bug
// this module exists to prevent: a plausible but wrong anchor silently
// reattributes one owner conversation to another topic, which is worse than
// showing no thread at all.
//
// This suite proves: within-topic threading picks the topic's own LATEST
// OWNER TURN START, not its latest member and not the canonical tail;
// interleaved topics never cross-anchor; general chat with no topic is
// untouched and stays byte-compatible with the pre-anchor wire format;
// missing/drifted/cross-topic anchors are refused rather than re-pointed; a
// topic with no owner-relevant member yields no anchor rather than a
// fallback; the derivation is deterministic and JSON round-trips unchanged
// (the restart-rebuild path); it never mutates canonical history or the topic
// it reads; membership binding on the real on-disk index is idempotent; and
// the anchor names exactly what the topic lens replays.
//
// Turn-start, not "last member", is load-bearing here. Owner-relevance
// deliberately keeps `done` and streaming `delta` records -- they are
// conversation, not narration -- so a topic's last MEMBER is routinely a
// `done` marker, a record the transcript renders no block for. An anchor
// pointing at it would name something the owner cannot see or jump to. A turn
// start (a `user_message` with owner provenance) is always rendered, so
// buildReplyAnchor walks the topic's owner-relevant membership from the end
// and returns the first record that is a turn start, not the first record it
// finds at all. `turnEventIndex` has been removed from the anchor shape --
// the anchor's own `eventIndex` already IS the turn start's index, so a
// second field naming the same thing was redundant.

// --- fixture builders --------------------------------------------------------
// No shared test helpers exist in this repo; every builder below is local to
// this file.

function ownerMsg(ts, text, extra) {
  // A genuine owner message: provenance (from/fromName/clientMessageId) is
  // what coop-topic-relevance.hasOwnerProvenance requires to treat this as a
  // real turn start, as opposed to an injected control prompt of the same type.
  return Object.assign({
    type: "user_message", text: text,
    from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-" + ts,
    _ts: ts,
  }, extra || {});
}

function injectedUserMessage(ts, text) {
  // Same carrier type as ownerMsg, deliberately with none of the provenance
  // markers -- what a scheduled Lead tick or a resume/continue marker looks
  // like on the wire.
  return { type: "user_message", text: text, _ts: ts };
}

function assistantDelta(ts, text) {
  return { type: "delta", text: text, _ts: ts };
}

function assistantDone(ts) {
  return { type: "done", _ts: ts };
}

function toolStart(ts) {
  return { type: "tool_start", id: "tool-" + ts, name: "Bash", _ts: ts };
}

function thinkingDelta(ts) {
  return { type: "thinking_delta", text: "reasoning", _ts: ts };
}

function infoRecord(ts) {
  return { type: "info", text: "provider routing notice", _ts: ts };
}

function session(history, extra) {
  return Object.assign({ storageId: "s1", history: history }, extra || {});
}

function turnRef(start, end) {
  return { sessionStorageId: "s1", startEventIndex: start, endEventIndex: end };
}

function topic(turnRefs, extra) {
  return Object.assign({ title: "A topic", status: "open", turnRefs: turnRefs || [] }, extra || {});
}

// --- owner-relevance assumptions this module depends on ---------------------
// Every scenario below builds fixtures assuming tool/thinking/info records and
// injected user_message records are excluded from ownerRelevantIndexes, and
// that a real owner message and assistant text are kept. Checked against the
// real predicate instead of guessed.

test("owner-relevance assumptions this module relies on hold against coop-topic-relevance", function () {
  assert.equal(relevance.isOwnerRelevantRecord(toolStart(1)), false, "tool_start is execution narration");
  assert.equal(relevance.isOwnerRelevantRecord(thinkingDelta(1)), false, "thinking* is internal reasoning");
  assert.equal(relevance.isOwnerRelevantRecord(infoRecord(1)), false, "bare info is a provider/routing notice");
  assert.equal(relevance.isOwnerRelevantRecord(injectedUserMessage(1, "↻ Resuming after restart")), false,
    "a user_message with no owner provenance is an injected control prompt");
  assert.equal(relevance.isOwnerRelevantRecord(ownerMsg(1, "hello")), true, "a real owner message is relevant");
  assert.equal(relevance.isOwnerRelevantRecord(assistantDelta(1, "answer")), true, "assistant text is conversation");
  assert.equal(relevance.isOwnerRelevantRecord(assistantDone(1)), true, "a turn boundary is not operational narration");
});

// --- successive replies inside one topic -------------------------------------

test("the second reply sent from a topic anchors to that topic's own latest owner turn start, not its latest member or the canonical tail", function () {
  var h = [
    ownerMsg(100, "first question"),        // 0 topic A turn start
    toolStart(101),                          // 1 internal, filtered out
    assistantDelta(102, "first answer"),     // 2
    assistantDone(103),                      // 3
    ownerMsg(104, "topic A reply one"),      // 4  <- topic A's latest owner turn start
    assistantDelta(105, "second answer"),    // 5
    assistantDone(106),                      // 6  topic A's latest MEMBER, but a done marker the transcript renders no block for
    ownerMsg(107, "unrelated general chat"), // 7 physical tail begins, no topic
    assistantDelta(108, "unrelated answer"), // 8
    assistantDone(109),                      // 9 physical tail
  ];
  var s = session(h);
  var topicA = topic([turnRef(0, 3), turnRef(4, 6)]);

  var anchor = replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, topicA, s);
  assert.ok(anchor, "topic A has owner-relevant membership and must anchor");
  assert.equal(anchor.eventIndex, 4,
    "anchors to topic A's latest owner turn start at index 4, not its latest member at index 6 (a done marker the transcript renders no block for) and not the physical tail at index 9");
  assert.equal(anchor.type, "user_message");
  assert.equal(anchor.ts, 104);
  assert.equal(anchor.clientMessageId, "cm-104");
});

// --- the exact bug this module exists to prevent -----------------------------

test("a topic whose membership ends in delta/done records still anchors to the preceding owner user_message, never to the trailing done", function () {
  var h = [
    ownerMsg(50, "topic question"),   // 0  <- the only record this topic can anchor to
    assistantDelta(51, "streaming answer"), // 1 conversation, but not a turn start
    assistantDone(52),                       // 2 turn boundary; the transcript renders NO block for this
  ];
  var s = session(h);
  var t = topic([turnRef(0, 2)]);

  var anchor = replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, t, s);
  assert.ok(anchor, "the topic has an owner turn and must anchor");
  assert.equal(anchor.eventIndex, 0,
    "anchors to the owner user_message that opened the turn, not the trailing delta at 1 or the done at 2 that the topic's membership also includes");
  assert.equal(anchor.type, "user_message");
  assert.notEqual(anchor.eventIndex, 2,
    "must never anchor to a done marker -- the owner cannot see it or jump to it in the transcript, so a chip pointing there would be silently broken");
});

test("a topic whose LATEST turn ends in delta/done still anchors to that turn's owner message across an earlier completed turn", function () {
  // Two turns: the first fully closed, the second still trailing delta/done.
  // The anchor must track the second (latest) turn's owner message, not the
  // first turn's, and never the trailing delta/done of either turn.
  var h = [
    ownerMsg(10, "first turn"),        // 0 first turn start
    assistantDone(11),                  // 1 first turn's done
    ownerMsg(12, "second turn"),       // 2  <- latest owner turn start, expected anchor
    assistantDelta(13, "still typing"), // 3
    assistantDone(14),                   // 4 latest member, but a done marker
  ];
  var s = session(h);
  var t = topic([turnRef(0, 1), turnRef(2, 4)]);
  var anchor = replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, t, s);
  assert.equal(anchor.eventIndex, 2, "anchors to the latest turn's owner message, not the earlier turn and not the trailing done at 4");
});

// --- interleaved topics -------------------------------------------------------

test("interleaved topics anchor independently to their own latest owner turn start, never to each other's events or the physical tail", function () {
  var h = [
    ownerMsg(200, "A message one"),          // 0 A turn start
    assistantDelta(201, "A answer one"),     // 1
    assistantDone(202),                       // 2  A's turn-one end
    ownerMsg(203, "B message one"),          // 3  <- B's latest (and only) owner turn start
    assistantDelta(204, "B answer one"),     // 4
    assistantDone(205),                       // 5  B's latest member, but a done marker
    ownerMsg(206, "A message two"),          // 6  <- A's latest owner turn start
    assistantDelta(207, "A answer two"),     // 7
    assistantDone(208),                       // 8  A's latest member, but a done marker
    ownerMsg(209, "general chat, no topic"), // 9 physical tail begins, unrelated to A and B
    assistantDelta(210, "general answer"),   // 10
    assistantDone(211),                       // 11 physical tail
  ];
  var s = session(h);
  var topicA = topic([turnRef(0, 2), turnRef(6, 8)]);
  var topicB = topic([turnRef(3, 5)]);

  var anchorA = replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, topicA, s);
  var anchorB = replyAnchor.buildReplyAnchor({ topicId: "topic-b" }, topicB, s);

  assert.equal(anchorA.eventIndex, 6, "topic A anchors to its own latest owner turn start, not its latest member at index 8");
  assert.equal(anchorB.eventIndex, 3, "topic B anchors to its own latest owner turn start, not its latest member at index 5");
  assert.notEqual(anchorA.eventIndex, anchorB.eventIndex, "the topics never anchor to each other's events");
  assert.notEqual(anchorA.eventIndex, 11, "topic A does not fall back to the physical tail");
  assert.notEqual(anchorB.eventIndex, 11, "topic B does not fall back to the physical tail");
});

// --- general chat with no topic ----------------------------------------------

test("a null or empty topic reference never produces an anchor", function () {
  var s = session([ownerMsg(1, "hi")]);
  var t = topic([turnRef(0, 0)]);
  assert.equal(replyAnchor.buildReplyAnchor(null, t, s), null);
  assert.equal(replyAnchor.buildReplyAnchor(undefined, t, s), null);
  assert.equal(replyAnchor.buildReplyAnchor({}, t, s), null, "a topicRef with no topicId is empty");
  assert.equal(replyAnchor.buildReplyAnchor({ topicId: "   " }, t, s), null, "whitespace-only is empty after trim");
});

test("a history item with no coopTopicAnchor yields no anchor from anchorForItem", function () {
  var h = [ownerMsg(1, "hi")];
  assert.equal(replyAnchor.anchorForItem({ type: "user_message", text: "hi" }, h), null);
  assert.equal(replyAnchor.anchorForItem(null, h), null);
});

test("withTopicContext is byte-compatible with the pre-anchor wire format", function () {
  assert.equal(
    projectUserMessageCoop.withTopicContext("hello owner", null, { projectId: "p1" }, null),
    "hello owner",
    "no topicRef at all means the text passes through unchanged"
  );

  var text = projectUserMessageCoop.withTopicContext("hello owner", { topicId: "topic-a" }, null, null);
  var expectedPayload = JSON.stringify({ topicRef: { topicId: "topic-a" }, projectRef: null });
  assert.equal(text, [
    "<coop_topic_context>",
    expectedPayload,
    "</coop_topic_context>",
    "",
    "hello owner",
  ].join("\n"), "a topicRef with no anchor omits replyTo entirely, byte-identical to the pre-anchor payload");
  assert.equal(expectedPayload.indexOf("replyTo"), -1, "no replyTo key is emitted when there is no anchor");
});

// --- missing / deleted / drifted / cross-topic anchors fail closed ----------

test("anchorResolves fails closed on an out-of-range index", function () {
  var h = [assistantDone(1), assistantDone(2)];
  var anchor = { version: replyAnchor.ANCHOR_VERSION, topicId: "topic-a", sessionStorageId: "s1", eventIndex: 5, type: "done", ts: 1, clientMessageId: "" };
  assert.equal(replyAnchor.anchorResolves(anchor, h), false);
});

test("anchorResolves fails closed when the record at the index now has a different type", function () {
  var h = [ownerMsg(10, "q"), assistantDelta(11, "a")];
  var anchor = { version: replyAnchor.ANCHOR_VERSION, topicId: "topic-a", sessionStorageId: "s1", eventIndex: 1, type: "done", ts: 11, clientMessageId: "" };
  assert.equal(replyAnchor.anchorResolves(anchor, h), false, "index 1 is a delta, not a done -- the record was replaced");
});

test("anchorResolves fails closed when _ts differs from the fingerprint", function () {
  var h = [ownerMsg(10, "q"), assistantDelta(11, "a")];
  var anchor = { version: replyAnchor.ANCHOR_VERSION, topicId: "topic-a", sessionStorageId: "s1", eventIndex: 1, type: "delta", ts: 999, clientMessageId: "" };
  assert.equal(replyAnchor.anchorResolves(anchor, h), false, "the stamped ts no longer matches history at that index");
});

test("anchorResolves fails closed when clientMessageId differs from the fingerprint", function () {
  var h = [ownerMsg(10, "q")];
  var anchor = { version: replyAnchor.ANCHOR_VERSION, topicId: "topic-a", sessionStorageId: "s1", eventIndex: 0, type: "user_message", ts: 10, clientMessageId: "cm-different" };
  assert.equal(replyAnchor.anchorResolves(anchor, h), false);
});

test("anchorForItem refuses cross-topic attribution when the anchor names a different topic than the item", function () {
  var h = [ownerMsg(10, "q")];
  var item = {
    type: "user_message", text: "reply",
    coopTopicRef: { topicId: "topic-a" },
    coopTopicAnchor: {
      version: replyAnchor.ANCHOR_VERSION, topicId: "topic-b", sessionStorageId: "s1",
      eventIndex: 0, type: "user_message", ts: 10, clientMessageId: "cm-10",
    },
  };
  assert.equal(replyAnchor.anchorForItem(item, h), null,
    "the anchor claims topic-b while the item claims topic-a -- refused, never attributed across topics");
});

test("normalizeReplyAnchor rejects a wrong version, missing ids, and a negative or non-integer eventIndex", function () {
  var valid = { version: replyAnchor.ANCHOR_VERSION, topicId: "topic-a", sessionStorageId: "s1", eventIndex: 0 };
  assert.ok(replyAnchor.normalizeReplyAnchor(valid), "sanity: the baseline shape normalizes");
  assert.equal(replyAnchor.normalizeReplyAnchor(Object.assign({}, valid, { version: replyAnchor.ANCHOR_VERSION + 1 })), null, "wrong version");
  assert.equal(replyAnchor.normalizeReplyAnchor(Object.assign({}, valid, { topicId: undefined })), null, "missing topicId");
  assert.equal(replyAnchor.normalizeReplyAnchor(Object.assign({}, valid, { sessionStorageId: undefined })), null, "missing sessionStorageId");
  assert.equal(replyAnchor.normalizeReplyAnchor(Object.assign({}, valid, { eventIndex: -1 })), null, "negative eventIndex");
  assert.equal(replyAnchor.normalizeReplyAnchor(Object.assign({}, valid, { eventIndex: 1.5 })), null, "non-integer eventIndex");
  assert.equal(replyAnchor.normalizeReplyAnchor(Object.assign({}, valid, { eventIndex: "3" })), null, "string eventIndex");
  assert.equal(replyAnchor.normalizeReplyAnchor(null), null);
  assert.equal(replyAnchor.normalizeReplyAnchor("not an object"), null);
});

// --- a topic with no owner-relevant member yields no anchor -----------------

test("a topic with empty membership produces no anchor", function () {
  var s = session([ownerMsg(1, "q"), assistantDone(2)]);
  var t = topic([]);
  assert.deepEqual(replyAnchor.topicMembershipIndexes(t, s), []);
  assert.equal(replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, t, s), null);
});

test("a topic whose only membership is internal or operational records produces no anchor -- never a fallback to the tail", function () {
  var h = [
    toolStart(1),
    thinkingDelta(2),
    infoRecord(3),
    injectedUserMessage(4, "↻ Resuming after restart"),
  ];
  var s = session(h);
  var t = topic([turnRef(0, 3)]);
  assert.deepEqual(replyAnchor.topicMembershipIndexes(t, s), [], "every record in the span is internal or operational");
  assert.equal(replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, t, s), null,
    "no owner-relevant member means no anchor -- not a fallback to whatever sits at the tail");
});

// --- replay / restart determinism --------------------------------------------

test("building the anchor twice from the same topic and session is deterministic", function () {
  var s = session([ownerMsg(1, "q"), assistantDelta(2, "a"), assistantDone(3)]);
  var t = topic([turnRef(0, 2)]);
  var first = replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, t, s);
  var second = replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, t, s);
  assert.deepEqual(first, second);
});

test("a persisted anchor round-trips through JSON unchanged", function () {
  var s = session([ownerMsg(1, "q"), assistantDelta(2, "a"), assistantDone(3)]);
  var t = topic([turnRef(0, 2)]);
  var anchor = replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, t, s);
  var roundTripped = JSON.parse(JSON.stringify(anchor));
  assert.deepEqual(replyAnchor.normalizeReplyAnchor(roundTripped), anchor);
});

test("withTopicContext produces identical text from a live anchor and its JSON round-tripped copy -- the restart-rebuild path", function () {
  var s = session([ownerMsg(1, "q"), assistantDelta(2, "a"), assistantDone(3)]);
  var t = topic([turnRef(0, 2)]);
  var topicRefA = { topicId: "topic-a" };
  var anchor = replyAnchor.buildReplyAnchor(topicRefA, t, s);
  var roundTripped = JSON.parse(JSON.stringify(anchor));

  var live = projectUserMessageCoop.withTopicContext("owner reply text", topicRefA, null, anchor);
  var rebuilt = projectUserMessageCoop.withTopicContext("owner reply text", topicRefA, null, roundTripped);
  assert.equal(live, rebuilt,
    "project-user-message-queue rebuilds this text from the persisted JSON anchor after a restart, and must reproduce it exactly");
});

// --- append-only: derivation never mutates what it reads ---------------------

test("buildReplyAnchor and topicMembershipIndexes never mutate the session history or the topic", function () {
  var h = [ownerMsg(1, "q"), assistantDelta(2, "a"), assistantDone(3), ownerMsg(4, "q2"), assistantDone(5)];
  var s = session(h);
  var t = topic([turnRef(0, 2), turnRef(3, 4)]);
  var historySnapshot = JSON.parse(JSON.stringify(s.history));
  var topicSnapshot = JSON.parse(JSON.stringify(t));

  replyAnchor.buildReplyAnchor({ topicId: "topic-a" }, t, s);
  replyAnchor.topicMembershipIndexes(t, s);

  assert.deepEqual(s.history, historySnapshot, "canonical history is append-only and must never be rewritten while deriving an anchor");
  assert.deepEqual(t, topicSnapshot, "the topic's own membership record must not be touched while deriving an anchor from it");
});

// --- membership binding on a real on-disk index ------------------------------

test("membership binding on a real on-disk index is idempotent and forward-only", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-reply-anchor-"));
  try {
    var topicIndex = require("../lib/coop-topic-index");
    var clock = 100;
    var idx = topicIndex.createTopicIndex({
      file: path.join(dir, "lead", "coop-topic-index.json"),
      now: function () { clock++; return clock; },
    });
    var state = idx.load();
    state.canonicalSessionStorageId = "canonical-topic-home";
    state.topics["reply-anchor-topic"] = {
      topicRef: { topicId: "reply-anchor-topic" }, title: "Reply anchor topic",
      keywords: [], group: { kind: "uncategorised" }, source: "manual",
      status: "open", createdAt: 1, updatedAt: 1,
      eventRefs: [], turnRefs: [], relatedExecutions: [],
    };
    idx.save();

    var ref = { topicId: "reply-anchor-topic" };
    assert.equal(idx.addEventMembership(ref, [{ eventIndex: 5 }]).ok, true);
    assert.equal(idx.addEventMembership(ref, [{ eventIndex: 2 }]).ok, true);
    var afterFirstPass = JSON.parse(JSON.stringify(idx.resolve(ref).topic.eventRefs));
    assert.equal(afterFirstPass.length, 2);
    assert.deepEqual(afterFirstPass.map(function (r) { return r.eventIndex; }), [2, 5]);

    // Binding the same events again -- as a replay or a retry would -- must not
    // duplicate the reference or reorder what is already there.
    assert.equal(idx.addEventMembership(ref, [{ eventIndex: 5 }]).ok, true);
    assert.equal(idx.addEventMembership(ref, [{ eventIndex: 2 }]).ok, true);
    var afterRepeat = idx.resolve(ref).topic.eventRefs;
    assert.equal(afterRepeat.length, 2, "no duplicate reference from binding the same event twice");
    assert.deepEqual(afterRepeat.map(function (r) { return r.eventIndex; }), [2, 5], "existing refs keep their order");
    assert.deepEqual(afterRepeat, afterFirstPass, "a repeated bind leaves the stored membership byte-for-byte unchanged");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- agreement with the topic lens -------------------------------------------

test("the reply anchor derivation agrees with the topic lens replay -- both read one shared function", function () {
  var topicConnection = require("../lib/coop-topic-connection");
  var h = [
    ownerMsg(1, "q1"), assistantDelta(2, "a1"), assistantDone(3),
    ownerMsg(4, "q2"), toolStart(5), assistantDelta(6, "a2"), assistantDone(7),
  ];
  var s = session(h);
  var t = topic([turnRef(0, 2), turnRef(3, 6)]);
  assert.deepEqual(
    topicConnection.boundedMembershipIndexes(t, s),
    replyAnchor.topicMembershipIndexes(t, s),
    "the anchor must name a record the topic lens actually replays"
  );
});

// --- direct exports: fingerprintOf, isOwnerTurnStart, anchorContextPayload --

test("fingerprintOf captures type, ts, and clientMessageId, and degrades gracefully on a missing record", function () {
  assert.deepEqual(replyAnchor.fingerprintOf(ownerMsg(10, "q")), { type: "user_message", ts: 10, clientMessageId: "cm-10" });
  assert.deepEqual(replyAnchor.fingerprintOf(assistantDone(3)), { type: "done", ts: 3, clientMessageId: "" });
  assert.deepEqual(replyAnchor.fingerprintOf(null), { type: "", ts: null, clientMessageId: "" });
  assert.deepEqual(replyAnchor.fingerprintOf({}), { type: "", ts: null, clientMessageId: "" });
});

test("isOwnerTurnStart requires both the user_message type and owner provenance", function () {
  assert.equal(replyAnchor.isOwnerTurnStart(ownerMsg(1, "q")), true);
  assert.equal(replyAnchor.isOwnerTurnStart(injectedUserMessage(1, "↻ Resuming after restart")), false,
    "same carrier type, no provenance -- not a turn start");
  assert.equal(replyAnchor.isOwnerTurnStart(assistantDone(1)), false, "not even a user_message");
  assert.equal(replyAnchor.isOwnerTurnStart(null), false);
});

test("anchorContextPayload is a content-free, reference-only projection of the anchor", function () {
  // turnEventIndex is gone from the anchor shape entirely: the anchor's own
  // eventIndex already IS the owner turn start's index, so there is nothing
  // left for a second field to name.
  var anchor = {
    version: replyAnchor.ANCHOR_VERSION, topicId: "topic-a", sessionStorageId: "s1",
    eventIndex: 4, type: "user_message", ts: 104, clientMessageId: "cm-104",
  };
  assert.deepEqual(replyAnchor.anchorContextPayload(anchor), {
    topicId: "topic-a", sessionStorageId: "s1", eventIndex: 4,
  }, "no type/ts/clientMessageId leaks into the agent-visible payload -- it points at a record, it does not copy it");
  assert.equal(replyAnchor.anchorContextPayload(null), null);
  assert.equal(replyAnchor.anchorContextPayload({ version: 999 }), null, "an unrecognised anchor shape yields no payload");
});
