var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var fixture = require("./helpers/coop-project-intake-fixture").fixture;

function snapshot(text) {
  var match = text.match(/<clay_control_context>\n([\s\S]*?)\n<\/clay_control_context>/);
  assert.ok(match);
  return JSON.parse(match[1]);
}

test("actual session reload restores assignments, obligations and reports into the next provider turn", async function (t) {
  var f = fixture(t, { notificationFailure: true });
  var input = f.ownerRequest();
  var queued = f.router.createProjectExecution(input);
  assert.equal(queued.ok, true);
  var root = f.root();
  root.pendingCoordinatorUpdates = [{ updateId: "report-1", text: "Owner decision needed for billing",
    state: "uncertain", attempts: 1 }];
  f.lead.saveSessionFile(root, { durable: true });
  f.reopen();
  await f.bridge.startQuery(f.root(), "Recover the current obligations", null, null);
  var query = await f.query();
  var context = snapshot(query.messages[0]);
  assert.deepEqual(context.work.assignments[0].taskRef, queued.taskRef);
  assert.equal(context.work.assignments[0].assignment.scope.objective, "Implement the approved project change.");
  assert.equal(context.work.assignments[0].assignment.scope.acceptanceCriteria, input.acceptanceCriteria);
  assert.equal(context.work.pendingReports[0].text, "Owner decision needed for billing");
  assert.equal(context.project.path, f.targetDir);
  assert.equal(f.root().coordinatorContextReceipt.state, "supplied");
  f.reopen();
  assert.equal(f.root().coordinatorContextReceipt.state, "supplied", "historical receipt survives disk reload");
  assert.equal(f.root()._coordinatorContextDelivery, undefined, "historical input is not current-provider authority");
});

test("editing a referenced rule during a turn blocks delegation until refreshed at the provider boundary", async function (t) {
  var f = fixture(t);
  fs.writeFileSync(path.join(f.targetDir, "AGENTS.md"), "Before work read `billing.md`.");
  fs.writeFileSync(path.join(f.targetDir, "billing.md"), "Preserve invoices.");
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var query = await f.query();
  assert.equal(snapshot(query.messages[0]).instructions[1].body, "Preserve invoices.");
  fs.writeFileSync(path.join(f.targetDir, "billing.md"), "Preserve invoices and require owner acceptance.");
  assert.equal((await f.accept(queued.taskRef)).reason, "coordinator_context_refresh_required");
  assert.equal(f.starts.length, 0);
  assert.equal(f.bridge.pushMessage(f.root(), "Refresh rules and inspect the task", null), true);
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(f.starts.length, 1);
});

test("context exposes the current exact bound worker after dispatch and survives another fresh query", async function (t) {
  var f = fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  var worker = f.starts[0].session;
  worker.currentActivity = "Waiting for the fixture verification result";
  var query = await f.query();
  query.handle.close();
  if (f.root().streamPromise) await f.root().streamPromise;
  await f.bridge.startQuery(f.root(), "Resume oversight", null, null);
  var context = snapshot((await f.query()).messages[0]);
  assert.equal(context.work.assignments[0].worker.sessionRef.sessionStorageId, worker.storageId);
  assert.equal(context.work.assignments[0].worker.activity, worker.currentActivity);
  assert.equal(context.work.assignments[0].assignment.phase, "accepted");
});


test("provider switch to Claude reloads the same rules and durable assignment into the new provider", async function (t) {
  var f = fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var first = await f.query();
  first.handle.close();
  await f.root().streamPromise;
  f.lead.modelsByVendor.claude = ["claude-fable-5"];
  f.lead.verifiedModelsByRoute["claude-anthropic"] = ["claude-fable-5"];
  f.lead.availableVendors = ["codex", "claude"];
  f.lead.installedVendors = ["codex", "claude"];
  var switcher = require("../lib/provider-switch").attachProviderSwitch({
    cwd: path.join(f.dir, "lead"), sm: f.lead, sendTo: function () {}, sendToSession: function () {},
    sendConfigForSession: function () {}, cancelScheduledMessage: function () {}, clearPendingQueuedMessages: function () {},
  });
  var switched = switcher.executeProviderSwitch({ session: f.root(), targetVendor: "claude",
    targetRouteId: "claude-anthropic", targetModel: "claude-fable-5" });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  fs.writeFileSync(path.join(f.targetDir, "AGENTS.md"), "Current Claude-side project obligations.");
  f.root().isProcessing = true;
  await f.bridge.startQuery(f.root(), "Continue the assigned work", null, null);
  var next = await f.query();
  assert.notEqual(next, first);
  assert.equal(f.root().vendor, "claude");
  var context = snapshot(next.messages[0]);
  assert.equal(context.instructions[0].body, "Current Claude-side project obligations.");
  assert.deepEqual(context.work.assignments[0].taskRef, queued.taskRef);
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
});

test("resident compaction renews its provider in place with open assignments and unchanged TaskRefs", async function (t) {
  var f = fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  await f.query();
  var root = f.root();
  var count = f.lead.sessions.size;
  var compact = require("../lib/project-session-compaction").attachSessionCompaction({
    cwd: path.join(f.dir, "lead"), sm: f.lead, sdk: f.bridge, sendToSession: function () {},
  });
  var renewed = compact.compactAndContinue(root, { reason: "manual", currentText: "Continue oversight" });
  assert.equal(renewed, root, "resident identity is not replaced by an unbound successor");
  await root._coordinatorRenewal;
  assert.equal(f.lead.sessions.size, count);
  assert.equal(f.root(), root);
  var next = await f.query();
  assert.deepEqual(snapshot(next.messages[0]).work.assignments[0].taskRef, queued.taskRef);
  var accepted = await f.accept(queued.taskRef);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
});


test("a rejected warm input cannot grant current-context authority", async function (t) {
  var f = fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var query = await f.query();
  query.handle.pushMessage = function () { return false; };
  assert.equal(f.bridge.pushMessage(f.root(), "Refresh before accepting", null), false);
  assert.equal(f.root().coordinatorContextReceipt.state, "rejected");
  assert.equal((await f.accept(queued.taskRef)).reason, "coordinator_context_refresh_required");
  assert.equal(f.starts.length, 0);
});

test("failed durable coordinator renewal preserves task identity and starts no replacement provider", async function (t) {
  var f = fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  await f.query();
  var root = f.root();
  var count = f.providerQueries.length;
  var save = f.lead.saveSessionFile;
  f.lead.saveSessionFile = function (session, options) {
    return session === root && session.handoffContext ? false : save(session, options);
  };
  var compact = require("../lib/project-session-compaction").attachSessionCompaction({
    cwd: path.join(f.dir, "lead"), sm: f.lead, sdk: f.bridge, sendToSession: function () {},
  });
  assert.equal(compact.compactAndContinue(root, { reason: "manual" }), root);
  await root._coordinatorRenewal;
  assert.equal(f.providerQueries.length, count);
  assert.equal(f.root(), root);
  assert.equal(root._compactionInProgress, false);
  assert.equal(root.orchestrationTasks[0].projectAssignment.taskRef.coordinatorSessionStorageId,
    queued.taskRef.coordinatorSessionStorageId);
});
