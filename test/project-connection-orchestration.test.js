var test = require("node:test");
var assert = require("node:assert/strict");
var connection = require("../lib/project-connection");

test("initial connection orchestration fields are complete before later broadcasts", function () {
  var session = {
    coordinationMode: true,
    demoteCoordinatorWhenIdle: true,
    orchestrationTasks: [
      { taskId: "queued", status: "queued" },
      { taskId: "running", status: "running" },
      { taskId: "done", status: "completed" },
    ],
    orchestrationParent: {
      taskId: "owner-task",
      sessionId: 42,
      sessionStorageId: "coordinator-storage",
      workerColor: "#A78BFA",
    },
    orchestrationAdoption: { adoptedAt: 123 },
  };

  assert.deepEqual(connection.orchestrationSessionFields(session), {
    coordinationMode: true,
    demotionPending: true,
    orchestrationActiveCount: 2,
    orchestrationPhase: "executing",
    orchestrationUnresolvedCount: 2,
    orchestrationParent: {
      taskId: "owner-task",
      sessionId: 42,
      workerColor: "#A78BFA",
    },
    orchestrationGroupParent: null,
    orchestrationAdoption: { adoptedAt: 123 },
  });
});

test("initial connection orchestration fields default without waiting for hydration", function () {
  assert.deepEqual(connection.orchestrationSessionFields({}), {
    coordinationMode: false,
    demotionPending: false,
    orchestrationActiveCount: 0,
    orchestrationPhase: "complete",
    orchestrationUnresolvedCount: 0,
    orchestrationParent: null,
    orchestrationGroupParent: null,
    orchestrationAdoption: null,
  });
});
