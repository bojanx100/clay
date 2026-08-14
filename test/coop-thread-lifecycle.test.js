var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var lifecycle = require("../lib/coop-thread-lifecycle");
var topics = require("../lib/coop-topic-index");

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var REMINDER_THREAD_ID = "auto-57ea56ea9f9cc0a4e96cf0f3";
var TEST_DECISION_THREAD_ID = "auto-ba81bcab5de78c4b5aee2b32";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-thread-lifecycle-"));
  var tick = 100;
  var index = topics.createTopicIndex({
    file: path.join(dir, "lead", "coop-topic-index.json"),
    now: function () { tick++; return tick; },
  });
  lifecycle.ensureIndex(index, function () { tick++; return tick; });
  return {
    dir: dir,
    index: index,
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function session() {
  return {
    coopHome: true,
    storageId: "canonical-coop-threads",
    history: [
      { type: "user_message", text: "Renderer caching regression needs an investigation", from: "owner" },
      { type: "done" },
      { type: "user_message", text: "Prepare the partner launch narrative", from: "owner" },
      { type: "done" },
      { type: "user_message", text: "Review household travel plans for October", from: "owner" },
      { type: "done" },
      { type: "user_message", text: "The renderer caching regression still needs profiling", from: "owner" },
      { type: "done" },
    ],
  };
}

function allThreads(projection) {
  return (projection.groups || []).reduce(function (result, group) {
    return result.concat(group.threads || group.topics || []);
  }, []);
}

function threadForTurn(rows, startEventIndex) {
  return rows.find(function (row) {
    return row.lastTurnRef && row.lastTurnRef.startEventIndex === startEventIndex ||
      (row.turnRefs || []).some(function (turn) { return turn.startEventIndex === startEventIndex; });
  });
}

test("three distinct owner themes become durable Threads and a related turn reattaches", function () {
  var h = harness();
  try {
    var canonical = session();
    assert.deepEqual(h.index.ensureRetro(canonical, {
      clayProjectRef: { projectId: CLAY }, projects: [],
    }).ok, true);

    var rows = allThreads(h.index.project({ history: canonical.history }));
    var renderer = threadForTurn(rows, 0);
    var narrative = threadForTurn(rows, 2);
    var travel = threadForTurn(rows, 4);
    var rendererFollowUp = threadForTurn(rows, 6);

    assert.ok(renderer && narrative && travel && rendererFollowUp);
    assert.notDeepEqual(renderer.threadRef, narrative.threadRef);
    assert.notDeepEqual(narrative.threadRef, travel.threadRef);
    assert.deepEqual(rendererFollowUp.threadRef, renderer.threadRef);
    assert.deepEqual(renderer.topicRef, { topicId: renderer.threadRef.threadId },
      "legacy TopicRef remains a lossless compatibility alias");
    assert.equal(renderer.threadState, lifecycle.THREAD_STATES.EXPLORING);
    assert.deepEqual(renderer.lastTurnRef, {
      projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 6, endEventIndex: 7,
    });
  } finally { h.cleanup(); }
});

test("migration preserves legacy records, parks owner reminders and test decisions, and keeps closed outcomes distinct", function () {
  var h = harness();
  try {
    var state = h.index.load();
    state.canonicalSessionStorageId = "canonical-coop-threads";
    state.topics[REMINDER_THREAD_ID] = legacyRecord(REMINDER_THREAD_ID, "Reminder: revisit import policy");
    state.topics[TEST_DECISION_THREAD_ID] = legacyRecord(TEST_DECISION_THREAD_ID, "#2539 owner test decision");
    state.topics["legacy-resolved"] = legacyRecord("legacy-resolved", "Resolved legacy work");
    h.index.save();

    lifecycle.ensureIndex(h.index, function () { return 1000; });
    var reminder = h.index.resolve({ threadId: REMINDER_THREAD_ID }, true).thread;
    var decision = h.index.resolve({ threadId: TEST_DECISION_THREAD_ID }, true).thread;
    assert.deepEqual(reminder.threadRef, { threadId: REMINDER_THREAD_ID });
    assert.deepEqual(reminder.topicRef, { topicId: REMINDER_THREAD_ID });
    assert.equal(reminder.threadState, lifecycle.THREAD_STATES.PARKED);
    assert.equal(decision.threadState, lifecycle.THREAD_STATES.PARKED);

    assert.deepEqual(h.index.setThreadState({ threadId: "legacy-resolved" }, lifecycle.THREAD_STATES.CLOSED, {
      closeOutcome: lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED,
    }), { ok: true });
    assert.equal(h.index.resolve({ topicId: "legacy-resolved" }, true).thread.closeOutcome,
      lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED);
    assert.deepEqual(h.index.setThreadState({ threadId: "legacy-resolved" }, lifecycle.THREAD_STATES.CLOSED, {
      closeOutcome: lifecycle.CLOSE_OUTCOMES.NOT_PURSUING,
    }), { ok: true });
    assert.equal(h.index.resolve({ threadId: "legacy-resolved" }, true).thread.closeOutcome,
      lifecycle.CLOSE_OUTCOMES.NOT_PURSUING);
  } finally { h.cleanup(); }
});

test("owner correction reassigns and merges canonical turn references, then undo restores the previous membership", function () {
  var h = harness();
  try {
    var canonical = session();
    h.index.ensureRetro(canonical, { clayProjectRef: { projectId: CLAY }, projects: [] });
    var rows = allThreads(h.index.project({ history: canonical.history }));
    var renderer = threadForTurn(rows, 0);
    var narrative = threadForTurn(rows, 2);
    var turn = {
      projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 2, endEventIndex: 3,
    };

    assert.deepEqual(h.index.reassignTurn(narrative.threadRef, renderer.threadRef, turn), { ok: true });
    assert.deepEqual(h.index.resolveCanonicalEvent(renderer.threadRef, { eventIndex: 2 }).turnRef, turn);
    assert.equal(h.index.resolveCanonicalEvent(narrative.threadRef, { eventIndex: 2 }).code, "event_not_in_thread");
    assert.deepEqual(h.index.undoLastCorrection(), { ok: true });
    assert.deepEqual(h.index.resolveCanonicalEvent(narrative.threadRef, { eventIndex: 2 }).turnRef, turn);

    assert.deepEqual(h.index.merge(renderer.threadRef, [narrative.threadRef]), { ok: true });
    assert.deepEqual(h.index.resolve(narrative.threadRef, true).thread.mergedIntoThreadRef, renderer.threadRef);
    assert.deepEqual(h.index.undoLastCorrection(), { ok: true });
    assert.equal(h.index.resolve(narrative.threadRef, true).thread.mergedIntoThreadRef, null);
  } finally { h.cleanup(); }
});

function legacyRecord(topicId, title) {
  return {
    topicRef: { topicId: topicId }, title: title, keywords: [],
    group: { kind: "uncategorised" }, source: "automatic", status: "open",
    createdAt: 1, updatedAt: 1, eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
}
