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

function productionEvent(sequence, eventIndex, text, timestamp) {
  return {
    type: "user_message",
    text: text,
    coopIngressId: "coop:" + recovery.CANONICAL_SESSION_ID + ":" + sequence,
    coopIngressSequence: sequence,
    coopIngressKind: "text",
    coopTopicRef: { topicId: SOURCE },
    coopThreadRef: { threadId: SOURCE },
    coopProjectRef: null,
    coopImplementationDecision: null,
    _ts: timestamp,
  };
}

function productionHarness(options) {
  var opts = options || {};
  var expected = [{
    sequence: 360, eventIndex: 166989, timestamp: 1786840579387,
    text: "Create a dedicated Voice conversational mode Thread for Clay, detach Voice work from Webapp, " +
      "use session 18104cdc-5aff-4328-9afc-88bb709dd21d as read-only context, and implement it.",
  }, {
    sequence: 361, eventIndex: 167058, timestamp: 1786840635680, text: "This is main",
  }, {
    sequence: 362, eventIndex: 167144, timestamp: 1786840723785, text: "Ok",
  }];
  var history = [];
  var sourceTurns = [];
  var targetTurns = [];
  var records = {};
  expected.forEach(function (item) {
    history[item.eventIndex] = productionEvent(item.sequence, item.eventIndex,
      item.text, item.timestamp);
    var itemTurn = { projectId: "system-lead",
      sessionStorageId: recovery.CANONICAL_SESSION_ID,
      startEventIndex: item.eventIndex, endEventIndex: item.eventIndex };
    if (!opts.moved || opts.duplicate) sourceTurns.push(itemTurn);
    if (opts.moved || opts.duplicate) targetTurns.push(Object.assign({}, itemTurn));
    records[history[item.eventIndex].coopIngressId] = {
      ingressId: history[item.eventIndex].coopIngressId,
      ingressSequence: item.sequence,
      ingressKind: "text",
      sessionRef: { projectId: "system-lead",
        sessionStorageId: recovery.CANONICAL_SESSION_ID },
      requestRef: { projectId: "system-lead",
        sessionStorageId: recovery.CANONICAL_SESSION_ID, eventIndex: item.eventIndex },
      receivedAt: item.timestamp + 200,
      classification: { kind: item.sequence === 360 ? "existing_topic" : "conversational",
        source: "ingress_route", at: item.timestamp + 191 },
      implementationDecision: null,
      topicRef: { topicId: opts.moved || opts.duplicate ? TARGET : SOURCE },
      projectRefs: [],
      expectsExecution: opts.executionSequence === item.sequence,
      links: { tasks: opts.executionSequence === item.sequence ? [{ taskId: "unrelated" }] : [],
        sessions: [], coordinators: [] },
      state: "open",
      outcome: null,
    };
  });
  var topics = {};
  topics[SOURCE] = {
    topicRef: { topicId: SOURCE }, threadRef: { threadId: SOURCE }, title: "Wrong thread",
    status: "open", threadState: "handed_off", turnRefs: sourceTurns,
    eventRefs: sourceTurns.map(function (item) { return item.startEventIndex; }),
  };
  if (opts.moved || opts.duplicate) {
    topics[TARGET] = {
      topicRef: { topicId: TARGET }, threadRef: { threadId: TARGET }, title: "Voice",
      status: "open", threadState: "exploring", turnRefs: targetTurns,
      eventRefs: targetTurns.map(function (item) { return item.startEventIndex; }),
    };
  }
  var index = {
    resolve: function (ref) {
      var id = ref && (ref.threadId || ref.topicId);
      return topics[id] ? { ok: true, topic: topics[id] } :
        { ok: false, code: "topic_not_found" };
    },
    split: function (ignored, parts) {
      var part = parts[0];
      topics[part.topicId] = {
        topicRef: { topicId: part.topicId }, threadRef: { threadId: part.topicId },
        title: part.title, status: "open", threadState: "exploring",
        turnRefs: [], eventRefs: [],
      };
      return { ok: true, topicRefs: [{ topicId: part.topicId }] };
    },
    reassignMainIngressRecoveryTurn: function (from, to, movedTurn) {
      var fromTopic = topics[from.threadId];
      var toTopic = topics[to.threadId];
      fromTopic.turnRefs = fromTopic.turnRefs.filter(function (candidate) {
        return candidate.startEventIndex !== movedTurn.startEventIndex;
      });
      fromTopic.eventRefs = fromTopic.eventRefs.filter(function (eventIndex) {
        return eventIndex !== movedTurn.startEventIndex;
      });
      if (!toTopic.turnRefs.some(function (candidate) {
        return candidate.startEventIndex === movedTurn.startEventIndex;
      })) toTopic.turnRefs.push(movedTurn);
      if (toTopic.eventRefs.indexOf(movedTurn.startEventIndex) === -1) {
        toTopic.eventRefs.push(movedTurn.startEventIndex);
      }
      return { ok: true };
    },
  };
  var classifications = 0;
  var ledger = {
    get: function (id) { return records[id] || null; },
    classify: function (id, input) {
      var record = records[id];
      if (!record) return null;
      classifications++;
      record.implementationDecision = {
        intent: input.implementationDecision.intent,
        source: input.implementationDecision.source,
        at: input.implementationDecision.at,
      };
      record.expectsExecution = true;
      record.topicRef = input.topicRef;
      record.projectRefs = input.projectRefs;
      return record;
    },
    retopicTurn: function (from, to, movedTurn) {
      var changed = [];
      Object.keys(records).forEach(function (id) {
        var record = records[id];
        if (record.topicRef.topicId !== from.threadId ||
            record.requestRef.eventIndex < movedTurn.startEventIndex ||
            record.requestRef.eventIndex > movedTurn.endEventIndex) return;
        if (record.expectsExecution || record.links.tasks.length) return;
        changed.push({ ingressId: id, topicRef: record.topicRef });
      });
      if (!changed.length) return { ok: false, reason: "execution_already_admitted" };
      changed.forEach(function (item) { records[item.ingressId].topicRef = { topicId: to.threadId }; });
      return { ok: true, requests: changed.length, undo: { requests: changed } };
    },
    restoreThreadCorrections: function (corrections) {
      (corrections[0].requests || []).forEach(function (item) {
        records[item.ingressId].topicRef = item.topicRef;
      });
      return { ok: true };
    },
  };
  var session = { storageId: opts.storageId || recovery.CANONICAL_SESSION_ID,
    coopHome: true, history: history };
  return { expected: expected, history: history, session: session, topics: topics,
    records: records, index: index, ledger: ledger,
    classificationCount: function () { return classifications; } };
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

test("production migration moves exact Voice ingresses 360-362 and backfills admission once", function () {
  var h = productionHarness();
  var historyBefore = JSON.stringify([h.history[166989], h.history[167058], h.history[167144]]);
  var first = recovery.migrateProduction(h.index, h.ledger, h.session);
  assert.deepEqual(first, {
    ok: true,
    migrationId: recovery.PRODUCTION_RECOVERY_ID,
    moved: 3,
    created: true,
    decisionBackfilled: true,
    threadRef: { threadId: TARGET },
  });
  assert.deepEqual(h.topics[TARGET].turnRefs.map(function (item) {
    return item.startEventIndex;
  }), [166989, 167058, 167144]);
  assert.deepEqual(h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"].implementationDecision, {
    intent: "implement", source: "explicit_owner_turn", at: 1786840579387,
  });
  assert.equal(h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"].expectsExecution, true);
  assert.deepEqual(h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"].projectRefs,
    [{ projectId: recovery.CLAY_PROJECT_ID }]);
  assert.equal(h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":361"].expectsExecution, false);
  assert.equal(h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":362"].expectsExecution, false);
  assert.deepEqual(h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"].links,
    { tasks: [], sessions: [], coordinators: [] });
  assert.equal(JSON.stringify([h.history[166989], h.history[167058], h.history[167144]]),
    historyBefore, "the canonical owner events remain byte-equivalent");
  assert.equal(h.classificationCount(), 1);

  assert.deepEqual(recovery.migrateProduction(h.index, h.ledger, h.session), {
    ok: true,
    migrationId: recovery.PRODUCTION_RECOVERY_ID,
    moved: 0,
    created: false,
    decisionBackfilled: false,
    threadRef: { threadId: TARGET },
  });
  assert.equal(h.classificationCount(), 1, "restart replay must not restamp the decision");
});

test("production migration backfills the already-recovered production Thread through startup", function () {
  var h = productionHarness({ moved: true });
  var result = recovery.migrateProductionFromSessionManager(h.index, h.ledger, {
    sessions: new Map([[1, h.session]]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.moved, 0);
  assert.equal(result.created, false);
  assert.equal(result.decisionBackfilled, true);
  assert.equal(h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"].expectsExecution, true);
  assert.equal(h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"].topicRef.topicId, TARGET);
  assert.equal(recovery.matchesRecoveredEntry(
    h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":361"], h.session,
    "coop:" + recovery.CANONICAL_SESSION_ID + ":361", h.history[167058]), false,
    "only ingress 360 may use the recovered replay alias");
});

test("production migration removes exact retrofit duplicates from Main before admission", function () {
  var h = productionHarness({ duplicate: true });
  var result = recovery.migrateProduction(h.index, h.ledger, h.session);
  assert.deepEqual(result, {
    ok: true,
    migrationId: recovery.PRODUCTION_RECOVERY_ID,
    moved: 3,
    created: false,
    decisionBackfilled: true,
    threadRef: { threadId: TARGET },
  });
  assert.deepEqual(h.topics[SOURCE].turnRefs, []);
  assert.deepEqual(h.topics[TARGET].turnRefs.map(function (item) {
    return item.startEventIndex;
  }), [166989, 167058, 167144]);
  assert.equal(h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"].expectsExecution,
    true);
});

test("an admitted Voice decision still permits exact duplicate membership cleanup", function () {
  var h = productionHarness({ duplicate: true });
  var record = h.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"];
  record.implementationDecision = {
    intent: "implement", source: "explicit_owner_turn", at: 1786840579387,
  };
  record.projectRefs = [{ projectId: recovery.CLAY_PROJECT_ID }];
  record.expectsExecution = true;
  assert.deepEqual(recovery.migrateProduction(h.index, h.ledger, h.session), {
    ok: true,
    migrationId: recovery.PRODUCTION_RECOVERY_ID,
    moved: 3,
    created: false,
    decisionBackfilled: false,
    threadRef: { threadId: TARGET },
  });
  assert.deepEqual(h.topics[SOURCE].turnRefs, []);
  assert.equal(h.classificationCount(), 0);
});

test("production migration fails closed on changed, ambiguous, or unrelated evidence", function () {
  var changedDigest = productionHarness({ moved: true });
  changedDigest.history[166989].text = "Changed canonical bytes";
  assert.equal(recovery.migrateProduction(changedDigest.index, changedDigest.ledger,
    changedDigest.session).code, "recovery_event_digest_mismatch");
  assert.equal(changedDigest.classificationCount(), 0);

  var changedTopic = productionHarness({ moved: true });
  changedTopic.history[166989].coopTopicRef = { topicId: "wrong-topic" };
  assert.equal(recovery.migrateProduction(changedTopic.index, changedTopic.ledger,
    changedTopic.session).code, "recovery_event_topic_mismatch");
  assert.equal(changedTopic.classificationCount(), 0);

  var missing = productionHarness({ moved: true });
  delete missing.history[166989];
  assert.equal(recovery.migrateProduction(missing.index, missing.ledger,
    missing.session).code, "recovery_canonical_event_missing");
  assert.equal(missing.classificationCount(), 0);

  var ambiguous = productionHarness({ moved: true });
  ambiguous.history[1] = Object.assign({}, ambiguous.history[166989]);
  assert.equal(recovery.migrateProduction(ambiguous.index, ambiguous.ledger,
    ambiguous.session).code, "recovery_event_ambiguous");
  assert.equal(ambiguous.classificationCount(), 0);

  var wrongSession = productionHarness({ moved: true, storageId: "wrong-session" });
  assert.equal(recovery.migrateProduction(wrongSession.index, wrongSession.ledger,
    wrongSession.session).code, "recovery_session_mismatch");
  assert.equal(wrongSession.classificationCount(), 0);

  var unrelated = productionHarness({ moved: true, executionSequence: 361 });
  assert.equal(recovery.migrateProduction(unrelated.index, unrelated.ledger,
    unrelated.session).code, "execution_already_admitted");
  assert.equal(unrelated.classificationCount(), 0);

  var injectedDecision = productionHarness({ moved: true });
  injectedDecision.history[166989].coopImplementationDecision = { intent: "ship" };
  assert.equal(recovery.migrateProduction(injectedDecision.index, injectedDecision.ledger,
    injectedDecision.session).code, "recovery_event_digest_mismatch");
  assert.equal(injectedDecision.classificationCount(), 0);

  var wrongLedgerRef = productionHarness({ moved: true });
  wrongLedgerRef.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"].requestRef.eventIndex = 1;
  assert.equal(recovery.migrateProduction(wrongLedgerRef.index, wrongLedgerRef.ledger,
    wrongLedgerRef.session).code, "recovery_ingress_ledger_mismatch");
  assert.equal(wrongLedgerRef.classificationCount(), 0);

  var wrongMapping = productionHarness({ moved: true });
  wrongMapping.records["coop:" + recovery.CANONICAL_SESSION_ID + ":360"].topicRef =
    { topicId: SOURCE };
  assert.equal(recovery.migrateProduction(wrongMapping.index, wrongMapping.ledger,
    wrongMapping.session).code, "recovery_ingress_ledger_mismatch");
  assert.equal(wrongMapping.classificationCount(), 0);

  var duplicateTurn = productionHarness({ moved: true });
  duplicateTurn.topics[TARGET].turnRefs.push(Object.assign({},
    duplicateTurn.topics[TARGET].turnRefs[0]));
  assert.equal(recovery.migrateProduction(duplicateTurn.index, duplicateTurn.ledger,
    duplicateTurn.session).code, "recovery_turn_membership_mismatch");
  assert.equal(duplicateTurn.classificationCount(), 0);

  var duplicateSession = productionHarness({ moved: true });
  assert.equal(recovery.migrateProductionFromSessionManager(duplicateSession.index,
    duplicateSession.ledger, { sessions: new Map([[1, duplicateSession.session],
      [2, Object.assign({}, duplicateSession.session)]]) }).code, "recovery_session_ambiguous");
  assert.equal(duplicateSession.classificationCount(), 0);
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
