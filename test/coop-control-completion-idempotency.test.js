// Isolated review reproduction. Real router, binding store, durable delivery,
// destination completion handler, and completion transport; no provider runs.
var fs = require("fs");
var os = require("os");
var path = require("path");
var assert = require("assert/strict");
var createRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var createHandler = require("../lib/project-task-orchestrator-cross-project").createCrossProjectEnvelopeHandler;
var transport = require("../lib/project-task-orchestrator-project-completion-transport");
var plane = require("../lib/coop-control-plane");
var test = require("node:test");
test("normal project completion records one terminal transition and ignores replay", function (t) {
var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-completion-transition-"));
t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var rootRef = { projectId: "system-lead", sessionStorageId: "resident-project-root" };
var childRef = { projectId: projectId, sessionStorageId: "project-task-child" };
var request = { portfolioTaskId: "review-completion", bindingRevision: 1,
  idempotencyKey: "review-completion-r1", mode: "project_coordinator",
  targetProject: { projectId: projectId }, source: rootRef };
var writes = 0;
var root = { localId: 1, storageId: rootRef.sessionStorageId, history: [],
  coordinationMode: true, coordinationRole: "project_coordinator",
  orchestrationTasks: [], orchestrationEvents: [], orchestrationPolicy: {
    coopControlPlane: { version: 1, role: "project_coordinator", projectRef: request.targetProject }
  } };
var leadManager = { sessions: new Map([[1, root]]),
  getProjectId: function () { return "system-lead"; },
  saveSessionFile: function () { writes++; }, broadcastSessionList: function () {} };
var child = { localId: 2, storageId: childRef.sessionStorageId, history: [],
  coordinationMode: true, coordinationRole: "task_coordinator",
  projectCoordinatorRef: rootRef, orchestrationPolicy: { portfolioExecution:
    Object.assign({}, request, { status: "completed", completedAt: 12345 }) } };
var childManager = { sessions: new Map([[2, child]]),
  getProjectId: function () { return projectId; }, saveSessionFile: function () {} };
var handler;
var received = 0;
var leadContext = { getSessionManager: function () { return leadManager; },
  deliverCrossProjectEnvelope: function (envelope) { received++; return handler.deliver(envelope); } };
var childContext = { getSessionManager: function () { return childManager; } };
var router = createRouter({ bindingFile: path.join(dir, "bindings.json"),
  deliveryFile: path.join(dir, "delivery.json"),
  getProjectContextById: function (id) {
    return id === "system-lead" ? leadContext : id === projectId ? childContext : null;
  } });
handler = createHandler({ crossProject: router,
  followup: { deliverCrossProjectEnvelope: function () { throw new Error("Unexpected cognitive notification"); } },
  portfolioExecutionTarget: { handleEnvelope: function () { throw new Error("Unexpected execution command"); } },
  commandSchema: "clay.project_execution_command" });
assert.equal(router.bindingStore.reserve(request).ok, true);
assert.equal(router.bindingStore.commit(request.portfolioTaskId, 1, childRef,
  { projectCoordinatorRef: rootRef }).ok, true);
var task = plane.prepareTask(leadManager, root, request,
  { title: "Review reproduction", objective: "Prove completion redelivery" });
assert.equal(plane.bindTask(leadManager, root, task, childRef), true);
var before = root.orchestrationEvents.length;
var writesBefore = writes;
var result = transport.deliverProjectCompletion(childManager, router, child,
  { status: "completed", completedAt: 12345, summary: "Verified reproduction work." });
var events = root.orchestrationEvents.slice(before);
var output = { result: result, deliveriesReceived: received,
  rootEventsBefore: before, rootEventsAfter: root.orchestrationEvents.length,
  appendedEventTypes: events.map(function (event) { return event.type; }),
  rootDurableWrites: writes - writesBefore,
  bindingStatus: router.getExecutionBinding(request.portfolioTaskId, 1).status,
  rootStatus: task.status };
assert.equal(result.ok, true);
assert.equal(result.deliveryError, false);
assert.equal(received, 1);
assert.deepEqual(output.appendedEventTypes,
  ["task_coordinator_completed"]);
assert.equal(output.rootDurableWrites, 1);
var terminal = JSON.stringify(root);
var replay = transport.deliverProjectCompletion(childManager, router, child,
  { status: "completed", completedAt: 12345, summary: "Verified reproduction work." });
assert.equal(replay.ok, true);
assert.equal(JSON.stringify(root), terminal);
assert.equal(plane.completeTask(leadManager, root, request, "needs_input", "Late attention"), true);
assert.equal(JSON.stringify(root), terminal, "terminal attempt cannot return to needs-input");

});
