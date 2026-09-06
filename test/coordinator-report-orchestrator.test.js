var test = require("node:test");
var assert = require("node:assert/strict");
var fixture = require("./helpers/coordinator-report-fixture").fixture;
var settled = require("./helpers/coordinator-report-fixture").settled;
var clientState = require("../lib/orchestration-task-state").orchestrationStateForClient;

function pending(f) { return f.session.pendingCoordinatorUpdates || []; }
function reports(f) { return f.session.history.filter(function (item) { return item.coordinatorUpdateBatchId; }); }
function metadata(f) { return f.disk().find(function (item) { return item.type === "meta"; }); }

test("typed transport refuses a failed durable enqueue and reloads the successfully retried report", function (t) {
  var f = fixture(t);
  f.session.isProcessing = true;
  var save = f.sm.saveSessionFile;
  f.sm.saveSessionFile = function () { return false; };
  assert.equal(f.deliver().ok, false);
  assert.equal(pending(f).length, 0);
  f.sm.saveSessionFile = save;
  f.session._lastSaveDurMs = 50;
  f.session._lastSaveBytes = 600 * 1024;
  f.session._lastSaveAt = Date.now();
  assert.equal(f.deliver().ok, true);
  assert.equal(metadata(f).pendingCoordinatorUpdates.length, 1, "transport receipt requires an immediate disk write");
  f.reopen();
  assert.equal(pending(f).length, 1);
  assert.match(pending(f)[0].text, /report-1/);
});

test("caught provider construction failures retain one report and stop after three spaced attempts", async function (t) {
  var f = fixture(t);
  f.failure = "create";
  assert.equal(f.deliver().ok, true);
  await settled();
  assert.equal(pending(f).length, 1);
  assert.equal(pending(f)[0].state, "pending");
  f.router.retryCoordinatorUpdates();
  assert.equal(f.starts, 1, "backoff prevents immediate retry storms");
  for (var i = 0; i < 2; i++) {
    f.now += 60001;
    f.router.retryCoordinatorUpdates();
    await settled();
  }
  assert.equal(f.starts, 3);
  assert.equal(pending(f)[0].state, "attention");
  assert.equal(reports(f).length, 1, "retries do not multiply synthetic history");
  assert.equal(clientState(f.session).coordinatorUpdates.attention.length, 1);
  f.reopen();
  f.now += 60001;
  f.router.retryCoordinatorUpdates();
  assert.equal(f.starts, 3, "the automatic budget survives restart");
});

test("the daemon clock retries the durable report after provider recovery", async function (t) {
  var f = fixture(t, { intervalMs: 10 });
  f.failure = "create";
  f.deliver();
  await settled();
  assert.equal(f.starts, 1);
  f.failure = "";
  f.now += 60001;
  var deadline = Date.now() + 2000;
  while (pending(f).length && Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, 10); });
  }
  assert.equal(f.starts, 2);
  assert.equal(pending(f).length, 0);
  assert.equal(f.pushes.length, 1);
  assert.equal(reports(f).length, 1);
  assert.equal(f.deliver().duplicate, true);
});

test("failed staging persists no attempted transcript and starts no provider", function (t) {
  var f = fixture(t);
  var save = f.sm.saveSessionFile;
  f.sm.saveSessionFile = function (session, options) {
    if (pending(f).some(function (entry) { return entry.state === "submitting"; })) return false;
    return save(session, options);
  };
  assert.equal(f.deliver().ok, true, "report is durably queued even though staging failed");
  assert.equal(f.starts, 0);
  assert.equal(reports(f).length, 0);
  assert.equal(pending(f)[0].state, "pending");
  assert.equal(f.disk().filter(function (item) { return item.coordinatorUpdateBatchId; }).length, 0);
});

test("restart during submission retains uncertain reports for review without resending", async function (t) {
  var f = fixture(t);
  f.failure = "defer";
  f.deliver();
  await settled();
  assert.equal(f.starts, 1);
  assert.equal(metadata(f).pendingCoordinatorUpdates[0].state, "submitting");
  f.reopen();
  var scheduled = require("../lib/project-scheduled-messages").attachProjectScheduledMessages({
    sm: f.sm, sdk: f.bridge, sendToSession: function () {},
    hydrateImageRefs: function (entry) { return entry; }, loadImagesForSdk: function () { return []; },
    onProcessingChanged: function () {}, ensureProjectAccessForSession: function () {},
  });
  scheduled.autoResumeRestartSession(f.session, { userInitiated: true });
  assert.equal(f.session.scheduledMessage || null, null, "the real restart scheduler cannot bypass report review");
  assert.equal(f.bridge.autoResumeAllowed(f.session), false);
  f.failure = "";
  f.router.retryCoordinatorUpdates();
  await settled();
  assert.equal(f.starts, 1);
  assert.equal(pending(f)[0].state, "uncertain");
  assert.equal(f.deliver().duplicate, true);
  assert.equal(reports(f).length, 1);
  assert.equal(clientState(f.session).coordinatorUpdates.attention[0].uncertain, true);
  scheduled.scheduleMessage(f.session, "continue", Date.now() + 60000,
    "Continue prior work", "Resuming", { autoAction: true });
  assert.equal(scheduled.sendScheduledMessageNow(f.session), false,
    "an already-scheduled automatic continuation cannot bypass review either");
  assert.equal(f.starts, 1);
  assert.equal(f.api.resolveCoordinatorUpdates(f.session, { action: "acknowledge",
    updateIds: pending(f).map(function (entry) { return entry.updateId; }) }), true);
  f.reopen();
  assert.equal(!!f.session.restartResumeEligible, false,
    "reviewed staging must not become hidden automatic work on another restart");
});

test("explicit retry of an uncertain report starts once and rejects repeated or stale actions", async function (t) {
  var f = fixture(t);
  f.failure = "push-throw";
  f.deliver();
  await settled();
  var ids = pending(f).map(function (entry) { return entry.updateId; });
  f.failure = "";
  assert.equal(f.api.resolveCoordinatorUpdates(f.session, { action: "retry", updateIds: ids }), true);
  assert.equal(f.api.resolveCoordinatorUpdates(f.session, { action: "retry", updateIds: ids }), false);
  await settled();
  assert.equal(f.starts, 2);
  assert.equal(pending(f).length, 0);
  assert.equal(reports(f).length, 1);
});

test("review refuses failed persistence and late callbacks cannot modify a destroyed session", async function (t) {
  var f = fixture(t);
  f.failure = "push-throw";
  f.deliver();
  await settled();
  var ids = pending(f).map(function (entry) { return entry.updateId; });
  var save = f.sm.saveSessionFile;
  f.sm.saveSessionFile = function () { return false; };
  assert.equal(f.api.resolveCoordinatorUpdates(f.session, { action: "acknowledge", updateIds: ids }), false);
  assert.equal(pending(f).length, 1);
  f.sm.saveSessionFile = save;
  f.failure = "defer";
  assert.equal(f.api.resolveCoordinatorUpdates(f.session, { action: "retry", updateIds: ids }), true);
  await settled();
  f.session.destroying = true;
  f.failure = "";
  f.release();
  await settled();
  assert.equal(pending(f)[0].state, "submitting", "a discarded runtime cannot acknowledge a batch");
});

test("an immediate-only warm dispatch refuses buffering behind query construction", function (t) {
  var f = fixture(t);
  f.session._queryStarting = true;
  assert.equal(f.bridge.pushMessage(f.session, "Report", null, { requireImmediate: true }), false);
  assert.equal((f.session.pendingPush || []).length, 0);
  f.deliver();
  assert.equal(f.starts, 0);
  assert.equal(pending(f)[0].state, "pending");
});

test("a failed receipt save retries persistence without resubmitting accepted input", async function (t) {
  var f = fixture(t);
  var save = f.sm.saveSessionFile;
  f.sm.saveSessionFile = function (session, options) {
    if (reports(f).length && !pending(f).length) return false;
    return save(session, options);
  };
  f.deliver();
  await settled();
  assert.equal(pending(f)[0].state, "submitted");
  assert.equal(metadata(f).pendingCoordinatorUpdates[0].state, "submitting");
  f.router.retryCoordinatorUpdates();
  assert.equal(f.pushes.length, 1);
  f.sm.saveSessionFile = save;
  f.router.retryCoordinatorUpdates();
  assert.equal(pending(f).length, 0);
  assert.equal(metadata(f).pendingCoordinatorUpdates, undefined);
  assert.equal(f.pushes.length, 1);
});

test("a durably accepted report remains restart-eligible even before the first provider event", async function (t) {
  var f = fixture(t);
  f.deliver();
  await settled();
  assert.equal(pending(f).length, 0);
  assert.equal(reports(f)[0].coordinatorUpdateSubmission, "submitted");
  f.reopen();
  assert.equal(f.session.restartResumeEligible, true);
  assert.equal(f.bridge.autoResumeAllowed(f.session), true);
  assert.equal(reports(f)[0].coordinatorUpdateSubmission, "submitted");
});

test("new reports arriving during provider creation keep their own queue and history batch", async function (t) {
  var f = fixture(t);
  f.failure = "defer";
  f.deliver("first");
  await settled();
  f.deliver("second");
  assert.equal(pending(f).length, 2);
  f.failure = "";
  f.release();
  await settled();
  assert.equal(pending(f).length, 1);
  assert.match(pending(f)[0].text, /second/);
  f.session.isProcessing = false;
  f.router.retryCoordinatorUpdates();
  await settled();
  assert.equal(pending(f).length, 0);
  assert.equal(f.starts, 1, "second report uses the warm query");
  assert.equal(f.pushes.length, 2);
  assert.equal(reports(f).length, 2);
});

["push-false", "push-throw"].forEach(function (failure) {
  test("warm " + failure + " preserves its report and does not buffer it invisibly", async function (t) {
    var f = fixture(t);
    f.deliver("first");
    await settled();
    f.session.isProcessing = false;
    f.failure = failure;
    f.deliver("second");
    await settled();
    assert.equal(pending(f).length, 1);
    assert.equal(pending(f)[0].state, failure === "push-false" ? "pending" : "uncertain");
    assert.equal(f.session.isProcessing, false);
    assert.equal((f.session.pendingPush || []).length, 0);
  });
});

test("Lead OFF holds new management reports while ordinary project orchestration still runs", async function (t) {
  var f = fixture(t);
  f.mode = false;
  assert.equal(f.deliver().ok, true);
  await settled();
  assert.equal(f.starts, 0);
  assert.equal(pending(f).length, 1);
  f.mode = true;
  f.router.retryCoordinatorUpdates();
  await settled();
  assert.equal(f.starts, 1);
  var project = fixture(t, { slug: "ordinary-project" });
  project.mode = false;
  project.deliver();
  await settled();
  assert.equal(project.starts, 1);
});

test("owner review resolves only the selected report IDs and preserves the report history", async function (t) {
  var f = fixture(t);
  f.failure = "push-throw";
  f.deliver();
  await settled();
  assert.equal(pending(f)[0].state, "uncertain");
  assert.equal(f.api.resolveCoordinatorUpdates(f.session, { action: "acknowledge", updateIds: ["missing"] }), false);
  var ids = pending(f).map(function (entry) { return entry.updateId; });
  f.mode = false;
  assert.equal(f.api.resolveCoordinatorUpdates(f.session, { action: "acknowledge", updateIds: ids }), true);
  assert.equal(pending(f).length, 0);
  assert.equal(reports(f).length, 1);
  f.reopen();
  assert.equal(pending(f).length, 0);
  assert.equal(reports(f).length, 1);
});
