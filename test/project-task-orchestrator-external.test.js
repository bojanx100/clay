var test = require("node:test");
var assert = require("node:assert");

var createExternalTaskCoordinator =
  require("../lib/project-task-orchestrator-external").createExternalTaskCoordinator;

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
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(saves, 1);
  assert.strictEqual(coordinator.orchestrationTasks.length, 1);
  assert.strictEqual(coordinator.orchestrationTasks[0].context,
    "Framer page: Checkout. Selection: PaymentForm/Error.");
  assert.strictEqual(coordinator.orchestrationTasks[0].clientRef, "framer-42");
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
