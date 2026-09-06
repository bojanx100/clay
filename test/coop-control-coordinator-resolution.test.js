require("./helpers/isolated-clay-home");
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var plane = require("../lib/coop-control-plane");
var createHandlers = require("../lib/orchestration-tool-handlers").createToolHandlers;
var taskState = require("../lib/orchestration-task-state");
var transport = require("../lib/project-task-orchestrator-project-completion-transport");

function fixture(t, extras) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coordinator-resolution-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var source = { projectId: "system-lead", sessionStorageId: "resident" };
  var workerRef = { projectId: projectId, sessionStorageId: "worker" };
  var request = { portfolioTaskId: "restore-auto-launch", bindingRevision: 1,
    idempotencyKey: "restore-r1", mode: "project_coordinator", targetProject: { projectId: projectId }, source: source };
  Object.assign(request, extras || {});
  var root = { localId: 1, storageId: "resident", coordinationMode: true,
    coordinationRole: "project_coordinator", orchestrationTasks: [], orchestrationEvents: [], history: [],
    orchestrationPolicy: { coopControlPlane: { version: 1, role: "project_coordinator", projectRef: request.targetProject } } };
  var worker = { localId: 2, storageId: "worker", coordinationRole: "task_coordinator", history: [],
    projectCoordinatorRef: source, orchestrationPolicy: { portfolioExecution: Object.assign({}, request,
      { status: "failed", reason: "activation_pending", completedAt: 100, updatedAt: 100 }) } };
  var writes = 0;
  var leadManager = { sessions: new Map([[1, root]]), getProjectId: function () { return "system-lead"; },
    saveSessionFile: function () { writes++; fs.writeFileSync(path.join(dir, "resident.json"), JSON.stringify(root)); },
    broadcastSessionList: function () {} };
  var workerManager = { sessions: new Map([[2, worker]]), getProjectId: function () { return projectId; },
    saveSessionFile: function () {}, broadcastSessionList: function () {} };
  var leadContext = { getProjectId: leadManager.getProjectId, getSessionManager: function () { return leadManager; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; } };
  var workerContext = { getProjectId: workerManager.getProjectId, getSessionManager: function () { return workerManager; } };
  var options = { bindingFile: path.join(dir, "bindings.json"), deliveryFile: path.join(dir, "delivery.json"),
    getProjectContextById: function (id) { return id === "system-lead" ? leadContext : id === projectId ? workerContext : null; } };
  var router = createRouter(options);
  assert.equal(router.bindingStore.reserve(request).ok, true);
  assert.equal(router.bindingStore.commit(request.portfolioTaskId, 1, workerRef, { projectCoordinatorRef: source }).ok, true);
  var task = plane.prepareTask(leadManager, root, request, { title: "Restore automatic work", objective: "Verify normal launch" });
  assert.equal(plane.bindTask(leadManager, root, task, workerRef), true);
  assert.equal(transport.deliverProjectFailure(workerManager, router, worker, "Source fixed; activation still pending.").ok, true);
  router.registerProjectResolver(leadContext);
  router.registerProjectResolver(workerContext);
  function handlers() {
    return createHandlers({ coordinatorForInput: function () { return root; },
      isVerifiedCompletion: taskState.isVerifiedCompletion,
      updateTask: function (parent, id, updates) { Object.assign(task, updates); leadManager.saveSessionFile(parent); },
      schedule: function () {}, error: function (text) { return { ok: false, text: text }; },
      success: function (text) { return { ok: true, text: text }; },
      afterResolve: function (parent, resolved) { return router.resolveProjectCoordinatorTask({ source: source, taskId: resolved.taskId }); } });
  }
  function resolve() { return handlers().resolve({ taskId: task.taskId, summary: "Normal issue launch now works.",
    verification: "Observed an eligible issue launch through the normal scheduler and verified its execution receipt.", escalationRequired: "no" }); }
  return { dir: dir, root: root, task: task, worker: worker, source: source, workerRef: workerRef,
    request: request, router: router, options: options, resolve: resolve, leadManager: leadManager,
    leadContext: leadContext, workerContext: workerContext, writes: function () { return writes; } };
}

test("verified resident resolution repairs the portfolio and sidebar without rewriting the worker attempt", function (t) {
  var f = fixture(t);
  var before = JSON.stringify(f.worker);
  assert.equal(f.router.sessionLedger.get(f.workerRef).lifecycleState, "failed");
  assert.equal(f.resolve().ok, true);
  var binding = f.router.getExecutionBinding(f.request.portfolioTaskId, 1);
  assert.equal(binding.status, "completed");
  assert.equal(binding.coordinatorResolution.previousOutcome.status, "failed");
  assert.equal(binding.coordinatorResolution.previousOutcome.reason, "activation_pending");
  assert.equal(binding.coordinatorResolution.taskId, f.task.taskId);
  assert.equal(JSON.stringify(f.worker), before, "the old execution is never resurrected or relabelled");
  var entry = f.router.sessionLedger.get(f.workerRef);
  assert.equal(entry.workState, "done");
  assert.match(entry.terminalOutcome.verification, /normal scheduler/);
  assert.deepEqual(entry.terminalOutcome.resolvedByCoordinator, f.source);
  assert.equal(entry.terminalOutcome.previousOutcome.status, "failed");
  var resolvedAt = f.task.resolvedAt;
  assert.equal(f.resolve().ok, true);
  assert.equal(f.task.resolvedAt, resolvedAt, "replaying resolution must not restamp completion");
  assert.deepEqual(f.router.getExecutionBinding(f.request.portfolioTaskId, 1), binding);
  assert.equal(f.router.bindingStore.complete(f.request.portfolioTaskId, 1,
    { eventId: "late-worker-result", terminalStatus: "completed" }).reason, "completion_conflict");
  var reloaded = createRouter(f.options);
  assert.deepEqual(reloaded.getExecutionBinding(f.request.portfolioTaskId, 1), binding, "resolution round-trips");
});

test("startup discovers a previously verified coordinator task using its actual graph and exact binding", function (t) {
  var f = fixture(t);
  Object.assign(f.task, { status: "completed", resolvedByCoordinator: true, resolvedAt: 200,
    resultSummary: "Activation verified.", verification: "Observed normal scheduler dispatch and verified execution receipt." });
  f.leadManager.saveSessionFile(f.root);
  assert.equal(f.router.getExecutionBinding(f.request.portfolioTaskId, 1).status, "failed");
  var router = createRouter(f.options);
  router.registerProjectResolver(f.workerContext);
  router.registerProjectResolver(f.leadContext);
  assert.equal(router.getExecutionBinding(f.request.portfolioTaskId, 1).status, "completed");
  assert.equal(router.sessionLedger.get(f.workerRef).workState, "done");
  var persisted = fs.readFileSync(path.join(f.dir, "bindings.json"), "utf8");
  router.registerProjectResolver(f.leadContext);
  assert.equal(fs.readFileSync(path.join(f.dir, "bindings.json"), "utf8"), persisted);
});

test("ordinary blocked reports preserve the actionable failure reason", function (t) {
  var f = fixture(t);
  var binding = f.router.getExecutionBinding(f.request.portfolioTaskId, 1);
  assert.equal(binding.statusReason, "activation_pending");
  assert.equal(f.router.sessionLedger.get(f.workerRef).terminalOutcome.summary, "activation_pending");
});

var refusals = [
  ["wrong worker", function (f) { f.task.workerSessionRef.sessionStorageId = "other-worker"; }],
  ["wrong revision", function (f) { f.task.clientRef = "portfolio:restore-auto-launch:2"; }],
  ["wrong resident", function (f) { f.root.orchestrationPolicy.coopControlPlane.projectRef = { projectId: "abf37d6c-7b91-50e4-8509-f6c73f724ebb" }; }],
  ["worker still running", function (f) { f.worker.isProcessing = true; }],
  ["unsaved verification", function (f) { f.leadManager.saveSessionFile = function () { return false; }; }],
];
refusals.forEach(function (scenario) {
  test("coordinator resolution refuses " + scenario[0], function (t) {
    var f = fixture(t);
    scenario[1](f);
    assert.equal(f.resolve().ok, false);
    assert.equal(f.router.getExecutionBinding(f.request.portfolioTaskId, 1).status, "failed");
  });
});

test("unverified text cannot reconcile a failed worker", function (t) {
  var f = fixture(t);
  Object.assign(f.task, { status: "completed", resolvedByCoordinator: true, resolvedAt: 200,
    resultSummary: "Probably done", verification: "" });
  assert.equal(f.router.resolveProjectCoordinatorTask({ source: f.source, taskId: f.task.taskId }).ok, false);
  assert.equal(f.router.getExecutionBinding(f.request.portfolioTaskId, 1).status, "failed");
});


test("coordinator verification cannot substitute for required owner acceptance", function (t) {
  var f = fixture(t, { ownerAcceptanceRequired: true, ownerAcceptance: { status: "pending", source: "project_local_instructions" } });
  var result = f.resolve();
  assert.equal(result.ok, false);
  assert.match(result.text, /owner_acceptance_pending/);
  assert.notEqual(f.router.getExecutionBinding(f.request.portfolioTaskId, 1).status, "completed");
});
