var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
require("./helpers/isolated-clay-home");
var config = require("../lib/config");
var leadMode = require("../lib/lead-mode");
var createManager = require("../lib/sessions").createSessionManager;
var attachOrchestrator = require("../lib/project-task-orchestrator").attachTaskOrchestrator;
var PROJECT = "11111111-1111-5111-8111-111111111111";

function toggle(enabled) {
  assert.equal(leadMode.setLeadMode({ enabled: enabled, multiUser: false }).ok, true);
  assert.equal(leadMode.getLeadMode(), enabled);
}

function fixture(t, options) {
  options = options || {};
  toggle(true);
  var cwd = fs.mkdtempSync(path.join(config.CONFIG_DIR, "pause-"));
  var managerOptions = { cwd: cwd, slug: "project", projectId: PROJECT, send: function () {} };
  var router = require("../lib/server-cross-project").createCrossProjectRouter({
    bindingFile: path.join(cwd, "bindings.json"), deliveryFile: path.join(cwd, "delivery.json"),
    sessionLedgerFile: path.join(cwd, "session-ledger.json"), deliveryRetryIntervalMs: options.intervalMs || 0,
    isLeadModeEnabled: leadMode.getLeadMode,
  });
  var h = { cwd: cwd, router: router, starts: [] };
  h.sdk = { startQuery: function (session, text, images) {
    h.starts.push({ session: session, text: text, images: images });
    return { ok: true, submission: "submitted" };
  }, pushMessage: function (session, text, images) {
    h.starts.push({ session: session, text: text, images: images }); return true;
  } };
  function attach() {
    h.sm = createManager(managerOptions);
    h.sm.availableVendors = ["codex"];
    h.sm.providerRoutes = [{ id: "codex-openai", vendor: "codex", provider: "openai", modelFamily: "gpt",
      label: "Codex", enabled: true, health: "healthy", catalogVerified: true, catalogSource: "live" }];
    h.sm.modelsByVendor = { codex: ["gpt-5.6-sol"] };
    h.api = attachOrchestrator({ sm: h.sm, sdk: h.sdk, cwd: cwd, slug: "project", crossProject: router,
      getLeadMode: leadMode.getLeadMode, sendToSession: function () {}, onProcessingChanged: function () {},
      ensureProjectAccessForSession: function () {}, loadImagesForSdk: function (refs) { return refs; } });
    h.unregister = router.registerProjectResolver({ getProjectId: function () { return h.sm.getProjectId(); },
      getSessionManager: function () { return h.sm; },
      getTaskOrchestrator: function () { return h.api; },
      getStatus: function () { return { slug: "project", path: cwd, projectId: PROJECT }; } });
  }
  attach();
  h.parent = h.sm.createSessionRaw({ coordinationMode: true, vendor: "codex", model: "gpt-5.6-sol",
    coopControlledBy: options.ownerCreated ? null : { coopSessionStorageId: "canonical-coop", since: Date.now() } });
  h.parent.isProcessing = true;
  h.sm.saveSessionFile(h.parent, { durable: true });
  h.reload = function () {
    var id = h.parent.storageId;
    h.api.stopCoopWatchdog();
    h.unregister();
    attach();
    h.parent = Array.from(h.sm.sessions.values()).find(function (session) { return session.storageId === id; });
  };
  h.worker = function (task) { return Array.from(h.sm.sessions.values()).find(function (session) {
    return session.storageId === task.workerStorageId;
  }); };
  h.finish = function (worker, status) {
    worker.isProcessing = false;
    h.sm.sendAndRecord(worker, { type: "delta", text: "WORKER_STATUS: " + (status || "completed") +
      "\nSUMMARY: Updated the requested copy.\nVERIFICATION: Copy assertion passed.\nESCALATION_REQUIRED: no" });
    h.sm.sendAndRecord(worker, { type: "done", code: 0 });
    h.sm.saveSessionFile(worker, { durable: true });
  };
  t.after(function () { h.api.stopCoopWatchdog(); router.stopDeliveryRetry(); });
  return h;
}

function plan(h, dependencies) {
  var result = h.api.planFromTool({ coordinatorSessionId: h.parent.storageId, tasks: [
    { ref: "a", title: "Update copy A", objective: "Update copy A", maxAttempts: 3 },
    { ref: "b", title: "Update copy B", objective: "Update copy B", dependencies: dependencies ? ["a"] : [] },
  ] });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(h.parent.orchestrationTasks[0].status, "running");
  return h.parent.orchestrationTasks;
}

function workerStarts(h) { return h.starts.filter(function (entry) { return entry.session.orchestrationParent; }); }
function pause(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

test("OFF records running work without launching its dependent or coordinator; ON resumes through the real clock", async function (t) {
  var h = fixture(t, { intervalMs: 20 });
  var tasks = plan(h, true);
  var worker = h.worker(tasks[0]);
  toggle(false);
  assert.equal(worker.isProcessing, true, "toggling does not abort the current worker");
  h.parent.isProcessing = false;
  h.finish(worker);
  await pause(70);
  assert.equal(tasks[0].status, "completed");
  assert.equal(tasks[1].status, "queued");
  assert.equal(h.starts.length, 1);
  assert.equal(h.parent.pendingCoordinatorUpdates.length, 1);
  assert.equal(h.parent.pendingCoordinatorUpdates[0].attempts, 0);
  toggle(true);
  var deadline = Date.now() + 10000;
  while (workerStarts(h).length < 2 && Date.now() < deadline) await pause(10);
  assert.equal(tasks[1].status, "running");
  assert.equal(workerStarts(h).length, 2);
  assert.equal(h.starts.filter(function (entry) { return entry.session === h.parent; }).length, 1);
  await pause(60);
  assert.equal(workerStarts(h).length, 2, "another tick cannot duplicate the dependent");
});

test("an owner-created coordinator keeps normal delegation and dependency scheduling with Lead OFF", function (t) {
  var h = fixture(t, { ownerCreated: true });
  toggle(false);
  var tasks = plan(h, true);
  h.finish(h.worker(tasks[0]));
  assert.equal(tasks[1].status, "running");
  assert.equal(workerStarts(h).length, 2);
});

test("OFF preserves a failed worker and its attempt rather than silently spending an automatic retry", function (t) {
  var h = fixture(t);
  var tasks = plan(h, true);
  var worker = h.worker(tasks[0]);
  toggle(false);
  h.finish(worker, "failed");
  assert.equal(tasks[0].status, "failed");
  assert.equal(tasks[0].attempt, 1);
  assert.equal(tasks[0].workerStorageId, worker.storageId);
  assert.equal(worker.orchestrationParent.taskId, tasks[0].taskId);
  assert.equal(workerStarts(h).length, 1);
  assert.match(tasks[0].resultSummary, /WORKER_STATUS: failed/);
  h.reload();
  var restored = h.parent.orchestrationTasks[0];
  assert.equal(restored.status, "failed");
  assert.equal(restored.attempt, 1);
  assert.equal(h.worker(restored).storageId, worker.storageId);
  assert.equal(workerStarts(h).length, 1);
});

test("an already-running model cannot bypass OFF through reused retries, new plans, or a forged owner flag", async function (t) {
  var h = fixture(t);
  var tasks = plan(h, true);
  toggle(false);
  h.finish(h.worker(tasks[0]), "reviewing");
  var before = JSON.stringify(h.parent.orchestrationTasks);
  var defs = require("../lib/orchestration-mcp-server").getToolDefs(h.api.delegateFromTool,
    h.api.messageFromTool, h.api.planFromTool, h.api.reportFromTool, h.api.retryFromTool, h.api.adoptFromTool);
  var base = { coordinatorSessionId: h.parent.storageId, taskId: tasks[0].taskId };
  var retry = defs.find(function (tool) { return tool.name === "retry_task"; });
  assert.equal((await retry.handler(base)).isError, true);
  assert.equal((await retry.handler(Object.assign({}, base, { freshSession: true }))).isError, true);
  var message = defs.find(function (tool) { return tool.name === "send_task_message"; });
  assert.equal((await message.handler(Object.assign({}, base, {
    message: "Start another pass", _liveUiFollowup: true, ownerContinuation: true,
  }))).isError, true);
  assert.equal(h.api.planFromTool({ coordinatorSessionId: h.parent.storageId,
    tasks: [{ title: "Extra copy", objective: "Extra copy" }] }).isError, true);
  assert.equal(JSON.stringify(h.parent.orchestrationTasks), before);
  assert.equal(workerStarts(h).length, 1);
});

test("automatic worker messages survive OFF and restart and resume once when ON", function (t) {
  var h = fixture(t);
  var tasks = plan(h, true);
  var worker = h.worker(tasks[0]);
  assert.equal(h.api.messageFromTool({ coordinatorSessionId: h.parent.storageId,
    taskId: tasks[0].taskId, message: "Also update the button copy" }).isError, undefined);
  toggle(false);
  h.finish(worker);
  assert.equal(workerStarts(h).length, 1);
  assert.equal(worker.pendingCoordinatorMessages.length, 1);
  h.reload();
  var restoredTask = h.parent.orchestrationTasks[0];
  var restoredWorker = h.worker(restoredTask);
  assert.equal(restoredWorker.pendingCoordinatorMessages.length, 1);
  h.router.retryCoordinatorUpdates();
  assert.equal(workerStarts(h).length, 1);
  toggle(true);
  h.router.retryCoordinatorUpdates();
  assert.equal(workerStarts(h).length, 2);
  assert.equal(workerStarts(h)[1].session.storageId, worker.storageId);
  assert.match(workerStarts(h)[1].text, /Also update the button copy/);
  assert.equal(restoredWorker.pendingCoordinatorMessages.length, 0);
  h.router.retryCoordinatorUpdates();
  assert.equal(workerStarts(h).length, 2);
});

test("owner Live UI feedback survives restart and runs while OFF without draining automatic messages", async function (t) {
  var h = fixture(t, { intervalMs: 20 });
  var tasks = plan(h, true);
  var worker = h.worker(tasks[0]);
  h.api.messageFromTool({ coordinatorSessionId: h.parent.storageId,
    taskId: tasks[0].taskId, message: "Automatic coordinator instruction" });
  toggle(false);
  assert.equal(h.api.messageFromOwner({ coordinatorSessionId: h.parent.storageId,
    taskId: tasks[0].taskId, message: "Owner correction to mobile copy",
    imageRefs: [{ mediaType: "image/png", file: "mobile.png" }] }).isError, undefined);
  // Simulate process loss after the provider finished but before its done
  // callback. Only session JSONL carries the owner continuation into reload.
  worker.isProcessing = false;
  worker.history.push({ type: "delta", text: "WORKER_STATUS: completed\nSUMMARY: First copy pass.\nVERIFICATION: Copy checks passed.\nESCALATION_REQUIRED: no" });
  worker.history.push({ type: "done", code: 0 });
  h.sm.saveSessionFile(worker, { durable: true });
  h.reload();
  // The full suite runs many isolated processes concurrently. Wait for the
  // real retry clock without making host scheduling speed an assertion.
  var deadline = Date.now() + 10000;
  while (workerStarts(h).length < 2 && Date.now() < deadline) await pause(10);
  assert.equal(workerStarts(h).length, 2);
  assert.match(workerStarts(h)[1].text, /Owner correction to mobile copy/);
  assert.deepEqual(workerStarts(h)[1].images, [{ mediaType: "image/png", file: "mobile.png" }]);
  var restoredWorker = h.worker(h.parent.orchestrationTasks[0]);
  assert.deepEqual(restoredWorker.pendingCoordinatorMessages, ["Automatic coordinator instruction"]);
  assert.equal(h.parent.orchestrationTasks[1].status, "queued");
  assert.equal(leadMode.getLeadMode(), false);
});

test("a direct prepared owner message still reaches an existing Coop worker with Lead OFF", function (t) {
  var h = fixture(t);
  var tasks = plan(h, true);
  var worker = h.worker(tasks[0]);
  toggle(false);
  h.finish(worker, "reviewing");
  var queue = require("../lib/project-user-message-queue").attachProjectUserMessageQueue({
    sm: h.sm, sdk: h.sdk, sendToSession: function () {}, onProcessingChanged: function () {},
    onUserMessageDispatched: function (session) { return h.api.resumeOwnedWorker(session); },
    ensureProjectAccessForSession: function () {},
  });
  queue.dispatchPreparedToSdk(worker, { finalText: "Use the business rule I described", displayText: "Owner correction",
    images: null, pastes: null, fromQueue: false, steer: false, intent: "chat" });
  assert.equal(workerStarts(h).length, 2);
  assert.equal(workerStarts(h)[1].session, worker);
  assert.match(workerStarts(h)[1].text, /Use the business rule/);
  assert.equal(tasks[0].status, "running");
  assert.equal(tasks[1].status, "queued");
});

test("startup OFF keeps queued graphs durable and does not create workers", function (t) {
  var h = fixture(t);
  var graph = require("../lib/orchestration-task-graph");
  var task = graph.createTask(h.parent, { title: "Queued copy", objective: "Update copy" });
  h.sm.saveSessionFile(h.parent, { durable: true });
  toggle(false);
  h.reload();
  h.router.retryCoordinatorUpdates();
  assert.equal(workerStarts(h).length, 0);
  assert.equal(h.parent.orchestrationTasks[0].taskId, task.taskId);
  assert.equal(h.parent.orchestrationTasks[0].status, "queued");
  assert.equal(h.parent.orchestrationTasks[0].attempt, 0);
});

test("a caller-supplied Live UI flag never grants owner continuation even when Lead is ON", function (t) {
  var h = fixture(t);
  var tasks = plan(h, true);
  h.finish(h.worker(tasks[0]));
  var count = workerStarts(h).length;
  var result = h.api.messageFromTool({ coordinatorSessionId: h.parent.storageId, taskId: tasks[0].taskId,
    message: "Restart this completed task", _liveUiFollowup: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already completed/);
  assert.equal(workerStarts(h).length, count);
});

test("a failed queued-message save retains owner feedback for the next retry clock", function (t) {
  var h = fixture(t);
  var tasks = plan(h, true);
  var worker = h.worker(tasks[0]);
  toggle(false);
  h.api.messageFromOwner({ coordinatorSessionId: h.parent.storageId, taskId: tasks[0].taskId,
    message: "Owner correction after save recovery" });
  var original = h.sm.saveSessionFile;
  var refused = false;
  h.sm.saveSessionFile = function (session, options) {
    if (!refused && session === worker && !worker.pendingCoordinatorMessages.length) { refused = true; return false; }
    return original(session, options);
  };
  h.finish(worker);
  assert.equal(refused, true);
  assert.equal(workerStarts(h).length, 1);
  assert.equal(worker.pendingCoordinatorMessages.length, 1);
  h.sm.saveSessionFile = original;
  h.router.retryCoordinatorUpdates();
  assert.equal(workerStarts(h).length, 2);
  assert.match(workerStarts(h)[1].text, /Owner correction after save recovery/);
  assert.equal(worker.pendingCoordinatorMessages.length, 0);
});

test("the real project completion finalizer cannot close a graph with paused continuation", function (t) {
  var h = fixture(t);
  h.parent.orchestrationPolicy = { portfolioExecution: { mode: "project_coordinator", status: "running",
    portfolioTaskId: "paused-project", bindingRevision: 1,
    source: { projectId: "system-lead", sessionStorageId: "canonical-coop" } } };
  var result = h.api.planFromTool({ coordinatorSessionId: h.parent.storageId,
    tasks: [{ title: "Update copy", objective: "Update copy" }] });
  assert.equal(result.isError, undefined);
  var task = h.parent.orchestrationTasks[0];
  var worker = h.worker(task);
  h.api.messageFromTool({ coordinatorSessionId: h.parent.storageId,
    taskId: task.taskId, message: "Check the updated business rule before closing" });
  toggle(false);
  h.finish(worker);
  function finalReport() {
    h.parent.history.push({ type: "delta", text: "PROJECT_COMPLETED: yes\nSUMMARY: Copy updated.\n" +
      "VERIFICATION: Copy assertions passed.\nINTEGRATION_VERIFIED: yes\nESCALATION_REQUIRED: no" });
    h.parent.history.push({ type: "done", code: 0 });
    h.parent.isProcessing = false;
    h.api.handleCoordinatorTurnDone(h.parent);
  }
  finalReport();
  assert.equal(task.status, "reviewing");
  assert.equal(require("../lib/orchestration-task-graph").graphResolutionState(h.parent).metrics.unresolved, 1);
  assert.equal(h.parent.orchestrationPolicy.portfolioExecution.status, "running");
  assert.notEqual(h.parent.orchestrationProjectCompletion && h.parent.orchestrationProjectCompletion.status, "completed");
  h.reload();
  toggle(true);
  h.router.retryCoordinatorUpdates();
  var resumedTask = h.parent.orchestrationTasks[0];
  assert.equal(resumedTask.status, "running");
  assert.equal(h.worker(resumedTask).storageId, worker.storageId);
  h.finish(h.worker(resumedTask));
  h.parent.isProcessing = false;
  h.api.flushCoordinatorUpdates(h.parent);
  finalReport();
  assert.equal(h.parent.orchestrationPolicy.portfolioExecution.status, "completed");
});

test("restart cannot restore completed status or release dependents ahead of pending follow-up", function (t) {
  ["needs_input", "completed"].forEach(function (persistedStatus) {
    var h = fixture(t);
    var tasks = plan(h, true);
    var worker = h.worker(tasks[0]);
    h.api.messageFromTool({ coordinatorSessionId: h.parent.storageId,
      taskId: tasks[0].taskId, message: "Finish the pending copy correction" });
    toggle(false);
    h.finish(worker);
    // A pre-fix completion record or restart-attention task can carry the
    // completed provider report alongside a durable pending continuation.
    require("../lib/orchestration-task-graph").transition(h.parent, tasks[0], persistedStatus);
    h.sm.saveSessionFile(h.parent, { durable: true });
    toggle(true);
    h.reload();
    assert.notEqual(h.parent.orchestrationTasks[0].status, "completed");
    assert.equal(h.parent.orchestrationTasks[1].status, "queued");
    assert.equal(workerStarts(h).length, 1, "startup cannot release the dependent before queued work resumes");
    h.router.retryCoordinatorUpdates();
    assert.equal(workerStarts(h).length, 2);
    assert.equal(workerStarts(h)[1].session.storageId, worker.storageId);
  });
});

test("application wiring provides the real Lead setting and keeps the owner continuation out of MCP", function () {
  function source(file) { return fs.readFileSync(path.join(__dirname, "../lib", file), "utf8"); }
  assert.match(source("project-features.js"), /attachTaskOrchestrator\(\{[\s\S]*?getLeadMode: leadMode\.getLeadMode/);
  assert.match(source("project-features.js"), /onUserMessageDispatched:[\s\S]*?taskOrchestrator\.resumeOwnedWorker\(session\)/);
  assert.match(source("server-cross-project.js"), /api\.resumeAutomaticWork\(session\)/);
  assert.match(source("project-live-ui.js"), /followUpTask: ctx\.taskOrchestrator\.messageFromOwner/);
  assert.doesNotMatch(source("project.js"), /_taskOrchestrationGate\.[\w]+\s*=\s*_taskOrchestrator\.messageFromOwner/);
});
