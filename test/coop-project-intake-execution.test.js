var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var fixture = require("./helpers/coop-project-intake-fixture").fixture;
var plane = require("../lib/coop-control-plane");

test("owner admission queues a durable assignment; the real session tool starts project execution", async function (t) {
  var f = fixture(t);
  var input = f.ownerRequest();
  var queued = f.router.createProjectExecution(input);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.phase, "assignment_queued");
  assert.equal(queued.sessionRef, null);
  assert.equal(f.starts.length, 0);
  assert.equal(f.router.getExecutionBindings().length, 0);
  assert.equal(f.ledger.get(input.coopIngressId).response.state, "unanswered");
  assert.deepEqual(f.links[0].taskRef, queued.taskRef);
  var query = await f.query();
  assert.match(query.messages[0], /Preserve ordinary project behavior/);
  assert.match(query.messages[0], /accept_project_assignment/);
  assert.deepEqual(query.options.toolServerDescriptors[0].sessionScoped, true);
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.phase, "execution_dispatched");
  assert.equal(accepted.sessionRef.projectId, input.targetProject.projectId);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].session.coordinationRole, "task_coordinator");
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.phase, "accepted");
  assert.equal(f.root().orchestrationTasks[0].workerStorageId, accepted.sessionStorageId);
  var replay = await f.accept(queued.taskRef);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.sessionStorageId, accepted.sessionStorageId);
  assert.equal(f.starts.length, 1);
  assert.equal(f.ledger.get(input.coopIngressId).response.state, "unanswered");
});

test("pending assignments survive the actual session save/load path and acceptance uses the stored scope", async function (t) {
  var f = fixture(t, { notificationFailure: true });
  var input = f.ownerRequest();
  var queued = f.router.createProjectExecution(input);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  var prior = f.root();
  input.objective = "A later mutable caller object must not change the admitted task";
  f.reopen();
  assert.notEqual(f.root(), prior);
  assert.equal(f.root().storageId, queued.taskRef.coordinatorSessionStorageId);
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.payload.objective, "Implement the approved project change.");
  f.notificationFailure = false;
  f.now += 60001;
  f.router.retryProjectAssignments();
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(f.starts.length, 1);
  assert.match(f.starts[0].text, /Implement the approved project change/);
  assert.doesNotMatch(f.starts[0].text, /later mutable caller/);
});

test("failed durable commissioning leaves no acknowledged task and retry keeps a single assignment", function (t) {
  var f = fixture(t, { notificationFailure: true });
  var input = f.ownerRequest();
  plane.ensureProjectCoordinator(f.lead, input.targetProject, "Target", input.source);
  var save = f.lead.saveSessionFile;
  f.lead.saveSessionFile = function (session, options) {
    if (session.orchestrationTasks && session.orchestrationTasks.some(function (task) { return task.projectAssignment; })) return false;
    return save(session, options);
  };
  assert.equal(f.router.createProjectExecution(input).reason, "assignment_persistence_failed");
  assert.equal(f.root().orchestrationTasks.length, 0);
  assert.equal(f.notifications.length, 0);
  f.lead.saveSessionFile = save;
  var queued = f.router.createProjectExecution(input);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(f.router.createProjectExecution(input).reused, true);
  assert.equal(f.root().orchestrationTasks.length, 1);
});

test("withdrawal, Lead OFF, and missing current project rules prevent acceptance", async function (t) {
  var f = fixture(t);
  var input = f.ownerRequest();
  var queued = f.router.createProjectExecution(input);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  await f.query();
  f.mode = false;
  assert.equal((await f.accept(queued.taskRef)).reason, "lead_mode_disabled");
  f.mode = true;
  fs.mkdirSync(path.join(f.targetDir, "localAIConfig"));
  assert.equal((await f.accept(queued.taskRef)).reason, "project_local_instructions_missing");
  fs.rmSync(path.join(f.targetDir, "localAIConfig"), { recursive: true });
  f.ledger.supersede(input.coopIngressId, "owner_withdrawal");
  assert.equal((await f.accept(queued.taskRef)).ok, false);
  assert.equal(f.starts.length, 0);
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.phase, "pending");
});

test("ordinary execution completion reaches its resident assignment and replay preserves the outcome", async function (t) {
  var f = fixture(t);
  var input = f.ownerRequest();
  var queued = f.router.createProjectExecution(input);
  assert.equal((await f.accept(queued.taskRef)).ok, true);
  var worker = f.starts[0].session;
  var result = { type: "delta", text: ["PROJECT_COMPLETED", "WORKER_STATUS: completed",
    "SUMMARY: Implemented the approved change.", "VERIFICATION: Focused checks passed.",
    "INTEGRATION_VERIFIED: yes", "ESCALATION_REQUIRED: no"].join("\n") };
  worker.history.push(result);
  f.target.appendToSessionFile(worker, result);
  worker.isProcessing = false;
  f.targetApi.handleCoordinatorTurnDone(worker);
  assert.equal(f.router.getExecutionBinding(input.portfolioTaskId, 1).status, "completed");
  assert.equal(f.root().orchestrationTasks[0].status, "completed");
  var replay = await f.accept(queued.taskRef);
  assert.equal(replay.phase, "execution_recorded", JSON.stringify(replay));
  assert.equal(f.root().orchestrationTasks[0].status, "completed");
  assert.equal(f.starts.length, 1);
  assert.equal(f.ledger.get(input.coopIngressId).response.state, "unanswered");
});
