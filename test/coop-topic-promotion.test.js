var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var topics = require("../lib/coop-topic-index");
var promotion = require("../lib/coop-topic-promotion");

// Phase 3 of the approved topic lifecycle: an automatic topic minted from a
// single owner turn stays durable and searchable but claims no owner-visible row
// until there is evidence the owner treats it as a real thread.
//
// A passing remark minting a permanent sidebar entry is how throwaway fragments
// used to accumulate forever. Nothing is lost -- the durable index keeps every
// membership -- so the topic appears the moment any promotion signal lands: a
// second owner-relevant turn, explicit owner routing, linked work, or a recorded
// owner disposition.
//
// Closure is deliberately NOT a promotion signal. Closing a quiet one-turn topic
// is the owner dismissing it, so counting closure would make tidying up ADD rows
// to the Done section.

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-topic-promotion-"));
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

// The single automatic topic the given history minted, read from the durable
// index. Automatic topics carry an id derived from their own title hash, which is
// what separates them from the curated seeds.
function automaticId(index) {
  var ids = Object.keys(index.load().topics).filter(function (id) {
    return id.indexOf("auto-") === 0;
  });
  return ids.length === 1 ? ids[0] : ids;
}

function projectedIds(index, canonical, options) {
  var request = Object.assign({ history: canonical.history }, options || {});
  var view = index.project(request);
  var found = [];
  for (var g = 0; g < view.groups.length; g++) {
    var list = view.groups[g].topics || [];
    for (var t = 0; t < list.length; t++) found.push(list[t].topicRef.topicId);
  }
  return found;
}

function isProjected(index, canonical, id, options) {
  return projectedIds(index, canonical, options).indexOf(id) !== -1;
}

// A one-turn automatic topic: minted, durable, and not yet promoted.
function quietTopic(h) {
  var history = turn("bakery inventory spreadsheet reconciliation");
  var canonical = session(history);
  h.index.ensureRetro(canonical, {});
  var id = automaticId(h.index);
  assert.equal(typeof id, "string", "exactly one automatic topic should exist");
  return { canonical: canonical, history: history, id: id };
}

test("a single-turn automatic topic is durable but not projected", function () {
  var h = harness();
  try {
    var quiet = quietTopic(h);
    var stored = h.index.load().topics[quiet.id];
    assert.ok(stored, "the topic must remain in the durable index");
    assert.equal(stored.turnRefs.length, 1);
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), false,
      "one owner turn does not yet earn a row");
  } finally { h.cleanup(); }
});

test("an interrupted queue-wide authorization still projects its owner-visible Thread", function () {
  var h = harness();
  try {
    var history = [];
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    var text = "Let's run all that you possibly can, anything that is not blocked should run...";
    var routed = h.index.classifyCanonicalIngress(canonical, { text: text }, {});
    assert.equal(routed.ok, true);
    history.push({
      type: "user_message",
      text: text,
      from: "a66ce4a1-b807-46da-b9c3-e62686e4b28e",
      fromName: "Admin",
      coopIngressId: "coop:canonical-topic-home:339",
      coopTopicRef: routed.topicRef,
    });
    h.index.addEventMembership(routed.topicRef, [{
      projectId: "system-lead",
      sessionStorageId: "canonical-topic-home",
      eventIndex: 0,
    }]);

    var stored = h.index.load().topics[routed.topicRef.topicId];
    assert.equal(stored.turnRefs.length, 0,
      "the priority-interrupted turn has no completed turn span");
    assert.equal(stored.eventRefs.length, 1,
      "send-time binding still preserves its exact owner event");
    assert.equal(isProjected(h.index, canonical, routed.topicRef.topicId), true,
      "an actionable queue Thread must not disappear just because its reply was interrupted");
  } finally { h.cleanup(); }
});

test("a second owner-relevant turn promotes the topic", function () {
  var h = harness();
  try {
    var quiet = quietTopic(h);
    // Overlapping keywords, so classification routes this to the SAME automatic
    // topic rather than minting a second one.
    quiet.history.push.apply(quiet.history, turn("bakery inventory audit follow up"));
    h.index.ensureRetro(quiet.canonical, {});

    assert.equal(h.index.load().topics[quiet.id].turnRefs.length, 2,
      "both turns must land on the same automatic topic");
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), true,
      "a thread the owner came back to earns its row");
  } finally { h.cleanup(); }
});

test("an internal second turn does not promote the topic", function () {
  // The threshold counts OWNER-relevant turns. Internal narration is already
  // dropped from replay, so counting it would promote a topic whose lens is still
  // effectively a single remark.
  var h = harness();
  try {
    var quiet = quietTopic(h);
    quiet.history.push.apply(quiet.history, turn("bakery inventory audit follow up", {
      internalOnly: true, synthetic: true, origin: { kind: "task-notification" },
    }));
    h.index.ensureRetro(quiet.canonical, {});

    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), false,
      "internal narration is not evidence the owner cares");
  } finally { h.cleanup(); }
});

test("explicit owner routing promotes the topic", function () {
  var h = harness();
  try {
    var quiet = quietTopic(h);
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), false);

    // The owner aims a new message at this exact lens. validateIngress without
    // includeClosedTopics is the write path, so it records the explicit route.
    var routed = h.index.validateIngress(quiet.canonical,
      { coopTopicRef: { topicId: quiet.id } }, {});
    assert.equal(routed.ok, true);
    assert.equal(h.index.load().topics[quiet.id].explicitlyRouted, true,
      "the explicit route is recorded durably");
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), true,
      "a lens the owner deliberately addressed earns its row");
  } finally { h.cleanup(); }
});

test("reviewing a topic is not explicit routing and does not promote it", function () {
  // Selection, replay and drill-through admit closed topics so a resolved topic
  // stays reviewable. Merely looking at a quiet topic must not pin it.
  var h = harness();
  try {
    var quiet = quietTopic(h);
    var reviewed = h.index.validateIngress(quiet.canonical,
      { coopTopicRef: { topicId: quiet.id } }, { includeClosedTopics: true });
    assert.equal(reviewed.ok, true);

    assert.notEqual(h.index.load().topics[quiet.id].explicitlyRouted, true,
      "a read-only review must not record an explicit route");
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), false,
      "reviewing a quiet topic does not promote it");
  } finally { h.cleanup(); }
});

test("an explicit route is recorded once and does not move updatedAt", function () {
  // updatedAt tracks membership. The turn this route carries will bump it on
  // arrival; recording the route itself must not.
  var h = harness();
  try {
    var quiet = quietTopic(h);
    var before = h.index.load().topics[quiet.id].updatedAt;

    h.index.validateIngress(quiet.canonical, { coopTopicRef: { topicId: quiet.id } }, {});
    h.index.validateIngress(quiet.canonical, { coopTopicRef: { topicId: quiet.id } }, {});

    assert.equal(h.index.load().topics[quiet.id].updatedAt, before,
      "recording an explicit route is not membership, so updatedAt stays put");
    assert.equal(h.index.load().topics[quiet.id].explicitlyRouted, true);
  } finally { h.cleanup(); }
});

test("linked execution work promotes the topic", function () {
  var h = harness();
  try {
    var quiet = quietTopic(h);
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), false);

    assert.deepEqual(h.index.linkExecution({ topicId: quiet.id }, {
      sessionRef: { projectId: CLAY, sessionStorageId: "worker-session" },
    }), { ok: true });

    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), true,
      "a topic with real work attached is never noise");
  } finally { h.cleanup(); }
});

test("hidden related sessions do not promote a quiet topic", function () {
  var h = harness();
  try {
    var quiet = quietTopic(h);
    var execution = {
      sessionRef: { projectId: CLAY, sessionStorageId: "hidden-session" },
    };
    assert.deepEqual(h.index.linkExecution({ topicId: quiet.id }, execution), { ok: true });

    var hidden = isProjected(h.index, quiet.canonical, quiet.id, {
      resolveRelatedSession: function () { return null; },
    });
    assert.equal(hidden, false,
      "an archived or hidden related session is not owner-visible promotion evidence");

    var visible = isProjected(h.index, quiet.canonical, quiet.id, {
      resolveRelatedSession: function () {
        return { topLevel: true, title: "Visible project session" };
      },
    });
    assert.equal(visible, true, "a visible related session still promotes the topic");
  } finally { h.cleanup(); }
});

test("a linked task promotes the topic through the state seam", function () {
  // Tasks link to a topic by coopTopicRef rather than through relatedExecutions,
  // so the promotion filter has to see the computed linked-work count.
  var h = harness();
  try {
    var quiet = quietTopic(h);
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), false);

    var withTask = isProjected(h.index, quiet.canonical, quiet.id, {
      computeTopicState: function () { return { taskCount: 1, workState: "working" }; },
    });
    assert.equal(withTask, true, "linked task work promotes the topic");
  } finally { h.cleanup(); }
});

test("a recorded owner disposition promotes the topic", function () {
  var h = harness();
  try {
    var quiet = quietTopic(h);
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), false);

    var applied = h.index.applyTopicDisposition({ topicId: quiet.id }, { verb: "accept_done" });
    assert.equal(applied.ok, true);
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), true,
      "a topic the owner ruled on is a decision they may want to revisit");
  } finally { h.cleanup(); }
});

test("closing a quiet automatic topic does not promote it", function () {
  // The explicit anti-regression for "closure does not worsen projection noise":
  // tidying up must never add rows.
  var h = harness();
  try {
    var quiet = quietTopic(h);
    assert.deepEqual(h.index.close({ topicId: quiet.id }), { ok: true });

    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), false,
      "closing a one-turn topic must not surface it in the Done section");
    assert.ok(h.index.load().topics[quiet.id], "it stays durable and searchable");
  } finally { h.cleanup(); }
});

test("closing a promoted topic keeps it discoverable", function () {
  // Closure must not silently delete a real thread from the owner's view either;
  // a resolved topic that earned its row stays visible as Done.
  var h = harness();
  try {
    var quiet = quietTopic(h);
    quiet.history.push.apply(quiet.history, turn("bakery inventory audit follow up"));
    h.index.ensureRetro(quiet.canonical, {});
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), true);

    h.index.close({ topicId: quiet.id });
    assert.equal(isProjected(h.index, quiet.canonical, quiet.id), true,
      "a promoted topic stays discoverable after closure");
  } finally { h.cleanup(); }
});

test("seed and manual topics are never held back", function () {
  // Only automatically minted topics are gated. Seeds share source "automatic"
  // but carry curated ids, and a split topic is a deliberate owner act.
  var h = harness();
  try {
    var canonical = session(turn("codex auth login credential rotation"));
    h.index.ensureRetro(canonical, {});
    assert.equal(isProjected(h.index, canonical, "codex-authentication"), true,
      "a seed with one turn still projects");

    var split = h.index.split({ topicId: "codex-authentication" }, [{ title: "Credential rotation detail" }]);
    assert.equal(split.ok, true);
    var splitTopic = h.index.load().topics[split.topicRefs[0].topicId];
    // A split topic is a deliberate owner act, so the promotion threshold never
    // applies to it. Whether it shows up is then governed only by the separate,
    // pre-existing rule that a topic needs one owner-relevant turn -- a brand-new
    // split has none yet, which is why this asserts the predicate rather than the
    // promotion.
    assert.equal(promotion.isAutomaticallyMinted(splitTopic), false);
    assert.equal(promotion.isProjectable(splitTopic, {}, { history: canonical.history }), true,
      "the promotion threshold must never hold back a split topic");
  } finally { h.cleanup(); }
});

test("promotion is judged on membership, not on identity, and is replay-stable", function () {
  // Re-running the retro over settled history must not flip a topic in or out of
  // the projection: the decision is a pure function of durable membership.
  var h = harness();
  try {
    var quiet = quietTopic(h);
    var first = projectedIds(h.index, quiet.canonical);
    h.index.ensureRetro(quiet.canonical, {});
    assert.deepEqual(projectedIds(h.index, quiet.canonical), first,
      "a replay of settled history leaves the projection identical");

    quiet.history.push.apply(quiet.history, turn("bakery inventory audit follow up"));
    h.index.ensureRetro(quiet.canonical, {});
    var promoted = projectedIds(h.index, quiet.canonical);
    h.index.ensureRetro(quiet.canonical, {});
    assert.deepEqual(projectedIds(h.index, quiet.canonical), promoted,
      "and a replay after promotion is equally stable");
  } finally { h.cleanup(); }
});

test("the promotion filter never hides a topic when there is no history to judge from", function () {
  // Callers without history cannot tell a one-turn topic from a busy one, so
  // withholding on a guess would hide real threads.
  var h = harness();
  try {
    var quiet = quietTopic(h);
    var view = h.index.project({});
    var found = [];
    for (var g = 0; g < view.groups.length; g++) {
      var list = view.groups[g].topics || [];
      for (var t = 0; t < list.length; t++) found.push(list[t].topicRef.topicId);
    }
    assert.ok(found.indexOf(quiet.id) !== -1,
      "with no history supplied the topic is shown rather than guessed away");
  } finally { h.cleanup(); }
});

test("isProjectable classifies topic kinds directly", function () {
  // Unit-level cover for the predicate, so the promotion rule is pinned
  // independently of how project() happens to call it.
  var automatic = {
    topicRef: { topicId: "auto-" + "a".repeat(24) }, source: "automatic",
    turnRefs: [], relatedExecutions: [],
  };
  assert.equal(promotion.isAutomaticallyMinted(automatic), true);
  assert.equal(promotion.isProjectable(automatic, {}, { history: [] }), false);
  assert.equal(promotion.isProjectable(automatic, { linkedWorkCount: 2 }, { history: [] }), true);

  var seed = {
    topicRef: { topicId: "codex-authentication" }, source: "automatic",
    turnRefs: [], relatedExecutions: [],
  };
  assert.equal(promotion.isAutomaticallyMinted(seed), false);
  assert.equal(promotion.isProjectable(seed, {}, { history: [] }), true);

  assert.equal(promotion.PROMOTION_TURN_THRESHOLD, 2);
});
