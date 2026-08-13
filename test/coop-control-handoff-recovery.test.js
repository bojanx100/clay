var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var storeModule = require("../lib/coop-control-store");
var executions = require("../lib/coop-control-executions");
var handoffs = require("../lib/coop-control-handoff");
var deliveryModule = require("../lib/coop-control-delivery");
var startupModule = require("../lib/coop-control-startup");
var controlRuntime = require("../lib/coop-control-runtime");

var PROJECT_A = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var SOURCE = { projectId: "system-lead", sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af" };
var OLD = { projectId: PROJECT_A, sessionStorageId: "coordinator-old" };
var NEW = { projectId: PROJECT_A, sessionStorageId: "coordinator-new" };

function harness(storeFaults) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-recovery-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  var store = storeModule.openControlStore({ dbPath: dbPath, faults: storeFaults });
  var control = executions.createExecutionControl({ enabled: true, store: store });
  var handoff = handoffs.createHandoffControl({ enabled: true, store: store, executionControl: control });
  return {
    control: control, dbPath: dbPath, dir: dir, handoff: handoff, store: store,
    cleanup: function () {
      try { handoff.close(); } catch (error) {}
      try { control.close(); } catch (error) {}
      try { store.close(); } catch (error) {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function request() {
  return {
    portfolioTaskId: "task-recoverable-coordinator", bindingRevision: 3,
    idempotencyKey: "task-recoverable-coordinator-r3", mode: "project_coordinator",
    targetProject: { projectId: PROJECT_A }, source: SOURCE,
  };
}

function continuityPacket(predecessor) {
  var executionId = predecessor && predecessor.executionId || "exec:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  var authorityId = predecessor && predecessor.authorityId || "auth:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return {
    schemaVersion: 1,
    objectives: [{ objectiveId: "objective-main", text: "Finish the approved recovery slice." }],
    decisions: [{ decisionId: "decision-one", value: "Roll forward after cutover.", acceptedAt: 10 }],
    ownerRequests: [{ requestId: "owner-open", ingressId: "ingress-open", receivedAt: 11 }],
    tasks: [{ taskId: "task-recoverable-coordinator", objectiveId: "objective-main",
      status: "in_progress", owner: OLD }],
    bindings: [{ portfolioTaskId: "task-recoverable-coordinator", bindingRevision: 3,
      targetProject: { projectId: PROJECT_A }, mode: "project_coordinator", status: "active" }],
    authorities: [{ authorityId: authorityId, source: SOURCE,
      portfolioTaskId: "task-recoverable-coordinator", bindingRevision: 3,
      targetProject: { projectId: PROJECT_A }, role: "coordinator", actionMask: 31 }],
    executions: [{ executionId: executionId, source: SOURCE,
      authorityId: authorityId,
      portfolioTaskId: "task-recoverable-coordinator", bindingRevision: 3,
      targetProject: { projectId: PROJECT_A }, mode: "project_coordinator", role: "coordinator" }],
    learningReferences: [{ learningId: "learning-placeholder", version: 1 }],
  };
}

function started(control) {
  var token = control.reserveStart(request());
  control.bindStart(token, OLD);
  control.openStartBarrier(token);
  control.markProviderStarted(token);
  return token;
}

function successorEvidence(ref, receiptId) {
  return { sessionRef: ref, receiptId: receiptId || "receipt-successor" };
}

function availableTest(name, fn) {
  test(name, { skip: !storeModule.isControlStoreAvailable() }, fn);
}

test("Slice 3 activation is default-off and its kill switch performs no I/O", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-recovery-off-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  try {
    var handoff = handoffs.createHandoffControl({ dbPath: dbPath, env: {} });
    var delivery = deliveryModule.createDeliveryControl({ dbPath: dbPath, env: {} });
    var startup = startupModule.createStartupRecovery({ dbPath: dbPath, env: {} });
    assert.equal(handoff.enabled, false);
    assert.equal(delivery.enabled, false);
    assert.equal(startup.enabled, false);
    assert.equal(startup.isReady(), true);
    assert.equal(fs.existsSync(dbPath), false);
    controlRuntime.closeExecutionControl();
    assert.equal(controlRuntime.getDeliveryControl({ dbPath: dbPath, env: {
      CLAY_COOP_CONTROL_STORE: "1", CLAY_COOP_CONTROL_EXECUTIONS: "1",
    } }).enabled, false);
    assert.equal(fs.existsSync(dbPath), false);
    controlRuntime.closeExecutionControl();
    assert.equal(handoffs.isHandoffControlEnabled({ enabled: false, env: {
      CLAY_COOP_CONTROL_STORE: "1", CLAY_COOP_CONTROL_EXECUTIONS: "1",
      CLAY_COOP_CONTROL_RECOVERY: "1",
    } }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

availableTest("Class A advances the fence while retaining the visible SessionRef", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var prepared = h.handoff.prepare({ class: "A", reason: "provider_unhealthy",
      predecessor: predecessor, from: OLD, continuity: continuityPacket(predecessor) });
    var creates = 0;
    h.handoff.ensureSuccessor(prepared.handoffId, function () { creates += 1; });
    var cutover = h.handoff.cutover(prepared.handoffId);
    assert.equal(creates, 0);
    assert.deepEqual(cutover.handoff.to, OLD);
    assert.equal(cutover.token.epoch, predecessor.epoch + 1);
    assert.throws(function () {
      h.control.assertCapability(predecessor, "callback");
    }, function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; });
    assert.equal(h.control.assertCapability(cutover.token, "provider_start"), true);
    h.control.markProviderStarted(cutover.token);
    h.handoff.complete(prepared.handoffId, cutover.token);
    assert.equal(h.handoff.inspect(prepared.handoffId).state, "completed");
  } finally {
    h.cleanup();
  }
});

availableTest("Class B replay creates exactly one stable successor and preserves continuity", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var spec = { class: "B", reason: "context_exhausted", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: continuityPacket(predecessor) };
    var first = h.handoff.prepare(spec);
    var replay = h.handoff.prepare(spec);
    assert.equal(replay.handoffId, first.handoffId);
    var creates = 0;
    h.handoff.ensureSuccessor(first.handoffId, function (ref, handoffId) {
      creates += 1;
      assert.deepEqual(ref, NEW);
      assert.equal(handoffId, first.handoffId);
      return successorEvidence(ref, "receipt-class-b");
    });
    h.handoff.ensureSuccessor(first.handoffId, function () { creates += 1; });
    assert.equal(creates, 1);
    var cutover = h.handoff.cutover(first.handoffId);
    assert.deepEqual(cutover.handoff.to, NEW);
    assert.equal(h.handoff.inspect(first.handoffId).successorState, "created");
    var checkpoint = h.handoff.checkpoint(first.handoffId);
    assert.deepEqual(checkpoint.packet.ownerRequests, continuityPacket(predecessor).ownerRequests);
    assert.deepEqual(checkpoint.packet.tasks, continuityPacket(predecessor).tasks);
    assert.deepEqual(checkpoint.packet.bindings, continuityPacket(predecessor).bindings);
    assert.deepEqual(checkpoint.packet.learningReferences, continuityPacket(predecessor).learningReferences);
    h.control.markProviderStarted(cutover.token);
    h.handoff.complete(first.handoffId, cutover.token);
    var completedReplay = h.handoff.prepare(spec);
    assert.equal(completedReplay.handoffId, first.handoffId);
    assert.equal(completedReplay.state, "completed");
    assert.equal(creates, 1);
    h.handoff.close();
    h.control.close();
    h.store.close();
    var reopened = storeModule.openControlStore({ dbPath: h.dbPath });
    var restored = reopened.getCheckpoint(first.handoffId);
    assert.deepEqual(restored.packet.ownerRequests, continuityPacket(predecessor).ownerRequests);
    assert.deepEqual(restored.packet.tasks, continuityPacket(predecessor).tasks);
    assert.equal(restored.exam.passed, true);
    reopened.close();
  } finally {
    h.cleanup();
  }
});

availableTest("pre-cutover abort preserves the predecessor while post-cutover recovery only rolls forward", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var before = h.handoff.prepare({ class: "B", reason: "wedged_thread", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: continuityPacket(predecessor) });
    h.handoff.abort(before.handoffId, "successor_create_failed");
    assert.equal(h.handoff.inspect(before.handoffId).state, "aborted");
    assert.equal(h.control.assertCapability(predecessor, "callback"), true);

    var second = h.handoff.prepare({ class: "B", reason: "context_exhausted", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: continuityPacket(predecessor) });
    h.handoff.ensureSuccessor(second.handoffId, function () { return successorEvidence(NEW); });
    var cutover = h.handoff.cutover(second.handoffId);
    assert.throws(function () {
      h.handoff.abort(second.handoffId, "late_failure");
    }, function (error) { return error && error.code === "COOP_CONTROL_HANDOFF_ROLL_FORWARD_REQUIRED"; });
    var recovered = h.handoff.recover(second.handoffId);
    assert.equal(recovered.token.epoch, cutover.token.epoch + 1);
    assert.deepEqual(recovered.handoff.to, NEW);
    assert.equal(h.control.inspect(predecessor.executionId).leases.length, 1);
    assert.throws(function () {
      h.control.assertCapability(cutover.token, "provider_start");
    }, function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; });
  } finally {
    h.cleanup();
  }
});

availableTest("handoff reasons reject inherited object names", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    ["constructor", "toString"].forEach(function (reason) {
      assert.throws(function () {
        h.handoff.prepare({ class: "A", reason: reason, predecessor: predecessor,
          from: OLD, continuity: continuityPacket(predecessor) });
      }, function (error) { return error && error.code === "COOP_CONTROL_HANDOFF_INVALID"; });
    });
    assert.equal(h.store.listHandoffs().length, 0);
    assert.equal(h.control.assertCapability(predecessor, "callback"), true);
  } finally {
    h.cleanup();
  }
});

availableTest("every durable handoff fault boundary converges with exactly one active incarnation", function () {
  var points = ["afterPrepare", "afterSuccessorCreate", "afterCutover", "afterRollForward"];
  for (var pointIndex = 0; pointIndex < points.length; pointIndex++) {
    var point = points[pointIndex];
    var h = harness();
    try {
      h.handoff.close();
      var armed = true;
      var faults = {};
      faults[point] = function () { if (armed) throw new Error("injected " + point); };
      var predecessor = started(h.control);
      var faulted = handoffs.createHandoffControl({ enabled: true, store: h.store,
        executionControl: h.control, faults: faults });
      var handoffId;
      if (point === "afterRollForward") {
        var normal = handoffs.createHandoffControl({ enabled: true, store: h.store,
          executionControl: h.control });
        var normalPrepared = normal.prepare({ class: "B", reason: "context_exhausted",
          predecessor: predecessor, from: OLD, successor: NEW, continuity: continuityPacket(predecessor) });
        handoffId = normalPrepared.handoffId;
        normal.ensureSuccessor(handoffId, function () { return successorEvidence(NEW); });
        normal.cutover(handoffId);
        normal.close();
        assert.throws(function () { faulted.recover(handoffId); }, /injected afterRollForward/);
      } else {
        try {
          var prepared = faulted.prepare({ class: "B", reason: "context_exhausted",
            predecessor: predecessor, from: OLD, successor: NEW, continuity: continuityPacket(predecessor) });
          handoffId = prepared.handoffId;
          faulted.ensureSuccessor(handoffId, function () { return successorEvidence(NEW); });
          faulted.cutover(handoffId);
          assert.fail("fault point did not fire: " + point);
        } catch (error) {
          assert.match(error.message, new RegExp("injected " + point));
          handoffId = handoffId || h.store.listHandoffs()[0].handoff_id;
        }
      }
      faulted.close();
      armed = false;
      var recovering = handoffs.createHandoffControl({ enabled: true, store: h.store,
        executionControl: h.control });
      var durable = recovering.inspect(handoffId);
      var result = recovering.recover(handoffId);
      if (durable.state === "prepared") {
        assert.ok(result.token, point);
        assert.deepEqual(result.target, OLD, point);
        h.control.markProviderStarted(result.token);
        recovering.abort(handoffId, "restart_pre_cutover");
        assert.equal(recovering.inspect(handoffId).state, "aborted", point);
        assert.throws(function () {
          h.control.assertCapability(predecessor, "callback");
        }, function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; }, point);
      } else {
        assert.ok(result.token, point);
        h.control.markProviderStarted(result.token);
        recovering.complete(handoffId, result.token);
        assert.throws(function () {
          h.control.assertCapability(predecessor, "callback");
        }, function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; }, point);
      }
      assert.equal(h.control.inspect(predecessor.executionId).leases.length, 1, point);
      recovering.close();
    } finally {
      h.cleanup();
    }
  }
});

availableTest("injected handoff commit failures roll back preparation and cutover atomically", function () {
  var failOperation = null;
  var h = harness({ beforeRecoveryCommit: function (event) {
    if (event.operation === failOperation) throw new Error("injected " + failOperation);
  } });
  try {
    var predecessor = started(h.control);
    var spec = { class: "B", reason: "context_exhausted", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: continuityPacket(predecessor) };
    failOperation = "prepare_handoff";
    assert.throws(function () { h.handoff.prepare(spec); }, /injected prepare_handoff/);
    assert.equal(h.store.listHandoffs().length, 0);
    assert.equal(h.control.assertCapability(predecessor, "callback"), true);

    failOperation = null;
    var prepared = h.handoff.prepare(spec);
    h.handoff.ensureSuccessor(prepared.handoffId, function () { return successorEvidence(NEW); });
    failOperation = "cutover_handoff";
    assert.throws(function () { h.handoff.cutover(prepared.handoffId); }, /injected cutover_handoff/);
    assert.equal(h.handoff.inspect(prepared.handoffId).state, "prepared");
    assert.equal(h.control.inspect(predecessor.executionId).execution.currentEpoch, predecessor.epoch);
    assert.equal(h.control.inspect(predecessor.executionId).leases.length, 1);
    assert.equal(h.control.assertCapability(predecessor, "callback"), true);
  } finally {
    h.cleanup();
  }
});

availableTest("stable transactional inboxes retain logically exactly-once delivery beyond 64 ids", function () {
  var h = harness();
  try {
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: h.store });
    var digest = "a".repeat(64);
    var effects = 0;
    for (var i = 0; i < 100; i++) {
      var envelope = delivery.enqueue({ messageId: "message-" + i, sender: SOURCE, recipient: NEW,
        kind: "rehydration", referenceId: "checkpoint-" + i,
        payloadReference: "delivery-" + i, payloadDigest: digest });
      var received = delivery.receive(envelope, { kind: "rehydrate", target: NEW });
      assert.equal(received.duplicate, false);
    }
    var duplicate = delivery.receive(delivery.inspectOutbox("message-0"), { kind: "rehydrate", target: NEW });
    assert.equal(duplicate.duplicate, true);
    assert.throws(function () {
      delivery.enqueue({ messageId: "message-0", sender: SOURCE, recipient: NEW,
        kind: "rehydration", referenceId: "checkpoint-0", payloadDigest: "c".repeat(64) });
    }, function (error) { return error && error.code === "COOP_CONTROL_DELIVERY_CONFLICT"; });
    delivery.reconcile(function () { effects += 1; return { receiptId: "receipt-" + effects }; });
    delivery.reconcile(function () { effects += 1; return { receiptId: "unexpected" }; });
    assert.equal(effects, 100);
    assert.equal(delivery.listInbox().length, 100);
    assert.equal(delivery.listEffects().filter(function (item) { return item.state === "received"; }).length, 100);
    delivery.close();
    h.handoff.close();
    h.control.close();
    h.store.close();
    var reopened = storeModule.openControlStore({ dbPath: h.dbPath });
    assert.equal(reopened.listInbox().length, 100);
    assert.equal(reopened.listEffects().length, 100);
    assert.equal(reopened.getDeliveryPayload("message-0").payload_reference, "delivery-0");
    assert.equal(Object.prototype.hasOwnProperty.call(reopened.getDeliveryPayload("message-0"), "payload"), false);
    reopened.close();
  } finally {
    h.cleanup();
  }
});

availableTest("effect intent survives a crash window and reconciliation reuses the same effect id", function () {
  var h = harness();
  try {
    var crash = true;
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: h.store, faults: {
      afterEffect: function () { if (crash) throw new Error("crash after visible effect"); },
    } });
    var envelope = delivery.enqueue({ messageId: "message-visible", sender: SOURCE, recipient: NEW,
      kind: "rehydration", referenceId: "checkpoint-visible", payloadDigest: "b".repeat(64) });
    delivery.receive(envelope, { kind: "rehydrate", target: NEW });
    var visible = Object.create(null);
    function apply(effect) {
      if (!visible[effect.effectId]) visible[effect.effectId] = 1;
      return { receiptId: "receipt-visible" };
    }
    assert.throws(function () { delivery.reconcile(apply); }, /crash after visible effect/);
    crash = false;
    delivery.reconcile(apply);
    assert.equal(Object.keys(visible).length, 1);
    assert.equal(delivery.listEffects()[0].state, "received");
  } finally {
    h.cleanup();
  }
});

availableTest("startup recovery keeps its barrier closed until post-cutover replay converges", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var prepared = h.handoff.prepare({ class: "B", reason: "empty_turns", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: continuityPacket(predecessor) });
    h.handoff.ensureSuccessor(prepared.handoffId, function () { return successorEvidence(NEW); });
    var cutover = h.handoff.cutover(prepared.handoffId);
    var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
      executionControl: h.control, handoffControl: h.handoff });
    assert.throws(function () { startup.assertReady(); }, function (error) {
      return error && error.code === "COOP_CONTROL_RECOVERY_BARRIER_CLOSED";
    });
    var result = startup.recover({
      activate: function (record, token) { h.control.markProviderStarted(token); return true; },
      rehydrate: function (record, checkpoint, token) {
        assert.equal(checkpoint.exam.passed, true);
        assert.equal(token.epoch, cutover.token.epoch + 1);
        return true;
      },
    });
    assert.equal(result.recoveredHandoffs, 1);
    assert.equal(startup.isReady(), true);
    assert.equal(h.handoff.inspect(prepared.handoffId).state, "completed");
    assert.equal(h.control.inspect(predecessor.executionId).leases.length, 1);
  } finally {
    h.cleanup();
  }
});

availableTest("startup recovery terminalizes non-handoff incarnations before opening the barrier", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
      executionControl: h.control, handoffControl: h.handoff });
    var result = startup.recover({});
    assert.equal(result.recoveredExecutions, 1);
    assert.equal(startup.isReady(), true);
    assert.equal(h.control.inspect(predecessor.executionId).execution.status, "failed");
    assert.throws(function () {
      h.control.assertCapability(predecessor, "callback");
    }, function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; });
  } finally {
    h.cleanup();
  }
});

availableTest("checkpoint corruption fails activation closed instead of appearing empty", function () {
  var h = harness();
  var handoffId;
  try {
    var predecessor = started(h.control);
    handoffId = h.handoff.prepare({ class: "A", reason: "provider_unhealthy", predecessor: predecessor,
      from: OLD, continuity: continuityPacket(predecessor) }).handoffId;
    h.handoff.close();
    h.control.close();
    h.store.close();
    var sqlite = require("node:sqlite");
    var db = new sqlite.DatabaseSync(h.dbPath);
    db.prepare("UPDATE coop_control_checkpoints SET packet_digest = ? WHERE handoff_id = ?")
      .run("f".repeat(64), handoffId);
    db.close();
    assert.throws(function () {
      storeModule.openControlStore({ dbPath: h.dbPath });
    }, function (error) { return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION"; });
  } finally {
    h.cleanup();
  }
});
