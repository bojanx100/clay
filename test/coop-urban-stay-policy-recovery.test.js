var test = require("node:test");
var assert = require("node:assert/strict");
var recovery = require("../lib/coop-urban-stay-policy-recovery");
var recoveredAdmission = require("../lib/coop-recovered-thread-admission");

function productionEvent() {
  return {
    type: "user_message",
    text: recovery.EXPECTED_TEXT,
    coopComposerScope: "main",
    coopClassification: "conversational",
    coopIngressId: recovery.EXPECTED.ingressId,
    coopIngressSequence: recovery.EXPECTED.sequence,
    coopIngressKind: "text",
    coopTopicRef: null,
    coopThreadRef: null,
    coopProjectRef: null,
    coopImplementationDecision: null,
    _ts: recovery.EXPECTED.timestamp,
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
    sessionRef: { projectId: "system-lead",
      sessionStorageId: recovery.CANONICAL_SESSION_ID },
    requestRef: { projectId: "system-lead",
      sessionStorageId: recovery.CANONICAL_SESSION_ID,
      eventIndex: recovery.EXPECTED.eventIndex },
    receivedAt: 1786899212954,
    classification: { kind: "conversational", source: "ingress_route",
      at: 1786899212968 },
    implementationDecision: null,
    implementationScope: null,
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
        topicRef: { topicId: input.topicId },
        threadRef: { threadId: input.topicId },
        title: input.title,
        status: "open",
        threadState: "exploring",
        group: { kind: "project", projectRef: input.projectRef },
        eventRefs: [],
      };
      return { ok: true, topic: topics[input.topicId] };
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
  return { history: history, record: record, topics: topics, index: index,
    ledger: ledger, session: session,
    classificationCount: function () { return classifications; } };
}

test("ingress 409 is pinned to the exact canonical owner event", function () {
  var h = harness();
  assert.equal(recovery.productionEventDigest(productionEvent()), recovery.EXPECTED.digest);
  assert.deepEqual(recovery.explicitPolicyDecision(recovery.EXPECTED_TEXT), {
    intent: "implement", projectName: "Urban Stay",
  });
  assert.equal(recovery.explicitPolicyDecision(recovery.EXPECTED_TEXT + " "), null);
  assert.equal(recovery.exactProductionEvent(h.session).ok, true);
  assert.equal(recovery.EXPECTED.persistedEventIndex, recovery.EXPECTED.eventIndex + 1,
    "the persisted JSONL index includes the metadata line excluded from session history");
});

test("production recovery creates one Urban Stay Thread and admits the decision once", function () {
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
    kind: "new_topic", source: "production_recovery", at: recovery.EXPECTED.timestamp,
  });
  assert.deepEqual(h.record.topicRef, { topicId: recovery.THREAD_ID });
  assert.deepEqual(h.record.projectRefs, [{ projectId: recovery.URBAN_STAY_PROJECT_ID }]);
  assert.deepEqual(h.record.implementationDecision, {
    intent: "implement", source: "explicit_owner_turn", at: recovery.EXPECTED.timestamp,
  });
  assert.equal(h.record.expectsExecution, true);
  assert.deepEqual(h.topics[recovery.THREAD_ID].group, {
    kind: "project", projectRef: { projectId: recovery.URBAN_STAY_PROJECT_ID },
  });
  assert.deepEqual(h.topics[recovery.THREAD_ID].eventRefs, [{
    projectId: "system-lead", sessionStorageId: recovery.CANONICAL_SESSION_ID,
    eventIndex: recovery.EXPECTED.eventIndex,
  }]);
  assert.equal(JSON.stringify(h.history[recovery.EXPECTED.eventIndex]), eventBefore,
    "the canonical source event remains immutable");
  assert.equal(h.classificationCount(), 1);

  assert.deepEqual(recovery.migrateProduction(h.index, h.ledger, h.session), {
    ok: true,
    migrationId: recovery.RECOVERY_ID,
    threadCreated: false,
    membershipAdded: false,
    decisionBackfilled: false,
    threadRef: { threadId: recovery.THREAD_ID },
  });
  assert.equal(h.classificationCount(), 1, "startup replay never restamps the decision");

  h.record.links.tasks.push({ taskId: "typed-urban-stay-policy-task" });
  assert.equal(recovery.migrateProduction(h.index, h.ledger, h.session).ok, true);
  assert.equal(h.classificationCount(), 1);
});

test("tampered, duplicate, and already-executed evidence fails closed", function () {
  var changed = harness();
  changed.history[recovery.EXPECTED.eventIndex].text += " Now.";
  assert.equal(recovery.migrateProduction(changed.index, changed.ledger,
    changed.session).code, "urban_stay_policy_recovery_event_digest_mismatch");
  assert.equal(changed.topics[recovery.THREAD_ID], undefined);

  var rerouted = harness();
  rerouted.history[recovery.EXPECTED.eventIndex].coopTopicRef = { topicId: "injected" };
  assert.equal(recovery.migrateProduction(rerouted.index, rerouted.ledger,
    rerouted.session).code, "urban_stay_policy_recovery_event_route_mismatch");
  assert.equal(rerouted.topics[recovery.THREAD_ID], undefined);

  var duplicate = harness();
  duplicate.history[1] = Object.assign({}, duplicate.history[recovery.EXPECTED.eventIndex]);
  assert.equal(recovery.migrateProduction(duplicate.index, duplicate.ledger,
    duplicate.session).code, "urban_stay_policy_recovery_event_ambiguous");
  assert.equal(duplicate.topics[recovery.THREAD_ID], undefined);

  var executed = harness();
  executed.record.links.tasks.push({ taskId: "unrelated" });
  assert.equal(recovery.migrateProduction(executed.index, executed.ledger,
    executed.session).code, "execution_already_admitted");
  assert.equal(executed.topics[recovery.THREAD_ID], undefined);

  var scoped = harness();
  scoped.record.implementationScope = { projectRef: {
    projectId: recovery.URBAN_STAY_PROJECT_ID }, topicRef: {
    topicId: recovery.THREAD_ID } };
  assert.equal(recovery.migrateProduction(scoped.index, scoped.ledger,
    scoped.session).code, "execution_already_admitted");
  assert.equal(scoped.topics[recovery.THREAD_ID], undefined);
});

test("ledger, ProjectRef, session, and target Thread drift fails closed", function () {
  var wrongRef = harness();
  wrongRef.record.requestRef.eventIndex++;
  assert.equal(recovery.migrateProduction(wrongRef.index, wrongRef.ledger,
    wrongRef.session).code, "urban_stay_policy_recovery_ledger_mismatch");

  var wrongProject = harness();
  wrongProject.record.projectRefs = [{ projectId: "another-project" }];
  assert.equal(recovery.migrateProduction(wrongProject.index, wrongProject.ledger,
    wrongProject.session).code, "urban_stay_policy_recovery_ledger_mismatch");

  var wrongSession = harness({ storageId: "wrong-session" });
  assert.equal(recovery.migrateProduction(wrongSession.index, wrongSession.ledger,
    wrongSession.session).code, "urban_stay_policy_recovery_session_mismatch");

  var conflict = harness();
  conflict.topics[recovery.THREAD_ID] = {
    topicRef: { topicId: recovery.THREAD_ID },
    threadRef: { threadId: recovery.THREAD_ID },
    title: "Conflicting Thread",
    status: "open",
    threadState: "exploring",
    group: { kind: "project", projectRef: {
      projectId: recovery.URBAN_STAY_PROJECT_ID } },
    eventRefs: [],
  };
  assert.equal(recovery.migrateProduction(conflict.index, conflict.ledger,
    conflict.session).code, "urban_stay_policy_recovery_thread_mismatch");
  assert.equal(conflict.classificationCount(), 0);
});

test("recovered routing and replay stay exact and Urban Stay-bound", function () {
  var h = harness();
  recovery.migrateProduction(h.index, h.ledger, h.session);
  var event = h.history[recovery.EXPECTED.eventIndex];
  assert.equal(recoveredAdmission.matchesRecoveredRoute(h.session, event,
    recovery.EXPECTED.eventIndex, recovery.THREAD_ID), true);
  assert.equal(recoveredAdmission.matchesRecoveredRoute(h.session, event,
    recovery.EXPECTED.eventIndex, "another-thread"), false);
  assert.equal(recoveredAdmission.matchesRecoveredEntry(h.record, h.session,
    recovery.EXPECTED.ingressId, event), true);
  assert.deepEqual(recoveredAdmission.decisionForRecoveredEntry(h.record, h.session,
    recovery.EXPECTED.ingressId, event), {
    decision: { intent: "implement", projectName: "Urban Stay" },
    projectRef: { projectId: recovery.URBAN_STAY_PROJECT_ID },
  });

  h.record.implementationScope = { projectRef: { projectId: "another-project" },
    topicRef: { topicId: recovery.THREAD_ID } };
  assert.equal(recoveredAdmission.matchesRecoveredEntry(h.record, h.session,
    recovery.EXPECTED.ingressId, event), false);
});

test("startup selection requires exactly one canonical Coop session", function () {
  var h = harness();
  assert.equal(recovery.migrateProductionFromSessionManager(h.index, h.ledger, {
    sessions: new Map([[1, h.session]]),
  }).ok, true);

  var duplicate = harness();
  assert.equal(recovery.migrateProductionFromSessionManager(duplicate.index,
    duplicate.ledger, { sessions: new Map([[1, duplicate.session],
      [2, Object.assign({}, duplicate.session)]]) }).code,
  "urban_stay_policy_recovery_session_ambiguous");
  assert.equal(duplicate.classificationCount(), 0);
});
