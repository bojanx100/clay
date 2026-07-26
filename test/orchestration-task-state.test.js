var test = require("node:test");
var assert = require("node:assert/strict");
var orchestrationTasksForClient = require("../lib/orchestration-task-state").orchestrationTasksForClient;
var workerPrompt = require("../lib/orchestration-task-state").workerPrompt;
var workerStatusFromResult = require("../lib/orchestration-task-state").workerStatusFromResult;

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
      providerRouteId: null,
      routingTier: null,
      routingRationale: "",
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
    parentTaskId: null,
    dependencies: [],
    provider: "codex",
    model: "gpt-test",
    providerRouteId: null,
    routingTier: null,
    routingRationale: "",
    currentActivity: "",
    verification: "",
    progress: null,
    attempt: 0,
    maxAttempts: 1,
    createdAt: 100,
    updatedAt: 200,
  }]);
});

test("worker completion requires an explicit verified completion report", function () {
  assert.equal(workerStatusFromResult([
    "WORKER_STATUS: completed",
    "SUMMARY: Fixed the sidebar status.",
    "VERIFICATION: node --test test/orchestration-task-state.test.js passed",
    "ESCALATION_REQUIRED: no",
  ].join("\n")), "completed");
});

test("ordinary worker replies and plans require coordinator attention", function () {
  assert.equal(workerStatusFromResult("That is a great plan."), "needs_input");
  assert.equal(workerStatusFromResult("I will inspect the implementation next."), "needs_input");
  assert.equal(workerStatusFromResult(""), "needs_input");
});

test("incomplete or unverifiable completed reports do not become green", function () {
  assert.equal(workerStatusFromResult("WORKER_STATUS: completed\nSUMMARY: Done."), "needs_input");
  assert.equal(workerStatusFromResult([
    "WORKER_STATUS: completed",
    "SUMMARY: Implemented the change.",
    "VERIFICATION: not tested",
  ].join("\n")), "needs_input");
  assert.equal(workerStatusFromResult([
    "WORKER_STATUS: completed",
    "SUMMARY: Implemented the change.",
    "VERIFICATION: tests pass",
    "ESCALATION_REQUIRED: yes",
  ].join("\n")), "needs_input");
  assert.equal(workerStatusFromResult([
    "WORKER_STATUS: completed",
    "SUMMARY: Implemented the change.",
    "VERIFICATION: tests pass",
  ].join("\n")), "needs_input");
  assert.equal(workerStatusFromResult([
    "Do not claim WORKER_STATUS: completed before testing.",
    "I am still working.",
  ].join("\n")), "needs_input");
});

test("explicit non-completion statuses remain non-complete", function () {
  assert.equal(workerStatusFromResult("WORKER_STATUS: needs_input\nSUMMARY: Need a choice."), "needs_input");
  assert.equal(workerStatusFromResult("WORKER_STATUS: blocked\nSUMMARY: Dependency missing."), "needs_input");
  assert.equal(workerStatusFromResult("WORKER_STATUS: failed\nSUMMARY: Tests failed."), "failed");
});

test("worker prompt defines green as finished and verifiable", function () {
  var prompt = workerPrompt({ localId: 7 }, {
    title: "Fix status",
    objective: "Prevent false completion",
    context: "Workers can stop without finishing",
    acceptanceCriteria: "Only verified work completes",
    ownedPaths: "lib/orchestration-task-state.js",
  }, "task-7");

  assert.match(prompt, /Use completed only when the requested result is finished/);
  assert.match(prompt, /unstructured or unverifiable report will be treated as/);
});
