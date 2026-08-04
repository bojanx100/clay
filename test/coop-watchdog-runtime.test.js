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
