var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var externalOrchestration = require("../lib/project-task-orchestrator-external");
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;
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

test("ledger recovery resolves stale offsets but refuses ambiguous or unverifiable records",
  function () {
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
  assert.equal(delivered.coopIngressId, "coop:canonical-coop:461",
    "a stale offset recovers the unique canonical event by immutable ingress id");

  source.history = [{
    type: "user_message", text: "different turn",
    coopIngressId: "coop:canonical-coop:999",
  }];
  delivered = null;
  coordinate(request);
  assert.equal(delivered.coopIngressId, undefined,
    "a record with no canonical ingress match chooses no ingress");
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

// The standing thread_ref_required dispatch blocker, reproduced from the live
// shapes measured on 2026-08-19 in the canonical Coop session.
//
// The owner authorized webapp-automation-policy-board-exclusions rev1 at ingress
// 459, which carries a durable implementationScope and its own Thread. Later,
// unrelated Main turns ("Fix that too", "FIX!") gained implementation decisions
// scoped to other tasks in another project. Because the scan's topic filter is
// guarded by `requested`, a dispatch that named no Thread adopted the LATEST
// implementation ingress instead of its own -- ingress 482, for project
// 5332aafc, whose event carries no TopicRef. The gate then reported
// thread_ref_required and blamed a Thread-minting gap that was never the
// blocker, and the early return also shadowed the approval route, the only path
// that can mint a Thread.
function boardExclusionsSource() {
  var webapp = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
  var other = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var authorization = {
    type: "user_message",
    text: "Implement webapp-automation-policy-board-exclusions revision 1 in the Webapp project.",
    coopIngressId: "coop:canonical-coop:459",
    coopComposerScope: "main",
    coopImplementationDecision: { intent: "implement" },
    _ts: 1000,
  };
  var unrelated = {
    type: "user_message",
    text: "FIX!",
    coopIngressId: "coop:canonical-coop:482",
    coopComposerScope: "main",
    coopImplementationDecision: { intent: "fix" },
    _ts: 2000,
  };
  // The owner's most recent turn is conversational, exactly as in live state, so
  // it is not an implementation ingress and cannot itself carry the route.
  var latest = {
    type: "user_message",
    text: "Bind it to task, carry the approval forward on retry",
    coopIngressId: "coop:canonical-coop:503",
    coopComposerScope: "main",
    _ts: 3000,
  };
  var entries = {
    "coop:canonical-coop:459": {
      ingressId: "coop:canonical-coop:459",
      expectsExecution: true,
      implementationDecision: { intent: "implement" },
      topicRef: { topicId: "owner-65d0dc78c4e6d085002842c1" },
      projectRefs: [{ projectId: webapp }],
      implementationScope: {
        projectRef: { projectId: webapp },
        topicRef: { topicId: "owner-65d0dc78c4e6d085002842c1" },
        portfolioTaskId: "webapp-automation-policy-board-exclusions",
        bindingRevision: 1,
        idempotencyKey: "webapp-automation-policy-board-exclusions-r1",
      },
    },
    "coop:canonical-coop:482": {
      ingressId: "coop:canonical-coop:482",
      expectsExecution: true,
      implementationDecision: { intent: "fix" },
      topicRef: { topicId: "owner-db63c678eaf213b79b8c62e9" },
      projectRefs: [{ projectId: other }],
      implementationScope: {
        projectRef: { projectId: other },
        topicRef: { topicId: "owner-db63c678eaf213b79b8c62e9" },
        portfolioTaskId: "clay-thread-followup-resolution-fix-2026-08-18",
        bindingRevision: 1,
        idempotencyKey: "clay-thread-followup-resolution-fix-2026-08-18-r1",
      },
    },
  };
  return {
    webapp: webapp,
    other: other,
    source: { localId: 1, storageId: "canonical-coop",
      history: [authorization, unrelated, latest] },
    ownerRequests: {
      get: function (id) { return entries[id] || null; },
      forTopic: function () { return []; },
    },
  };
}

test("an unscoped dispatch never adopts an owner turn that authorized other work", function () {
  var live = boardExclusionsSource();
  var delivered = null;
  var minted = 0;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return live.source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: live.ownerRequests,
    readLeadEvents: function () { return []; },
    ensureOwnerThread: function () {
      minted++;
      return { ok: true, topicRef: { topicId: "owner-minted" } };
    },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });
  function dispatch(revision) {
    delivered = null;
    return coordinate({
      coordinatorSessionId: "canonical-coop",
      portfolioTaskId: "webapp-automation-policy-board-exclusions",
      bindingRevision: revision,
      idempotencyKey: "webapp-automation-policy-board-exclusions-r" + revision,
      mode: "project_coordinator",
      targetProject: { projectId: live.webapp },
    });
  }

  // rev1: the owner's own authorization is found, and with it the Thread that
  // owner turn already owns. Before the fix this routed ingress 482 with no
  // TopicRef at all, which is what surfaced as thread_ref_required.
  dispatch(1);
  assert.equal(delivered.coopIngressId, "coop:canonical-coop:459");
  assert.deepEqual(delivered.coopTopicRef, { topicId: "owner-65d0dc78c4e6d085002842c1" });
  // The Thread is the owner turn's existing one, not a newly minted container.
  assert.equal(minted, 0);

  // rev2: a retry of the same work at a later revision. This case USED to assert
  // an empty route, on the reasoning that the owner authorized rev1 only -- and
  // that assertion is what let the approval carry-forward (a8500b9a3a) ship dead.
  // An approval is spent on a task AT A REVISION, so every retry arrives with a
  // bumped revision; refusing to route one meant admission never reached
  // `approvalCarriesForward` and the rule could not fire in production.
  //
  // So the router now proposes ingress 459 -- the owner's own turn for THIS task,
  // with the Thread that turn already owns. Whether the carry-forward is actually
  // earned (did rev1 end terminal-unsuccessful? has any revision ever completed?)
  // is admission's decision and needs the binding store, which the router cannot
  // read. Proposing is not authorizing.
  //
  // The property this case exists to defend is unchanged and still asserted: the
  // unrelated "FIX!" turn 482, for another project and another task, is never
  // borrowed to stand in for a covering authorization at any revision.
  dispatch(2);
  assert.equal(delivered.coopIngressId, "coop:canonical-coop:459");
  assert.deepEqual(delivered.coopTopicRef, { topicId: "owner-65d0dc78c4e6d085002842c1" });
  assert.equal(minted, 0);

  // The scope widening is bounded to the revision. Ask 482's task for a revision
  // it never authorized and the route stays empty rather than sliding onto 459.
  delivered = null;
  coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-thread-followup-resolution-fix-2026-08-18",
    bindingRevision: 2,
    idempotencyKey: "clay-thread-followup-resolution-fix-2026-08-18-r2",
    mode: "project_coordinator",
    targetProject: { projectId: live.webapp },
  });
  assert.equal(delivered.coopIngressId, undefined);
  assert.equal(delivered.coopTopicRef, undefined);
  assert.equal(minted, 0);
});

test("narrowing the unscoped scan still routes the task each owner turn did authorize", function () {
  var live = boardExclusionsSource();
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return live.source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: live.ownerRequests,
    readLeadEvents: function () { return []; },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });
  // Ingress 482 is not blocked as such -- it is only blocked for work it never
  // authorized. Asked for its own task, it routes, with its own Thread.
  coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-thread-followup-resolution-fix-2026-08-18",
    bindingRevision: 1,
    idempotencyKey: "clay-thread-followup-resolution-fix-2026-08-18-r1",
    mode: "project_coordinator",
    targetProject: { projectId: live.other },
  });
  assert.equal(delivered.coopIngressId, "coop:canonical-coop:482");
  assert.deepEqual(delivered.coopTopicRef, { topicId: "owner-db63c678eaf213b79b8c62e9" });
});

test("an unscoped dispatch may still adopt the owner turn that just spoke", function () {
  // The unscoped-Main path depends on this: the owner types a fix request in
  // Main with no Thread and Coop dispatches immediately. That turn is the latest
  // owner ingress and carries no durable scope yet, so it stays routable and
  // admitUnscopedMainImplementation re-derives it independently. Narrowing the
  // scan must not close this.
  var justSpoke = {
    type: "user_message",
    text: "Fix the broken thing now",
    coopIngressId: "coop:canonical-coop:600",
    coopComposerScope: "main",
    coopImplementationDecision: { intent: "fix" },
    _ts: 5000,
  };
  var source = { localId: 1, storageId: "canonical-coop", history: [justSpoke] };
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: { get: function () { return null; }, forTopic: function () { return []; } },
    readLeadEvents: function () { return []; },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });
  coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-some-new-task",
    bindingRevision: 1,
    idempotencyKey: "clay-some-new-task-r1",
    mode: "project_coordinator",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
  });
  assert.equal(delivered.coopIngressId, "coop:canonical-coop:600");
  // No Thread, because this harness wires no ensureOwnerThread seam. The turn
  // being routable at all is the point here; the Thread it needs is minted from
  // that seam and covered by the unscoped-Main minting tests below.
  assert.equal(delivered.coopTopicRef, undefined);
});

test("an unscoped hijack no longer shadows the Thread-minting approval route", function () {
  // The approval route is the only path that mints a Thread for approved backlog
  // work. Before the fix the scan returned an unrelated implementation ingress
  // first, so this route was unreachable for any dispatch without a TopicRef.
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var unrelated = {
    type: "user_message",
    text: "Fix that too",
    coopIngressId: "coop:canonical-coop:468",
    coopComposerScope: "main",
    coopImplementationDecision: { intent: "fix" },
    _ts: 1000,
  };
  var approval = {
    type: "user_message",
    text: "approve eligibility fix",
    coopIngressId: "coop:canonical-coop:455",
    coopComposerScope: "main",
    _ts: 3000,
  };
  var source = { localId: 1, storageId: "canonical-coop", history: [unrelated, approval] };
  var minted = [];
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: {
      get: function () {
        return { ingressId: "coop:canonical-coop:468", expectsExecution: true,
          implementationDecision: { intent: "fix" },
          implementationScope: {
            projectRef: { projectId: projectId },
            topicRef: { topicId: "owner-other" },
            portfolioTaskId: "clay-unrelated-task",
            bindingRevision: 1,
            idempotencyKey: "clay-unrelated-task-r1",
          } };
      },
      forTopic: function () { return []; },
    },
    readLeadEvents: function () {
      return [{ type: "staffing_attention",
        attentionKey: "clay-lead-project-policy-eligibility:1",
        itemId: "clay-lead-project-policy-eligibility",
        portfolioTaskId: "clay-lead-project-policy-eligibility",
        bindingRevision: 1, at: 1000, seq: 1 }];
    },
    ensureOwnerThread: function (request) {
      minted.push(request);
      return { ok: true, topicRef: { topicId: "owner-deadbeef" } };
    },
    createProjectExecution: function (input) { delivered = input; return { ok: true }; },
  });
  coordinate({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-lead-project-policy-eligibility",
    bindingRevision: 1,
    idempotencyKey: "eligibility-r1",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
  });
  assert.equal(delivered.coopApprovalIngressId, "coop:canonical-coop:455");
  assert.equal(minted.length, 1);
  assert.deepEqual(delivered.coopTopicRef, { topicId: "owner-deadbeef" });
});

// Narrowing the scan unshadowed the minting route for approved backlog work, but
// left one shape with authority and no container: an implementation command typed
// straight into Main. Its own turn has no TopicRef and a first dispatch has no
// durable scope to borrow one from, so it routed the ingress alone and the gate
// answered thread_ref_required forever -- the owner's most direct instruction was
// the one shape that could not be staffed, and retrying never helped.
function unscopedMainCoordinator(command, overrides) {
  var source = { localId: 1, storageId: "canonical-coop", history: [command] };
  var state = { minted: [], delivered: null, history: source.history };
  var options = {
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: { get: function () { return null; }, forTopic: function () { return []; } },
    readLeadEvents: function () { return []; },
    ensureOwnerThread: function (request) {
      state.minted.push(request);
      // Deterministic by (ingressId, projectRef), as coop-owner-thread is.
      return { ok: true, created: true,
        topicRef: { topicId: "owner-" + request.ingressId },
        threadRef: { threadId: "owner-" + request.ingressId } };
    },
    createProjectExecution: function (input) { state.delivered = input; return { ok: true }; },
  };
  Object.keys(overrides || {}).forEach(function (key) { options[key] = overrides[key]; });
  state.coordinate = createExternalTaskCoordinator(options);
  return state;
}

function unscopedMainCommand(text) {
  return {
    type: "user_message",
    text: text,
    coopIngressId: "coop:canonical-coop:612",
    coopComposerScope: "main",
    _ts: 2000,
  };
}

function unscopedMainInput(overrides) {
  var input = {
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-threadref-minting-fix",
    bindingRevision: 1,
    idempotencyKey: "threadref-r1",
    mode: "project_coordinator",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
  };
  Object.keys(overrides || {}).forEach(function (key) { input[key] = overrides[key]; });
  return input;
}

test("an unscoped Main implementation command mints the Thread it needs", function () {
  var harness = unscopedMainCoordinator(
    unscopedMainCommand("implement the ThreadRef minting fix in clay"));

  var result = harness.coordinate(unscopedMainInput());
  assert.equal(result.ok, true);

  // The Thread is bound to the owner's own turn and reaches the gate as a
  // TopicRef, which is what thread_ref_required was blocking on.
  assert.equal(harness.minted.length, 1);
  assert.equal(harness.minted[0].ingressId, "coop:canonical-coop:612");
  assert.equal(harness.minted[0].projectRef.projectId,
    "5332aafc-31e7-5cb1-ba96-c8d90e78260e");
  assert.equal(harness.delivered.coopIngressId, "coop:canonical-coop:612");
  assert.deepEqual(harness.delivered.coopTopicRef,
    { topicId: "owner-coop:canonical-coop:612" });
});

test("a retried unscoped Main command reuses its Thread instead of minting a second", function () {
  var harness = unscopedMainCoordinator(
    unscopedMainCommand("implement the ThreadRef minting fix in clay"));

  var first = harness.coordinate(unscopedMainInput());
  var firstRef = harness.delivered.coopTopicRef;
  var second = harness.coordinate(unscopedMainInput({ idempotencyKey: "threadref-r1-retry" }));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  // Minting is keyed on the owner ingress, so a retry resolves the same container
  // rather than accumulating a Thread per attempt.
  assert.deepEqual(harness.delivered.coopTopicRef, firstRef);
  assert.equal(harness.minted.length, 2);
  assert.equal(harness.minted[0].ingressId, harness.minted[1].ingressId);
});

test("a minted Thread is carried by the durable scope once the owner types again", function () {
  // Minting and the unscoped-scan narrowing have to compose. Once the owner has
  // spoken again the command is no longer the latest turn, so it may only be
  // adopted through the durable owner-request scope that admission recorded --
  // and that scope already holds the minted Thread. So the same work keeps
  // resolving the same Thread without minting a second one, and without the fix
  // evaporating the moment the conversation moves on.
  var command = unscopedMainCommand("implement the ThreadRef minting fix in clay");
  var recorded = null;
  var harness = unscopedMainCoordinator(command, {
    ownerRequests: {
      get: function () { return recorded ? { implementationScope: recorded } : null; },
      forTopic: function () { return []; },
    },
  });

  harness.coordinate(unscopedMainInput());
  var firstRef = harness.delivered.coopTopicRef;
  assert.deepEqual(firstRef, { topicId: "owner-coop:canonical-coop:612" });

  // What implementationAdmission durably records on a successful dispatch.
  recorded = {
    projectRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    topicRef: firstRef,
    portfolioTaskId: "clay-threadref-minting-fix",
    bindingRevision: 1,
    idempotencyKey: "threadref-r1",
  };
  harness.history.push({
    type: "user_message",
    text: "thanks, that makes sense",
    coopIngressId: "coop:canonical-coop:613",
    coopComposerScope: "main",
    _ts: 3000,
  });
  harness.coordinate(unscopedMainInput({ idempotencyKey: "threadref-r1-later" }));

  assert.deepEqual(harness.delivered.coopTopicRef, firstRef);
  assert.equal(harness.delivered.coopIngressId, "coop:canonical-coop:612",
    "the command's own ingress still carries the work, not the chatter's");
  assert.equal(harness.minted.length, 1,
    "the recorded scope supplies the Thread, so nothing is minted a second time");
});

test("an unscoped Main turn carrying no implementation decision mints nothing", function () {
  // Minting is not a courtesy extended to every Main turn. A question authorizes
  // nothing, so it gets no Thread and stays undispatchable.
  var harness = unscopedMainCoordinator(unscopedMainCommand("what is blocking the dispatch?"));

  harness.coordinate(unscopedMainInput());

  assert.equal(harness.minted.length, 0);
  assert.equal(harness.delivered.coopTopicRef, undefined);
});

test("an unscoped Main command still routes when no Thread can be minted", function () {
  // ensureOwnerThread refuses a Lead-targeted, closed or conflicting request.
  // That must leave the route intact and let the gate report the missing Thread,
  // never fabricate a TopicRef.
  var harness = unscopedMainCoordinator(
    unscopedMainCommand("implement the ThreadRef minting fix in clay"),
    { ensureOwnerThread: function () { return { ok: false, code: "owner_thread_closed" }; } });

  harness.coordinate(unscopedMainInput());

  assert.equal(harness.delivered.coopIngressId, "coop:canonical-coop:612");
  assert.ok(!harness.delivered.coopTopicRef, "a refused mint must never fabricate a TopicRef");
  // And the reason travels to the gate rather than being swallowed, so the
  // blocker reads as "the Thread cannot be created, and here is why" instead of
  // the generic "a Thread is required".
  assert.equal(harness.delivered.coopThreadMintRefusal, "owner_thread_closed");
});
