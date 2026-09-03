var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createDurableDelivery = require("../lib/cross-project-delivery").createDurableDelivery;
var SCHEMA = require("../lib/cross-project-delivery").SCHEMA;
var SCHEMA_VERSION = require("../lib/cross-project-delivery").SCHEMA_VERSION;

var SOURCE = { projectId: "system-source", sessionStorageId: "source-session" };
var TARGET = { projectId: "system-target", sessionStorageId: "target-session" };

function temporaryFile() {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cross-project-"));
  return { directory: directory, file: path.join(directory, "delivery.json") };
}

function envelope(eventId, seq, text) {
  return {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    eventId: eventId,
    source: SOURCE,
    destination: TARGET,
    bindingRevision: 1,
    sourceSeq: seq,
    createdAt: 100,
    payload: { type: "coordinator_update", text: text || eventId },
  };
}

function withTransport(options, fn) {
  var scratch = temporaryFile();
  try {
    fn(scratch, options || {});
  } finally {
    fs.rmSync(scratch.directory, { recursive: true, force: true });
  }
}

test("typed delivery validates its versioned envelope and records invalid payload once", function () {
  withTransport({}, function (scratch) {
    var recovery = [];
    var delivery = createDurableDelivery({
      deliveryFile: scratch.file,
      recordRecoveryEvent: function (event) { recovery.push(event); },
    });
    var invalid = envelope("invalid-schema", 1, "ignored");
    invalid.schemaVersion = 99;

    var first = delivery.deliverEnvelope(invalid);
    var second = delivery.deliverEnvelope(invalid);

    assert.equal(first.reason, "unsupported_schema");
    assert.equal(first.deadLettered, true);
    assert.equal(second.reason, "unsupported_schema");
    assert.equal(delivery.getDeadLetters().length, 1);
    assert.equal(recovery.length, 1);
  });
});

test("duplicate typed delivery is acknowledged after one target application", function () {
  withTransport({}, function (scratch) {
    var applied = [];
    var delivery = createDurableDelivery({
      deliveryFile: scratch.file,
      getProjectContextById: function (projectId) {
        if (projectId !== TARGET.projectId) return null;
        return {
          deliverCrossProjectEnvelope: function (item) {
            applied.push(item.eventId);
            return { ok: true };
          },
        };
      },
    });
    var item = envelope("apply-once", 1);

    assert.equal(delivery.deliverEnvelope(item).acknowledged, true);
    assert.deepEqual(delivery.deliverEnvelope(item), {
      ok: true,
      duplicate: true,
      acknowledged: true,
    });
    assert.deepEqual(applied, ["apply-once"]);
    assert.deepEqual(delivery.getPendingEventIds(), []);
    assert.equal(delivery.getState().inbox["system-target:target-session"].streams[
      "system-source:source-session>system-target:target-session"].cursor, 1);
  });
});

test("out-of-order delivery buffers until the source sequence gap is filled", function () {
  withTransport({}, function (scratch) {
    var applied = [];
    var delivery = createDurableDelivery({
      deliveryFile: scratch.file,
      retryBaseMs: 1,
      getProjectContextById: function () {
        return { deliverCrossProjectEnvelope: function (item) {
          applied.push(item.eventId);
          return { ok: true };
        } };
      },
    });

    var second = delivery.deliverEnvelope(envelope("second", 2));
    assert.equal(second.reason, "sequence_gap");
    assert.deepEqual(applied, []);

    var first = delivery.deliverEnvelope(envelope("first", 1));
    assert.equal(first.ok, true);
    assert.deepEqual(applied, ["first", "second"]);
    assert.deepEqual(delivery.getPendingEventIds(), []);
  });
});

test("the envelope factory reserves source sequences before multiple events are sent", function () {
  withTransport({}, function (scratch) {
    var applied = [];
    var delivery = createDurableDelivery({
      deliveryFile: scratch.file,
      getProjectContextById: function () {
        return { deliverCrossProjectEnvelope: function (item) {
          applied.push(item.eventId);
          return { ok: true };
        } };
      },
    });
    var first = delivery.createEnvelope({
      eventId: "factory-first",
      source: SOURCE,
      destination: TARGET,
      bindingRevision: 1,
      createdAt: 100,
      payload: { type: "coordinator_update", text: "first" },
    });
    var second = delivery.createEnvelope({
      eventId: "factory-second",
      source: SOURCE,
      destination: TARGET,
      bindingRevision: 1,
      createdAt: 101,
      payload: { type: "coordinator_update", text: "second" },
    });

    assert.equal(first.sourceSeq, 1);
    assert.equal(second.sourceSeq, 2);
    assert.equal(delivery.deliverEnvelope(second).reason, "sequence_gap");
    assert.equal(delivery.deliverEnvelope(first).ok, true);
    assert.deepEqual(applied, ["factory-first", "factory-second"]);
  });
});

test("source cursor capacity stays retryable and redelivers after bounded cursor reconciliation", function () {
  withTransport({}, function (scratch) {
    var clock = 0;
    var applied = [];
    var recovery = [];
    var options = {
      deliveryFile: scratch.file,
      now: function () { return clock; },
      retryBaseMs: 5,
      recordRecoveryEvent: function (event) { recovery.push(event); },
      getProjectContextById: function (projectId) {
        if (projectId !== TARGET.projectId) return null;
        return { deliverCrossProjectEnvelope: function (received) {
          applied.push(received.eventId);
          return { ok: true };
        } };
      },
    };
    var delivery = createDurableDelivery(options);

    for (var i = 0; i < 512; i++) {
      var targetSession = i < 256 ? "cursor-a" : "cursor-b";
      var reserved = {
        schema: SCHEMA,
        schemaVersion: SCHEMA_VERSION,
        eventId: "cursor-reserved-" + i,
        source: { projectId: "system-source-" + i, sessionStorageId: "session-" + i },
        destination: { projectId: TARGET.projectId, sessionStorageId: targetSession },
        bindingRevision: 1,
        sourceSeq: 1,
        createdAt: i,
        payload: { type: "coordinator_update", text: "reserved " + i },
      };
      assert.equal(delivery.deliverEnvelope(reserved).delivered, true, "reserved " + i);
    }
    assert.equal(Object.keys(delivery.getState().sequences).length, 512);

    var blocked = {
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      eventId: "cursor-capacity-needs-input",
      source: { projectId: "system-source-needs-input", sessionStorageId: "worker-needs-input" },
      destination: { projectId: TARGET.projectId, sessionStorageId: "cursor-c" },
      bindingRevision: 1,
      sourceSeq: 1,
      createdAt: 513,
      payload: { type: "coordinator_update", text: "worker needs input" },
    };
    var first = delivery.deliverEnvelope(blocked);

    assert.equal(first.deadLettered, true);
    assert.equal(first.pending, true);
    assert.deepEqual(delivery.getPendingEventIds(), ["cursor-capacity-needs-input"]);
    assert.equal(applied.includes("cursor-capacity-needs-input"), false);
    assert.deepEqual(recovery.map(function (event) { return event.lastError; }), [
      "source cursor capacity reached",
    ]);

    // Older capacity failures were persisted only as a dead letter, with no
    // outbox record for retry. Simulate that exact durable pre-repair state.
    var persisted = delivery.getState();
    delete persisted.outbox[blocked.eventId];
    fs.writeFileSync(scratch.file, JSON.stringify(persisted));

    clock = 5;
    var afterRestart = createDurableDelivery(options);
    assert.deepEqual(afterRestart.retryPending(), ["cursor-capacity-needs-input"]);
    assert.equal(applied.includes("cursor-capacity-needs-input"), true);
    assert.deepEqual(afterRestart.getPendingEventIds(), []);
    assert.equal(afterRestart.getDeadLetters().length, 0);
    assert.equal(Object.keys(afterRestart.getState().sequences).length, 512);
  });
});

test("unacknowledged events survive restart and apply once when the project returns", function () {
  withTransport({}, function (scratch) {
    var clock = 100;
    var beforeRestart = createDurableDelivery({
      deliveryFile: scratch.file,
      now: function () { return clock; },
      retryBaseMs: 10,
      getProjectContextById: function () { return null; },
    });
    var item = envelope("restart-replay", 1);
    assert.equal(beforeRestart.deliverEnvelope(item).reason, "project_unavailable");
    assert.deepEqual(beforeRestart.getPendingEventIds(), ["restart-replay"]);

    var applied = [];
    clock = 110;
    var afterRestart = createDurableDelivery({
      deliveryFile: scratch.file,
      now: function () { return clock; },
      retryBaseMs: 10,
      getProjectContextById: function () {
        return { deliverCrossProjectEnvelope: function (received) {
          applied.push(received.eventId);
          return { ok: true };
        } };
      },
    });
    assert.deepEqual(afterRestart.retryPending(), ["restart-replay"]);
    assert.deepEqual(applied, ["restart-replay"]);
    assert.equal(afterRestart.deliverEnvelope(item).duplicate, true);
    assert.deepEqual(applied, ["restart-replay"]);
  });
});

test("bounded transient retries dead-letter once with observable reason evidence", function () {
  withTransport({}, function (scratch) {
    var clock = 0;
    var recovery = [];
    var delivery = createDurableDelivery({
      deliveryFile: scratch.file,
      now: function () { return clock; },
      retryBaseMs: 5,
      maxAttempts: 2,
      recordRecoveryEvent: function (event) { recovery.push(event); },
      getProjectContextById: function () {
        return { deliverCrossProjectEnvelope: function () {
          return { ok: false, reason: "delivery_error" };
        } };
      },
    });
    assert.equal(delivery.deliverEnvelope(envelope("bounded-retry", 1)).pending, true);
    clock = 5;
    assert.deepEqual(delivery.retryPending(), []);
    var deadLetters = delivery.getDeadLetters();
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0].reason, "delivery_error");
    assert.equal(deadLetters[0].attempts, 2);
    assert.equal(recovery.length, 1);
    assert.equal(delivery.deliverEnvelope(envelope("bounded-retry", 1)).deadLettered, true);
    assert.equal(delivery.getDeadLetters().length, 1);
  });
});

test("a conflicting event-id reuse does not poison the acknowledged envelope", function () {
  withTransport({}, function (scratch) {
    var delivery = createDurableDelivery({
      deliveryFile: scratch.file,
      getProjectContextById: function () {
        return { deliverCrossProjectEnvelope: function () { return { ok: true }; } };
      },
    });
    var original = envelope("immutable-event", 1, "original");
    var conflicting = envelope("immutable-event", 1, "tampered");

    assert.equal(delivery.deliverEnvelope(original).ok, true);
    assert.equal(delivery.deliverEnvelope(conflicting).reason, "invalid_payload");
    assert.equal(delivery.deliverEnvelope(original).acknowledged, true);
  });
});

test("delivery resolves the target by stable project id, not a changed slug", function () {
  withTransport({}, function (scratch) {
    var slug = "before-rename";
    var delivery = createDurableDelivery({
      deliveryFile: scratch.file,
      getProjectContextById: function (projectId) {
        if (projectId !== TARGET.projectId) return null;
        return {
          deliverCrossProjectEnvelope: function () {
            assert.equal(slug, "after-rename");
            return { ok: true };
          },
        };
      },
    });
    slug = "after-rename";
    assert.equal(delivery.deliverEnvelope(envelope("stable-project-ref", 1)).ok, true);
  });
});
