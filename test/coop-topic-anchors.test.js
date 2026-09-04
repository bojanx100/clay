var test = require("node:test");
var assert = require("node:assert/strict");
var anchors = require("../lib/coop-topic-anchors");

// Topic membership is persisted as event-index spans into canonical history.
// Indexes are positional, so any shift invalidates every later anchor, and the
// record itself proves nothing about what it was meant to point at.
//
// coop-topic-extraction.completeTurns -- the live admission path -- sets
// startEventIndex to the owner user_message's OWN index (offset 0, inclusive).
// That is the canonical, current-and-future convention.
//
// The owner's real persisted index instead resolves an owner turn start at
// offset 0 zero times across all 1124 real memberships, and at offset +1 (the
// NEXT record after start) 600 times (53.4%), with endEventIndex landing on
// done/result 88.3% of the time -- a legacy artifact from an earlier off-by-one
// in how those spans were recorded, not corruption and not today's admission
// behaviour. Treating +1 as the only rule would silently break every
// future-created topic (correctly anchored at offset 0); treating 0 as the
// only rule reproduces the original bug and suppresses all 43 real open
// topics.
//
// The rule under test is prove-or-suppress with a legacy fallback: try offset
// 0 first (the canonical rule); if that fails to resolve to an owner turn
// start, try offset +1 (accommodating already-persisted legacy spans without
// guessing which span is legacy). Only when neither resolves is the anchor
// unproven and the topic withheld. Never re-point by further guesswork,
// because a plausible re-anchor silently reattributes one owner conversation
// to another topic.

function ownerMsg(text, extra) {
  return Object.assign({
    type: "user_message", text: text,
    from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-" + text.length,
    _ts: 1000 + text.length,
  }, extra || {});
}

function history() {
  return [
    ownerMsg("first question"),        // 0  owner turn start (canonical, offset 0)
    { type: "tool_start", id: "e1", name: "Bash", _ts: 1001 },
    { type: "delta", text: "answer", _ts: 1002 },
    { type: "done", _ts: 1003 },
    ownerMsg("second question"),       // 4  owner turn start (canonical, offset 0)
    { type: "delta", text: "more", _ts: 1005 },
    { type: "done", _ts: 1006 },
  ];
}

// A legacy-shaped history: turn starts are only reachable via offset +1, as in
// the owner's real persisted index (start points at the PRECEDING boundary
// record, not the owner message itself).
function legacyHistory() {
  return [
    { type: "done", _ts: 999 },        // 0  boundary record a legacy anchor points AT
    ownerMsg("first question"),        // 1  owner turn start (legacy, offset +1 from 0)
    { type: "delta", text: "answer", _ts: 1002 },
    { type: "done", _ts: 1003 },       // 3  boundary record
    ownerMsg("second question"),       // 4  owner turn start (legacy, offset +1 from 3)
    { type: "delta", text: "more", _ts: 1005 },
    { type: "done", _ts: 1006 },
  ];
}

function topic(starts, extra) {
  return Object.assign({
    title: "A topic",
    status: "open",
    turnRefs: starts.map(function (i) {
      return { sessionStorageId: "s1", startEventIndex: i, endEventIndex: i + 2 };
    }),
  }, extra || {});
}

// --- proving a single anchor -------------------------------------------------

test("a canonical (offset 0) anchor is proven directly", function () {
  var h = history();
  assert.equal(anchors.proveAnchor(h, { startEventIndex: 0 }).proven, true);
  assert.equal(anchors.proveAnchor(h, { startEventIndex: 4 }).proven, true);
  // Records strictly inside a turn (not immediately preceding the next turn's
  // start) are not turn starts under either offset.
  [1, 2].forEach(function (i) {
    var verdict = anchors.proveAnchor(h, { startEventIndex: i });
    assert.equal(verdict.proven, false, "index " + i);
    assert.equal(verdict.reason, anchors.REASON_NOT_TURN_START);
  });
  // Index 3 ("done") sits immediately before the next owner turn (index 4),
  // which is exactly the legacy shape -- offset +1 correctly proves it, the
  // same way it correctly proves the owner's real persisted legacy spans.
  var boundary = anchors.proveAnchor(h, { startEventIndex: 3 });
  assert.equal(boundary.proven, true);
  assert.equal(boundary.offset, 1);
});

test("a legacy (offset +1) anchor is proven as a fallback when offset 0 fails", function () {
  var h = legacyHistory();
  var verdict1 = anchors.proveAnchor(h, { startEventIndex: 0 });
  assert.equal(verdict1.proven, true);
  assert.equal(verdict1.offset, 1, "resolved via the legacy fallback, not the canonical offset");
  var verdict2 = anchors.proveAnchor(h, { startEventIndex: 3 });
  assert.equal(verdict2.proven, true);
  assert.equal(verdict2.offset, 1);
});

test("canonical offset 0 is always tried first and preferred over the legacy fallback", function () {
  // A history where BOTH offset 0 and offset +1 land on owner turn starts:
  // proveAnchor must report offset 0, not skip to the fallback.
  var h = [ownerMsg("a"), ownerMsg("b"), { type: "done", _ts: 3 }];
  var verdict = anchors.proveAnchor(h, { startEventIndex: 0 });
  assert.equal(verdict.proven, true);
  assert.equal(verdict.offset, 0);
});

test("an injected control prompt is not an owner turn start", function () {
  // Same type, no provenance. This is what minted "Resuming After Restart" in
  // the real index -- unlike a legacy boundary record, no offset rescues it.
  var h = [{ type: "done", _ts: 0 }, { type: "user_message", text: "\u21bb Resuming after restart", _ts: 1 }];
  assert.equal(anchors.isOwnerTurnStart(h[1]), false);
  var verdict = anchors.proveAnchor(h, { startEventIndex: 0 });
  assert.equal(verdict.proven, false,
    "this is exactly what suppressed Resuming After Restart in the real index");
  // And a genuine owner message whose text mentions the same thing IS a turn start.
  var owner = [ownerMsg("why do I have lead tick every time I send you a message?")];
  assert.equal(anchors.isOwnerTurnStart(owner[0]), true);
});

test("an out-of-range or malformed anchor is refused, never clamped", function () {
  var h = history();
  [h.length, h.length + 500, -1, null, undefined, 1.5, "3"].forEach(function (i) {
    var verdict = anchors.proveAnchor(h, { startEventIndex: i });
    assert.equal(verdict.proven, false, JSON.stringify(i));
    assert.equal(verdict.reason, anchors.REASON_OUT_OF_RANGE);
  });
  // Clamping to the nearest valid index would silently attach the topic to
  // whatever conversation happens to sit at the edge.
});

test("absent history proves nothing rather than defaulting to trust", function () {
  var verdict = anchors.proveAnchor(null, { startEventIndex: 0 });
  assert.equal(verdict.proven, false);
  assert.equal(verdict.reason, anchors.REASON_NO_HISTORY);
});

// --- drift shapes -------------------------------------------------------------

test("records inserted before an anchor invalidate it rather than shifting it", function () {
  var before = history();
  var t = topic([0, 4]);
  assert.equal(anchors.topicHasProvenAnchor(t, before), true);

  // Compaction or a replay-window change prepends two records. Neither offset
  // 0 nor +1 happens to resolve here, since both prepended records are
  // "info" type, not owner turn starts.
  var after = [{ type: "info", text: "x", _ts: 1 }, { type: "info", text: "y", _ts: 2 }].concat(before);
  var split = anchors.classifyTopicAnchors(t, after);
  assert.equal(split.proven.length, 0, "both anchors now point at the wrong records");
  assert.equal(split.unproven.length, 2);
  // Nothing is silently re-pointed to 2 and 6, even though that is where the
  // turns actually moved -- a shift that LOOKS uniform may not be.
  assert.equal(anchors.topicHasProvenAnchor(t, after), false);
});

test("removed records leave anchors out of range and the topic suppressed", function () {
  var t = topic([0, 4]);
  var truncated = history().slice(0, 2);
  var split = anchors.classifyTopicAnchors(t, truncated);
  assert.equal(split.proven.length, 1, "index 0 still resolves");
  assert.equal(split.unproven[0].reason, anchors.REASON_OUT_OF_RANGE);
  // One proven anchor is still enough to show the topic, from that span only.
  assert.equal(anchors.topicHasProvenAnchor(t, truncated), true);
  assert.deepEqual(anchors.provenTurnRefs(t, truncated).map(function (r) { return r.startEventIndex; }), [0]);
});

test("duplicate text does not make an anchor provable by content, only by position", function () {
  // Two identical owner messages: proving must never fall back to text
  // matching, which would risk attaching a span to the wrong occurrence.
  var h = [ownerMsg("same"), { type: "done", _ts: 2 }, ownerMsg("same"), { type: "delta", text: "x", _ts: 4 }];
  assert.equal(anchors.proveAnchor(h, { startEventIndex: 0 }).proven, true);
  // Index 1 ("done") sits immediately before the second occurrence, which the
  // legacy offset +1 rule correctly (and only positionally) resolves.
  var boundary = anchors.proveAnchor(h, { startEventIndex: 1 });
  assert.equal(boundary.proven, true);
  assert.equal(boundary.offset, 1);
  // A record with no owner turn anywhere nearby (offset 0 or +1) is refused
  // regardless of the duplicate text existing elsewhere in history.
  assert.equal(anchors.proveAnchor(h, { startEventIndex: 3 }).proven, false);
});

// --- topic-level projection ---------------------------------------------------

test("a topic with no proven anchor is withheld from the owner", function () {
  var h = history();
  var drifted = topic([1, 2]);
  assert.equal(anchors.topicHasProvenAnchor(drifted, h), false);
  assert.equal(anchors.isProjectable(drifted, h), false);
  assert.deepEqual(anchors.provenTurnRefs(drifted, h), [],
    "and it contributes no transcript, so nothing can be titled from it");
});

test("a partially drifted topic keeps only its proven spans", function () {
  var h = history();
  var mixed = topic([0, 2, 4]);
  assert.equal(anchors.isProjectable(mixed, h), true);
  assert.deepEqual(anchors.provenTurnRefs(mixed, h).map(function (r) { return r.startEventIndex; }),
    [0, 4], "the drifted middle span contributes nothing");
});

test("membership is never deleted, only withheld", function () {
  var h = history();
  var drifted = topic([1, 2]);
  var before = JSON.parse(JSON.stringify(drifted.turnRefs));
  anchors.classifyTopicAnchors(drifted, h);
  anchors.topicHasProvenAnchor(drifted, h);
  anchors.provenTurnRefs(drifted, h);
  assert.deepEqual(drifted.turnRefs, before,
    "the durable record survives so a future re-derivation still has evidence");
});

test("canonical history is never mutated", function () {
  var h = history();
  var snapshot = JSON.parse(JSON.stringify(h));
  var t = topic([0, 1, 2, 99]);
  anchors.classifyTopicAnchors(t, h);
  anchors.reconcileAnchors({ topics: [t] }, { historyFor: function () { return h; } });
  assert.deepEqual(h, snapshot);
});

// --- reconciliation: versioned, idempotent, auditable -------------------------

function indexWith(topics) { return { topics: topics }; }

test("reconciliation records an auditable verdict per topic", function () {
  var h = history();
  var good = topic([0, 4], { title: "Real topic" });
  var bad = topic([1, 2], { title: "Drifted topic" });
  var summary = anchors.reconcileAnchors(indexWith([good, bad]), {
    historyFor: function () { return h; }, now: function () { return 4242; },
  });

  assert.equal(summary.checked, 2);
  assert.equal(summary.verified, 1);
  assert.equal(summary.suppressed, 1);

  assert.equal(good.anchorAudit.projectable, true);
  assert.equal(good.anchorAudit.provenCount, 2);
  assert.equal(good.anchorAudit.reason, anchors.REASON_PROVEN);
  assert.equal(good.anchorAudit.checkedAt, 4242);
  assert.equal(good.anchorAudit.schemaVersion, anchors.ANCHOR_SCHEMA_VERSION);

  assert.equal(bad.anchorAudit.projectable, false);
  assert.equal(bad.anchorAudit.provenCount, 0);
  assert.equal(bad.anchorAudit.reason, anchors.REASON_NOT_TURN_START);
  // The examples explain the suppression without re-deriving it.
  assert.equal(bad.anchorAudit.examples[0].found, "tool_start");
});

test("reconciliation is idempotent across repeated runs and restarts", function () {
  var h = history();
  var t = topic([1, 2]);
  var deps = { historyFor: function () { return h; }, now: function () { return 4242; } };
  anchors.reconcileAnchors(indexWith([t]), deps);
  var first = JSON.parse(JSON.stringify(t.anchorAudit));

  // Re-running at a later clock must not rewrite a verdict already reached at
  // this schema version against the same anchors.
  var again = anchors.reconcileAnchors(indexWith([t]), {
    historyFor: function () { return h; }, now: function () { return 9999; },
  });
  assert.deepEqual(t.anchorAudit, first, "no churn on repeat");
  assert.equal(again.unchanged, 1);
  assert.equal(again.suppressed, 0);
});

test("a schema bump forces re-evaluation instead of trusting an old verdict", function () {
  var h = history();
  var t = topic([0]);
  t.anchorAudit = { schemaVersion: 0, projectable: false, anchorCount: 1, reason: "stale" };
  anchors.reconcileAnchors(indexWith([t]), { historyFor: function () { return h; } });
  assert.equal(t.anchorAudit.schemaVersion, anchors.ANCHOR_SCHEMA_VERSION);
  assert.equal(t.anchorAudit.projectable, true, "re-proved under the current rule");
});

test("appended membership forces re-evaluation", function () {
  var h = history();
  var t = topic([0]);
  anchors.reconcileAnchors(indexWith([t]), { historyFor: function () { return h; } });
  assert.equal(t.anchorAudit.anchorCount, 1);
  // A new span arrives; the cached verdict no longer covers the topic.
  t.turnRefs.push({ sessionStorageId: "s1", startEventIndex: 4, endEventIndex: 6 });
  var summary = anchors.reconcileAnchors(indexWith([t]), { historyFor: function () { return h; } });
  assert.equal(summary.unchanged, 0, "a changed anchor count must be re-checked");
  assert.equal(t.anchorAudit.anchorCount, 2);
  assert.equal(t.anchorAudit.provenCount, 2);
  assert.equal(t.anchorAudit.projectable, true);
});

test("history that shifts after a verdict is re-checked on the next schema run", function () {
  // The cached verdict is keyed to a schema version and an anchor count, so a
  // silent history shift alone will not re-open it. isProjectable is therefore
  // the live check for anything not yet reconciled. Prepending two records (not
  // one) ensures neither offset 0 nor the legacy +1 fallback happens to still
  // resolve the anchor.
  var t = topic([0]);
  var shifted = [{ type: "info", text: "x", _ts: 1 }, { type: "info", text: "y", _ts: 2 }].concat(history());
  assert.equal(anchors.isProjectable(t, shifted), false,
    "an unreconciled topic is proved live and fails closed");
});

test("a mixed index suppresses only the invalid topics", function () {
  var h = history();
  var valid = topic([0], { title: "Valid" });
  var invalid = topic([2], { title: "Invalid" });
  var partial = topic([0, 2], { title: "Partial" });
  var summary = anchors.reconcileAnchors(indexWith([valid, invalid, partial]), {
    historyFor: function () { return h; },
  });
  assert.equal(summary.suppressed, 1);
  assert.equal(summary.verified, 2);
  assert.equal(summary.partial, 1);
  assert.equal(valid.anchorAudit.projectable, true);
  assert.equal(invalid.anchorAudit.projectable, false);
  assert.equal(partial.anchorAudit.projectable, true);
  assert.equal(partial.anchorAudit.reason, "partial_anchors_proven");
});

test("topic identity, group and closed state are preserved untouched", function () {
  var h = history();
  var t = topic([2], {
    title: "Drifted", status: "closed", group: { kind: "project", projectRef: { projectId: "p1" } },
    topicRef: { topicId: "topic-1" }, keywords: ["a", "b"], createdAt: 7, relatedExecutions: [{ id: "x" }],
  });
  anchors.reconcileAnchors(indexWith([t]), { historyFor: function () { return h; } });
  assert.equal(t.title, "Drifted");
  assert.equal(t.status, "closed");
  assert.deepEqual(t.topicRef, { topicId: "topic-1" });
  assert.deepEqual(t.group, { kind: "project", projectRef: { projectId: "p1" } });
  assert.deepEqual(t.keywords, ["a", "b"]);
  assert.deepEqual(t.relatedExecutions, [{ id: "x" }]);
  assert.equal(t.createdAt, 7);
});

test("an audit at the current version is trusted without re-proving", function () {
  // isProjectable must not silently disagree with the recorded verdict, or a
  // suppression would flicker between reconciliations.
  var t = topic([0]);
  t.anchorAudit = { schemaVersion: anchors.ANCHOR_SCHEMA_VERSION, projectable: false, anchorCount: 1 };
  assert.equal(anchors.isProjectable(t, history()), false);
  t.anchorAudit.projectable = true;
  assert.equal(anchors.isProjectable(t, history()), true);
});

test("an empty or absent membership list is suppressed, not trusted", function () {
  var h = history();
  assert.equal(anchors.topicHasProvenAnchor({ turnRefs: [] }, h), false);
  assert.equal(anchors.topicHasProvenAnchor({}, h), false);
  assert.equal(anchors.topicHasProvenAnchor(null, h), false);
});

test("a legacy-offset anchor is proven at the topic level too", function () {
  var h = legacyHistory();
  var t = { title: "Legacy topic", status: "open", turnRefs: [
    { sessionStorageId: "s1", startEventIndex: 0, endEventIndex: 2 },
    { sessionStorageId: "s1", startEventIndex: 3, endEventIndex: 5 },
  ] };
  assert.equal(anchors.topicHasProvenAnchor(t, h), true);
  assert.equal(anchors.isProjectable(t, h), true);
  var split = anchors.classifyTopicAnchors(t, h);
  assert.equal(split.proven.length, 2);
});
