var test = require("node:test");
var assert = require("node:assert/strict");

var attachCoopWatchdog = require("../lib/coop-watchdog-runtime").attachCoopWatchdog;
var buildFanInEvent = require("../lib/coop-fanin-events").buildFanInEvent;

function runtimeHarness() {
  var intervals = [];
  var cleared = [];
  var deliveredIds = [];
  var parent = {
    localId: 1,
    storageId: "coop-home",
    coordinationMode: true,
    coopHome: true,
    orchestrationTasks: [{
      taskId: "task-1",
      status: "running",
      workerSessionId: 2,
      workerStorageId: "worker-1",
      updatedAt: 10,
    }],
    orchestrationEvents: [{
      type: "task_status_changed",
      taskId: "task-1",
      at: 10,
      data: { to: "running" },
    }],
  };
  var worker = {
    localId: 2,
    storageId: "worker-1",
    ownerId: "owner-1",
    orchestrationParent: {
      taskId: "task-1",
      sessionId: 1,
      sessionStorageId: "coop-home",
    },
    coopControlledBy: {
      coopSessionStorageId: "coop-home",
      since: 1,
    },
  };
  var sm = {
    sessions: new Map([
      [1, parent],
      [2, worker],
    ]),
  };
  var delivery = {
    getDeliveredEventIds: function () {
      return deliveredIds.slice();
    },
    deliverEvent: function (event) {
      deliveredIds.push(event.eventId);
      return { ok: true, delivered: true };
    },
  };
  var watchdog = attachCoopWatchdog({
    sm: sm,
    usersModule: {
      getLeadMode: function () { return true; },
    },
    fanInDelivery: delivery,
    now: function () { return 100; },
    setInterval: function (fn, ms) {
      var handle = { fn: fn, ms: ms };
      intervals.push(handle);
      return handle;
    },
    clearInterval: function (handle) {
      cleared.push(handle);
    },
  });
  return {
    cleared: cleared,
    deliveredIds: deliveredIds,
    intervals: intervals,
    parent: parent,
    watchdog: watchdog,
    worker: worker,
  };
}

test("watchdog starts only when lead-controlled work exists and uses a 60 second interval", function () {
  var h = runtimeHarness();

  assert.equal(h.watchdog.isRunning(), false);
  h.watchdog.refresh();
  assert.equal(h.watchdog.isRunning(), true);
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, 60000);
});

test("watchdog stops after delivering the last missed terminal transition", function () {
  var h = runtimeHarness();
  h.watchdog.refresh();

  h.parent.orchestrationTasks[0].status = "completed";
  h.parent.orchestrationTasks[0].updatedAt = 20;
  h.parent.orchestrationTasks[0].resultSummary = "Finished";
  h.parent.orchestrationEvents.push({
    type: "task_status_changed",
    taskId: "task-1",
    at: 20,
    data: { to: "completed" },
  });

  var events = h.watchdog.tick();
  var expectedEvent = buildFanInEvent(h.worker, Object.assign({}, h.parent.orchestrationTasks[0], {
    statusTransitionAt: 20,
  }), {
    status: "completed",
    occurredAt: 20,
    summary: "Finished",
  });

  assert.equal(events.length, 1);
  assert.equal(h.deliveredIds[0], expectedEvent.eventId);
  assert.equal(h.watchdog.isRunning(), false);
  assert.equal(h.cleared.length, 1);
});

test("watchdog calls retryPending on every tick to drive the replay-after-restart fallback", function () {
  var h = runtimeHarness();
  var retryCalls = 0;
  var watchdog = attachCoopWatchdog({
    sm: { sessions: new Map() },
    usersModule: { getLeadMode: function () { return true; } },
    fanInDelivery: {
      getDeliveredEventIds: function () { return []; },
      deliverEvent: function () { return { ok: true, delivered: true }; },
      retryPending: function () { retryCalls++; return []; },
      hasPendingWork: function () { return false; },
    },
    now: function () { return 100; },
    setInterval: function (fn, ms) { return { fn: fn, ms: ms }; },
    clearInterval: function () {},
  });
  watchdog.tick();
  assert.equal(retryCalls, 1);
});

test("watchdog stays active while the fan-in outbox still has pending (undelivered) cross-project events", function () {
  var h = runtimeHarness();
  // No local active/watched task transitions remain -- the only remaining
  // controlled work is a lingering pending outbox entry from a prior
  // failed cross-project delivery (e.g. the lead project was briefly
  // unreachable). The watchdog must not stop while that is still pending.
  h.parent.orchestrationTasks[0].status = "completed";
  h.parent.orchestrationTasks[0].updatedAt = 20;
  h.parent.orchestrationEvents.push({
    type: "task_status_changed", taskId: "task-1", at: 20, data: { to: "completed" },
  });
  h.deliveredIds.push("already-delivered-event-id-that-does-not-matter-here");
  var pendingOutstanding = true;
  var watchdog = attachCoopWatchdog({
    sm: { sessions: new Map() }, // empty: no controlled sessions of its own
    usersModule: { getLeadMode: function () { return true; } },
    fanInDelivery: {
      getDeliveredEventIds: function () { return h.deliveredIds.slice(); },
      deliverEvent: function () { return { ok: true, delivered: true }; },
      retryPending: function () { return []; },
      hasPendingWork: function () { return pendingOutstanding; },
    },
    now: function () { return 100; },
    setInterval: function (fn, ms) { return { fn: fn, ms: ms }; },
    clearInterval: function () {},
  });
  watchdog.refresh();
  assert.equal(watchdog.isRunning(), true, "watchdog must keep running while the outbox has pending work");

  pendingOutstanding = false;
  watchdog.tick();
  assert.equal(watchdog.isRunning(), false, "watchdog stops once no controlled work and no pending outbox remain");
});

