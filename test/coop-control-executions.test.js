var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var controlStore = require("../lib/coop-control-store");
var executions = require("../lib/coop-control-executions");

var PROJECT_A = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var SOURCE_SESSION = "871a194b-8879-40f7-a1fe-656e48e722af";
var TARGET_SESSION = "target-session-a";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-execution-"));
  return {
    dbPath: path.join(dir, "coop-control.sqlite"),
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function request(overrides) {
  return Object.assign({
    portfolioTaskId: "clay-perfect-control-task",
    bindingRevision: 1,
    idempotencyKey: "clay-perfect-control-task-r1",
    mode: "direct_leaf",
    targetProject: { projectId: PROJECT_A },
    source: { projectId: "system-lead", sessionStorageId: SOURCE_SESSION },
  }, overrides || {});
}

function sessionRef(value) {
  return { projectId: PROJECT_A, sessionStorageId: value || TARGET_SESSION };
}

function availableTest(name, fn) {
  test(name, { skip: !controlStore.isControlStoreAvailable() }, fn);
}

test("the Slice 2 kill switch is default-off and never opens SQLite", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, env: {} });
    assert.equal(control.enabled, false);
    assert.deepEqual(control.reserveStart(request()), { enabled: false, bypass: true });
    assert.equal(fs.existsSync(h.dbPath), false);
    control.close();
    assert.equal(executions.isExecutionControlEnabled({
      enabled: false,
      env: { CLAY_COOP_CONTROL_STORE: "1", CLAY_COOP_CONTROL_EXECUTIONS: "1" },
    }), false);
  } finally {
    h.cleanup();
  }
});

availableTest("logical execution replay is stable and only one incarnation role lease wins", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var first = control.reserveStart(request());
    var replay = control.reserveStart(request());
    assert.equal(replay.executionId, first.executionId);
    assert.equal(replay.incarnationId, first.incarnationId);
    assert.equal(replay.epoch, 1);
    assert.equal(replay.capability, first.capability);

    var rival = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    assert.throws(function () {
      rival.reserveStart(request());
    }, function (error) { return error && error.code === "COOP_CONTROL_EXECUTION_ACTIVE"; });
    var durable = control.inspect(first.executionId);
    assert.equal(durable.execution.currentEpoch, 1);
    assert.equal(durable.incarnations.length, 1);
    assert.equal(durable.leases.length, 1);
    assert.equal(durable.leases[0].incarnationId, first.incarnationId);
    assert.equal(durable.authority.actionMask, executions.ALL_ACTIONS_MASK);
    assert.equal(JSON.stringify(durable).includes(first.capability), false);
    rival.close();
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("start intent, SessionRef binding, and barrier are ordered before provider start", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var start = control.reserveStart(request());
    assert.equal(control.inspect(start.executionId).current.startState, "reserved");
    assert.throws(function () {
      control.assertCapability(start, "provider_start");
    }, function (error) { return error && error.code === "COOP_CONTROL_START_BARRIER_CLOSED"; });

    assert.throws(function () {
      control.bindStart(start, {
        projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sessionStorageId: "wrong-target",
      });
    }, function (error) { return error && error.code === "COOP_CONTROL_EXECUTION_INVALID"; });

    control.bindStart(start, sessionRef());
    assert.equal(control.inspect(start.executionId).current.startState, "bound");
    assert.throws(function () {
      control.assertCapability(start, "provider_start");
    }, function (error) { return error && error.code === "COOP_CONTROL_START_BARRIER_CLOSED"; });

    control.openStartBarrier(start);
    assert.equal(control.assertCapability(start, "provider_start"), true);
    control.markProviderStarted(start);
    assert.equal(control.inspect(start.executionId).current.startState, "started");
    assert.equal(control.assertCapability(start, "callback"), true);
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("every stale capability category is rejected after an epoch advances", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var first = control.reserveStart(request());
    control.bindStart(first, sessionRef("target-session-one"));
    control.openStartBarrier(first);
    control.markProviderStarted(first);
    control.abandon(first, "retry");
    var second = control.reserveStart(request());
    control.bindStart(second, sessionRef("target-session-two"));
    control.openStartBarrier(second);
    control.markProviderStarted(second);
    assert.equal(second.executionId, first.executionId);
    assert.equal(second.epoch, first.epoch + 1);
    assert.notEqual(second.incarnationId, first.incarnationId);
    assert.notEqual(second.capability, first.capability);

    var actions = ["provider_start", "callback", "tool", "progress", "completion"];
    for (var i = 0; i < actions.length; i++) {
      (function (action) {
        assert.throws(function () {
          control.assertCapability(first, action);
        }, function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; }, action);
        assert.equal(control.assertCapability(second, action), true, action);
      })(actions[i]);
    }
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("structured authority rejects prose, unknown fields, and idempotency conflicts", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    assert.throws(function () {
      control.reserveStart(request({ prompt: "private owner prompt" }));
    }, function (error) { return error && error.code === "COOP_CONTROL_AUTHORITY_INVALID"; });
    assert.throws(function () {
      control.reserveStart(request({ mode: "administrator" }));
    }, function (error) { return error && error.code === "COOP_CONTROL_AUTHORITY_INVALID"; });
    var start = control.reserveStart(request());
    assert.throws(function () {
      control.reserveStart(request({ idempotencyKey: "different-key" }));
    }, function (error) { return error && error.code === "COOP_CONTROL_EXECUTION_CONFLICT"; });
    assert.throws(function () {
      control.assertCapability(start, "shell_anything");
    }, function (error) { return error && error.code === "COOP_CONTROL_AUTHORITY_DENIED"; });
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("restart recovery releases incomplete leases and advances the epoch", function () {
  var h = harness();
  try {
    var firstControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var first = firstControl.reserveStart(request());
    firstControl.bindStart(first, sessionRef("interrupted-session"));
    firstControl.openStartBarrier(first);
    firstControl.markProviderStarted(first);
    var startedAt = firstControl.inspect(first.executionId).current.startedAt;
    firstControl.close();

    var recovered = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    assert.equal(recovered.recoverIncomplete(), 1);
    assert.equal(recovered.inspect(first.executionId).current.startedAt, startedAt);
    var second = recovered.reserveStart(request());
    assert.equal(second.executionId, first.executionId);
    assert.equal(second.epoch, 2);
    assert.equal(recovered.inspect(second.executionId).leases.length, 1);
    assert.throws(function () {
      recovered.assertCapability(first, "callback");
    }, function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; });
    recovered.close();
  } finally {
    h.cleanup();
  }
});

availableTest("activation rejects a physically valid but impossible execution state", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var start = control.reserveStart(request());
    control.bindStart(start, sessionRef());
    control.openStartBarrier(start);
    control.markProviderStarted(start);
    control.close();
    var db = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    db.prepare("UPDATE coop_control_incarnations SET start_state = 'failed', failure_code = 'forged' " +
      "WHERE incarnation_id = ?").run(start.incarnationId);
    db.close();
    assert.throws(function () {
      executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    }, function (error) { return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION"; });
  } finally {
    h.cleanup();
  }
});

availableTest("activation rejects terminal timestamps later than the last execution update", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var start = control.reserveStart(request());
    control.bindStart(start, sessionRef());
    control.openStartBarrier(start);
    control.markProviderStarted(start);
    control.createFence(start).complete();
    var updatedAt = control.inspect(start.executionId).execution.updatedAt;
    control.close();
    var db = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    db.prepare("UPDATE coop_control_executions SET finished_at = ? WHERE execution_id = ?")
      .run(updatedAt + 1, start.executionId);
    db.close();
    assert.throws(function () {
      executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    }, function (error) { return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION"; });
  } finally {
    h.cleanup();
  }
});

availableTest("activation rejects a gap in the durable incarnation epoch history", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var first = control.reserveStart(request());
    control.bindStart(first, sessionRef("first-attempt"));
    control.openStartBarrier(first);
    control.markProviderStarted(first);
    control.abandon(first, "retry");
    var second = control.reserveStart(request());
    control.close();
    var db = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    db.prepare("DELETE FROM coop_control_incarnations WHERE execution_id = ? AND epoch = 1")
      .run(second.executionId);
    db.close();
    assert.throws(function () {
      executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    }, function (error) { return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION"; });
  } finally {
    h.cleanup();
  }
});

availableTest("execution corruption fails activation closed instead of becoming empty state", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var start = control.reserveStart(request());
    control.close();
    var db = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE coop_control_executions SET current_epoch = ? WHERE execution_id = ?")
      .run(9, start.executionId);
    db.close();
    assert.throws(function () {
      executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    }, function (error) { return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION"; });
  } finally {
    h.cleanup();
  }
});
