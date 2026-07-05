// Regression tests for vendor-handoff context injection and consumption.
//
// Observed defects: (1) the live send path kept re-injecting the full handoff
// transcript for the whole 4-turn budget even after the new vendor responded
// successfully (token waste + "just handed off" re-framing — the exact bug
// sessions-loader already fixed for the restart path); (2) synthetic sends
// (scheduled messages) bypassed injection entirely, reaching the new vendor
// with zero context.
var test = require("node:test");
var assert = require("node:assert");

var handoff = require("../lib/handoff-context");

function switchedSession(vendor, context) {
  return {
    vendor: vendor,
    handoffContext: context || "<clay_handoff_context>prior work</clay_handoff_context>",
    handoffContextTurnsRemaining: handoff.handoffTurnBudgetForVendor(vendor),
  };
}

test("applyHandoffToOutgoingText wraps the message and burns one turn", function () {
  var s = switchedSession("codex");
  var out = handoff.applyHandoffToOutgoingText(s, "fix the login bug");
  assert.ok(out.indexOf("<clay_handoff_context>") === 0, "context prepended");
  assert.ok(out.indexOf("<current_user_message>\nfix the login bug\n</current_user_message>") !== -1);
  assert.strictEqual(s.handoffContextTurnsRemaining, 3);
  assert.ok(s.handoffContext, "context retained while budget remains");
  assert.ok(!s.handoffContextConsumed);
});

test("budget exhaustion consumes the handoff terminally", function () {
  var s = switchedSession("codex");
  for (var i = 0; i < 4; i++) handoff.applyHandoffToOutgoingText(s, "msg " + i);
  assert.strictEqual(s.handoffContext, null);
  assert.strictEqual(s.handoffContextConsumed, true);
  // Further sends pass through untouched.
  assert.strictEqual(handoff.applyHandoffToOutgoingText(s, "plain"), "plain");
});

test("github-copilot gets exactly one handoff turn and arms the native reset", function () {
  var s = switchedSession("github-copilot");
  s.handoffContextTurnsRemaining = 4; // stale/over-provisioned value must clamp
  handoff.applyHandoffToOutgoingText(s, "hello");
  assert.strictEqual(s.handoffContext, null);
  assert.strictEqual(s.handoffContextConsumed, true);
  assert.strictEqual(s.copilotResetAfterCurrentHandoffTurn, true);
});

test("a successful turn finalizes the handoff early (budget is retry headroom)", function () {
  var s = switchedSession("codex");
  handoff.applyHandoffToOutgoingText(s, "first message"); // turns 4 -> 3
  // New vendor responded with real output -> native session carries context.
  assert.strictEqual(handoff.finalizeHandoffAfterSuccessfulTurn(s), true);
  assert.strictEqual(s.handoffContext, null);
  assert.strictEqual(s.handoffContextTurnsRemaining, 0);
  assert.strictEqual(s.handoffContextConsumed, true);
  // No pending handoff -> finalize is a no-op returning false.
  assert.strictEqual(handoff.finalizeHandoffAfterSuccessfulTurn(s), false);
});

test("no pending handoff leaves outgoing text untouched", function () {
  var s = { vendor: "codex" };
  assert.strictEqual(handoff.applyHandoffToOutgoingText(s, "hello"), "hello");
  assert.strictEqual(handoff.applyHandoffToOutgoingText(null, "hello"), "hello");
});
