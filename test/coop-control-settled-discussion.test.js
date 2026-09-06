require("./helpers/isolated-clay-home");
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var plane = require("../lib/coop-control-plane");
var queueModule = require("../lib/project-user-message-queue");
var attachUpdates = require("../lib/project-coordinator-update-queue").attachCoordinatorUpdateQueue;
var attachFollowup = require("../lib/project-task-orchestrator-followup").attachTaskFollowup;

function fixture(t, status) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-settled-discussion-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var project = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var source = { projectId: project, sessionStorageId: "worker" };
  var destination = { projectId: "system-lead", sessionStorageId: "resident" };
  var request = { portfolioTaskId: "restore-launch", bindingRevision: 1, idempotencyKey: "restore-launch-r1",
    mode: "project_coordinator", coopTopicRef: { topicId: "restore-launch-topic" }, targetProject: { projectId: project }, source: destination };
  var root = { localId: 1, storageId: "resident", history: [], coordinationMode: true,
    coordinationRole: "project_coordinator", orchestrationTasks: [], orchestrationEvents: [],
    orchestrationPolicy: { coopControlPlane: { version: 1, role: "project_coordinator", projectRef: request.targetProject } } };
  var worker = { localId: 2, storageId: "worker", history: [], coordinationRole: "task_coordinator",
    orchestrationPolicy: { portfolioExecution: Object.assign({}, request, { status: status || "failed", control: { executionId: "closed-attempt", epoch: 1 } }) } };
  var starts = 0;
  var sdk = { startQuery: function () { starts++; }, pushMessage: function () { starts++; } };
  var manager = { sessions: new Map([[1, root]]), getProjectId: function () { return "system-lead"; },
    saveSessionFile: function () { fs.writeFileSync(path.join(dir, "root.json"), JSON.stringify(root)); return true; },
    broadcastSessionList: function () {} };
  var workerManager = { sessions: new Map([[2, worker]]), getProjectId: function () { return project; },
    broadcastSessionList: function () {}, saveSessionFile: function () { return true; },
    sendAndRecord: function (session, event) { session.history.push(event); } };
  var updates = attachUpdates({ sm: manager, sdk: sdk, canDispatch: function () { return false; },
    sendState: function () {}, onProcessingChanged: function () {}, sendToSession: function () {} });
  var router;
  var followup;
  var context = { getSessionManager: function () { return manager; },
    deliverCrossProjectEnvelope: function (envelope) { return followup.deliverCrossProjectEnvelope(envelope); } };
  var options = { bindingFile: path.join(dir, "bindings.json"), deliveryFile: path.join(dir, "delivery.json"),
    getProjectContextById: function (id) { return id === "system-lead" ? context : null; } };
  router = createRouter(options);
  followup = attachFollowup({ sm: manager, sdk: sdk, crossProject: router,
    sessionByStorageId: function (id) { return id === "resident" ? root : null; },
    queueCoordinatorUpdate: updates.queue, flushCoordinatorUpdates: updates.flush });
  assert.equal(router.bindingStore.reserve(request).ok, true);
  assert.equal(router.bindingStore.commit(request.portfolioTaskId, 1, source, { projectCoordinatorRef: destination }).ok, true);
  var task = plane.prepareTask(manager, root, request, { title: "Restore launch", objective: "Verify launch" });
  assert.equal(plane.bindTask(manager, root, task, source), true);
  assert.equal(router.bindingStore.complete(request.portfolioTaskId, 1, { eventId: "worker-ended",
    terminalStatus: status || "failed", failureCode: "activation_pending" }).ok, true);
  var queue = queueModule.attachProjectUserMessageQueue({ sm: workerManager, sdk: sdk, crossProject: router,
    sendToSession: function () {}, onProcessingChanged: function () {}, ensureProjectAccessForSession: function () {} });
  return { worker: worker, root: root, source: source, destination: destination, request: request,
    router: router, queue: queue, options: options, dir: dir, starts: function () { return starts; } };
}

["failed", "completed", "needs_input"].forEach(function (status) {
  test("owner discussion on " + status + " worker reaches the resident durably without starting the worker", function (t) {
    var f = fixture(t, status);
    var execution = JSON.stringify(f.worker.orchestrationPolicy);
    var beforeBinding = f.router.getExecutionBinding(f.request.portfolioTaskId, 1);
    var args = { finalText: "Was the automatic launch actually verified?", displayText: "Was it verified?",
      clientMessageId: "owner-question", images: [{ savedPath: "/tmp/owner-screenshot.png" }] };
    f.queue.dispatchPreparedToSdk(f.worker, args);
    assert.equal(f.starts(), 0);
    assert.ok(f.root.pendingCoordinatorUpdates, JSON.stringify(f.worker.history));
    assert.equal(f.root.pendingCoordinatorUpdates.length, 1);
    assert.match(f.root.pendingCoordinatorUpdates[0].text, /Was the automatic launch actually verified/);
    assert.match(f.root.pendingCoordinatorUpdates[0].text, /owner-screenshot.png/);
    assert.match(f.root.pendingCoordinatorUpdates[0].text, /worker attempt has ended/);
    assert.equal(f.root.pendingCoordinatorUpdates[0].feedback.portfolioTaskId, f.request.portfolioTaskId);
    assert.equal(f.root.pendingCoordinatorUpdates[0].feedback.coopTopicRef.topicId, "restore-launch-topic");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "root.json"))).pendingCoordinatorUpdates.length, 1);
    assert.equal(JSON.stringify(f.worker.orchestrationPolicy), execution);
    assert.deepEqual(f.router.getExecutionBinding(f.request.portfolioTaskId, 1), beforeBinding);
    assert.deepEqual(f.worker.history[0].conversationRef, f.destination);
    f.queue.dispatchPreparedToSdk(f.worker, args);
    assert.equal(f.root.pendingCoordinatorUpdates.length, 1, "retry is one durable discussion turn");
    assert.equal(f.starts(), 0);
  });
});

test("an unavailable resident leaves an actionable notice and never falls back to the closed worker", function (t) {
  var f = fixture(t);
  f.root.hidden = true;
  f.queue.dispatchPreparedToSdk(f.worker, { finalText: "What happened?", clientMessageId: "q" });
  assert.equal(f.starts(), 0);
  assert.equal(f.worker.history[0].type, "error");
  assert.match(f.worker.history[0].text, /coordinator_unavailable/);
});

test("owner discussion cannot target another worker's binding", function (t) {
  var f = fixture(t);
  f.worker.storageId = "unrelated-worker";
  f.queue.dispatchPreparedToSdk(f.worker, { finalText: "What happened?", clientMessageId: "q" });
  assert.equal(f.starts(), 0);
  assert.match(f.worker.history[0].text, /binding_mismatch/);
  assert.equal(f.root.pendingCoordinatorUpdates, undefined);
});

test("manual sessions retain their normal conversation behavior", function (t) {
  var f = fixture(t);
  delete f.worker.orchestrationPolicy.portfolioExecution.control;
  f.queue.dispatchPreparedToSdk(f.worker, { finalText: "Continue", clientMessageId: "q" });
  assert.equal(f.starts(), 1);
  assert.equal(f.root.pendingCoordinatorUpdates, undefined);
});


test("the discussion link reopens the exact coordinator through Clay's real session URL parser", async function () {
  var url = require("url").pathToFileURL;
  var linkModule = await import(url(path.resolve("lib/public/modules/coordinator-discussion-link.js")).href);
  var tabs = await import(url(path.resolve("lib/public/modules/session-tab-state.js")).href);
  var priorDocument = global.document;
  var priorLocation = global.location;
  try {
    global.document = { createElement: function () { return {}; } };
    var links = [];
    var ref = { projectId: "system-lead", sessionStorageId: "resident&with=query" };
    linkModule.appendCoordinatorDiscussionLink({ appendChild: function (link) { links.push(link); } }, ref);
    assert.equal(links.length, 1);
    global.location = new URL(links[0].href, "http://127.0.0.1:7392");
    assert.deepEqual(tabs.readUrlSessionRef("lead"), ref);
    linkModule.appendCoordinatorDiscussionLink({ appendChild: function (link) { links.push(link); } },
      { projectId: "https://untrusted.example", sessionStorageId: "bad" });
    assert.equal(links.length, 1);
  } finally { global.document = priorDocument; global.location = priorLocation; }
});
