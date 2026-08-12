var test = require("node:test");
var assert = require("node:assert");

var externalOrchestration = require("../lib/project-task-orchestrator-external");
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
  attachPortfolioExecutionTarget({
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
  attachPortfolioExecutionTarget({
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
