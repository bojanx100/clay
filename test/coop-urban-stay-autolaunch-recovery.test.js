var test = require("node:test");
var assert = require("node:assert/strict");
var recovery = require("../lib/coop-urban-stay-autolaunch-recovery");
var recoveredAdmission = require("../lib/coop-recovered-thread-admission");

function productionEvent() {
  return {
    type: "user_message",
    text: "If you know to instruct me why cant you just do it?\n\n" +
      "Start a Clay implementation Thread for the Urban Stay auto-launch regression.",
    coopIngressId: recovery.EXPECTED.ingressId,
    coopIngressSequence: recovery.EXPECTED.sequence,
    coopIngressKind: "text",
    coopTopicRef: null,
    coopThreadRef: null,
    coopProjectRef: null,
    coopImplementationDecision: null,
    _ts: 1786895858260,
  };
}

function harness(options) {
  var opts = options || {};
  var history = [];
  history[recovery.EXPECTED.eventIndex] = productionEvent();
  var record = {
    ingressId: recovery.EXPECTED.ingressId,
    ingressSequence: recovery.EXPECTED.sequence,
    ingressKind: "text",
    sessionRef: { projectId: "system-lead", sessionStorageId: recovery.CANONICAL_SESSION_ID },
    requestRef: { projectId: "system-lead", sessionStorageId: recovery.CANONICAL_SESSION_ID,
      eventIndex: recovery.EXPECTED.eventIndex },
    receivedAt: 1786895858999,
    classification: { kind: "conversational", source: "ingress_route", at: 1786895858999 },
    implementationDecision: null,
    topicRef: null,
    projectRefs: [],
    expectsExecution: false,
    links: { coordinators: [], tasks: [], sessions: [] },
    state: "open",
    outcome: null,
  };
  var topics = {};
  var classifications = 0;
  var index = {
    resolve: function (ref) {
      var id = ref && (ref.threadId || ref.topicId);
      return topics[id] ? { ok: true, topic: topics[id] } :
        { ok: false, code: "topic_not_found" };
    },
    createTopic: function (input) {
      if (topics[input.topicId]) return { ok: false, code: "topic_exists" };
      topics[input.topicId] = {
        topicRef: { topicId: input.topicId }, threadRef: { threadId: input.topicId },
        title: input.title, status: "open", threadState: "exploring",
        group: { kind: "project", projectRef: input.projectRef }, eventRefs: [],
      };
      return { ok: true, topic: { topicRef: { topicId: input.topicId } } };
    },
    addEventMembership: function (ref, refs) {
      var id = ref && (ref.threadId || ref.topicId);
      if (!topics[id]) return { ok: false, code: "topic_not_found" };
      topics[id].eventRefs = topics[id].eventRefs.concat(refs);
      return { ok: true };
    },
  };
  var ledger = {
    get: function (id) { return id === record.ingressId ? record : null; },
    classify: function (id, input) {
      if (id !== record.ingressId) return null;
      classifications++;
      record.classification = { kind: input.kind, source: input.source, at: input.at };
      record.implementationDecision = input.implementationDecision;
      record.topicRef = input.topicRef;
      record.projectRefs = input.projectRefs;
      record.expectsExecution = true;
      return record;
    },
  };
  var session = { storageId: opts.storageId || recovery.CANONICAL_SESSION_ID,
    coopHome: true, history: history };
  return {
    history: history, record: record, topics: topics, index: index, ledger: ledger,
    session: session, classificationCount: function () { return classifications; },
  };
}

test("the exact historical owner command is the only event admitted by the finite repair", function () {
  var h = harness();
  var exact = recovery.exactProductionEvent(h.session);
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.decision, {
    intent: "implement", projectName: "Clay", topicText: recovery.THREAD_TITLE,
  });

  h.history[recovery.EXPECTED.eventIndex].text += " Now.";
  assert.equal(recovery.exactProductionEvent(h.session).code,
    "urban_stay_recovery_event_digest_mismatch");
});

test("production migration creates one Clay Thread, preserves the canonical event, and admits it once", function () {
  var h = harness();
  var eventBefore = JSON.stringify(h.history[recovery.EXPECTED.eventIndex]);
  assert.deepEqual(recovery.migrateProduction(h.index, h.ledger, h.session), {
    ok: true,
    migrationId: recovery.RECOVERY_ID,
    threadCreated: true,
    membershipAdded: true,
    decisionBackfilled: true,
    threadRef: { threadId: recovery.THREAD_ID },
  });
  assert.deepEqual(h.record.classification, {
    kind: "new_topic", source: "production_recovery", at: 1786895858260,
  });
  assert.deepEqual(h.record.topicRef, { topicId: recovery.THREAD_ID });
  assert.deepEqual(h.record.projectRefs, [{ projectId: recovery.CLAY_PROJECT_ID }]);
  assert.deepEqual(h.record.implementationDecision, {
    intent: "implement", source: "explicit_owner_turn", at: 1786895858260,
  });
  assert.equal(h.record.expectsExecution, true);
  assert.deepEqual(h.topics[recovery.THREAD_ID].group, {
    kind: "project", projectRef: { projectId: recovery.CLAY_PROJECT_ID },
  });
  assert.deepEqual(h.topics[recovery.THREAD_ID].eventRefs, [{
    projectId: "system-lead", sessionStorageId: recovery.CANONICAL_SESSION_ID,
    eventIndex: recovery.EXPECTED.eventIndex,
  }]);
  assert.equal(JSON.stringify(h.history[recovery.EXPECTED.eventIndex]), eventBefore,
    "the immutable canonical owner event is never rewritten");
  assert.equal(h.classificationCount(), 1);

  assert.deepEqual(recovery.migrateProduction(h.index, h.ledger, h.session), {
    ok: true,
    migrationId: recovery.RECOVERY_ID,
    threadCreated: false,
    membershipAdded: false,
    decisionBackfilled: false,
    threadRef: { threadId: recovery.THREAD_ID },
  });
  assert.equal(h.classificationCount(), 1, "a restart does not readmit the owner command");
});

test("the recovery fails closed before creating or admitting on drift or pre-existing execution", function () {
  var changed = harness();
  changed.history[recovery.EXPECTED.eventIndex].text = "Start a Clay implementation Thread.";
  assert.equal(recovery.migrateProduction(changed.index, changed.ledger, changed.session).code,
    "urban_stay_recovery_event_digest_mismatch");
  assert.equal(changed.topics[recovery.THREAD_ID], undefined);
  assert.equal(changed.classificationCount(), 0);

  var admitted = harness();
  admitted.record.links.tasks.push({ taskId: "unrelated-task" });
  assert.equal(recovery.migrateProduction(admitted.index, admitted.ledger, admitted.session).code,
    "execution_already_admitted");
  assert.equal(admitted.topics[recovery.THREAD_ID], undefined);
  assert.equal(admitted.classificationCount(), 0);

  var conflict = harness();
  conflict.topics[recovery.THREAD_ID] = {
    topicRef: { topicId: recovery.THREAD_ID }, threadRef: { threadId: recovery.THREAD_ID },
    title: "Wrong topic", status: "open", threadState: "exploring",
    group: { kind: "project", projectRef: { projectId: recovery.CLAY_PROJECT_ID } }, eventRefs: [],
  };
  assert.equal(recovery.migrateProduction(conflict.index, conflict.ledger, conflict.session).code,
    "urban_stay_recovery_thread_mismatch");
  assert.equal(conflict.classificationCount(), 0);
});

test("recovered routing aliases permit only the exact project-bound Thread", function () {
  var h = harness();
  recovery.migrateProduction(h.index, h.ledger, h.session);
  var event = h.history[recovery.EXPECTED.eventIndex];
  assert.equal(recovery.matchesRecoveredRoute(h.session, event,
    recovery.EXPECTED.eventIndex, recovery.THREAD_ID), true);
  assert.equal(recovery.matchesRecoveredRoute(h.session, event,
    recovery.EXPECTED.eventIndex, "other-thread"), false);
  assert.equal(recovery.matchesRecoveredEntry(h.record, h.session,
    recovery.EXPECTED.ingressId, event), true);
  assert.equal(recovery.matchesRecoveredEntry(h.record, h.session,
    "coop:" + recovery.CANONICAL_SESSION_ID + ":407", event), false);
  assert.equal(recoveredAdmission.matchesRecoveredRoute(h.session, event,
    recovery.EXPECTED.eventIndex, recovery.THREAD_ID), true,
  "the central restart-recovery seam retains the exact recovered route");
  assert.deepEqual(recoveredAdmission.decisionForRecoveredEntry(h.record, h.session,
    recovery.EXPECTED.ingressId, event), {
    decision: { intent: "implement", projectName: "Clay" },
    projectRef: { projectId: recovery.CLAY_PROJECT_ID },
  });
});

test("startup selection requires exactly one canonical Coop session", function () {
  var h = harness();
  assert.equal(recovery.migrateProductionFromSessionManager(h.index, h.ledger, {
    sessions: new Map([[1, h.session]]),
  }).ok, true);

  var duplicate = harness();
  assert.equal(recovery.migrateProductionFromSessionManager(duplicate.index, duplicate.ledger, {
    sessions: new Map([[1, duplicate.session], [2, Object.assign({}, duplicate.session)]]),
  }).code, "urban_stay_recovery_session_ambiguous");
  assert.equal(duplicate.classificationCount(), 0);
});
