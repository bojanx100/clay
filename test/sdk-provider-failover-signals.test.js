var test = require("node:test");
var assert = require("node:assert");

var providerHealth = require("../lib/provider-health");
var signals = require("../lib/sdk-provider-failover-signals");
require("../lib/recovery-log").recordRecoveryEvent = function () {};

test("unhealthy provider signal queues one boundary failover when auto-continue is enabled", function () {
  providerHealth._reset();
  var session = { vendor: "claude" };
  signals.recordProviderFailure(session, "claude", "a");
  signals.recordProviderFailure(session, "claude", "b");
  signals.recordProviderFailure(session, "claude", "c");
  var queued = null;

  var handled = signals.queuePendingProviderFailover(session, {
    getAutoContinueSetting: function () { return true; },
    queueProviderFailover: function (targetSession, failure) {
      queued = { session: targetSession, failure: failure };
      return true;
    },
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(queued.session, session);
  assert.strictEqual(queued.failure.reason, "c");
  assert.strictEqual(session.providerFailoverPending, null);
  providerHealth._reset();
});

test("disabled auto-continue consumes the provider signal without switching", function () {
  providerHealth._reset();
  var session = { vendor: "claude" };
  signals.recordProviderFailure(session, "claude", "unavailable", { immediate: true });
  var calls = 0;

  var handled = signals.queuePendingProviderFailover(session, {
    getAutoContinueSetting: function () { return false; },
    queueProviderFailover: function () {
      calls++;
      return true;
    },
  });

  assert.strictEqual(handled, false);
  assert.strictEqual(calls, 0);
  assert.strictEqual(session.providerFailoverPending, null);
  providerHealth._reset();
});

test("runtime failure signals carry the exact session route and verified model", function () {
  providerHealth._reset();
  var session = {
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "best",
    verifiedModel: "claude-fable-5",
  };
  signals.recordProviderFailure(session, "claude", "rate-limit-rejected", { immediate: true });

  assert.strictEqual(session.providerFailoverPending.providerRouteId, "claude-anthropic");
  assert.strictEqual(session.providerFailoverPending.model, "claude-fable-5");
  assert.strictEqual(providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-fable-5").state, "unhealthy");
  assert.strictEqual(providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-opus-4.8").state, "healthy");
  assert.strictEqual(providerHealth.getHealth("claude").state, "healthy");
  providerHealth._reset();
});

// --- Limit-shaped vs connectivity failures ---------------------------------
//
// Only a limit failure carries a meaningful reset time. Regression for the
// 2026-08-11 Codex park: a stream disconnect inherited a stale rate-limit
// reset and scheduled an 11-hour "continue after reset".

test("a connectivity failure is not limit-shaped and carries no reset time", function () {
  providerHealth._reset();
  var session = {
    vendor: "codex",
    rateLimitLastResetsAt: Date.now() + 11 * 3600000,
  };
  var reason = "provider-error:stream disconnected before completion: error sending request for url";
  signals.recordProviderFailure(session, "codex", reason, { strong: true, immediate: true });

  var pending = session.providerFailoverPending;
  assert.ok(pending, "a strong failure still queues a failover signal");
  assert.strictEqual(pending.isLimitFailure, false);
  assert.strictEqual(pending.resetsAt, null,
    "a stale rate-limit reset must not attach to a connectivity failure");
  assert.strictEqual(signals.isLimitFailure(pending), false);
  providerHealth._reset();
});

test("limit-shaped failures keep recovering the session reset time", function () {
  providerHealth._reset();
  var resetsAt = Date.now() + 3600000;
  var session = { vendor: "claude", rateLimitLastResetsAt: resetsAt };
  signals.recordProviderFailure(session, "claude", "usage-credits-exhausted", { strong: true, immediate: true });

  var pending = session.providerFailoverPending;
  assert.strictEqual(pending.isLimitFailure, true);
  assert.strictEqual(pending.resetsAt, resetsAt);
  assert.strictEqual(signals.isLimitFailure(pending), true);
  providerHealth._reset();
});

test("isLimitFailure falls back to the reason text for externally built failures", function () {
  assert.strictEqual(signals.isLimitFailure({ reason: "rate-limit-rejected" }), true);
  assert.strictEqual(signals.isLimitFailure({ reason: "usage-credits-exhausted" }), true);
  assert.strictEqual(signals.isLimitFailure({ reason: "provider-unavailable" }), false);
  assert.strictEqual(signals.isLimitFailure({ reason: "transient:socket hang up" }), false);
  assert.strictEqual(signals.isLimitFailure(null), false);
  // An explicit stamp always wins over the text heuristic.
  assert.strictEqual(signals.isLimitFailure({ reason: "rate-limit", isLimitFailure: false }), false);
});
