var test = require("node:test");
var assert = require("node:assert/strict");
var harness = require("./helpers/coop-project-intake-fixture");
var plane = require("../lib/coop-control-plane");

test("resolving an unrelated report lets its blocked assignment receive its first coordinator notification", async function (t) {
  var f = harness.fixture(t);
  var input = f.ownerRequest();
  var root = plane.ensureProjectCoordinator(f.lead, { projectId: harness.PROJECT }, "Target", input.source);
  root.queryInstance = { pushMessage: function () { throw new Error("Ambiguous report submission"); } };
  assert.equal(f.leadApi.deliverCoordinatorUpdate(root.storageId, "Earlier project report"), true);
  assert.equal(root.pendingCoordinatorUpdates[0].state, "uncertain");
  var queued = f.router.createProjectExecution(input);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  var task = root.orchestrationTasks.find(function (entry) { return entry.taskId === queued.taskRef.taskId; });
  assert.equal(task.projectAssignment.reason, "coordinator_report_delivery_attention");
  assert.equal(f.notifications.length, 0);
  root.queryInstance = null;
  var ids = root.pendingCoordinatorUpdates.map(function (entry) { return entry.updateId; });
  assert.equal(f.leadApi.resolveCoordinatorUpdates(root, { action: "acknowledge", updateIds: ids }), true);
  f.router.retryProjectAssignments();
  assert.equal(f.notifications.length, 1);
  assert.equal(task.projectAssignment.phase, "pending");
  assert.equal(task.status, "queued");
  assert.equal((await f.accept(queued.taskRef)).ok, true);
  assert.equal(f.starts.length, 1);
});

test("clearing report delivery does not erase a later independent coordinator question", function (t) {
  var f = harness.fixture(t);
  var input = f.ownerRequest();
  var root = plane.ensureProjectCoordinator(f.lead, { projectId: harness.PROJECT }, "Target", input.source);
  root.queryInstance = { pushMessage: function () { throw new Error("Ambiguous report submission"); } };
  f.leadApi.deliverCoordinatorUpdate(root.storageId, "Earlier project report");
  var queued = f.router.createProjectExecution(input);
  var task = root.orchestrationTasks.find(function (entry) { return entry.taskId === queued.taskRef.taskId; });
  var question = f.leadApi.requestInputFromTool({ coordinatorSessionId: root.storageId, taskIds: [task.taskId],
    question: "Which business rule should apply?", reason: "Owner expertise required" });
  assert.notEqual(question.isError, true, JSON.stringify(question));
  var status = task.status;
  root.queryInstance = null;
  f.leadApi.resolveCoordinatorUpdates(root, { action: "acknowledge",
    updateIds: root.pendingCoordinatorUpdates.map(function (entry) { return entry.updateId; }) });
  f.router.retryProjectAssignments();
  assert.equal(f.notifications.length, 0);
  assert.equal(task.status, status);
  assert.match(task.userQuestion, /business rule/);
});
