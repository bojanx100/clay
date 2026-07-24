var test = require("node:test");
var assert = require("node:assert/strict");
var orchestrationTasksForClient = require("../lib/orchestration-task-state").orchestrationTasksForClient;

test("task projection exposes stable orchestration identity separately from worker identity", function () {
  var result = orchestrationTasksForClient({
    orchestrationTasks: [{
      taskId: "task-stable",
      title: "Review reconnect logic",
      objective: "Fix reconnect",
      acceptanceCriteria: "One reconnect",
      ownedPaths: "lib/reconnect.js",
      resultSummary: "",
      status: "running",
      workerSessionId: 42,
      provider: "codex",
      model: "gpt-test",
      createdAt: 100,
      updatedAt: 200,
      internalOnly: "not exposed",
    }],
  });

  assert.deepEqual(result, [{
    taskId: "task-stable",
    title: "Review reconnect logic",
    objective: "Fix reconnect",
    acceptanceCriteria: "One reconnect",
    ownedPaths: "lib/reconnect.js",
    resultSummary: "",
    status: "running",
    workerSessionId: 42,
    provider: "codex",
    model: "gpt-test",
    createdAt: 100,
    updatedAt: 200,
  }]);
});
