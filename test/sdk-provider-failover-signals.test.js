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
