var test = require("node:test");
var assert = require("node:assert");

test("importing a hidden coordinator restores all linked workers", function () {
  var saved = [];
  var broadcasts = 0;
  var worker = {
    localId: 11,
    storageId: "worker-storage",
    cliSessionId: "worker-cli",
    hidden: true,
    closedAt: 101,
  };
  var nestedWorker = {
    localId: 13,
    storageId: "nested-worker-storage",
    cliSessionId: "nested-worker-cli",
    hidden: true,
    closedAt: 102,
  };
  var nestedCoordinator = {
    localId: 12,
    storageId: "nested-coordinator-storage",
    cliSessionId: "nested-coordinator-cli",
    hidden: true,
    closedAt: 103,
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "nested-task",
      workerSessionId: nestedWorker.localId,
      workerStorageId: nestedWorker.storageId,
    }],
  };
  var coordinator = {
    localId: 10,
    storageId: "coordinator-storage",
    cliSessionId: "coordinator-cli",
    hidden: true,
    closedAt: 104,
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "worker-task",
      workerSessionId: 999,
      workerStorageId: worker.storageId,
    }, {
      taskId: "nested-coordinator-task",
      workerSessionId: nestedCoordinator.localId,
      workerStorageId: nestedCoordinator.storageId,
    }],
  };
  var unrelated = {
    localId: 14,
    storageId: "unrelated-storage",
    cliSessionId: "unrelated-cli",
    hidden: true,
    closedAt: 105,
  };
  var sessions = new Map([
    [coordinator.localId, coordinator],
    [worker.localId, worker],
    [nestedCoordinator.localId, nestedCoordinator],
    [nestedWorker.localId, nestedWorker],
    [unrelated.localId, unrelated],
  ]);
  var cliImport = require("../lib/sessions-cli-import").attachSessionCliImport({
    cwd: "/tmp/clay-coordinator-import",
    sessions: sessions,
    allocateLocalId: function () { return 100; },
    saveSessionFile: function (session) { saved.push(session.localId); },
    broadcastSessionList: function () { broadcasts++; },
    isValidCliSessionId: function () { return true; },
    getSessionStorageId: function (session) { return session.storageId || session.cliSessionId; },
  });

  var importedId = cliImport.importCliSession(coordinator.cliSessionId, "codex");

  assert.strictEqual(importedId, coordinator.localId);
  assert.strictEqual(coordinator.hidden, false);
  assert.strictEqual(worker.hidden, false);
  assert.strictEqual(nestedCoordinator.hidden, false);
  assert.strictEqual(nestedWorker.hidden, false);
  assert.strictEqual(coordinator.closedAt, null);
  assert.strictEqual(worker.closedAt, null);
  assert.strictEqual(nestedCoordinator.closedAt, null);
  assert.strictEqual(nestedWorker.closedAt, null);
  assert.strictEqual(unrelated.hidden, true);
  assert.strictEqual(unrelated.closedAt, 105);
  assert.deepStrictEqual(saved.sort(function (a, b) { return a - b; }), [10, 11, 12, 13]);
  assert.strictEqual(broadcasts, 1);
});
