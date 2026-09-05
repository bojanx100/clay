var test = require("node:test");
var assert = require("node:assert/strict");
var fixture = require("./helpers/coop-project-intake-fixture").fixture;

test("owner task close durably cancels a pending assignment, even with Lead OFF", function (t) {
  var f = fixture(t, { notificationFailure: true });
  var input = f.ownerRequest();
  var queued = f.router.createProjectExecution(input);
  assert.equal(queued.ok, true);
  f.mode = false;
  assert.equal(f.leadApi.closeTask(f.root(), queued.taskRef.taskId, null, "Owner withdrew this task"), true);
  f.reopen();
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.phase, "cancelled");
  f.mode = true;
  f.now += 60001;
  f.router.retryProjectAssignments();
  assert.equal(f.router.createProjectExecution(input).reason, "assignment_closed");
  assert.equal(f.notifications.length, 1);
  assert.equal(f.starts.length, 0);
});

test("coordinator dismissal uses the same pending-assignment closure path", function (t) {
  var f = fixture(t, { notificationFailure: true });
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var response = f.leadApi.dismissFromTool({ coordinatorSessionId: String(f.root().localId),
    taskId: queued.taskRef.taskId, reason: "Scope withdrawn" });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.phase, "cancelled");
});

test("failed cancellation save refuses success and leaves the assignment pending", function (t) {
  var f = fixture(t, { notificationFailure: true });
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var save = f.lead.saveSessionFile;
  f.lead.saveSessionFile = function (session, options) {
    if (session.orchestrationTasks && session.orchestrationTasks.some(function (task) {
      return task.projectAssignment && task.projectAssignment.phase === "cancelled";
    })) return false;
    return save(session, options);
  };
  assert.equal(f.leadApi.closeTask(f.root(), queued.taskRef.taskId), false);
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.phase, "pending");
  assert.equal(f.root().orchestrationTasks[0].archivedAt, undefined);
});

test("acceptance retries a failed target creation without replacing its assignment", async function (t) {
  var f = fixture(t);
  var input = f.ownerRequest();
  var queued = f.router.createProjectExecution(input);
  await f.query();
  f.targetFailure = true;
  var failed = await f.accept(queued.taskRef);
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(f.root().orchestrationTasks.length, 1);
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.phase, "pending");
  f.targetFailure = false;
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(f.starts.length, 1);
  assert.equal(f.root().orchestrationTasks.length, 1);
});

test("a failed acceptance receipt reconciles its committed execution after restart", async function (t) {
  var f = fixture(t);
  var input = f.ownerRequest();
  var queued = f.router.createProjectExecution(input);
  var save = f.lead.saveSessionFile;
  f.lead.saveSessionFile = function (session, options) {
    if (session.orchestrationTasks && session.orchestrationTasks.some(function (task) {
      return task.projectAssignment && task.projectAssignment.phase === "accepted";
    })) return false;
    return save(session, options);
  };
  assert.equal((await f.accept(queued.taskRef)).reason, "assignment_persistence_failed");
  var binding = f.router.getExecutionBinding(input.portfolioTaskId, 1);
  assert.ok(binding.coordinator);
  assert.equal(f.starts.length, 1);
  var priorQuery = await f.query();
  priorQuery.handle.close();
  f.lead.saveSessionFile = save;
  await new Promise(function (resolve) { setImmediate(resolve); });
  f.reopen();
  f.now += 60001;
  f.router.retryProjectAssignments();
  var accepted = f.router.acceptProjectAssignment(f.root(), f.lead, { taskRef: queued.taskRef });
  assert.equal(accepted.phase, "execution_recorded", JSON.stringify(accepted));
  assert.deepEqual(accepted.sessionRef, binding.coordinator);
  assert.equal(f.starts.length, 1);
});

test("bounded notification failures become retryable Coop attention with one envelope", function (t) {
  var f = fixture(t, { notificationFailure: true });
  var queued = f.router.createProjectExecution(f.ownerRequest());
  f.attentionFailure = true;
  for (var i = 0; i < 3; i++) { f.now += 60001; f.router.retryProjectAssignments(); }
  var record = f.root().orchestrationTasks[0].projectAssignment;
  assert.equal(record.phase, "attention");
  assert.equal(f.notifications.length, 3);
  assert.equal(f.attentionDeliveries.length, 1);
  var envelope = record.attentionEnvelope;
  assert.ok(envelope);
  f.reopen();
  f.attentionFailure = false;
  f.now += 60001;
  f.router.retryProjectAssignments();
  assert.deepEqual(f.attentionDeliveries[1], envelope);
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.attentionReported, true);
  assert.equal(f.notifications.length, 3);
  assert.equal(f.starts.length, 0);
  assert.equal(f.root().orchestrationTasks[0].taskId, queued.taskRef.taskId);
});

test("failed assignment acknowledgement cannot orphan an allocated attention sequence", function (t) {
  var f = fixture(t, { notificationFailure: true });
  f.router.createProjectExecution(f.ownerRequest());
  var save = f.lead.saveSessionFile;
  f.lead.saveSessionFile = function (session, options) {
    if (session.orchestrationTasks && session.orchestrationTasks.some(function (task) {
      return task.projectAssignment && task.projectAssignment.attentionEnvelope;
    })) return false;
    return save(session, options);
  };
  for (var i = 0; i < 3; i++) { f.now += 60001; f.router.retryProjectAssignments(); }
  var pending = f.router.getPendingEventIds();
  assert.equal(pending.length, 1);
  var envelope = f.router.getDeliveryState().outbox[pending[0]].envelope;
  f.lead.saveSessionFile = save;
  f.reopen();
  f.now += 60001;
  f.router.retryProjectAssignments();
  assert.deepEqual(f.attentionDeliveries[0], envelope);
  assert.equal(f.router.getPendingEventIds().length, 0);
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.attentionEnvelope.sourceSeq, 1);
});

test("an unrouted assignment can be dismissed when the actual project has no execution", async function (t) {
  var f = fixture(t);
  var input = f.ownerRequest();
  var queued = f.router.createProjectExecution(input);
  f.targetFailure = true;
  assert.equal((await f.accept(queued.taskRef)).ok, false);
  assert.equal(f.router.getExecutionBinding(input.portfolioTaskId, 1).status, "unrouted");
  assert.equal(f.leadApi.closeTask(f.root(), queued.taskRef.taskId), true);
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.phase, "cancelled");
});

test("a partially linked target must be reconciled before a pending assignment can be dismissed", async function (t) {
  var f = fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var save = f.lead.saveSessionFile;
  f.lead.saveSessionFile = function (session, options) {
    if (session.orchestrationTasks && session.orchestrationTasks.some(function (task) { return task.workerSessionRef; })) return false;
    return save(session, options);
  };
  var failed = await f.accept(queued.taskRef);
  assert.equal(failed.reason, "control_plane_task_link_failed", JSON.stringify(failed));
  assert.equal(f.starts.length, 1);
  f.lead.saveSessionFile = save;
  assert.equal(f.leadApi.closeTask(f.root(), queued.taskRef.taskId), false);
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.phase, "pending");
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(f.starts.length, 1);
  assert.equal(f.leadApi.closeTask(f.root(), queued.taskRef.taskId), true);
});

test("a failed Thread link cannot notify or accept work until the real link is saved", async function (t) {
  var f = fixture(t, { notificationFailure: true });
  f.threadFailure = true;
  var input = f.ownerRequest();
  assert.equal(f.router.createProjectExecution(input).reason, "thread_handoff_link_failed");
  f.now += 60001;
  f.router.retryProjectAssignments();
  var taskRef = f.root().orchestrationTasks[0].projectAssignment.taskRef;
  assert.equal(f.router.acceptProjectAssignment(f.root(), f.lead, { taskRef: taskRef }).reason, "thread_handoff_link_failed");
  assert.equal(f.notifications.length, 0);
  assert.equal(f.starts.length, 0);
  f.threadFailure = false;
  f.notificationFailure = false;
  f.router.retryProjectAssignments();
  assert.equal((await f.accept(taskRef)).ok, true);
});
