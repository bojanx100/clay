var test = require("node:test");
var assert = require("node:assert/strict");
var connection = require("../lib/project-connection");

test("initial connection orchestration fields are complete before later broadcasts", function () {
  var session = {
    coordinationMode: true,
    coordinationRole: "task_coordinator",
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
    orchestrationPolicy: { portfolioExecution: { status: "needs_input" } },
  };

  assert.deepEqual(connection.orchestrationSessionFields(session), {
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopExecutionStatus: "needs_input",
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
    coordinationRole: null,
    coopExecutionStatus: null,
    demotionPending: false,
    orchestrationActiveCount: 0,
    orchestrationPhase: "complete",
    orchestrationUnresolvedCount: 0,
    orchestrationParent: null,
    orchestrationGroupParent: null,
    orchestrationAdoption: null,
  });
});

test("direct-leaf binding internals are not copied into project connection state", function () {
  var fields = connection.orchestrationSessionFields({
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "portfolio-private",
        bindingRevision: 1,
        idempotencyKey: "private-command-key",
        mode: "direct_leaf",
        status: "running",
      },
    },
  });

  assert.equal(fields.coordinationMode, false);
  assert.equal(fields.coopExecutionStatus, "running");
  assert.equal(fields.orchestrationParent, null);
  assert.equal(JSON.stringify(fields).includes("private-command-key"), false);
  assert.equal(JSON.stringify(fields).includes("portfolio-private"), false);
});
