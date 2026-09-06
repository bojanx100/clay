var test = require("node:test");
var assert = require("node:assert/strict");
var build = require("../lib/coop-coordinator-work-context").buildWorkContext;

function context(status) {
  var project = { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" };
  var root = { storageId: "resident", orchestrationTasks: [{ taskId: "restore-launch", status: status,
    workerSessionRef: { projectId: project.projectId, sessionStorageId: "worker" },
    resultSummary: "Observed automatic launch through the normal scheduler.",
    verification: "Verified the actual execution receipt.", resolvedAt: status === "completed" ? 321 : null,
    resolvedByCoordinator: status === "completed" }] };
  var worker = { storageId: "worker", lastActivity: 123, isProcessing: false,
    projectCoordinatorRef: { projectId: "system-lead", sessionStorageId: "resident" },
    orchestrationPolicy: { portfolioExecution: { status: "failed", reason: "activation_pending" } },
    contextRecovery: { status: "blocked", reason: "recovery_exhausted", attempts: 1 } };
  var unrelated = { storageId: "another-worker", lastActivity: 999, isProcessing: true };
  return build(root, [{ getSessionManager: function () {
    return { sessions: new Map([[1, unrelated], [2, worker]]) };
  } }], project);
}

test("coordinator context exposes the actual worker blocker and last activity after reload", function () {
  var result = context("failed");
  assert.equal(result.ok, true);
  var worker = result.assignments[0].worker;
  assert.equal(worker.processing, false);
  assert.equal(worker.lastActivity, 123);
  assert.equal(worker.executionStatus, "failed");
  assert.equal(worker.executionReason, "activation_pending");
  assert.deepEqual(worker.contextRecovery, { status: "blocked", reason: "recovery_exhausted", attempts: 1 });
});

test("completed task verification survives into the resident's next conversation", function () {
  var result = context("completed");
  assert.equal(result.assignments.length, 0);
  var outcome = result.recentOutcomes[0];
  assert.equal(outcome.resultSummary, "Observed automatic launch through the normal scheduler.");
  assert.equal(outcome.verification, "Verified the actual execution receipt.");
  assert.equal(outcome.resolvedAt, 321);
  assert.equal(outcome.resolvedByCoordinator, true);
});
