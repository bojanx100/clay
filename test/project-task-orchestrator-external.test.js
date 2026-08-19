var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var externalOrchestration = require("../lib/project-task-orchestrator-external");
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var mainIngressRecovery = require("../lib/coop-main-ingress-recovery");
var threadsRecovery = require("../lib/coop-threads-implementation-recovery");
var createExternalTaskCoordinator = externalOrchestration.createExternalTaskCoordinator;
var attachPortfolioExecutionTarget = externalOrchestration.attachPortfolioExecutionTarget;
var terminalStatusForTurn =
  require("../lib/project-task-orchestrator-direct-leaf-status").terminalStatusForTurn;

test("external task context becomes a durable task owned by the coordinator", function () {
  var coordinator = {
    localId: 7,
    storageId: "coordinator-storage",
    coordinationMode: true,
    orchestrationTasks: [],
    orchestrationEvents: [],
  };
  var scheduled = [];
  var saves = 0;
  var coordinate = createExternalTaskCoordinator({
    coordinatorForInput: function (input) {
      return input.coordinatorSessionId === "coordinator-storage" ? coordinator : null;
    },
    schedule: function (session) {
      scheduled.push(session);
      session.orchestrationTasks[0].workerSessionId = 18;
      session.orchestrationTasks[0].workerStorageId = "worker-storage";
    },
    sm: {
      saveSessionFile: function () { saves++; },
    },
  });

  var result = coordinate({
    coordinatorSessionId: "coordinator-storage",
    title: "Checkout error state",
    objective: "Implement the task.",
    context: "Framer page: Checkout. Selection: PaymentForm/Error.",
    acceptanceCriteria: "Match desktop and mobile.",
    ownedPaths: "Payment form UI.",
    clientRef: "framer-42",
    imageRefs: [{ mediaType: "image/png", file: "shot.png" }],
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.coordinatorSessionId, "coordinator-storage");
  assert.strictEqual(result.workerSessionId, 18);
  assert.strictEqual(result.workerStorageId, "worker-storage");
  assert.match(result.workerColor, /^#[0-9A-F]{6}$/);
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(saves, 1);
  assert.strictEqual(coordinator.orchestrationTasks.length, 1);
  assert.strictEqual(coordinator.orchestrationTasks[0].context,
    "Framer page: Checkout. Selection: PaymentForm/Error.");
  assert.strictEqual(coordinator.orchestrationTasks[0].clientRef, "framer-42");
  assert.strictEqual(coordinator.orchestrationTasks[0].workerColor,
    result.workerColor);
  assert.deepStrictEqual(coordinator.orchestrationTasks[0].imageRefs, [{
    mediaType: "image/png",
    file: "shot.png",
  }]);

  var duplicate = coordinate({
    coordinatorSessionId: "coordinator-storage",
    title: "Duplicate title",
    objective: "Do not create this.",
    clientRef: "framer-42",
  });
  assert.strictEqual(duplicate.ok, true);
  assert.strictEqual(duplicate.skipped, true);
  assert.strictEqual(duplicate.orchestrationTaskId, result.orchestrationTaskId);
  assert.strictEqual(coordinator.orchestrationTasks.length, 1);
  assert.strictEqual(scheduled.length, 1);
});

test("external task rejects a missing or ordinary target conversation", function () {
  var coordinate = createExternalTaskCoordinator({
    coordinatorForInput: function () { return null; },
    schedule: function () {
      assert.fail("invalid coordinator must not schedule");
    },
    sm: {
      saveSessionFile: function () {
        assert.fail("invalid coordinator must not save");
      },
    },
  });

  assert.deepStrictEqual(coordinate({
    coordinatorSessionId: "ordinary-chat",
    title: "Task",
    objective: "Do it.",
  }), {
    ok: false,
    error: "Coordinator session not found or is not a coordinator",
  });
});

test("the next typed dispatch reuses explicit approval text restored from history", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var topic = { topicId: "auto-fb42f62b499c463e340f95b8" };
  var source = { localId: 1, storageId: "canonical-coop", history: [{
    type: "user_message",
    text: "ok set it to implement...",
    coopIngressId: "coop:canonical-coop:281",
    coopTopicRef: topic,
  }] };
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });

  assert.equal(coordinate({ coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "cleanup", bindingRevision: 3,
    idempotencyKey: "cleanup-r3", mode: "project_coordinator",
    targetProject: { projectId: projectId }, coopTopicRef: topic }).ok, true);
  assert.equal(delivered.coopIngressId, "coop:canonical-coop:281");
  assert.deepEqual(delivered.coopTopicRef, topic);
});

test("the latest explicit Main command supplies the exact next typed execution route", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var topic = { topicId: "auto-main-owner-directed" };
  var source = { localId: 1, storageId: "canonical-coop", history: [{
    type: "user_message", text: "Fix it", coopComposerScope: "main",
    coopIngressId: "coop:canonical-coop:301",
    coopImplementationDecision: { intent: "fix" },
  }] };
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });

  assert.equal(coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "main-directed-fix", bindingRevision: 1,
    idempotencyKey: "main-directed-fix-r1", mode: "project_coordinator",
    targetProject: { projectId: projectId }, coopTopicRef: topic,
  }).ok, true);
  assert.equal(delivered.coopIngressId, "coop:canonical-coop:301");
  assert.deepEqual(delivered.coopTopicRef, topic);
});

test("a durable owner classification restores an unmarked Main ingress for its exact Thread", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var topic = { topicId: "owner-6f1e740ba6c300a282290713" };
  var ingressId = "coop:canonical-coop:461";
  var source = { localId: 1, storageId: "canonical-coop", history: [{
    type: "user_message", text: "solve it", coopComposerScope: "main",
    coopIngressId: ingressId,
  }] };
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: {
      forTopic: function (requested) {
        if (!requested || requested.topicId !== topic.topicId) return [];
        return [{
          ingressId: ingressId,
          sessionRef: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
          requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
          expectsExecution: true,
          implementationDecision: { intent: "implement", source: "explicit_owner_turn" },
        }];
      },
    },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });

  assert.equal(coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-stale-project-activity-indicator-2026-08-18",
    bindingRevision: 1,
    idempotencyKey: "clay-stale-project-activity-indicator-2026-08-18-r1",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
    coopTopicRef: topic,
  }).ok, true);
  assert.equal(delivered.coopIngressId, ingressId);
  assert.deepEqual(delivered.coopTopicRef, topic);

  // A ThreadRef supplied by a caller never selects a ledger ingress from a
  // different Thread.
  coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-stale-project-activity-indicator-2026-08-18",
    bindingRevision: 1,
    idempotencyKey: "clay-stale-project-activity-indicator-2026-08-18-r1-wrong-thread",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
    coopTopicRef: { topicId: "owner-forged-thread" },
  });
  assert.equal(delivered.coopIngressId, undefined);
});

test("ledger recovery refuses ambiguous or unverifiable implementation records", function () {
  var topic = { topicId: "owner-admission-thread" };
  var source = { localId: 1, storageId: "canonical-coop", history: [{
    type: "user_message", text: "solve it", coopIngressId: "coop:canonical-coop:461",
  }, {
    type: "user_message", text: "solve it too", coopIngressId: "coop:canonical-coop:462",
  }] };
  var candidates = [0, 1].map(function (index) {
    return {
      ingressId: source.history[index].coopIngressId,
      sessionRef: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
      requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: index },
      expectsExecution: true,
      implementationDecision: { intent: "implement", source: "explicit_owner_turn" },
    };
  });
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: { forTopic: function () { return candidates; } },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });
  var request = {
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "admission-recovery", bindingRevision: 1,
    idempotencyKey: "admission-recovery-r1", mode: "project_coordinator",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" }, coopTopicRef: topic,
  };

  coordinate(request);
  assert.equal(delivered.coopIngressId, undefined, "ambiguous records choose no ingress");

  candidates.splice(1, 1);
  candidates[0].requestRef.eventIndex = 99;
  coordinate(request);
  assert.equal(delivered.coopIngressId, undefined,
    "a record without its exact canonical event chooses no ingress");
});

test("an older unscoped Main command cannot authorize a later owner turn", function () {
  var delivered = null;
  var source = { localId: 1, storageId: "canonical-coop", history: [{
    type: "user_message", text: "Fix it", coopComposerScope: "main",
    coopIngressId: "coop:canonical-coop:301",
    coopImplementationDecision: { intent: "fix" },
  }, {
    type: "user_message", text: "What is the current status?", coopComposerScope: "main",
    coopIngressId: "coop:canonical-coop:302",
  }] };
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });

  assert.equal(coordinate({
    coordinatorSessionId: "canonical-coop", portfolioTaskId: "stale-main-fix",
    bindingRevision: 1, idempotencyKey: "stale-main-fix-r1",
    mode: "project_coordinator",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    coopTopicRef: { topicId: "auto-stale-main" },
  }).ok, true);
  assert.equal(delivered.coopIngressId, undefined);
});

test("the exact recovered Voice command routes through its canonical ProjectRef", function () {
  var history = [];
  history[166989] = {
    type: "user_message",
    text: "Create a dedicated Voice conversational mode Thread for Clay, detach Voice work from Webapp, " +
      "use session 18104cdc-5aff-4328-9afc-88bb709dd21d as read-only context, and implement it.",
    coopIngressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:360",
    coopIngressSequence: 360,
    coopIngressKind: "text",
    coopTopicRef: { topicId: mainIngressRecovery.SOURCE_THREAD_ID },
    coopThreadRef: { threadId: mainIngressRecovery.SOURCE_THREAD_ID },
    coopProjectRef: null,
    coopImplementationDecision: null,
    _ts: 1786840579387,
  };
  var source = { localId: 1, storageId: mainIngressRecovery.CANONICAL_SESSION_ID,
    history: history };
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });
  var targetTopic = { topicId: mainIngressRecovery.TARGET_THREAD_ID };

  var result = coordinate({
    coordinatorSessionId: mainIngressRecovery.CANONICAL_SESSION_ID,
    portfolioTaskId: "clay-voice-conversational-mode-2026-08-16",
    bindingRevision: 1,
    idempotencyKey: "clay-voice-conversational-mode-2026-08-16-r1",
    mode: "project_coordinator",
    targetProject: { projectId: mainIngressRecovery.CLAY_PROJECT_ID },
    coopTopicRef: targetTopic,
    objective: "Implement the approved Voice conversational mode.",
  });

  assert.equal(result.ok, true);
  assert.equal(delivered.coopIngressId,
    "coop:871a194b-8879-40f7-a1fe-656e48e722af:360");
  assert.deepEqual(delivered.coopTopicRef, targetTopic);
  assert.deepEqual(delivered.targetProject,
    { projectId: mainIngressRecovery.CLAY_PROJECT_ID });
});

test("the exact current Threads direction routes through its canonical ThreadRef", function () {
  var history = [];
  history[threadsRecovery.EXPECTED.eventIndex] = {
    type: "user_message",
    text: "Also when are we starting threads work?\n\n" +
      "Concil is repeted several times in sidebar.\n\n" +
      "Voce is a thread and should have started work by now. \n\n" +
      "A bunch of issues there... move on it",
    coopIngressId: threadsRecovery.EXPECTED.ingressId,
    coopIngressSequence: threadsRecovery.EXPECTED.sequence,
    coopIngressKind: "text",
    coopTopicRef: null,
    coopThreadRef: null,
    coopProjectRef: null,
    coopImplementationDecision: null,
    _ts: 1786877151125,
  };
  var source = { localId: 1, storageId: threadsRecovery.CANONICAL_SESSION_ID,
    history: history };
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });
  var targetTopic = { topicId: threadsRecovery.THREAD_ID };

  var result = coordinate({
    coordinatorSessionId: threadsRecovery.CANONICAL_SESSION_ID,
    portfolioTaskId: "clay-threads-v2-implementation-2026-08-16",
    bindingRevision: 1,
    idempotencyKey: "clay-threads-v2-implementation-20260816-r1-owner-directed",
    mode: "project_coordinator",
    targetProject: { projectId: threadsRecovery.CLAY_PROJECT_ID },
    coopTopicRef: targetTopic,
    objective: "Implement the accepted Threads V2 direction.",
  });

  assert.equal(result.ok, true);
  assert.equal(delivered.coopIngressId, threadsRecovery.EXPECTED.ingressId);
  assert.deepEqual(delivered.coopTopicRef, targetTopic);
  assert.deepEqual(delivered.targetProject,
    { projectId: threadsRecovery.CLAY_PROJECT_ID });
});

test("queue-wide approval preserves the queued task's original ThreadRef and ingress", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var taskTopic = { topicId: "auto-session-context" };
  var queueTopic = { topicId: "auto-run-everything-unblocked" };
  var source = { localId: 1, storageId: "canonical-coop", history: [{
    type: "user_message",
    text: "Put Coop's owner controls in Session Context.",
    coopIngressId: "coop:canonical-coop:323",
    coopTopicRef: taskTopic,
    _ts: 100,
  }, {
    type: "user_message",
    text: "Let's run all that you possibly can, anything that is not blocked should run...",
    coopIngressId: "coop:canonical-coop:339",
    coopTopicRef: queueTopic,
    _ts: 300,
  }] };
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    readLeadEvents: function () { return [{
      type: "staffing_attention",
      attentionKey: "clay-coop-owner-control-sidebar-2026-08-15:1",
      portfolioTaskId: "clay-coop-owner-control-sidebar-2026-08-15",
      bindingRevision: 1,
      seq: 40,
      at: 200,
    }]; },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });

  var result = coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-coop-owner-control-sidebar-2026-08-15",
    bindingRevision: 1,
    idempotencyKey: "clay-coop-owner-control-sidebar-20260815-r1",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
    coopTopicRef: taskTopic,
  });

  assert.equal(result.ok, true);
  assert.equal(delivered.coopIngressId, "coop:canonical-coop:323");
  assert.equal(delivered.coopAuthorizationIngressId, "coop:canonical-coop:339");
  assert.deepEqual(delivered.coopTopicRef, taskTopic);
  assert.deepEqual(delivered.targetProject, { projectId: projectId });
});

function routedReadOnlyReview(input) {
  var topic = { topicId: "auto-61f5ae911c79deab7fa6b255" };
  var source = { localId: 1, storageId: "canonical-coop", history: [{
    type: "user_message",
    text: "Implement the earlier approved task.",
    coopIngressId: "coop:canonical-coop:281",
    coopTopicRef: topic,
  }, {
    type: "user_message",
    text: "do them",
    coopIngressId: "coop:canonical-coop:332",
    coopTopicRef: topic,
  }] };
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    createProjectExecution: function (execution) {
      delivered = execution;
      return { ok: true };
    },
  });

  var result = coordinate(Object.assign({
    coordinatorSessionId: "canonical-coop",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    coopTopicRef: topic,
    mode: "project_coordinator",
  }, input));
  assert.equal(result.ok, true);
  return delivered;
}

test("Council dispatch binds the current owner-approved read-only review ingress", function () {
  var delivered = routedReadOnlyReview({
    portfolioTaskId: "clay-threads-v2-council-review-2026-08-15",
    bindingRevision: 2,
    idempotencyKey: "clay-threads-v2-council-review-20260815-r2-owner-approved",
    title: "Council review for Threads V2",
    objective: "Run a participatory Council-style review for Coop Threads V2.",
    context: "The owner authorized both proposed reviews with ingress 332: do them.",
    acceptanceCriteria: "Return recommendations without source edits.",
    ownedPaths: "read-only: product interaction architecture; no source edits",
  });

  assert.equal(delivered.coopIngressId, "coop:canonical-coop:332");
  assert.equal(delivered.controlRole, "council");
  assert.equal(delivered.reviewOnly, true);
});

test("Triage dispatch binds the current owner-approved read-only review ingress", function () {
  var delivered = routedReadOnlyReview({
    portfolioTaskId: "clay-threads-v2-triage-review-2026-08-15",
    bindingRevision: 1,
    idempotencyKey: "clay-threads-v2-triage-review-20260815-r1-owner-approved",
    title: "Triage review for Threads V2 routing",
    objective: "Run a focused Triage review of routing and title behavior.",
    context: "The owner authorized both proposed reviews with ingress 332: do them.",
    acceptanceCriteria: "Return prioritized findings without source edits.",
    ownedPaths: "read-only: routing, title, and triage requirements; no source edits",
  });

  assert.equal(delivered.coopIngressId, "coop:canonical-coop:332");
  assert.equal(delivered.controlRole, "triage");
  assert.equal(delivered.reviewOnly, true);
});

test("an external Live UI report can promote an ordinary conversation", function () {
  var ordinary = {
    localId: 9,
    storageId: "ordinary-chat",
    coordinationMode: false,
    orchestrationTasks: [],
    orchestrationEvents: [],
  };
  var coordinate = createExternalTaskCoordinator({
    coordinatorForInput: function () { return null; },
    ensureCoordinatorForInput: function () {
      ordinary.coordinationMode = true;
      return ordinary;
    },
    schedule: function () {},
    sm: { saveSessionFile: function () {} },
  });
  var result = coordinate({
    coordinatorSessionId: "ordinary-chat",
    promoteCoordinator: true,
    title: "Live UI report",
    objective: "Fix it.",
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(ordinary.coordinationMode, true);
  assert.strictEqual(ordinary.orchestrationTasks.length, 1);
});

test("completed Coop direct leaves deliver their result before terminal archival", function () {
  var timeline = [];
  var session = {
    localId: 7,
    storageId: "direct-leaf-storage",
    history: [],
    isProcessing: false,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "portfolio-direct-leaf",
        bindingRevision: 1,
        idempotencyKey: "direct-leaf-1",
        mode: "direct_leaf",
        status: "running",
        source: { projectId: "system-lead", sessionStorageId: "coop-home" },
      },
    },
  };
  var sessions = new Map([[session.localId, session]]);
  var metadata = session.orchestrationPolicy.portfolioExecution;
  var sm = {
    sessions: sessions,
    getProjectId: function () { return null; },
    subscribeSession: function (id, callback) {
      session._subscriber = callback;
      return function () { timeline.push("unsubscribe"); };
    },
    saveSessionFile: function () { timeline.push("save:" + metadata.status); },
    broadcastSessionList: function () {},
    hideSession: function (id) {
      timeline.push("hide");
      sessions.get(id).hidden = true;
    },
  };
  var target = attachPortfolioExecutionTarget({
    slug: "webapp",
    sm: sm,
    sdk: {},
    onProcessingChanged: function () {},
    crossProject: {
      getExecutionBinding: function () {
        return { worker: { projectId: "system-target", sessionStorageId: "direct-leaf-storage" } };
      },
      createEnvelope: function (input) {
        timeline.push("envelope");
        return input;
      },
      deliverEnvelope: function (envelope) {
        timeline.push("deliver:" + metadata.status);
        assert.equal(metadata.status, "completed");
        assert.deepEqual(envelope.source, {
          projectId: "system-target",
          sessionStorageId: "direct-leaf-storage",
        });
        assert.equal(envelope.payload.type, "portfolio_execution_completed");
        assert.equal(envelope.payload.ownerNotification, true);
        assert.equal(session.hidden, undefined);
        return { ok: true, delivered: true, acknowledged: true };
      },
    },
  });
  target.reconcilePersistedSessions();

  session.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Direct leaf finished.\n" +
      "VERIFICATION: durable result delivery passed\nESCALATION_REQUIRED: no",
  });
  session._subscriber({ type: "done" });

  assert.equal(metadata.status, "completed");
  assert.equal(session.hidden, true);
  assert.ok(timeline.indexOf("save:completed") < timeline.indexOf("deliver:completed"));
  assert.ok(timeline.indexOf("deliver:completed") < timeline.indexOf("hide"));
});

test("needs-input Coop direct leaves deliver terminal attention without hiding evidence", function () {
  var timeline = [];
  var session = {
    localId: 8,
    storageId: "needs-input-direct-leaf",
    history: [],
    isProcessing: false,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "portfolio-needs-input-leaf",
        bindingRevision: 1,
        idempotencyKey: "needs-input-leaf-1",
        mode: "direct_leaf",
        status: "running",
        source: { projectId: "system-lead", sessionStorageId: "coop-home" },
      },
    },
  };
  var sessions = new Map([[session.localId, session]]);
  var metadata = session.orchestrationPolicy.portfolioExecution;
  var sm = {
    sessions: sessions,
    getProjectId: function () { return null; },
    subscribeSession: function (id, callback) {
      session._subscriber = callback;
      return function () { timeline.push("unsubscribe"); };
    },
    saveSessionFile: function () { timeline.push("save:" + metadata.status); },
    broadcastSessionList: function () {},
    hideSession: function (id) {
      timeline.push("hide");
      sessions.get(id).hidden = true;
    },
  };
  var target = attachPortfolioExecutionTarget({
    slug: "webapp",
    sm: sm,
    sdk: {},
    onProcessingChanged: function () {},
    crossProject: {
      getExecutionBinding: function () {
        return { worker: { projectId: "system-target", sessionStorageId: "needs-input-direct-leaf" } };
      },
      createEnvelope: function (input) {
        timeline.push("envelope");
        return input;
      },
      deliverEnvelope: function (envelope) {
        timeline.push("deliver:" + metadata.status);
        assert.equal(envelope.payload.type, "portfolio_execution_completed");
        assert.equal(envelope.payload.terminalStatus, "needs_input");
        assert.equal(metadata.status, "needs_input");
        assert.equal(session.hidden, undefined);
        return { ok: true, delivered: true, acknowledged: true };
      },
    },
  });
  target.reconcilePersistedSessions();

  session.history.push({
    type: "delta",
    text: "WORKER_STATUS: needs_input\nSUMMARY: Owner decision required.\n" +
      "ESCALATION_REQUIRED: yes",
  });
  session._subscriber({ type: "done" });

  assert.equal(metadata.status, "needs_input");
  assert.equal(session.hidden, undefined);
  assert.ok(timeline.indexOf("save:needs_input") < timeline.indexOf("deliver:needs_input"));
  assert.equal(timeline.indexOf("hide"), -1);
});

test("direct leaves never strand a completed worker report in graph-only reviewing status", function () {
  var result = [
    "WORKER_STATUS: completed",
    "SUMMARY: The direct leaf finished the bounded change.",
    "VERIFICATION: npm test passed, 42/42",
    "ESCALATION_REQUIRED: yes",
  ].join("\n");

  assert.equal(terminalStatusForTurn({}, { type: "done", code: 0 }, result), "needs_input");
});

test("restart recovery closes an archived project coordinator binding after session reconciliation", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-archived-coordinator-binding-"));
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var request = {
    source: { projectId: "system-lead", sessionStorageId: "coop-home" },
    portfolioTaskId: "portfolio-archived-recovery",
    bindingRevision: 1,
    idempotencyKey: "portfolio-archived-recovery-r1",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
  };
  assert.equal(router.bindingStore.reserve(request).ok, true);
  assert.equal(router.bindingStore.commit(request.portfolioTaskId, request.bindingRevision, {
    projectId: projectId,
    sessionStorageId: "archived-task-coordinator",
  }).ok, true);

  var metadata = Object.assign({}, request, { status: "running" });
  var coordinator = {
    localId: 7,
    storageId: "archived-task-coordinator",
    history: [],
    isProcessing: false,
    orchestrationProjectCompletion: { status: "pending", completionRevision: 0 },
    orchestrationPolicy: { portfolioExecution: metadata },
  };
  var sessions = new Map([[coordinator.localId, coordinator]]);
  var sm = {
    sessions: sessions,
    getProjectId: function () { return projectId; },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    getSessionManager: function () { return sm; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });
  var attached = attachPortfolioExecutionTarget({
    coopDeliveryControl: { enabled: true },
    coopStartupRecovery: {},
    crossProject: router,
    sdk: {},
    sm: sm,
    slug: "clay",
  });

  metadata.status = "failed";
  metadata.reason = "restart_recovery";
  metadata.terminalAt = 1234;
  metadata.updatedAt = 1234;
  coordinator.hidden = true;
  router.bindingStore.markAttention(request.portfolioTaskId, request.bindingRevision,
    "session_archived");
  assert.equal(router.getExecutionBinding(request.portfolioTaskId, 1).status, "active");
  assert.equal(router.getExecutionBinding(request.portfolioTaskId, 1).statusReason,
    "session_archived");

  attached.reconcilePersistedSessions();

  var binding = router.getExecutionBinding(request.portfolioTaskId, request.bindingRevision);
  assert.equal(binding.status, "failed");
  assert.equal(binding.completedAt, 1234);
  // Recovery provenance survives end to end. It replaces the pre-terminal
  // "session_archived" (why it stalled) with why it actually ended, so a binding
  // swept by restart recovery stays tellable apart from a task that failed on
  // its own merits -- previously both landed as a bare "failed" with no reason.
  assert.equal(binding.failureCode, "restart_recovery");
  assert.equal(binding.statusReason, "restart_recovery");
  assert.equal(binding.attentionAt, undefined);
  assert.equal(coordinator.orchestrationProjectCompletion.status, "pending",
    "a recovered failure is terminal but not a verified project completion");
  assert.deepEqual(router.bindingStore.listCurrent(), []);
});

test("steering recovers an archived active task coordinator but leaves terminal evidence archived", function () {
  var saves = 0;
  var broadcasts = 0;
  var sm = {
    saveSessionFile: function () { saves++; },
    broadcastSessionList: function () { broadcasts++; },
  };
  var active = {
    hidden: true, closedAt: 123, coordinationRole: "task_coordinator",
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "active-task", bindingRevision: 1,
      idempotencyKey: "active-task-r1", mode: "project_coordinator", status: "running",
    } },
  };
  var terminal = {
    hidden: true, closedAt: 456, coordinationRole: "task_coordinator",
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "done-task", bindingRevision: 1,
      idempotencyKey: "done-task-r1", mode: "project_coordinator", status: "completed",
    } },
  };

  assert.equal(externalOrchestration.recoverArchivedTaskCoordinator(sm, active), true);
  assert.equal(active.hidden, false);
  assert.equal(active.closedAt, null);
  assert.equal(externalOrchestration.recoverArchivedTaskCoordinator(sm, terminal), false);
  assert.equal(terminal.hidden, true);
  assert.equal(saves, 1);
  assert.equal(broadcasts, 1);
});

test("a partial project-execution field set names what is missing", function () {
  var problem = externalOrchestration.projectExecutionInputProblem;
  // The exact shape that used to fail as a bare "invalid_binding": a target
  // project and task id, but no idempotency key, mode or binding revision.
  var partial = problem({
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    portfolioTaskId: "cleanup",
  });
  assert.ok(partial, "a partial set must be reported as a problem");
  assert.match(partial, /idempotencyKey/);
  assert.match(partial, /mode/);
  assert.match(partial, /bindingRevision/);
  assert.doesNotMatch(partial, /targetProject\.projectId/);
  assert.match(partial, /Omit all five to delegate a local worker task instead/);

  // A missing target project is named too -- that was the original report.
  assert.match(problem({ portfolioTaskId: "cleanup", bindingRevision: 1,
    idempotencyKey: "cleanup-r1", mode: "direct_leaf" }) || "",
    /targetProject\.projectId/);

  // A revision that is not a positive integer is invalid, not merely absent.
  assert.match(problem({ targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    portfolioTaskId: "cleanup", idempotencyKey: "cleanup-r1",
    mode: "direct_leaf", bindingRevision: 0 }) || "", /bindingRevision/);

  // The complete set is accepted.
  assert.equal(problem({
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    portfolioTaskId: "cleanup", bindingRevision: 2,
    idempotencyKey: "cleanup-r2", mode: "project_coordinator",
  }), null);
});

test("an incomplete typed dispatch is refused with a legible reason", function () {
  var source = { localId: 1, storageId: "canonical-coop", history: [] };
  var reached = false;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    createProjectExecution: function () { reached = true; return { ok: true }; },
  });
  var result = coordinate({ coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "cleanup", bindingRevision: 3,
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" } });
  assert.equal(result.ok, false);
  assert.match(result.error, /idempotencyKey/);
  // Refused before the binding layer, so the caller never sees invalid_binding.
  assert.equal(reached, false);
  assert.equal(result.reason, undefined);
});

test("a named owner approval routes itself and mints the Thread it needs", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var approval = {
    type: "user_message",
    text: "approve eligibility fix",
    coopIngressId: "coop:canonical-coop:455",
    coopComposerScope: "main",
    _ts: 2000,
  };
  var source = { localId: 1, storageId: "canonical-coop", history: [approval] };
  var minted = [];
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    // The pending item, recorded BEFORE the approval as the contract requires.
    readLeadEvents: function () {
      return [{
        type: "staffing_attention",
        attentionKey: "clay-lead-project-policy-eligibility:1",
        itemId: "clay-lead-project-policy-eligibility",
        portfolioTaskId: "clay-lead-project-policy-eligibility",
        bindingRevision: 1,
        at: 1000,
        seq: 1,
      }];
    },
    ensureOwnerThread: function (request) {
      minted.push(request);
      return { ok: true, created: true, topicRef: { topicId: "owner-deadbeef" },
        threadRef: { threadId: "owner-deadbeef" } };
    },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });

  var result = coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-lead-project-policy-eligibility",
    bindingRevision: 1,
    idempotencyKey: "eligibility-r1",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
  });
  assert.equal(result.ok, true);

  // The approval ingress is derived server-side, never taken from the caller.
  assert.equal(delivered.coopApprovalIngressId, "coop:canonical-coop:455");
  // The Thread is bound to the approval turn and reaches the gate as a TopicRef,
  // which is what "thread_ref_required" was blocking on.
  assert.equal(minted.length, 1);
  assert.equal(minted[0].ingressId, "coop:canonical-coop:455");
  assert.equal(minted[0].projectRef.projectId, projectId);
  assert.deepEqual(delivered.coopTopicRef, { topicId: "owner-deadbeef" });
});

test("an approval never routes a task it did not name", function () {
  var approval = {
    type: "user_message",
    text: "approve eligibility fix",
    coopIngressId: "coop:canonical-coop:455",
    coopComposerScope: "main",
    _ts: 2000,
  };
  var source = { localId: 1, storageId: "canonical-coop", history: [approval] };
  var minted = 0;
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    readLeadEvents: function () {
      return [{
        type: "staffing_attention",
        attentionKey: "clay-lead-project-policy-eligibility:1",
        itemId: "clay-lead-project-policy-eligibility",
        portfolioTaskId: "clay-lead-project-policy-eligibility",
        bindingRevision: 1,
        at: 1000,
        seq: 1,
      }];
    },
    ensureOwnerThread: function () {
      minted++;
      return { ok: true, topicRef: { topicId: "owner-should-not-exist" } };
    },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });

  // Same approval, a DIFFERENT task: no route, and above all no Thread minted
  // for work the owner never approved.
  coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-something-else-entirely",
    bindingRevision: 1,
    idempotencyKey: "other-r1",
    mode: "project_coordinator",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
  });
  assert.equal(minted, 0);
  assert.equal(delivered.coopApprovalIngressId, undefined);
  assert.equal(delivered.coopTopicRef, undefined);

  // A bumped revision is outside the approval too.
  coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-lead-project-policy-eligibility",
    bindingRevision: 2,
    idempotencyKey: "eligibility-r2",
    mode: "project_coordinator",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
  });
  assert.equal(minted, 0);
  assert.equal(delivered.coopApprovalIngressId, undefined);
});
