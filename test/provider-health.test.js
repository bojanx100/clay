var test = require("node:test");
var assert = require("node:assert");

var providerHealth = require("../lib/provider-health");

// Base timestamp used across the injected-clock tests.
var T0 = 1000000;

test("three qualifying failures within the window mark the vendor unhealthy", function () {
  providerHealth._reset();

  providerHealth.recordFailure("claude", "transient", { now: T0 });
  var afterOne = providerHealth.getHealth("claude");
  assert.strictEqual(afterOne.state, "degraded");
  assert.strictEqual(afterOne.consecutiveFailures, 1);

  providerHealth.recordFailure("claude", "watchdog", { now: T0 + 1000 });
  var afterTwo = providerHealth.getHealth("claude");
  assert.strictEqual(afterTwo.state, "degraded");
  assert.strictEqual(afterTwo.consecutiveFailures, 2);

  providerHealth.recordFailure("claude", "transient", { now: T0 + 2000 });
  var afterThree = providerHealth.getHealth("claude");
  assert.strictEqual(afterThree.state, "unhealthy");
  assert.strictEqual(afterThree.consecutiveFailures, 3);
  assert.strictEqual(afterThree.unhealthySince, T0 + 2000);
  assert.strictEqual(afterThree.lastError, "transient");
});

test("two qualifying failures leave the vendor degraded, not unhealthy", function () {
  providerHealth._reset();

  providerHealth.recordFailure("codex", "transient", { now: T0 });
  providerHealth.recordFailure("codex", "transient", { now: T0 + 500 });

  var health = providerHealth.getHealth("codex");
  assert.strictEqual(health.state, "degraded");
  assert.strictEqual(health.consecutiveFailures, 2);
  assert.strictEqual(health.unhealthySince, null);
});

test("failures spaced beyond the window restart the streak", function () {
  providerHealth._reset();
  // Default window is 120000ms.
  providerHealth.recordFailure("claude", "a", { now: T0 });
  providerHealth.recordFailure("claude", "b", { now: T0 + 60000 });
  assert.strictEqual(providerHealth.getHealth("claude").consecutiveFailures, 2);

  // This failure lands well beyond the 120s window since the previous one, so
  // the streak restarts at 1 and the vendor stays degraded.
  providerHealth.recordFailure("claude", "c", { now: T0 + 60000 + 200000 });
  var health = providerHealth.getHealth("claude");
  assert.strictEqual(health.consecutiveFailures, 1);
  assert.strictEqual(health.state, "degraded");
});

test("a strong signal extends the streak even outside the window", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "a", { now: T0 });
  providerHealth.recordFailure("claude", "b", { now: T0 + 1000 });

  // Way outside the window, but strong: it still extends the streak to 3.
  providerHealth.recordFailure("claude", "resume-gave-up", { now: T0 + 500000, strong: true });
  var health = providerHealth.getHealth("claude");
  assert.strictEqual(health.consecutiveFailures, 3);
  assert.strictEqual(health.state, "unhealthy");
});

test("a definitive unavailable signal marks the provider unhealthy immediately", function () {
  providerHealth._reset();

  providerHealth.recordFailure("claude", "usage-credits-exhausted", { now: T0, immediate: true });

  var health = providerHealth.getHealth("claude");
  assert.strictEqual(health.state, "unhealthy");
  assert.strictEqual(health.consecutiveFailures, 1);
  assert.strictEqual(health.unhealthySince, T0);
  assert.strictEqual(health.lastError, "usage-credits-exhausted");
});

test("recordSuccess resets an unhealthy vendor to healthy and stamps recoveredAt", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "a", { now: T0 });
  providerHealth.recordFailure("claude", "b", { now: T0 + 100 });
  providerHealth.recordFailure("claude", "c", { now: T0 + 200 });
  assert.strictEqual(providerHealth.getHealth("claude").state, "unhealthy");

  providerHealth.recordSuccess("claude", { now: T0 + 5000 });
  var health = providerHealth.getHealth("claude");
  assert.strictEqual(health.state, "healthy");
  assert.strictEqual(health.consecutiveFailures, 0);
  assert.strictEqual(health.lastError, null);
  assert.strictEqual(health.recoveredAt, T0 + 5000);
  assert.strictEqual(health.unhealthySince, null);
});

test("recordSuccess on a healthy vendor does not stamp recoveredAt", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "a", { now: T0 });
  // Single failure = degraded, not unhealthy.
  providerHealth.recordSuccess("claude", { now: T0 + 100 });
  var health = providerHealth.getHealth("claude");
  assert.strictEqual(health.state, "healthy");
  assert.strictEqual(health.consecutiveFailures, 0);
  assert.strictEqual(health.recoveredAt, null);
});

test("configure() applies a custom threshold and window", function () {
  providerHealth._reset();
  providerHealth.configure({ failureThreshold: 2, failureWindowMs: 5000 });

  providerHealth.recordFailure("claude", "a", { now: T0 });
  assert.strictEqual(providerHealth.getHealth("claude").state, "degraded");
  providerHealth.recordFailure("claude", "b", { now: T0 + 1000 });
  assert.strictEqual(providerHealth.getHealth("claude").state, "unhealthy");

  // Reset and verify the custom (shorter) window is honoured for streak restart.
  providerHealth._reset();
  providerHealth.configure({ failureThreshold: 2, failureWindowMs: 5000 });
  providerHealth.recordFailure("claude", "a", { now: T0 });
  // 6000ms later is beyond the 5000ms window: streak restarts at 1.
  providerHealth.recordFailure("claude", "b", { now: T0 + 6000 });
  assert.strictEqual(providerHealth.getHealth("claude").consecutiveFailures, 1);
  assert.strictEqual(providerHealth.getHealth("claude").state, "degraded");
});

test("configure() ignores invalid values", function () {
  providerHealth._reset();
  providerHealth.configure({ failureThreshold: 0, failureWindowMs: -1 });
  // Defaults (threshold 3) still apply.
  providerHealth.recordFailure("claude", "a", { now: T0 });
  providerHealth.recordFailure("claude", "b", { now: T0 + 1 });
  assert.strictEqual(providerHealth.getHealth("claude").state, "degraded");
  providerHealth.recordFailure("claude", "c", { now: T0 + 2 });
  assert.strictEqual(providerHealth.getHealth("claude").state, "unhealthy");
});

test("vendor state is isolated across providers", function () {
  providerHealth._reset();
  providerHealth.recordFailure("codex", "a", { now: T0 });
  providerHealth.recordFailure("codex", "b", { now: T0 + 100 });
  providerHealth.recordFailure("codex", "c", { now: T0 + 200 });

  assert.strictEqual(providerHealth.getHealth("codex").state, "unhealthy");
  // claude never saw a failure — still healthy.
  assert.strictEqual(providerHealth.getHealth("claude").state, "healthy");
  assert.strictEqual(providerHealth.getHealth("claude").consecutiveFailures, 0);

  var all = providerHealth.getAllHealth();
  assert.strictEqual(all.codex.state, "unhealthy");
  assert.strictEqual(all.claude.state, "healthy");
});

test("getHealth defaults an unknown vendor to claude bucket", function () {
  providerHealth._reset();
  // Empty/undefined vendor keys map to the claude bucket.
  providerHealth.recordFailure(undefined, "a", { now: T0 });
  assert.strictEqual(providerHealth.getHealth(undefined).consecutiveFailures, 1);
  assert.strictEqual(providerHealth.getHealth("claude").consecutiveFailures, 1);
});
