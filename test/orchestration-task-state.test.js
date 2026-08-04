var test = require("node:test");
var assert = require("node:assert/strict");
var buildOrchestrationSessionGroups =
  require("../lib/orchestration-task-state").buildOrchestrationSessionGroups;
var orchestrationGroupParentForClient =
  require("../lib/orchestration-task-state").orchestrationGroupParentForClient;
var orchestrationTasksForClient = require("../lib/orchestration-task-state").orchestrationTasksForClient;
var orchestrationParentForClient =
  require("../lib/orchestration-task-state").orchestrationParentForClient;
var restoreVerifiedWorkerCompletion =
  require("../lib/orchestration-task-state").restoreVerifiedWorkerCompletion;
var workerPrompt = require("../lib/orchestration-task-state").workerPrompt;
var workerResultText = require("../lib/orchestration-task-state").workerResultText;
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
      workerColor: null,
      parentTaskId: null,
    dependencies: [],
    provider: "codex",
    model: "gpt-test",
    providerRouteId: null,
    routingTier: null,
    routingRationale: "",
    currentActivity: "",
    verification: "",
    resolutionReason: "",
    resolutionSummary: "",
    resolvedAt: null,
    userQuestion: "",
    waitingReason: "",
    userAnsweredAt: null,
    progress: null,
    attempt: 0,
    maxAttempts: 1,
    createdAt: 100,
    updatedAt: 200,
  }]);
});

test("retry attempts retain coordinator grouping with distinct attempt numbers", function () {
  var taskId = "task-review";
  var coordinator = {
    localId: 10,
    orchestrationTasks: [{ taskId: taskId, workerColor: "#F0B35A" }],
  };
  var firstAttempt = {
    localId: 11,
    createdAt: 100,
    history: [{
      type: "user_message",
      orchestrationTaskId: taskId,
      origin: { kind: "coordinator" },
    }],
  };
  var secondAttempt = {
    localId: 12,
    createdAt: 200,
    history: [{
      type: "user_message",
      orchestrationTaskId: taskId,
      origin: { kind: "coordinator" },
    }],
  };
  var currentAttempt = {
    localId: 13,
    createdAt: 300,
    orchestrationParent: { taskId: taskId, sessionId: 10, workerColor: "#F0B35A" },
    history: [],
  };
  var groups = buildOrchestrationSessionGroups([
    secondAttempt,
    coordinator,
    currentAttempt,
    firstAttempt,
  ]);

  assert.equal(orchestrationParentForClient(firstAttempt), null);
  assert.deepEqual(orchestrationGroupParentForClient(firstAttempt, groups), {
    taskId: taskId,
    sessionId: 10,
    workerColor: "#F0B35A",
    taskStatus: null,
    attempt: 1,
    attemptCount: 3,
    historical: true,
  });
  assert.equal(orchestrationParentForClient(secondAttempt), null);
  assert.deepEqual(orchestrationGroupParentForClient(secondAttempt, groups), {
    taskId: taskId,
    sessionId: 10,
    workerColor: "#F0B35A",
    taskStatus: null,
    attempt: 2,
    attemptCount: 3,
    historical: true,
  });
  assert.deepEqual(orchestrationParentForClient(currentAttempt), {
    taskId: taskId,
    sessionId: 10,
    workerColor: "#F0B35A",
  });
  assert.deepEqual(orchestrationGroupParentForClient(currentAttempt, groups), {
    taskId: taskId,
    sessionId: 10,
    workerColor: "#F0B35A",
    taskStatus: null,
    attempt: 3,
    attemptCount: 3,
    historical: false,
  });
});

test("worker grouping projects the coordinator task status for sidebar parity", function () {
  var coordinator = {
    localId: 20,
    orchestrationTasks: [{
      taskId: "task-complete",
      status: "completed",
      workerColor: "#36C6A7",
    }],
  };
  var worker = {
    localId: 21,
    orchestrationParent: {
      taskId: "task-complete",
      sessionId: 20,
      workerColor: "#36C6A7",
    },
  };

  var groups = buildOrchestrationSessionGroups([coordinator, worker]);

  assert.equal(groups[21].taskStatus, "completed");
});

test("worker completion requires an explicit verified completion report", function () {
  assert.equal(workerStatusFromResult([
    "WORKER_STATUS: completed",
    "SUMMARY: Fixed the sidebar status.",
    "VERIFICATION: node --test test/orchestration-task-state.test.js passed",
    "ESCALATION_REQUIRED: no",
  ].join("\n")), "completed");
});

test("worker result preserves text block boundaries around tool calls", function () {
  var result = workerResultText({
    history: [
      { type: "user_message", text: "Finish the task." },
      { type: "delta", text: "I am confirming the branch before handoff." },
      { type: "tool_start", id: "tool-1", name: "Bash" },
      { type: "tool_result", id: "tool-1", content: "clean" },
      { type: "delta", text: "WORKER_STATUS: completed\n" },
      { type: "delta", text: "SUMMARY: The fix is pushed.\n" },
      { type: "delta", text: "VERIFICATION: focused tests and build passed\n" },
      { type: "delta", text: "ESCALATION_REQUIRED: no" },
      { type: "done", code: 0 },
    ],
  });

  assert.equal(result, [
    "I am confirming the branch before handoff.",
    "WORKER_STATUS: completed",
    "SUMMARY: The fix is pushed.",
    "VERIFICATION: focused tests and build passed",
    "ESCALATION_REQUIRED: no",
  ].join("\n"));
  assert.equal(workerStatusFromResult(result), "completed");
});

test("restore repair leaves unverified needs-input results unchanged", function () {
  var task = { taskId: "task-1", status: "needs_input" };
  var worker = {
    history: [
      { type: "user_message", text: "Finish the task." },
      { type: "delta", text: "WORKER_STATUS: completed\n" },
      { type: "delta", text: "SUMMARY: The change is drafted.\n" },
      { type: "delta", text: "VERIFICATION: not tested\n" },
      { type: "delta", text: "ESCALATION_REQUIRED: no" },
      { type: "done", code: 0 },
    ],
  };
  var updates = [];

  var restored = restoreVerifiedWorkerCompletion({}, task, worker, function (parent, taskId, next) {
    updates.push({ parent: parent, taskId: taskId, next: next });
  });

  assert.equal(restored, false);
  assert.deepEqual(updates, []);
  assert.equal(task.status, "needs_input");
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
