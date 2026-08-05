var test = require("node:test");
var assert = require("node:assert/strict");

var validId = "handoff-00000000-0000-4000-8000-000000000501";

async function client() {
  return import("../lib/public/modules/coop-handoff-client.js");
}

test("a Coop intent decorates exactly one successful session switch", async function () {
  var handoff = await client();
  assert.equal(handoff.rememberCoopHandoffIntent({ handoffTraceId: validId }), true);

  var unrelated = handoff.attachPendingHandoffTrace({ type: "refresh" });
  assert.deepEqual(unrelated, { type: "refresh" });
  var switchAction = handoff.attachPendingHandoffTrace({ type: "switch_session", storageId: "worker" });
  assert.deepEqual(switchAction, { type: "switch_session", storageId: "worker", handoffTraceId: validId });

  handoff.clearSentHandoffTrace(switchAction);
  assert.deepEqual(handoff.attachPendingHandoffTrace({ type: "switch_session", storageId: "later" }), {
    type: "switch_session", storageId: "later",
  });
});

test("a failed or pre-correlated switch preserves the pending Coop intent", async function () {
  var handoff = await client();
  handoff.rememberCoopHandoffIntent({ handoffTraceId: validId });

  var retry = handoff.attachPendingHandoffTrace({ type: "switch_session", storageId: "worker" });
  assert.equal(retry.handoffTraceId, validId, "send failure does not call clear");
  assert.deepEqual(handoff.attachPendingHandoffTrace({
    type: "switch_session", storageId: "already-set", handoffTraceId: "manual-trace",
  }), { type: "switch_session", storageId: "already-set", handoffTraceId: "manual-trace" });
  assert.equal(handoff.attachPendingHandoffTrace({ type: "switch_session", storageId: "retry" }).handoffTraceId, validId);

  handoff.clearSentHandoffTrace(retry);
  assert.equal(handoff.rememberCoopHandoffIntent({ handoffTraceId: "not-an-id" }), false);
  assert.deepEqual(handoff.attachPendingHandoffTrace({ type: "switch_session", storageId: "worker" }), {
    type: "switch_session", storageId: "worker",
  });
});
