var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var intent = require("../lib/coop-thread-intent");
var topicIndex = require("../lib/coop-topic-index");

function indexHarness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-thread-intent-"));
  var tick = 100;
  var index = topicIndex.createTopicIndex({
    file: path.join(dir, "lead", "topics.json"),
    now: function () { tick += 1; return tick; },
  });
  var state = index.load();
  state.topics["thread-a"] = {
    topicRef: { topicId: "thread-a" }, threadRef: { threadId: "thread-a" },
    title: "Thread A", group: { kind: "uncategorised" }, source: "manual",
    status: "open", createdAt: 1, updatedAt: 1, eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
  state.topics["thread-b"] = {
    topicRef: { topicId: "thread-b" }, threadRef: { threadId: "thread-b" },
    title: "Thread B", group: { kind: "uncategorised" }, source: "manual",
    status: "open", createdAt: 1, updatedAt: 1, eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
  index.save();
  index.ensureThreadLifecycle();
  return { dir: dir, index: index };
}

test("natural language maps only clear exact-target lifecycle commands", function () {
  assert.equal(intent.parse("keep this open", { explicitTarget: true }).kind, "keep_open");
  assert.equal(intent.parse("continue the discussion", { explicitTarget: true }).kind, "keep_open");
  assert.equal(intent.parse("open this", { explicitTarget: true }).kind, "reopen");
  assert.equal(intent.parse("keep discussing this", { explicitTarget: true }).kind, "keep_open");
  assert.equal(intent.parse("hand this off", { explicitTarget: true }).kind, "hand_off");
  assert.equal(intent.parse("hand this to Clay", { explicitTarget: true }).kind, "hand_off");
  assert.equal(intent.parse("implement this", { explicitTarget: true }).kind, "implement");
  assert.deepEqual(intent.parse("request changes: add a regression test", { explicitTarget: true }), {
    kind: "request_changes", note: "add a regression test",
  });
  assert.equal(intent.parse("hide this", { explicitTarget: true }).kind, "hide");
  assert.equal(intent.parse("do not pursue this", { explicitTarget: true }).kind, "hide");
  assert.equal(intent.parse("reopen", { explicitTarget: true }).kind, "reopen");
  assert.equal(intent.parse("undo that", { explicitTarget: true }).kind, "undo");
});

test("Main command-shaped language is clarification-only and never actionable", function () {
  var parsed = intent.parse("hide this", { explicitTarget: false });
  assert.equal(parsed.kind, "ambiguous");
  assert.equal(intent.isActionable(parsed), false);
  assert.equal(intent.parse("request changes", { explicitTarget: true }).kind, "ambiguous");
});

test("hide retains exact refs, request changes is durable, and reopen/undo repeat safely", function () {
  var h = indexHarness();
  try {
    var ref = { threadId: "thread-a" };
    var hidden = intent.apply(h.index, ref, { kind: "hide" }, {});
    assert.equal(hidden.ok, true);
    var retained = h.index.resolve({ topicId: "thread-a" }, true).thread;
    assert.equal(retained.hidden, true);
    assert.deepEqual(retained.threadRef, ref);
    assert.equal(h.index.resolve({ topicId: "thread-b" }, true).thread.hidden, false);

    var reopened = intent.apply(h.index, ref, { kind: "reopen" }, {});
    assert.equal(reopened.ok, true);
    assert.equal(h.index.resolve(ref, true).thread.hidden, false);
    assert.equal(intent.apply(h.index, ref, { kind: "reopen" }, {}).unchanged, true);

    var requested = intent.apply(h.index, ref, {
      kind: "request_changes", note: "Please add coverage.",
    }, { requestId: "thread-control:one" });
    assert.equal(requested.ok, true);
    assert.equal(h.index.resolve(ref, true).thread.ownerDisposition.status, "needs_input");

    var undone = intent.apply(h.index, ref, { kind: "undo" }, {});
    assert.equal(undone.ok, true);
    assert.equal(h.index.resolve(ref, true).thread.threadState, "exploring");
    assert.equal(intent.apply(h.index, ref, { kind: "undo" }, {}).unchanged, true);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
