var test = require("node:test");
var assert = require("node:assert/strict");

var findMissedTransitions = require("../lib/coop-watchdog-policy").findMissedTransitions;
var buildFanInEvent = require("../lib/coop-fanin-events").buildFanInEvent;

function controlledSession() {
  return {
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
}

function completedTask() {
  return {
    taskId: "task-1",
    status: "completed",
    workerSessionId: 2,
    workerStorageId: "worker-1",
    statusTransitionAt: 55,
    resultSummary: "Finished",
  };
}

test("watchdog policy requires an injected finite now value", function () {
  assert.throws(function () {
    findMissedTransitions({}, {});
  }, /finite now value/);
});

test("watchdog policy finds a missed controlled terminal transition", function () {
  var events = findMissedTransitions({
    sessions: [controlledSession()],
    tasks: [completedTask()],
    deliveredEventIds: [],
  }, { now: 100 });

  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, "task-1");
  assert.equal(events[0].status, "completed");
});

test("watchdog policy does not re-emit transitions that were already delivered", function () {
  var session = controlledSession();
  var task = completedTask();
  var event = buildFanInEvent(session, task, {
    status: task.status,
    occurredAt: task.statusTransitionAt,
  });
  var events = findMissedTransitions({
    sessions: [session],
    tasks: [task],
    deliveredEventIds: [event.eventId],
  }, { now: 100 });

  assert.deepEqual(events, []);
});

test("watchdog policy returns nothing when no controlled work exists", function () {
  var events = findMissedTransitions({
    sessions: [{ storageId: "ordinary" }],
    tasks: [completedTask()],
    deliveredEventIds: [],
  }, { now: 100 });

  assert.deepEqual(events, []);
});
