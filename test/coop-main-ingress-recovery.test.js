var test = require("node:test");
var assert = require("node:assert/strict");
var recovery = require("../lib/coop-main-ingress-recovery");
var management = require("../lib/coop-topic-management");

var SOURCE = recovery.SOURCE_THREAD_ID;
var TARGET = recovery.TARGET_THREAD_ID;
var STORAGE = "canonical-session";

function turn(eventIndex) {
  return { projectId: "system-lead", sessionStorageId: STORAGE,
    startEventIndex: eventIndex, endEventIndex: eventIndex + 1 };
}

function makeHarness(options) {
  var opts = options || {};
  var turns = [turn(10), turn(20), turn(30)];
  var source = {
    topicRef: { topicId: SOURCE }, threadRef: { threadId: SOURCE }, title: "Wrong thread",
    status: "open", threadState: "handed_off", turnRefs: turns.slice(), eventRefs: [10, 20, 30],
  };
  var topics = {};
  topics[SOURCE] = source;
  var records = {};
  var history = [];
  for (var i = 0; i < 31; i++) history.push({ type: "delta" });
  [360, 361, 362].forEach(function (sequence, index) {
    var eventIndex = turns[index].startEventIndex;
    history[eventIndex] = {
      type: "user_message", coopIngressSequence: sequence,
      coopIngressId: "coop:" + STORAGE + ":" + sequence,
      coopTopicRef: { topicId: SOURCE },
    };
    records["coop:" + STORAGE + ":" + sequence] = {
      ingressId: "coop:" + STORAGE + ":" + sequence,
      topicRef: { topicId: SOURCE }, requestRef: { sessionStorageId: STORAGE, eventIndex: eventIndex },
      expectsExecution: !!(opts.executionSequence === sequence), links: { tasks: [], sessions: [], coordinators: [] },
    };
  });
  var index = {
    resolve: function (ref) {
      var id = ref && (ref.threadId || ref.topicId);
      var topic = topics[id];
      return topic ? { ok: true, topic: topic } : { ok: false, code: "topic_not_found" };
    },
    split: function (sourceRef, parts) {
      var part = parts[0];
      if (topics[part.topicId]) return { ok: false, code: "topic_exists" };
      topics[part.topicId] = {
        topicRef: { topicId: part.topicId }, threadRef: { threadId: part.topicId },
        title: part.title, status: "open", threadState: "exploring", turnRefs: [], eventRefs: [],
      };
      return { ok: true, topicRefs: [{ topicId: part.topicId }] };
    },
  };
  var ledger = { get: function (id) { return records[id] || null; } };
  function reassign(from, to, movedTurn) {
    var sourceTopic = topics[from.threadId];
    var targetTopic = topics[to.threadId];
    sourceTopic.turnRefs = sourceTopic.turnRefs.filter(function (candidate) {
      return candidate.startEventIndex !== movedTurn.startEventIndex;
    });
    sourceTopic.eventRefs = sourceTopic.eventRefs.filter(function (eventIndex) {
      return eventIndex !== movedTurn.startEventIndex;
    });
    targetTopic.turnRefs.push(movedTurn);
    targetTopic.eventRefs.push(movedTurn.startEventIndex);
    Object.keys(records).forEach(function (id) {
      if (records[id].requestRef.eventIndex === movedTurn.startEventIndex) records[id].topicRef = { topicId: TARGET };
    });
    return { ok: true };
  }
  return { index: index, ledger: ledger, session: { storageId: STORAGE, history: history }, topics: topics, records: records, reassign: reassign };
}

test("fixed ingress recovery moves only 360-362 and is idempotent", function () {
  var h = makeHarness();
  var historyBefore = JSON.parse(JSON.stringify(h.session.history));
  var first = recovery.recover(h.index, h.ledger, h.session, h.reassign);
  assert.deepEqual(first, { ok: true, moved: 3, created: true, threadRef: { threadId: TARGET } });
  assert.equal(h.topics[SOURCE].threadState, "handed_off", "unrelated source execution remains untouched");
  assert.deepEqual(h.topics[SOURCE].turnRefs, []);
  assert.deepEqual(h.topics[TARGET].turnRefs.map(function (item) { return item.startEventIndex; }), [10, 20, 30]);
  assert.deepEqual(h.session.history, historyBefore, "canonical history is never rewritten");
  assert.deepEqual(Object.keys(h.records).map(function (id) { return h.records[id].topicRef.topicId; }), [TARGET, TARGET, TARGET]);

  assert.deepEqual(recovery.recover(h.index, h.ledger, h.session, h.reassign), {
    ok: true, moved: 0, created: false, threadRef: { threadId: TARGET },
  });
});

test("recovery fails closed before creating a Voice Thread when an ingress has admitted execution", function () {
  var h = makeHarness({ executionSequence: 361 });
  assert.deepEqual(recovery.recover(h.index, h.ledger, h.session, h.reassign), {
    ok: false, code: "execution_already_admitted",
  });
  assert.equal(h.topics[TARGET], undefined);
  assert.equal(h.topics[SOURCE].turnRefs.length, 3);
});

test("recovery is owner-gated and requires its exact activation id", function () {
  var h = makeHarness();
  var replies = [];
  var broadcasts = 0;
  var ctx = {
    coopOwnerRequests: h.ledger,
    sendTo: function (ws, message) { replies.push(message); },
  };
  var deps = {
    isOwnerSocket: function () { return false; },
    topicIndexForContext: function () { return h.index; },
    canonicalCoopSession: function () { return h.session; },
    reassignMainIngressRecoveryTurn: function (ignored, index, from, to, movedTurn) {
      return h.reassign(from, to, movedTurn);
    },
    broadcastProjection: function () { broadcasts++; },
  };
  assert.equal(recovery.handleRecovery(ctx, {}, {
    type: "coop_main_ingress_recovery", recoveryId: recovery.RECOVERY_ID,
  }, deps), true);
  assert.equal(replies[0].code, "access_denied");
  assert.equal(h.topics[TARGET], undefined);

  deps.isOwnerSocket = function () { return true; };
  assert.equal(recovery.handleRecovery(ctx, {}, {
    type: "coop_main_ingress_recovery", recoveryId: "wrong",
  }, deps), true);
  assert.equal(replies[1].code, "recovery_activation_required");
  assert.equal(h.topics[TARGET], undefined);

  assert.equal(recovery.handleRecovery(ctx, {}, {
    type: "coop_main_ingress_recovery", recoveryId: recovery.RECOVERY_ID,
  }, deps), true);
  assert.equal(replies[2].ok, true);
  assert.equal(broadcasts, 1);
});

test("the management entry preserves the canonical owner gate dependencies", function () {
  var h = makeHarness();
  var replies = [];
  var ctx = {
    coopOwnerRequests: h.ledger,
    isCoopTopicOwner: function (ws) { return !!ws.owner; },
    sendTo: function (ws, message) { replies.push(message); },
  };
  assert.equal(management.handleMainIngressRecovery(ctx, { owner: true }, {
    type: "coop_main_ingress_recovery", recoveryId: "wrong",
  }, {
    isCoopClient: function () { return true; },
    topicIndexForContext: function () { return h.index; },
    globalProjectionProvider: function () { return null; },
  }, h.session), true);
  assert.equal(replies[0].code, "recovery_activation_required");
});
