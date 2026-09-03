var test = require("node:test");
var assert = require("node:assert");
require("./helpers/isolated-clay-home");

var providerHealth = require("../lib/provider-health");
require("../lib/recovery-log").recordRecoveryEvent = function () {};

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

// Regression for F-2 flapping (2026-07-24): a hard rate-limit rejection
// marked claude unhealthy, then a DIFFERENT in-flight claude turn completed
// one second later and flipped it straight back to healthy — while new sends
// were still rejected until the window reset. Successes inside a known quota
// window must not recover the vendor.
test("success inside a known quota window does not recover the vendor", function () {
  providerHealth._reset();
  var resetsAt = T0 + 60 * 60 * 1000; // window resets in an hour

  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    now: T0, immediate: true, unavailableUntil: resetsAt,
  });
  assert.strictEqual(providerHealth.getHealth("claude").state, "unhealthy");

  // An already-streaming turn completes cleanly one second later.
  providerHealth.recordSuccess("claude", { now: T0 + 1000 });
  var afterInFlight = providerHealth.getHealth("claude");
  assert.strictEqual(afterInFlight.state, "unhealthy",
    "in-flight completions must not clear quota unavailability");
  assert.strictEqual(afterInFlight.lastError, "rate-limit-rejected",
    "the unhealthy record must stay truthful during the window");

  // After the window resets, the next clean turn recovers the vendor.
  providerHealth.recordSuccess("claude", { now: resetsAt + 1000 });
  var afterReset = providerHealth.getHealth("claude");
  assert.strictEqual(afterReset.state, "healthy");
  assert.strictEqual(afterReset.recoveredAt, resetsAt + 1000);
  assert.strictEqual(afterReset.unavailableUntil, null);
});

test("unavailableUntil in the past or invalid is ignored", function () {
  providerHealth._reset();

  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    now: T0, immediate: true, unavailableUntil: T0 - 5000,
  });
  providerHealth.recordSuccess("claude", { now: T0 + 1000 });
  assert.strictEqual(providerHealth.getHealth("claude").state, "healthy",
    "a stale reset time must not pin the vendor unhealthy");

  providerHealth._reset();
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    now: T0, immediate: true, unavailableUntil: null,
  });
  providerHealth.recordSuccess("claude", { now: T0 + 1000 });
  assert.strictEqual(providerHealth.getHealth("claude").state, "healthy",
    "no reset time keeps today's success-recovers behavior");
});

test("non-quota unhealthy still recovers on the next clean turn", function () {
  providerHealth._reset();

  providerHealth.recordFailure("codex", "watchdog", { now: T0 });
  providerHealth.recordFailure("codex", "watchdog", { now: T0 + 1000 });
  providerHealth.recordFailure("codex", "watchdog", { now: T0 + 2000 });
  assert.strictEqual(providerHealth.getHealth("codex").state, "unhealthy");

  providerHealth.recordSuccess("codex", { now: T0 + 3000 });
  assert.strictEqual(providerHealth.getHealth("codex").state, "healthy",
    "outage-style unhealthiness has no window and recovers on success");
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

test("quota health is isolated to the exact provider route and model", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", {
    now: T0,
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5",
    immediate: true,
  });

  assert.strictEqual(providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-fable-5", { now: T0 }).state, "unhealthy");
  assert.strictEqual(providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-opus-4-8", { now: T0 }).state, "healthy");
  assert.strictEqual(providerHealth.getHealth("claude", { now: T0 }).state, "healthy",
    "model quota must not become vendor-wide health");
});

test("local App-server errors never penalize the provider route-model", function () {
  providerHealth._reset();
  var options = {
    now: T0,
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    strong: true,
  };

  providerHealth.recordFailure("codex", "provider-error:App-server not started", options);
  providerHealth.recordFailure("codex", "provider-error:App-server not started",
    Object.assign({}, options, { now: T0 + 1 }));
  providerHealth.recordFailure("codex", "provider-error:App-server not started",
    Object.assign({}, options, { now: T0 + 2 }));

  var health = providerHealth.getRouteHealth("codex", "codex-openai", "gpt-5.6-sol", {
    now: T0 + 2,
  });
  assert.strictEqual(health.state, "healthy");
  assert.strictEqual(health.targetState, "healthy");
  assert.strictEqual(health.consecutiveFailures, 0);
});

test("a successful Opus turn does not clear a Fable quota bucket", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    now: T0,
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5",
    immediate: true,
    unavailableUntil: T0 + 5000,
  });
  providerHealth.recordSuccess("claude", {
    now: T0 + 100,
    providerRouteId: "claude-anthropic",
    model: "claude-opus-4-8",
  });

  assert.strictEqual(providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-fable-5", { now: T0 + 100 }).state, "unhealthy");
  assert.strictEqual(providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-opus-4-8", { now: T0 + 100 }).state, "healthy");
});

test("shared authentication failures degrade every model for the vendor only", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "authentication credentials rejected", {
    now: T0,
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5",
    immediate: true,
  });

  assert.strictEqual(providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-fable-5", { now: T0 }).state, "unhealthy");
  assert.strictEqual(providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-opus-4-8", { now: T0 }).state, "unhealthy");
  assert.strictEqual(providerHealth.getHealth("codex", { now: T0 }).state, "healthy");
});

test("expired exact-model quota becomes eligible without a stale process-wide mark", function () {
  providerHealth._reset();
  providerHealth.recordFailure("codex", "rate-limit-rejected", {
    now: T0,
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    immediate: true,
    unavailableUntil: T0 + 1000,
  });

  assert.strictEqual(providerHealth.getRouteHealth("codex", "codex-openai", "gpt-5.6-sol", { now: T0 + 500 }).state, "unhealthy");
  assert.strictEqual(providerHealth.getRouteHealth("codex", "codex-openai", "gpt-5.6-sol", { now: T0 + 1001 }).state, "healthy");
});
