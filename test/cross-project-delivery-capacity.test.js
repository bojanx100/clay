var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createDurableDelivery = require("../lib/cross-project-delivery").createDurableDelivery;

function withDelivery(fn) {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), "clay-delivery-capacity-"));
  var applied = [];
  var recovery = [];
  var ready = true;
  var clock = 100;
  var options = {
    deliveryFile: path.join(directory, "delivery.json"),
    now: function () { return clock; },
    recordRecoveryEvent: function (event) { recovery.push(event); },
    getProjectContextById: function () {
      return ready ? { deliverCrossProjectEnvelope: function (item) {
        applied.push(item.eventId);
        return { ok: true };
      } } : null;
    },
  };
  var delivery = createDurableDelivery(options);
  try {
    fn({
      delivery: delivery,
      applied: applied,
      recovery: recovery,
      restart: function () { return createDurableDelivery(options); },
      setReady: function (value) { ready = value; },
      advance: function () { clock += 60000; },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function reserve(delivery, id, source, destination) {
  return delivery.createEnvelope({
    eventId: "capacity-" + id,
    source: { projectId: "system-workers", sessionStorageId: "worker-" + source },
    destination: { projectId: "system-target", sessionStorageId: destination || "coordinator" },
    bindingRevision: 1,
    payload: { type: "coordinator_update", text: "Worker result " + id },
  });
}

test("new workers deliver on the first attempt across inbox and source capacity limits", function () {
  withDelivery(function (fixture) {
    var delivery = fixture.delivery;
    // Three coordinators exercise the global 512-source limit as well as the
    // per-coordinator 256-stream limit, using the real envelope factory.
    for (var i = 0; i < 520; i++) {
      var destination = i < 512 ? "coordinator-" + Math.floor(i / 256) : "coordinator-2";
      var item = reserve(delivery, i, i, destination);
      assert.equal(delivery.deliverEnvelope(item).delivered, true, "worker " + i);
    }
    for (var j = 520; j < 780; j++) {
      assert.equal(delivery.deliverEnvelope(reserve(delivery, j, j, "coordinator-2")).delivered,
        true, "worker " + j);
    }
    assert.equal(fixture.applied.length, 780);
    assert.equal(fixture.recovery.length, 0);
    assert.deepEqual(delivery.getPendingEventIds(), []);
    assert.deepEqual(delivery.getDeadLetters(), []);
    var state = delivery.getState();
    assert.ok(Object.keys(state.sequences).length <= 512);
    Object.values(state.inbox).forEach(function (inbox) {
      assert.ok(Object.keys(inbox.streams).length <= 256);
    });
    var restarted = fixture.restart();
    assert.equal(restarted.deliverEnvelope(reserve(restarted, 780, 780, "coordinator-2")).delivered,
      true);
    assert.equal(fixture.recovery.length, 0);
  });
});

test("immediate cursor reclamation preserves factory reservations and duplicate acknowledgements", function () {
  withDelivery(function (fixture) {
    var delivery = fixture.delivery;
    var first = reserve(delivery, 0, 0);
    assert.equal(delivery.deliverEnvelope(first).delivered, true);
    var unsent = reserve(delivery, "unsent", 0);
    assert.equal(unsent.sourceSeq, 2);
    for (var i = 1; i < 256; i++) {
      assert.equal(delivery.deliverEnvelope(reserve(delivery, i, i)).delivered, true);
    }
    assert.equal(delivery.deliverEnvelope(reserve(delivery, 256, 256)).delivered, true);
    assert.equal(delivery.deliverEnvelope(unsent).delivered, true);
    assert.equal(delivery.deliverEnvelope(first).duplicate, true);
    assert.equal(fixture.applied.length, 258);
    assert.equal(fixture.recovery.length, 0);
  });
});

test("inbox saturation keeps unacknowledged streams pending until their receiver recovers", function () {
  withDelivery(function (fixture) {
    var delivery = fixture.delivery;
    for (var i = 0; i < 256; i++) {
      assert.equal(delivery.deliverEnvelope(reserve(delivery, i, i)).delivered, true);
    }
    fixture.setReady(false);
    for (var j = 0; j < 256; j++) {
      assert.equal(delivery.deliverEnvelope(reserve(delivery, "next-" + j, j)).pending, true);
    }
    // Free one outbox slot without making its stream reclaimable: reserve a
    // further event before the pending one is delivered.
    var reserved = reserve(delivery, "reserved", 0);
    fixture.setReady(true);
    fixture.advance();
    assert.equal(delivery.deliverEnvelope(reserve(delivery, "next-0", 0)).delivered, true);
    var extra = reserve(delivery, "extra", 256);
    var blocked = delivery.deliverEnvelope(extra);
    assert.equal(blocked.pending, true);
    assert.equal(blocked.deadLetter.lastError, "inbox cursor capacity reached");
    assert.equal(fixture.applied.includes(extra.eventId), false);
    assert.equal(delivery.deliverEnvelope(reserve(delivery, "next-1", 1)).delivered, true);
    assert.equal(delivery.deliverEnvelope(reserved).delivered, true);
    fixture.advance();
    delivery.retryPending();
    assert.equal(fixture.applied.includes(extra.eventId), true);
    assert.deepEqual(delivery.getPendingEventIds(), []);
    assert.deepEqual(delivery.getDeadLetters(), []);
    assert.equal(new Set(fixture.applied).size, fixture.applied.length);
  });
});

test("source reservations without receiver streams are retained under global capacity pressure", function () {
  withDelivery(function (fixture) {
    var delivery = fixture.delivery;
    var first;
    for (var i = 0; i < 512; i++) {
      var item = reserve(delivery, i, i, "coordinator-" + Math.floor(i / 256));
      if (i === 0) first = item;
    }
    var extra = reserve(delivery, "extra", 512, "coordinator-2");
    assert.equal(delivery.deliverEnvelope(extra).pending, true);
    fixture.advance();
    delivery.retryPending();
    assert.equal(fixture.applied.length, 0);
    assert.equal(delivery.deliverEnvelope(first).delivered, true);
    fixture.advance();
    assert.deepEqual(delivery.retryPending(), [extra.eventId]);
  });
});
