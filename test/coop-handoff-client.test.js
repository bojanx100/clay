var test = require("node:test");
var assert = require("node:assert/strict");

var validId = "handoff-00000000-0000-4000-8000-000000000501";

async function client() {
  return import("../lib/public/modules/coop-handoff-client.js");
}

test("a server Coop intent serializes exactly one later session switch", async function () {
  var handoff = await client();
  var sent = [];
  assert.equal(handoff.rememberCoopHandoffIntent({ type: "coop_handoff_intent", handoffTraceId: validId }), true);

  var recordingWs = { send: function (serialized) { sent.push(JSON.parse(serialized)); } };
  assert.equal(handoff.sendCorrelatedAction(recordingWs, { type: "refresh" }), true);
  assert.deepEqual(sent, [{ type: "refresh" }]);
  assert.equal(handoff.sendCorrelatedAction(recordingWs, { type: "switch_session", storageId: "worker" }), true);
  assert.deepEqual(sent[1], { type: "switch_session", storageId: "worker", handoffTraceId: validId });

  assert.equal(handoff.sendCorrelatedAction(recordingWs, { type: "switch_session", storageId: "later" }), true);
  assert.deepEqual(sent[2], { type: "switch_session", storageId: "later" });
});

test("a failed or pre-correlated switch preserves the pending Coop intent", async function () {
  var handoff = await client();
  var sent = [];
  handoff.rememberCoopHandoffIntent({ type: "coop_handoff_intent", handoffTraceId: validId });

  assert.equal(handoff.sendCorrelatedAction({ send: function () {
    throw new Error("socket write failed");
  } }, { type: "switch_session", storageId: "worker" }), false, "send failure does not consume the trace");
  var recordingWs = { send: function (serialized) { sent.push(JSON.parse(serialized)); } };
  assert.equal(handoff.sendCorrelatedAction(recordingWs, {
    type: "switch_session", storageId: "already-set", handoffTraceId: "manual-trace",
  }), true);
  assert.deepEqual(sent[0], { type: "switch_session", storageId: "already-set", handoffTraceId: "manual-trace" });
  assert.equal(handoff.sendCorrelatedAction(recordingWs, { type: "switch_session", storageId: "retry" }), true);
  assert.equal(sent[1].handoffTraceId, validId);

  assert.equal(handoff.rememberCoopHandoffIntent({ type: "coop_handoff_intent", handoffTraceId: "not-an-id" }), false);
});
