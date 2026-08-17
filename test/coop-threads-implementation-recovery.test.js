var test = require("node:test");
var assert = require("node:assert/strict");
var recovery = require("../lib/coop-threads-implementation-recovery");

function productionEvent() {
  return {
    type: "user_message",
    text: "Also when are we starting threads work?\n\n" +
      "Concil is repeted several times in sidebar.\n\n" +
      "Voce is a thread and should have started work by now. \n\n" +
      "A bunch of issues there... move on it",
    coopIngressId: recovery.EXPECTED.ingressId,
    coopIngressSequence: recovery.EXPECTED.sequence,
    coopIngressKind: "text",
    coopTopicRef: null,
    coopThreadRef: null,
    coopProjectRef: null,
    coopImplementationDecision: null,
    _ts: 1786877151125,
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
    receivedAt: 1786877151405,
    classification: { kind: "conversational", source: "ingress_route", at: 1786877151418 },
    implementationDecision: null,
    topicRef: null,
    projectRefs: [],
    expectsExecution: false,
    links: { coordinators: [], tasks: [], sessions: [] },
    state: "open",
    outcome: null,
  };
  var thread = {
    topicRef: { topicId: recovery.THREAD_ID },
    threadRef: { threadId: recovery.THREAD_ID },
    status: "open",
    threadState: "handed_off",
  };
  var classifications = 0;
  var index = {
    resolve: function (ref) {
      var id = ref && (ref.threadId || ref.topicId);
      return id === recovery.THREAD_ID ? { ok: true, topic: thread } :
        { ok: false, code: "topic_not_found" };
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
  return { history: history, record: record, thread: thread, index: index,
    ledger: ledger, session: session,
    classificationCount: function () { return classifications; } };
}

test("the exact owner direction is the only Threads decision recognized by the finite repair", function () {
  assert.deepEqual(recovery.explicitThreadsDecision(productionEvent().text), {
    intent: "implement",
  });
  assert.equal(recovery.explicitThreadsDecision("When are we starting Threads work?"), null);
  assert.equal(recovery.explicitThreadsDecision("Move on it"), null);
  assert.equal(recovery.explicitThreadsDecision(
    "When are we starting Threads work? Maybe move on it"), null);
});

test("production migration pins ingress 371 to canonical Threads and Clay exactly once", function () {
  var h = harness();
  var historyBefore = JSON.stringify(h.history[recovery.EXPECTED.eventIndex]);
  assert.deepEqual(recovery.migrateProduction(h.index, h.ledger, h.session), {
    ok: true,
    migrationId: recovery.RECOVERY_ID,
    noop: false,
    decisionBackfilled: true,
    threadRef: { threadId: recovery.THREAD_ID },
  });
  assert.deepEqual(h.record.implementationDecision, {
    intent: "implement", source: "explicit_owner_turn", at: 1786877151125,
  });
  assert.deepEqual(h.record.topicRef, { topicId: recovery.THREAD_ID });
  assert.deepEqual(h.record.projectRefs, [{ projectId: recovery.CLAY_PROJECT_ID }]);
  assert.equal(h.record.expectsExecution, true);
  assert.deepEqual(h.record.links, { coordinators: [], tasks: [], sessions: [] });
  assert.equal(JSON.stringify(h.history[recovery.EXPECTED.eventIndex]), historyBefore,
    "the canonical owner event remains immutable");
  assert.equal(h.classificationCount(), 1);

  assert.deepEqual(recovery.migrateProduction(h.index, h.ledger, h.session), {
    ok: true,
    migrationId: recovery.RECOVERY_ID,
    noop: true,
    decisionBackfilled: false,
    threadRef: { threadId: recovery.THREAD_ID },
  });
  assert.equal(h.classificationCount(), 1, "startup replay does not restamp the decision");

  h.record.links.tasks.push({ taskId: "typed-dispatch" });
  assert.equal(recovery.migrateProduction(h.index, h.ledger, h.session).ok, true,
    "a later restart reuses the exact decision after typed execution links it");
  assert.equal(h.classificationCount(), 1);
});

// The applied state is the durable ledger record alone: the finished repair keeps
// proving itself after the owner closes, renames, or reassigns the Thread it created,
// which is the intended end of that Thread's lifecycle rather than an edge case.
function appliedHarness(options) {
  var h = harness(options);
  h.record.implementationDecision = { intent: "implement", source: "explicit_owner_turn",
    at: h.history[recovery.EXPECTED.eventIndex]._ts };
  h.record.topicRef = { topicId: recovery.THREAD_ID };
  h.record.projectRefs = [{ projectId: recovery.CLAY_PROJECT_ID }];
  h.record.expectsExecution = true;
  return h;
}

test("an applied Threads repair stays a no-op success after the Thread is closed", function () {
  var closed = appliedHarness();
  closed.thread.status = "closed";
  assert.deepEqual(recovery.migrateProduction(closed.index, closed.ledger, closed.session), {
    ok: true,
    migrationId: recovery.RECOVERY_ID,
    noop: true,
    decisionBackfilled: false,
    threadRef: { threadId: recovery.THREAD_ID },
  });
  assert.equal(closed.classificationCount(), 0);

  var released = appliedHarness();
  released.thread.threadState = "exploring";
  assert.equal(recovery.migrateProduction(released.index, released.ledger,
    released.session).noop, true, "a released handoff no longer wedges the repair");

  var gone = appliedHarness();
  gone.index = { resolve: function () { return { ok: false, code: "topic_not_found" }; } };
  assert.equal(recovery.migrateProduction(gone.index, gone.ledger, gone.session).noop, true,
    "even a deleted Thread leaves the durable ledger decision intact");

  // Strongest form of the same rule: the applied verdict never reads live Thread state.
  var poisoned = appliedHarness();
  poisoned.index = { resolve: function () {
    throw new Error("mutable Thread state must not be re-proven once applied");
  } };
  assert.deepEqual(recovery.migrateProduction(poisoned.index, poisoned.ledger,
    poisoned.session), {
    ok: true,
    migrationId: recovery.RECOVERY_ID,
    noop: true,
    decisionBackfilled: false,
    threadRef: { threadId: recovery.THREAD_ID },
  });
});

// Split deliberately from the applied case above: before the decision is written the
// repair still has to touch the Thread, so mutable drift must keep failing closed.
test("production migration fails closed on changed event or Thread evidence", function () {
  var changedText = harness();
  changedText.history[recovery.EXPECTED.eventIndex].text += ".";
  assert.equal(recovery.migrateProduction(changedText.index, changedText.ledger,
    changedText.session).code, "threads_recovery_event_digest_mismatch");
  assert.equal(changedText.classificationCount(), 0);

  var injectedRoute = harness();
  injectedRoute.history[recovery.EXPECTED.eventIndex].coopTopicRef =
    { topicId: recovery.THREAD_ID };
  assert.equal(recovery.migrateProduction(injectedRoute.index, injectedRoute.ledger,
    injectedRoute.session).code, "threads_recovery_event_route_mismatch");
  assert.equal(injectedRoute.classificationCount(), 0);

  var changedState = harness();
  changedState.thread.threadState = "exploring";
  assert.equal(recovery.migrateProduction(changedState.index, changedState.ledger,
    changedState.session).code, "threads_recovery_thread_mismatch",
  "drift before the decision is written still fails closed");
  assert.equal(changedState.classificationCount(), 0);

  var closedBeforeApplication = harness();
  closedBeforeApplication.thread.status = "closed";
  assert.equal(recovery.migrateProduction(closedBeforeApplication.index,
    closedBeforeApplication.ledger, closedBeforeApplication.session).code,
  "threads_recovery_thread_mismatch");
  assert.equal(closedBeforeApplication.classificationCount(), 0);

  var wrongSession = harness({ storageId: "wrong-session" });
  assert.equal(recovery.migrateProduction(wrongSession.index, wrongSession.ledger,
    wrongSession.session).code, "threads_recovery_session_mismatch");
  assert.equal(wrongSession.classificationCount(), 0);
});

test("production migration rejects ledger drift and unrelated execution", function () {
  var wrongRef = harness();
  wrongRef.record.requestRef.eventIndex = 1;
  assert.equal(recovery.migrateProduction(wrongRef.index, wrongRef.ledger,
    wrongRef.session).code, "threads_recovery_ledger_mismatch");
  assert.equal(wrongRef.classificationCount(), 0);

  var wrongTopic = harness();
  wrongTopic.record.topicRef = { topicId: "some-other-thread" };
  assert.equal(recovery.migrateProduction(wrongTopic.index, wrongTopic.ledger,
    wrongTopic.session).code, "threads_recovery_ledger_mismatch");
  assert.equal(wrongTopic.classificationCount(), 0);

  var linked = harness();
  linked.record.links.tasks.push({ taskId: "unrelated" });
  assert.equal(recovery.migrateProduction(linked.index, linked.ledger,
    linked.session).code, "execution_already_admitted");
  assert.equal(linked.classificationCount(), 0);

  var wrongProject = harness();
  wrongProject.record.projectRefs = [{ projectId: "another-project" }];
  assert.equal(recovery.migrateProduction(wrongProject.index, wrongProject.ledger,
    wrongProject.session).code, "threads_recovery_ledger_mismatch");
  assert.equal(wrongProject.classificationCount(), 0);
});

test("route and replay aliases accept only the exact recovered Threads event", function () {
  var h = harness();
  var event = h.history[recovery.EXPECTED.eventIndex];
  var entry = h.record;
  entry.topicRef = { topicId: recovery.THREAD_ID };
  assert.equal(recovery.matchesRecoveredRoute(h.session, event,
    recovery.EXPECTED.eventIndex, recovery.THREAD_ID), true);
  assert.equal(recovery.matchesRecoveredRoute(h.session, event,
    recovery.EXPECTED.eventIndex, "another-thread"), false);
  assert.equal(recovery.matchesRecoveredRoute(h.session, event,
    recovery.EXPECTED.eventIndex - 1, recovery.THREAD_ID), false);
  assert.equal(recovery.matchesRecoveredEntry(entry, h.session,
    recovery.EXPECTED.ingressId, event), true);
  assert.equal(recovery.matchesRecoveredEntry(entry, h.session,
    "coop:" + recovery.CANONICAL_SESSION_ID + ":370", event), false);

  event.coopImplementationDecision = { intent: "implement" };
  assert.equal(recovery.matchesRecoveredRoute(h.session, event,
    recovery.EXPECTED.eventIndex, recovery.THREAD_ID), false);
  assert.equal(recovery.matchesRecoveredEntry(entry, h.session,
    recovery.EXPECTED.ingressId, event), false);
});

test("startup selection requires exactly one canonical Coop session", function () {
  var h = harness();
  var first = recovery.migrateProductionFromSessionManager(h.index, h.ledger, {
    sessions: new Map([[1, h.session]]),
  });
  assert.equal(first.ok, true);
  assert.equal(first.decisionBackfilled, true);

  var duplicate = harness();
  assert.equal(recovery.migrateProductionFromSessionManager(
    duplicate.index, duplicate.ledger, { sessions: new Map([[1, duplicate.session],
      [2, Object.assign({}, duplicate.session)]]) }).code,
  "threads_recovery_session_ambiguous");
  assert.equal(duplicate.classificationCount(), 0);
});
