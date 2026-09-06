var test = require("node:test");
var assert = require("node:assert/strict");
var harness = require("./helpers/coop-project-intake-fixture");
var mcp = require("../lib/coop-project-assignment-mcp");

test("acceptance refuses another project, coordinator, task, or replacement scope", async function (t) {
  var f = harness.fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var query = await f.query();
  var inputs = [
    { taskRef: Object.assign({}, queued.taskRef, { projectId: harness.PROJECT }) },
    { taskRef: Object.assign({}, queued.taskRef, { coordinatorSessionStorageId: f.coop.storageId }) },
    { taskRef: Object.assign({}, queued.taskRef, { taskId: "unknown-task" }) },
    { taskRef: queued.taskRef, objective: "Replace the approved scope" },
  ];
  for (var i = 0; i < inputs.length; i++) {
    var result = await query.options.callMcpTool(mcp.SERVER_NAME, "accept_project_assignment", inputs[i]);
    assert.equal(result.isError, true, JSON.stringify(result));
  }
  assert.equal(f.starts.length, 0);
  assert.equal(f.router.acceptProjectAssignment(Object.assign({}, f.root()), f.lead,
    { taskRef: queued.taskRef }).ok, false);
  assert.equal(f.router.acceptProjectAssignment(f.coop, f.lead, { taskRef: queued.taskRef }).ok, false);
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
});

test("anonymous discovery reserves the scoped server name without an executable handler", function () {
  var server = mcp.createAssignmentServer(null, null, null, null);
  assert.deepEqual(server, { name: mcp.SERVER_NAME, sessionScoped: true });
});

test("an aborted query cannot accept a pending assignment", async function (t) {
  var f = harness.fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  await f.query();
  f.root().abortController.abort();
  assert.equal((await f.accept(queued.taskRef)).ok, false);
  assert.equal(f.starts.length, 0);
});

test("a replaced provider query loses its acceptance capability", async function (t) {
  var f = harness.fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var old = await f.query();
  old.handle.close();
  await new Promise(function (resolve) { setImmediate(resolve); });
  await f.bridge.startQuery(f.root(), "Inspect the pending assignment again", null, null);
  var fresh = await f.query();
  assert.notEqual(fresh, old);
  var stale = await old.options.callMcpTool(mcp.SERVER_NAME, "accept_project_assignment", { taskRef: queued.taskRef });
  assert.equal(stale.isError, true, JSON.stringify(stale));
  assert.equal(f.starts.length, 0);
  f.root().isProcessing = true;
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
});

test("a changed durable payload fails integrity checks; presentation edits do not replace scope", async function (t) {
  var f = harness.fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var task = f.root().orchestrationTasks[0];
  var objective = task.projectAssignment.payload.objective;
  task.projectAssignment.payload.objective = "Unauthorized replacement";
  assert.equal((await f.accept(queued.taskRef)).reason, "assignment_integrity_failed");
  task.projectAssignment.payload.objective = objective;
  task.objective = "Editable task presentation";
  assert.equal((await f.accept(queued.taskRef)).reason, "coordinator_context_refresh_required",
    "the provider first received an invalid assignment snapshot");
  assert.equal(f.bridge.pushMessage(f.root(), "Re-read the restored durable assignment", null), true);
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.match(f.starts[0].text, /Implement the approved project change/);
  assert.doesNotMatch(f.starts[0].text, /Editable task presentation/);
});

test("a later owner turn does not invalidate an already scoped pending assignment", async function (t) {
  var f = harness.fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  f.ownerRequest("Build an unrelated follow-up", "later");
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(f.starts.length, 1);
});

test("real task dependencies block acceptance before any target execution is created", async function (t) {
  var f = harness.fixture(t);
  var first = f.router.createProjectExecution(f.ownerRequest());
  var input = f.ownerRequest("Build the dependent change", "dependent");
  input.dependencies = [first.taskRef.taskId];
  var second = f.router.createProjectExecution(input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal((await f.accept(second.taskRef)).reason, "assignment_dependencies_unresolved");
  assert.equal(f.notifications.length, 1);
  assert.equal(f.starts.length, 0);
});

test("a provider-start failure preserves the assignment for bounded recovery", async function (t) {
  var f = harness.fixture(t);
  f.providerFailure = true;
  var queued = f.router.createProjectExecution(f.ownerRequest());
  assert.equal(queued.ok, true, JSON.stringify(queued));
  await harness.waitFor(function () { return !f.root().isProcessing; });
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.phase, "pending");
  assert.equal(f.starts.length, 0);
  f.providerFailure = false;
  f.now += 60001;
  f.router.retryProjectAssignments();
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(f.starts.length, 1);
});

test("a named implementation grant is preserved and rechecked against the actual current plan", async function (t) {
  var f = harness.fixture(t);
  var input = f.ownerRequest();
  var workstream = { workstreamId: "intake-plan", topicRef: input.coopTopicRef,
    targetProject: input.targetProject, portfolioTaskId: input.portfolioTaskId };
  var digest = require("crypto").createHash("sha256").update("approved scope").digest("hex");
  function record(id, type, actor, fields) {
    var result = f.governance.record(Object.assign({ recordId: id, type: type, actor: actor,
      workstream: workstream }, fields));
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  record("workstream", "workstream", "coop", {});
  record("evidence", "stage_run", "triage", { stageRun: {
    stageRunId: "evidence", stage: "evidence_review", evidenceDigest: "evidence" } });
  record("plan", "plan_revision", "coop", { planRevision: {
    planRevision: 1, planDigest: digest, scopeDigest: "scope" } });
  record("decision", "owner_decision", "owner", { ownerDecision: {
    planRevision: 1, planDigest: digest, decision: "approved", ownerIngressId: input.coopIngressId } });
  record("grant", "implementation_grant", "coop", { implementationGrant: {
    grantId: "grant", planRevision: 1, planDigest: digest, portfolioTaskId: input.portfolioTaskId,
    bindingRevision: 1, idempotencyKey: input.idempotencyKey, targetProject: input.targetProject } });
  input.implementationGrantRef = "grant";
  var queued = f.router.createProjectExecution(input);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(f.root().orchestrationTasks[0].projectAssignment.payload.implementationGrantRef, "grant");
  record("changed-plan", "plan_revision", "coop", { planRevision: {
    planRevision: 2, planDigest: digest, scopeDigest: "scope" } });
  var rejected = await f.accept(queued.taskRef);
  assert.equal(rejected.reason, "implementation_grant_refused", JSON.stringify(rejected));
  assert.equal(f.starts.length, 0);
});
