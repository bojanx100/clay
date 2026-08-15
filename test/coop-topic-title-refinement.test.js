var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var topicIndex = require("../lib/coop-topic-index");
var titleRefinement = require("../lib/coop-topic-title-refinement");

function ownerMessage(text, index, extra) {
  return Object.assign({
    type: "user_message",
    text: text,
    from: "owner",
    fromName: "Owner",
    clientMessageId: "owner-" + index,
    _ts: 1000 + index,
  }, extra || {});
}

function appendTurn(session, text, topicRef, extra) {
  var start = session.history.length;
  session.history.push(ownerMessage(text, start,
    Object.assign({ coopTopicRef: topicRef }, extra || {})));
  session.history.push({ type: "delta", text: "Verified reply", _ts: start + 1 });
  session.history.push({ type: "done", _ts: start + 2 });
  return start;
}

function newHarness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-title-refinement-"));
  var file = path.join(dir, "lead", "coop-topic-index.json");
  var clock = 10;
  var index = topicIndex.createTopicIndex({
    file: file,
    now: function () { clock++; return clock; },
  });
  var session = { coopHome: true, storageId: "canonical-coop", history: [] };
  var options = { projects: [], isProjectAvailable: function () { return false; } };
  index.ensureRetro(session, options);
  return {
    dir: dir,
    file: file,
    index: index,
    session: session,
    options: options,
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function classifyAndComplete(harness, text) {
  var classified = harness.index.classifyCanonicalIngress(harness.session,
    { text: text }, harness.options);
  assert.equal(classified.ok, true);
  appendTurn(harness.session, text, classified.topicRef);
  assert.equal(harness.index.ensureRetro(harness.session, harness.options).ok, true);
  return classified;
}

test("related clarification refines one stable Thread while unrelated and ambiguous input classify safely", function () {
  var h = newHarness();
  try {
    var initial = classifyAndComplete(h,
      "The orchid canvas inspector initially needs a clearer purpose");
    var topic = h.index.resolve(initial.topicRef, true).topic;
    var firstTitle = topic.title;
    var identity = JSON.stringify({
      topicRef: topic.topicRef,
      threadRef: topic.threadRef,
      group: topic.group,
      status: topic.status,
      threadState: topic.threadState,
      relatedExecutions: topic.relatedExecutions,
    });
    assert.equal(initial.classification, "new_topic");
    assert.equal(firstTitle,
      "The orchid canvas inspector");
    assert.doesNotMatch(firstTitle, /…$/,
      "the initial title is a complete owner clause rather than a clipped raw prefix");

    var clarification = classifyAndComplete(h,
      "Orchid canvas inspection should expose safe retry controls");
    var refined = classifyAndComplete(h,
      "The orchid canvas inspector should show failed-step diagnosis and safe retry");
    assert.deepEqual(clarification.topicRef, initial.topicRef,
      "a related clarification enriches the existing Thread");
    assert.deepEqual(refined.topicRef, initial.topicRef,
      "accumulated purpose stays on the same Thread");
    topic = h.index.resolve(initial.topicRef, true).topic;
    assert.equal(topic.title,
      "The orchid canvas inspector should show failed-step diagnosis and safe retry");
    assert.doesNotMatch(topic.title, /…$/,
      "the settled title is a complete owner clause, not clipped raw prose");
    assert.notEqual(topic.title, firstTitle);
    assert.equal(JSON.stringify({
      topicRef: topic.topicRef,
      threadRef: topic.threadRef,
      group: topic.group,
      status: topic.status,
      threadState: topic.threadState,
      relatedExecutions: topic.relatedExecutions,
    }), identity, "retitling changes no identity, binding, group, or lifecycle field");

    var beforeAmbiguous = topic.title;
    var ambiguous = classifyAndComplete(h, "yes, continue");
    assert.deepEqual(ambiguous.topicRef, initial.topicRef,
      "ambiguous low-information input follows the recent proven conversation");
    assert.equal(h.index.resolve(initial.topicRef, true).topic.title, beforeAmbiguous,
      "minor input does not churn the title");

    var unrelated = classifyAndComplete(h,
      "Billing invoice export needs a separate retention policy");
    assert.notDeepEqual(unrelated.topicRef, initial.topicRef,
      "an unrelated named subject creates a separate Thread");
    assert.equal(h.index.resolve(initial.topicRef, true).topic.title, beforeAmbiguous,
      "the latest unrelated turn cannot retitle the existing Thread");
  } finally {
    h.cleanup();
  }
});

test("manual titles and durable handoff bindings survive owner clarification and restart replay", function () {
  var h = newHarness();
  try {
    var initial = classifyAndComplete(h, "Renderer recovery inspection for desktop and mobile");
    classifyAndComplete(h, "Renderer recovery inspection needs a stable navigation route");
    var execution = {
      projectRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
      sessionRef: {
        projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
        sessionStorageId: "project-task-coordinator",
      },
    };
    assert.equal(h.index.linkExecution(initial.topicRef, execution).ok, true);
    assert.equal(h.index.rename(initial.topicRef, "Owner-approved recovery title").ok, true);

    appendTurn(h.session,
      "Renderer recovery inspection should now focus on navigation restoration",
      initial.topicRef);
    h.index.ensureRetro(h.session, h.options);
    var topic = h.index.resolve(initial.topicRef, true).topic;
    assert.equal(topic.title, "Owner-approved recovery title");
    assert.equal(topic.titleManuallySet, true);
    assert.equal(topic.titleRefinement.manual, true);
    assert.equal(topic.threadState, "handed_off");
    assert.deepEqual(topic.relatedExecutions, [execution]);
    var settled = fs.readFileSync(h.file, "utf8");

    var restarted = topicIndex.createTopicIndex({ file: h.file, now: function () { return 9999; } });
    assert.equal(restarted.ensureRetro(h.session, h.options).changed, false);
    assert.equal(fs.readFileSync(h.file, "utf8"), settled,
      "replaying identical owner history does not rewrite the durable index");
    var replayed = restarted.resolve(initial.topicRef, true).topic;
    assert.equal(replayed.title, "Owner-approved recovery title");
    assert.equal(replayed.threadState, "handed_off");
    assert.deepEqual(replayed.relatedExecutions, [execution]);
  } finally {
    h.cleanup();
  }
});

test("worker and fan-in records cannot influence an automatic Thread title", function () {
  var history = [
    ownerMessage("Search recovery diagnostics for the mobile sidebar", 0),
    { type: "done" },
    ownerMessage("Search recovery diagnostics should preserve the selected session", 2),
    { type: "done" },
    ownerMessage("Completely replace this title with worker fan-in noise", 4, {
      internalOnly: true,
      synthetic: true,
      origin: { kind: "task-notification" },
    }),
    { type: "done" },
  ];
  var topic = {
    topicRef: { topicId: "auto-aaaaaaaaaaaaaaaaaaaaaaaa" },
    threadRef: { threadId: "auto-aaaaaaaaaaaaaaaaaaaaaaaa" },
    title: "Search recovery diagnostics…",
    source: "automatic",
    status: "open",
    group: { kind: "uncategorised" },
    turnRefs: [
      { sessionStorageId: "canonical", startEventIndex: 0, endEventIndex: 1 },
      { sessionStorageId: "canonical", startEventIndex: 2, endEventIndex: 3 },
      { sessionStorageId: "canonical", startEventIndex: 4, endEventIndex: 5 },
    ],
    relatedExecutions: [],
    titleRetrofitAudit: { action: "retitled" },
  };
  var result = titleRefinement.refineTopic(topic, history, function () { return 77; });
  assert.equal(result.changed, true);
  assert.match(topic.title, /^Search recovery diagnostics/);
  assert.doesNotMatch(topic.title, /worker|fan-in|Completely/);
  assert.equal(topic.titleRefinement.evidenceCount, 2,
    "only the two proven owner turns contribute title evidence");
});

test("an existing index runs progressive title migration once and then replays idempotently", function () {
  var h = newHarness();
  try {
    var initial = classifyAndComplete(h,
      "The orchid canvas inspector initially needs a clearer purpose");
    classifyAndComplete(h, "Orchid canvas inspection should expose safe retry controls");
    classifyAndComplete(h,
      "The orchid canvas inspector should show failed-step diagnosis and safe retry");
    var state = h.index.load();
    var topic = state.topics[initial.topicRef.topicId];
    var stableId = topic.topicRef.topicId;
    topic.title = "The orchid canvas inspector";
    delete topic.titleRefinement;
    delete state.titleRefinementVersion;
    h.index.save();

    var restarted = topicIndex.createTopicIndex({ file: h.file, now: function () { return 888; } });
    var migrated = restarted.ensureRetro(h.session, h.options);
    assert.equal(migrated.changed, true);
    assert.equal(restarted.resolve(initial.topicRef, true).topic.title,
      "The orchid canvas inspector should show failed-step diagnosis and safe retry");
    assert.equal(restarted.resolve(initial.topicRef, true).topic.topicRef.topicId, stableId);
    var settled = fs.readFileSync(h.file, "utf8");
    assert.equal(restarted.ensureRetro(h.session, h.options).changed, false);
    assert.equal(fs.readFileSync(h.file, "utf8"), settled);
  } finally {
    h.cleanup();
  }
});
