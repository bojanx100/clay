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

function durableThreads(index) {
  return Object.keys(index.load().topics).filter(function (id) {
    return id !== "uncategorised-conversations";
  }).map(function (id) { return index.load().topics[id]; });
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

    var rows = durableThreads(h.index);
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
    var projectedRenderer = allThreads(h.index.project({ history: canonical.history })).find(function (row) {
      return row.threadRef.threadId === renderer.threadRef.threadId;
    });
    assert.deepEqual(projectedRenderer.lastTurnRef, {
      projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 6, endEventIndex: 7,
    });
  } finally { h.cleanup(); }
});

test("migration parks owner reminders and hiding a not-pursuing Thread retains its durable record", function () {
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
    var discarded = h.index.setThreadState({ threadId: "legacy-resolved" }, lifecycle.THREAD_STATES.CLOSED, {
      closeOutcome: lifecycle.CLOSE_OUTCOMES.NOT_PURSUING,
    });
    assert.equal(discarded.ok, true);
    assert.equal(h.index.resolve({ threadId: "legacy-resolved" }, true).thread.closeOutcome,
      lifecycle.CLOSE_OUTCOMES.NOT_PURSUING);
    assert.equal(h.index.resolve({ threadId: "legacy-resolved" }, true).thread.hidden, true);
    assert.equal(h.index.resolve({ threadId: "legacy-resolved" }, true).thread.eventRefs.length, 0);
    assert.equal(h.index.setThreadState({ threadId: "legacy-resolved" }, lifecycle.THREAD_STATES.EXPLORING).ok, true);
    assert.equal(h.index.resolve({ threadId: "legacy-resolved" }, true).thread.hidden, false,
      "reopen restores the retained Thread instead of recreating it");
  } finally { h.cleanup(); }
});

test("lifecycle undo is exact-Thread and idempotent", function () {
  var h = harness();
  try {
    var state = h.index.load();
    state.topics.alpha = legacyRecord("alpha", "Alpha");
    state.topics.beta = legacyRecord("beta", "Beta");
    h.index.save();
    lifecycle.ensureIndex(h.index, function () { return 2000; });
    assert.equal(h.index.setThreadState({ threadId: "alpha" }, lifecycle.THREAD_STATES.CLOSED, {
      closeOutcome: lifecycle.CLOSE_OUTCOMES.NOT_PURSUING,
    }).ok, true);
    assert.equal(h.index.setThreadState({ threadId: "beta" }, lifecycle.THREAD_STATES.PARKED).ok, true);
    assert.equal(h.index.undoLastLifecycleAction({ threadId: "alpha" }).ok, true);
    assert.equal(h.index.resolve({ threadId: "alpha" }, true).thread.hidden, false);
    assert.equal(h.index.resolve({ threadId: "beta" }, true).thread.threadState, lifecycle.THREAD_STATES.PARKED);
    assert.equal(h.index.undoLastLifecycleAction({ threadId: "alpha" }).unchanged, true);
  } finally { h.cleanup(); }
});

test("owner correction reassigns and merges canonical turn references, then undo restores the previous membership", function () {
  var h = harness();
  try {
    var canonical = session();
    h.index.ensureRetro(canonical, { clayProjectRef: { projectId: CLAY }, projects: [] });
    var rows = durableThreads(h.index);
    var renderer = threadForTurn(rows, 0);
    var narrative = threadForTurn(rows, 2);
    var turn = {
      projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 2, endEventIndex: 3,
    };

    assert.deepEqual(h.index.reassignTurn(narrative.threadRef, renderer.threadRef, turn), { ok: true });
    var correction = h.index.load().threadCorrections.at(-1);
    assert.deepEqual(correction.classificationEvidence,
      { version: 1, kind: "exact_turn_membership" });
    assert.equal(correction.undoneAt, null);
    assert.deepEqual(h.index.resolveCanonicalEvent(renderer.threadRef, { eventIndex: 2 }).turnRef, turn);
    assert.equal(h.index.resolveCanonicalEvent(narrative.threadRef, { eventIndex: 2 }).code, "event_not_in_thread");
    assert.deepEqual(h.index.undoLastCorrection(), { ok: true });
    assert.equal(h.index.load().threadCorrections.at(-1).undoneAt !== null, true);
    assert.deepEqual(h.index.resolveCanonicalEvent(narrative.threadRef, { eventIndex: 2 }).turnRef, turn);

    assert.deepEqual(h.index.merge(renderer.threadRef, [narrative.threadRef]), { ok: true });
    assert.deepEqual(h.index.resolve(narrative.threadRef, true).thread.mergedIntoThreadRef, renderer.threadRef);
    assert.deepEqual(h.index.undoLastCorrection(), { ok: true });
    assert.equal(h.index.resolve(narrative.threadRef, true).thread.mergedIntoThreadRef, null);
  } finally { h.cleanup(); }
});

test("the Main-ingress recovery reassignment is exempt at both handed off endpoints", function () {
  var h = harness();
  try {
    var canonical = session();
    h.index.ensureRetro(canonical, { clayProjectRef: { projectId: CLAY }, projects: [] });
    var rows = durableThreads(h.index);
    var source = threadForTurn(rows, 2);
    var target = threadForTurn(rows, 0);
    var turn = {
      projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 2, endEventIndex: 3,
    };
    assert.equal(h.index.setThreadState(source.threadRef,
      lifecycle.THREAD_STATES.HANDED_OFF).ok, true);
    assert.equal(h.index.setThreadState(target.threadRef,
      lifecycle.THREAD_STATES.HANDED_OFF).ok, true);

    // Ordinary owner correction stays strict on both endpoints.
    assert.deepEqual(h.index.reassignTurn(source.threadRef, target.threadRef, turn),
      { ok: false, code: "thread_handed_off" });

    // The proven one-time recovery is exempt at both. Exempting only the source
    // left the repair unable to clean stale membership once the recovered
    // Thread had itself been handed off.
    assert.deepEqual(h.index.reassignMainIngressRecoveryTurn(source.threadRef,
      target.threadRef, turn, { ownerRequestCorrections: [] }), { ok: true });
    assert.deepEqual(h.index.resolveCanonicalEvent(target.threadRef, { eventIndex: 2 }).turnRef, turn);
    assert.equal(h.index.resolveCanonicalEvent(source.threadRef, { eventIndex: 2 }).code,
      "event_not_in_thread");
  } finally { h.cleanup(); }
});

test("recovery reassignment drops stale duplicate membership without duplicating the target turn", function () {
  var h = harness();
  try {
    var canonical = session();
    h.index.ensureRetro(canonical, { clayProjectRef: { projectId: CLAY }, projects: [] });
    var rows = durableThreads(h.index);
    var source = threadForTurn(rows, 2);
    var target = threadForTurn(rows, 0);
    var turn = {
      projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 2, endEventIndex: 3,
    };
    // Reproduce the live half-applied shape: the turn is in BOTH Threads.
    var state = h.index.load();
    state.topics[target.threadRef.threadId].turnRefs.push(JSON.parse(JSON.stringify(turn)));
    h.index.save(state);
    assert.equal(h.index.setThreadState(source.threadRef,
      lifecycle.THREAD_STATES.HANDED_OFF).ok, true);
    assert.equal(h.index.setThreadState(target.threadRef,
      lifecycle.THREAD_STATES.HANDED_OFF).ok, true);

    assert.deepEqual(h.index.reassignMainIngressRecoveryTurn(source.threadRef,
      target.threadRef, turn, { ownerRequestCorrections: [] }), { ok: true });

    var after = h.index.load().topics;
    var targetHits = after[target.threadRef.threadId].turnRefs.filter(function (candidate) {
      return candidate.startEventIndex === 2;
    });
    var sourceHits = after[source.threadRef.threadId].turnRefs.filter(function (candidate) {
      return candidate.startEventIndex === 2;
    });
    assert.equal(targetHits.length, 1, "target keeps exactly one copy");
    assert.equal(sourceHits.length, 0, "stale source membership is gone");
  } finally { h.cleanup(); }
});

test("retro replay consumes exact correction evidence and an undo restores negative membership evidence", function () {
  var h = harness();
  try {
    var canonical = session();
    h.index.ensureRetro(canonical, { clayProjectRef: { projectId: CLAY }, projects: [] });
    var rows = durableThreads(h.index);
    var renderer = threadForTurn(rows, 0);
    var narrative = threadForTurn(rows, 2);
    var turn = {
      projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 2, endEventIndex: 3,
    };
    h.index.reassignTurn(narrative.threadRef, renderer.threadRef, turn);

    var correctedState = h.index.load();
    correctedState.retro.version = 0;
    h.index.save();
    h.index.ensureRetro(canonical, { clayProjectRef: { projectId: CLAY }, projects: [] });
    assert.deepEqual(h.index.resolveCanonicalEvent(renderer.threadRef, { eventIndex: 2 }).turnRef, turn);
    assert.equal(h.index.resolveCanonicalEvent(narrative.threadRef, { eventIndex: 2 }).code,
      "event_not_in_thread");

    h.index.undoLastCorrection();
    var undoneState = h.index.load();
    undoneState.retro.version = 0;
    h.index.save();
    h.index.ensureRetro(canonical, { clayProjectRef: { projectId: CLAY }, projects: [] });
    assert.deepEqual(h.index.resolveCanonicalEvent(narrative.threadRef, { eventIndex: 2 }).turnRef, turn);
    assert.equal(h.index.resolveCanonicalEvent(renderer.threadRef, { eventIndex: 2 }).code,
      "event_not_in_thread");
  } finally { h.cleanup(); }
});

function legacyRecord(topicId, title) {
  return {
    topicRef: { topicId: topicId }, title: title, keywords: [],
    group: { kind: "uncategorised" }, source: "automatic", status: "open",
    createdAt: 1, updatedAt: 1, eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
}

test("lifecycle undo cannot erase an execution linked after the action", function () {
  var h = harness();
  try {
    h.index.load().topics.alpha = legacyRecord("alpha", "Alpha");
    h.index.save();
    assert.equal(h.index.setThreadState({ threadId: "alpha" }, "parked").ok, true);
    assert.equal(h.index.linkExecution({ threadId: "alpha" }, {
      sessionRef: { projectId: CLAY, sessionStorageId: "running-worker" },
    }).ok, true);
    var before = JSON.stringify(h.index.resolve({ threadId: "alpha" }, true).thread);
    assert.equal(h.index.undoLastLifecycleAction({ threadId: "alpha" }).code, "thread_undo_conflict");
    assert.equal(JSON.stringify(h.index.resolve({ threadId: "alpha" }, true).thread), before);
  } finally { h.cleanup(); }
});

test("lifecycle undo preserves unrelated conversation updates", function () {
  var h = harness();
  try {
    h.index.load().topics.alpha = legacyRecord("alpha", "Alpha");
    h.index.save();
    assert.equal(h.index.setThreadState({ threadId: "alpha" }, "parked").ok, true);
    var current = h.index.load().topics.alpha;
    current.title = "New owner title";
    current.eventRefs.push({ sessionStorageId: "canonical-coop-threads", eventIndex: 20 });
    h.index.save();
    assert.equal(h.index.undoLastLifecycleAction({ threadId: "alpha" }).ok, true);
    var after = h.index.resolve({ threadId: "alpha" }, true).thread;
    assert.equal(after.threadState, "exploring");
    assert.equal(after.title, "New owner title");
    assert.equal(after.eventRefs.length, 1);
  } finally { h.cleanup(); }
});

test("correction undo and redo retain subsequently linked execution", function () {
  var h = harness();
  try {
    var canonical = session();
    h.index.ensureRetro(canonical, { clayProjectRef: { projectId: CLAY }, projects: [] });
    var rows = durableThreads(h.index);
    var source = threadForTurn(rows, 2);
    var target = threadForTurn(rows, 0);
    var turn = { projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 2, endEventIndex: 3 };
    assert.equal(h.index.reassignTurn(source.threadRef, target.threadRef, turn).ok, true);
    var correction = h.index.lastCorrection();
    assert.equal(h.index.linkExecution(target.threadRef, {
      sessionRef: { projectId: CLAY, sessionStorageId: "running-worker" },
    }).ok, true);
    assert.equal(h.index.undoLastCorrection().ok, true);
    var after = h.index.resolve(target.threadRef, true).thread;
    assert.equal(after.threadState, "handed_off");
    assert.equal(after.relatedExecutions.length, 1);
    assert.equal(h.index.redoCorrection(correction.correctionId).ok, true);
    after = h.index.resolve(target.threadRef, true).thread;
    assert.equal(after.threadState, "handed_off");
    assert.equal(after.relatedExecutions.length, 1);
  } finally { h.cleanup(); }
});

test("a conflicting correction undo changes neither Thread", function () {
  var h = harness();
  try {
    var canonical = session();
    h.index.ensureRetro(canonical, { clayProjectRef: { projectId: CLAY }, projects: [] });
    var rows = durableThreads(h.index);
    var source = threadForTurn(rows, 2);
    var target = threadForTurn(rows, 0);
    var turn = { projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 2, endEventIndex: 3 };
    assert.equal(h.index.reassignTurn(source.threadRef, target.threadRef, turn).ok, true);
    h.index.load().topics[target.threadRef.threadId].turnRefs.push({
      projectId: "system-lead", sessionStorageId: canonical.storageId,
      startEventIndex: 10, endEventIndex: 11,
    });
    h.index.save();
    var before = JSON.stringify(h.index.load().topics);
    assert.equal(h.index.undoLastCorrection().code, "thread_undo_conflict");
    assert.equal(JSON.stringify(h.index.load().topics), before);
    assert.equal(h.index.lastCorrection().undoneAt, null);
  } finally { h.cleanup(); }
});
