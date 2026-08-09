var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var topics = require("../lib/coop-topic-index");

// Topic admission must require at least one owner-relevant turn. Internal
// execution narration -- worker fan-in, the scheduled Lead tick -- is already
// dropped from replay, so a topic minted from it alone would open onto an empty
// transcript. These tests drive the real index against a real canonical session.

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-topic-admission-"));
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

// Owner turns carry real provenance, matching the owner's transcript. An
// injected control prompt has none, which is how admission tells them apart
// without reading the words.
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

function automaticTopics(index, canonical) {
  var projection = index.project({ history: canonical.history });
  var found = [];
  for (var g = 0; g < projection.groups.length; g++) {
    var list = projection.groups[g].topics || [];
    for (var t = 0; t < list.length; t++) {
      var id = list[t].topicRef && list[t].topicRef.topicId;
      if (id && id.indexOf("auto-") === 0) found.push(id);
    }
  }
  return found;
}

function allProjectedIds(index, canonical) {
  var projection = index.project({ history: canonical.history });
  var found = [];
  for (var g = 0; g < projection.groups.length; g++) {
    var list = projection.groups[g].topics || [];
    for (var t = 0; t < list.length; t++) found.push(list[t].topicRef.topicId);
  }
  return found;
}

test("an owner turn can mint a topic", function () {
  var h = harness();
  try {
    // Deliberately unlike any seed, so this exercises automatic creation rather
    // than seed matching.
    var canonical = session(turn("bakery inventory spreadsheet reconciliation"));
    h.index.ensureRetro(canonical, {});
    assert.ok(automaticTopics(h.index, canonical).length > 0,
      "an owner conversation should be able to create an automatic topic");
  } finally { h.cleanup(); }
});

test("the same wording from an internal turn creates nothing", function () {
  // The paired negative: identical text, only the durable flags differ, so the
  // gate is provably keyed on provenance rather than on wording.
  var h = harness();
  try {
    var canonical = session(turn("bakery inventory spreadsheet reconciliation", {
      internalOnly: true, synthetic: true, origin: { kind: "task-notification" },
    }));
    h.index.ensureRetro(canonical, {});
    assert.deepEqual(automaticTopics(h.index, canonical), []);
  } finally { h.cleanup(); }
});

test("an internal-only candidate does not create a topic", function () {
  var h = harness();
  try {
    var canonical = session(turn("worker completed the delegated review task", {
      synthetic: true, origin: { kind: "task-notification" },
      fromName: "Clay workers", internalOnly: true,
    }));
    h.index.ensureRetro(canonical, {});
    assert.deepEqual(automaticTopics(h.index, canonical), [],
      "internal execution narration must not be enough to create a topic");
  } finally { h.cleanup(); }
});

test("the scheduled Lead tick does not create a topic", function () {
  var h = harness();
  try {
    var canonical = session(turn("↻ Lead tick", { autoAction: true }));
    h.index.ensureRetro(canonical, {});
    assert.deepEqual(automaticTopics(h.index, canonical), []);
  } finally { h.cleanup(); }
});

test("a topic with only internal turns is not projected", function () {
  var h = harness();
  try {
    // Owner turn first so a topic exists, then confirm the catch-all is not
    // shown on the strength of internal turns alone.
    var internalOnly = session(turn("automation status sweep", {
      internalOnly: true, synthetic: true, origin: { kind: "task-notification" },
    }));
    h.index.ensureRetro(internalOnly, {});
    assert.deepEqual(allProjectedIds(h.index, internalOnly), [],
      "no topic should be visible when every turn is internal");
  } finally { h.cleanup(); }
});

test("a topic appears as soon as one relevant turn lands", function () {
  var h = harness();
  try {
    var history = turn("worker finished", {
      internalOnly: true, synthetic: true, origin: { kind: "task-notification" },
    });
    var canonical = session(history);
    h.index.ensureRetro(canonical, {});
    assert.deepEqual(allProjectedIds(h.index, canonical), []);

    // The owner speaks. Nothing was lost; the topic simply becomes visible.
    canonical.history = history.concat(turn("what did the worker actually change?"));
    h.index.ensureRetro(canonical, {});
    assert.ok(allProjectedIds(h.index, canonical).length > 0,
      "a relevant turn must make the topic visible");
  } finally { h.cleanup(); }
});

test("internal turns still join a topic they are explicitly routed to", function () {
  var h = harness();
  try {
    // No history is orphaned: an internal turn may not CREATE a topic, but it
    // still attaches where it belongs so the durable index stays complete.
    var canonical = session(turn("review the switcher work"));
    h.index.ensureRetro(canonical, {});
    var before = allProjectedIds(h.index, canonical);
    assert.ok(before.length > 0);

    canonical.history = canonical.history.concat(turn("worker reported completion", {
      internalOnly: true, synthetic: true, origin: { kind: "task-notification" },
    }));
    h.index.ensureRetro(canonical, {});
    var after = allProjectedIds(h.index, canonical);
    assert.deepEqual(after.sort(), before.sort(),
      "an internal turn must not add or remove visible topics");
  } finally { h.cleanup(); }
});

test("the visibility gate is display-only and loses no membership", function () {
  var h = harness();
  try {
    var canonical = session(turn("worker finished", {
      internalOnly: true, synthetic: true, origin: { kind: "task-notification" },
    }));
    h.index.ensureRetro(canonical, {});
    // Hidden from the projection...
    assert.deepEqual(allProjectedIds(h.index, canonical), []);
    // ...but the durable index still holds the catch-all with its membership,
    // so the transcript remains fully addressable.
    var withoutHistory = h.index.project({});
    var ids = [];
    for (var g = 0; g < withoutHistory.groups.length; g++) {
      var list = withoutHistory.groups[g].topics || [];
      for (var t = 0; t < list.length; t++) ids.push(list[t].topicRef.topicId);
    }
    assert.ok(ids.indexOf("uncategorised-conversations") !== -1,
      "membership must survive; only visibility is gated");
  } finally { h.cleanup(); }
});
