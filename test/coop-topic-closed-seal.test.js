var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var topics = require("../lib/coop-topic-index");

// Phase 1 of the approved topic lifecycle: closed and merged topics are sealed
// against NEW membership.
//
// A closed topic is a resolution the owner recorded; a merged one is retired in
// favour of its target. Neither may gain a turn, and neither auto-reopens --
// reopening is an explicit owner act. A turn whose only match is sealed routes to
// the open catch-all when one exists, and otherwise keeps no topic membership at
// all. Existing membership is never rewritten or removed: sealing only refuses
// additions.

var CATCH_ALL = "uncategorised-conversations";
var CODEX_SEED = "codex-authentication";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-topic-seal-"));
  var clock = 100;
  var index = topics.createTopicIndex({
    file: path.join(dir, "lead", "coop-topic-index.json"),
    now: function () { clock++; return clock; },
  });
  return {
    index: index,
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// Owner turns carry real provenance; that is how admission separates a message
// the owner typed from an injected control prompt without reading the words.
function turn(text, extra) {
  return [
    Object.assign({
      type: "user_message", text: text,
      from: "a66ce4a1-b807-46da-b9c3-e62686e4b28e",
      fromName: "Admin",
      clientMessageId: "cm-owner-" + String(text).length,
    }, extra || {}),
    { type: "delta_replace", text: "assistant reply about " + text },
    { type: "done" },
  ];
}

function session(history) {
  return { coopHome: true, storageId: "canonical-topic-home", history: history };
}

function topicById(index, id) {
  return index.load().topics[id];
}

function turnCount(index, id) {
  var topic = topicById(index, id);
  return topic && Array.isArray(topic.turnRefs) ? topic.turnRefs.length : 0;
}

// Every topic id this turn span became a member of, read from the durable index
// rather than the projection: sealing is a membership rule, and projection has
// its own separate visibility rules that would mask the answer.
function membershipFor(index, startEventIndex) {
  var topicsById = index.load().topics;
  var ids = Object.keys(topicsById).sort();
  var found = [];
  for (var i = 0; i < ids.length; i++) {
    var refs = topicsById[ids[i]].turnRefs || [];
    for (var r = 0; r < refs.length; r++) {
      if (refs[r].startEventIndex === startEventIndex) { found.push(ids[i]); break; }
    }
  }
  return found;
}

test("a closed seed cannot gain a new turn and the turn falls to the open catch-all", function () {
  var h = harness();
  try {
    var history = turn("codex auth login credential rotation");
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    assert.equal(turnCount(h.index, CODEX_SEED), 1, "the seed matches while it is open");

    assert.deepEqual(h.index.close({ topicId: CODEX_SEED }), { ok: true });
    var before = turnCount(h.index, CODEX_SEED);

    // A second turn matching the same seed words arrives after closure.
    history.push.apply(history, turn("more codex auth token credential questions"));
    h.index.ensureRetro(canonical, {});

    assert.equal(turnCount(h.index, CODEX_SEED), before,
      "a closed seed must not absorb a turn that matches its words");
    assert.deepEqual(membershipFor(h.index, 3), [CATCH_ALL],
      "the sealed match routes deterministically to the open catch-all");
    assert.equal(topicById(h.index, CODEX_SEED).status, "closed",
      "matching a closed seed must never auto-reopen it");
  } finally { h.cleanup(); }
});

test("a closed seed match does not mint a replacement automatic topic", function () {
  // Sealing must not be a loophole that spawns a near-duplicate lens: the match
  // is real, so it suppresses auto-creation even though it grants no membership.
  var h = harness();
  try {
    var history = turn("codex auth login credential rotation");
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    h.index.close({ topicId: CODEX_SEED });

    history.push.apply(history, turn("codex auth token credential rotation again"));
    h.index.ensureRetro(canonical, {});

    var ids = Object.keys(h.index.load().topics);
    var automatic = ids.filter(function (id) { return id.indexOf("auto-") === 0; });
    assert.deepEqual(automatic, [],
      "a turn whose only match is a closed seed must not mint a fresh automatic topic");
  } finally { h.cleanup(); }
});

test("an explicit ref to a closed topic grants no membership and does not reopen it", function () {
  var h = harness();
  try {
    var history = turn("bakery inventory spreadsheet reconciliation");
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    var automaticId = Object.keys(h.index.load().topics).filter(function (id) {
      return id.indexOf("auto-") === 0;
    })[0];
    assert.ok(automaticId, "the first owner turn mints an automatic topic durably");

    h.index.close({ topicId: automaticId });
    var before = turnCount(h.index, automaticId);

    // The owner's next turn still carries the ref recorded before closure.
    history.push.apply(history, turn("a follow up thought", {
      coopTopicRef: { topicId: automaticId },
    }));
    h.index.ensureRetro(canonical, {});

    assert.equal(turnCount(h.index, automaticId), before,
      "an explicit ref must not push a new turn into a closed topic");
    assert.deepEqual(membershipFor(h.index, 3), [CATCH_ALL],
      "the explicitly routed turn falls back to the open catch-all");
    assert.equal(topicById(h.index, automaticId).status, "closed",
      "explicit routing must never auto-reopen a closed topic");
  } finally { h.cleanup(); }
});

test("an explicit ref to a merged topic follows the chain and never revives the source", function () {
  var h = harness();
  try {
    var history = turn("codex auth login credential rotation");
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});

    var split = h.index.split({ topicId: CODEX_SEED }, [{ title: "Credential rotation detail" }]);
    assert.equal(split.ok, true);
    var sourceId = split.topicRefs[0].topicId;
    assert.deepEqual(h.index.merge({ topicId: CODEX_SEED }, [{ topicId: sourceId }]).ok, true);
    assert.equal(topicById(h.index, sourceId).status, "merged");

    var before = turnCount(h.index, CODEX_SEED);
    history.push.apply(history, turn("an unrelated quiet aside", {
      coopTopicRef: { topicId: sourceId },
    }));
    h.index.ensureRetro(canonical, {});

    assert.equal(turnCount(h.index, sourceId), 0,
      "a merged topic must never gain membership");
    assert.equal(topicById(h.index, sourceId).status, "merged",
      "a merged topic must never auto-reopen");
    assert.equal(turnCount(h.index, CODEX_SEED), before + 1,
      "the ref resolves through the merge chain to the open target instead");
  } finally { h.cleanup(); }
});

test("a merged topic cannot be reopened even by an explicit owner action", function () {
  var h = harness();
  try {
    h.index.ensureRetro(session(turn("codex auth login credential rotation")), {});
    var split = h.index.split({ topicId: CODEX_SEED }, [{ title: "Credential rotation detail" }]);
    var sourceId = split.topicRefs[0].topicId;
    h.index.merge({ topicId: CODEX_SEED }, [{ topicId: sourceId }]);

    assert.deepEqual(h.index.reopen({ topicId: sourceId }), { ok: false, code: "topic_merged" },
      "its membership now lives in the target, so reviving it would duplicate a lens");
    assert.equal(topicById(h.index, sourceId).status, "merged");
  } finally { h.cleanup(); }
});

test("a closed topic reopens on an explicit owner action and takes turns again", function () {
  // The seal is about automatic routing, not about taking away owner control.
  var h = harness();
  try {
    var history = turn("codex auth login credential rotation");
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    h.index.close({ topicId: CODEX_SEED });
    assert.deepEqual(h.index.reopen({ topicId: CODEX_SEED }), { ok: true });

    history.push.apply(history, turn("more codex auth credential questions"));
    h.index.ensureRetro(canonical, {});
    assert.equal(turnCount(h.index, CODEX_SEED), 2,
      "once the owner reopens it, the topic routes normally again");
  } finally { h.cleanup(); }
});

test("with the matching seed and the catch-all both closed a turn keeps no membership", function () {
  // The end of the fallback chain, and the whole point of failing closed: when
  // every candidate home is sealed the turn is simply not a member of anything.
  // Nothing is reopened, nothing is misattributed, and the canonical transcript
  // still holds the turn itself.
  var h = harness();
  try {
    var history = turn("codex auth login credential rotation");
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    h.index.close({ topicId: CODEX_SEED });
    h.index.close({ topicId: CATCH_ALL });
    var catchAllBefore = turnCount(h.index, CATCH_ALL);
    var seedBefore = turnCount(h.index, CODEX_SEED);

    history.push.apply(history, turn("more codex auth credential questions"));
    h.index.ensureRetro(canonical, {});

    assert.equal(turnCount(h.index, CATCH_ALL), catchAllBefore,
      "a closed catch-all must not absorb new turns either");
    assert.equal(turnCount(h.index, CODEX_SEED), seedBefore,
      "the closed seed gains nothing despite matching the words");
    assert.deepEqual(membershipFor(h.index, 3), [],
      "with no open home the turn keeps no membership rather than reopening one");
    assert.equal(topicById(h.index, CATCH_ALL).status, "closed",
      "the catch-all must not auto-reopen under pressure");
    assert.equal(topicById(h.index, CODEX_SEED).status, "closed");
  } finally { h.cleanup(); }
});

test("a closed catch-all still absorbs nothing while other topics route normally", function () {
  var h = harness();
  try {
    var history = turn("codex auth login credential rotation");
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    h.index.close({ topicId: CATCH_ALL });
    var before = turnCount(h.index, CATCH_ALL);

    history.push.apply(history, turn("more codex auth credential questions"));
    h.index.ensureRetro(canonical, {});

    assert.equal(turnCount(h.index, CATCH_ALL), before,
      "the closed catch-all is sealed even though it is the universal fallback");
    assert.deepEqual(membershipFor(h.index, 3), [CODEX_SEED],
      "the still-open seed takes the turn on its own");
  } finally { h.cleanup(); }
});

test("closing a topic never removes or rewrites the membership it already had", function () {
  // Existing (even misclassified) membership is deliberately left untouched: the
  // seal refuses additions, it does not rewrite history.
  var h = harness();
  try {
    var canonical = session(turn("codex auth login credential rotation"));
    h.index.ensureRetro(canonical, {});
    var before = JSON.stringify(topicById(h.index, CODEX_SEED).turnRefs);

    h.index.close({ topicId: CODEX_SEED });
    h.index.ensureRetro(canonical, {});

    assert.equal(JSON.stringify(topicById(h.index, CODEX_SEED).turnRefs), before,
      "membership recorded while the topic was open survives closure verbatim");
  } finally { h.cleanup(); }
});

test("updatedAt moves exactly with membership and a replay is a true no-op", function () {
  var h = harness();
  try {
    var history = turn("codex auth login credential rotation");
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    var afterFirst = topicById(h.index, CODEX_SEED).updatedAt;
    assert.ok(afterFirst > 0);

    // Idempotent replay of settled history: no membership changes, so no
    // timestamp may move. This is what makes "last changed" mean something.
    var replay = h.index.ensureRetro(canonical, {});
    assert.equal(replay.changed, false, "replaying settled history changes nothing");
    assert.equal(topicById(h.index, CODEX_SEED).updatedAt, afterFirst,
      "a no-op replay must not touch updatedAt");

    // A genuinely new turn adds membership, so the timestamp must move.
    history.push.apply(history, turn("more codex auth credential questions"));
    h.index.ensureRetro(canonical, {});
    assert.ok(topicById(h.index, CODEX_SEED).updatedAt > afterFirst,
      "new membership must move updatedAt");
  } finally { h.cleanup(); }
});

test("a sealed topic's updatedAt stays frozen while other topics move", function () {
  var h = harness();
  try {
    var history = turn("codex auth login credential rotation");
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    h.index.close({ topicId: CODEX_SEED });
    var sealedAt = topicById(h.index, CODEX_SEED).updatedAt;
    var catchAllAt = topicById(h.index, CATCH_ALL).updatedAt;

    history.push.apply(history, turn("more codex auth credential questions"));
    h.index.ensureRetro(canonical, {});

    assert.equal(topicById(h.index, CODEX_SEED).updatedAt, sealedAt,
      "a sealed topic gained nothing, so its updatedAt must not move");
    assert.ok(topicById(h.index, CATCH_ALL).updatedAt > catchAllAt,
      "the catch-all that actually absorbed the turn does move");
  } finally { h.cleanup(); }
});

test("sealing does not bump the retro version", function () {
  // A RETRO_VERSION bump forces a full reclassification of the owner's real
  // transcript. Phase 1 changes routing rules only, so it must not trigger one.
  var h = harness();
  try {
    var canonical = session(turn("codex auth login credential rotation"));
    h.index.ensureRetro(canonical, {});
    assert.equal(h.index.load().retro.version, 3,
      "the retro version must stay at the value Phase 0 shipped");
  } finally { h.cleanup(); }
});

test("live ingress classification refuses a closed topic and uses the open catch-all", function () {
  // classifyCanonicalIngress is the live path, separate from retro replay, and
  // has to honour the same seal.
  var h = harness();
  try {
    var canonical = session(turn("bakery inventory spreadsheet reconciliation"));
    h.index.ensureRetro(canonical, {});
    var automaticId = Object.keys(h.index.load().topics).filter(function (id) {
      return id.indexOf("auto-") === 0;
    })[0];
    h.index.close({ topicId: automaticId });

    var routed = h.index.classifyCanonicalIngress(canonical, {
      text: "bakery inventory spreadsheet reconciliation",
    }, {});
    assert.equal(routed.ok, true);
    assert.equal(routed.topicRef.topicId, CATCH_ALL,
      "live ingress falls back to the open catch-all rather than reviving the closed topic");
    assert.equal(topicById(h.index, automaticId).status, "closed");
  } finally { h.cleanup(); }
});

test("live ingress fails closed when the catch-all is closed too", function () {
  var h = harness();
  try {
    var canonical = session(turn("bakery inventory spreadsheet reconciliation"));
    h.index.ensureRetro(canonical, {});
    var automaticId = Object.keys(h.index.load().topics).filter(function (id) {
      return id.indexOf("auto-") === 0;
    })[0];
    h.index.close({ topicId: automaticId });
    h.index.close({ topicId: CATCH_ALL });

    var routed = h.index.classifyCanonicalIngress(canonical, {
      text: "bakery inventory spreadsheet reconciliation",
    }, {});
    assert.deepEqual(routed, { ok: false, code: "topic_closed" },
      "with no open home the ingress reports topic_closed instead of guessing");
  } finally { h.cleanup(); }
});

test("explicit new-message ingress is refused for a closed topic", function () {
  // validateIngress without includeClosedTopics is the write path, and it stays
  // open-only. Review paths that pass includeClosedTopics are unaffected.
  var h = harness();
  try {
    var canonical = session(turn("codex auth login credential rotation"));
    h.index.ensureRetro(canonical, {});
    h.index.close({ topicId: CODEX_SEED });

    assert.deepEqual(
      h.index.validateIngress(canonical, { coopTopicRef: { topicId: CODEX_SEED } }, {}),
      { ok: false, code: "topic_closed" });

    var review = h.index.validateIngress(canonical, { coopTopicRef: { topicId: CODEX_SEED } },
      { includeClosedTopics: true });
    assert.equal(review.ok, true,
      "a closed topic stays reviewable, so Done topics remain discoverable");
  } finally { h.cleanup(); }
});

test("a closed topic can still gain linked work but a merged one cannot", function () {
  // Work outlives the decision to close, and that link is how completed work
  // becomes awaiting acceptance instead of vanishing. A merged identity is
  // retired, so linking live work to it would strand the work on a dead lens.
  var h = harness();
  try {
    h.index.ensureRetro(session(turn("codex auth login credential rotation")), {});
    var execution = {
      sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e", sessionStorageId: "worker-session" },
    };

    h.index.close({ topicId: CODEX_SEED });
    assert.deepEqual(h.index.linkExecution({ topicId: CODEX_SEED }, execution), { ok: true });

    h.index.reopen({ topicId: CODEX_SEED });
    var split = h.index.split({ topicId: CODEX_SEED }, [{ title: "Credential rotation detail" }]);
    var sourceId = split.topicRefs[0].topicId;
    h.index.merge({ topicId: CODEX_SEED }, [{ topicId: sourceId }]);

    assert.deepEqual(h.index.linkExecution({ topicId: sourceId }, execution),
      { ok: false, code: "topic_merged" });
  } finally { h.cleanup(); }
});
