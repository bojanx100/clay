var test = require("node:test");
var assert = require("node:assert/strict");

var buildFanInEvent = require("../lib/coop-fanin-events").buildFanInEvent;

function baseSession(id) {
  return {
    storageId: id,
    title: "Worker",
    coopControlledBy: {
      coopSessionStorageId: "coop-home",
      since: 1,
    },
  };
}

function baseTask(id, status) {
  return {
    taskId: id,
    status: status,
    updatedAt: 200,
    resultSummary: "Done",
  };
}

test("buildFanInEvent is deterministic for the same transition", function () {
  var session = baseSession("worker-1");
  var task = baseTask("task-1", "completed");
  var transition = { occurredAt: 150, status: "completed" };

  var a = buildFanInEvent(session, task, transition);
  var b = buildFanInEvent(session, task, transition);

  assert.deepEqual(a, b);
  assert.equal(a.occurredAt, 150);
  assert.equal(a.summary, "Done");
});

test("buildFanInEvent changes identity when the task state changes", function () {
  var base = buildFanInEvent(baseSession("worker-1"), baseTask("task-1", "completed"), {
    occurredAt: 150,
    status: "completed",
  });
  var differentStatus = buildFanInEvent(baseSession("worker-1"), baseTask("task-1", "failed"), {
    occurredAt: 150,
    status: "failed",
  });
  var differentTask = buildFanInEvent(baseSession("worker-1"), baseTask("task-2", "completed"), {
    occurredAt: 150,
    status: "completed",
  });
  var differentSession = buildFanInEvent(baseSession("worker-2"), baseTask("task-1", "completed"), {
    occurredAt: 150,
    status: "completed",
  });

  assert.notEqual(base.eventId, differentStatus.eventId);
  assert.notEqual(base.eventId, differentTask.eventId);
  assert.notEqual(base.eventId, differentSession.eventId);
});
