var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createDelivery = require("../lib/cross-project-delivery").createDurableDelivery;

function fixture(t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-queued-envelope-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var applied = [];
  var options = { deliveryFile: path.join(dir, "delivery.json"), now: function () { return 1000; },
    getProjectContextById: function () { return { deliverCrossProjectEnvelope: function (envelope) {
      applied.push(envelope.eventId); return { ok: true };
    } }; } };
  return { options: options, delivery: createDelivery(options), applied: applied };
}

function spec(id, source, destination) {
  return { eventId: id, source: { projectId: "system-source", sessionStorageId: source || "source" },
    destination: { projectId: "system-target", sessionStorageId: destination || "target" },
    bindingRevision: 1, payload: { type: "coordinator_update", text: id } };
}

test("queueing reserves the envelope and sequence together before caller acknowledgement", function (t) {
  var f = fixture(t);
  var first = f.delivery.queueEnvelope(spec("first"));
  assert.equal(first.sourceSeq, 1);
  assert.deepEqual(f.applied, []);
  var restarted = createDelivery(f.options);
  assert.deepEqual(restarted.queueEnvelope(spec("first")), first);
  assert.equal(restarted.queueEnvelope(spec("second")).sourceSeq, 2);
  restarted.retryPending();
  assert.deepEqual(f.applied, ["first", "second"]);
  assert.deepEqual(restarted.getPendingEventIds(), []);
});

test("queueing reclaims actual idle streams and rolls the reclamation back on failed save", function (t) {
  var f = fixture(t);
  for (var i = 0; i < 512; i++) {
    var envelope = f.delivery.createEnvelope(spec("old-" + i, "old-" + i, i < 256 ? "a" : "b"));
    assert.equal(f.delivery.deliverEnvelope(envelope).ok, true);
  }
  var before = f.delivery.getState();
  assert.equal(Object.keys(before.sequences).length, 512);
  var rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (to === f.options.deliveryFile) throw new Error("Fixture persistence failure");
    return rename(from, to);
  };
  try { assert.throws(function () { f.delivery.queueEnvelope(spec("attention", "new", "c")); }, /persistence failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(f.delivery.getState(), before);
  assert.deepEqual(createDelivery(f.options).getState(), before);
  var queued = f.delivery.queueEnvelope(spec("attention", "new", "c"));
  assert.ok(queued);
  assert.equal(queued.sourceSeq, 1);
  assert.equal(Object.keys(f.delivery.getState().sequences).length, 512);
  f.delivery.retryPending();
  assert.equal(f.applied[f.applied.length - 1], "attention");
});
