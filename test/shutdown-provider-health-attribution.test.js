// Regression test: a daemon shutdown must not be scored as a provider failure.
//
// Observed 2026-09-04. Six daemon restarts inside one working period
// (pids 61877 -> 45660 -> 67768 -> 89408 -> 6193 -> 45993, each SIGTERMed by
// its own parent) each aborted the turn that was in flight. Teardown destroys
// every project, which closes the provider stream, and the abort surfaced as an
// ordinary stream failure:
//
//   [yoke/github-copilot] prompt failed for session fef28e65...:
//       GitHub Copilot session closed
//
// Three of those aborts landed on claude-github-copilot inside the 120s window,
// so ~/.clay/recovery-events-dev.log recorded:
//
//   10:08:30.904  provider_health   claude-opus-5  healthy  -> degraded    (1 failure)
//   10:09:37.076  provider_health   claude-opus-5  degraded -> unhealthy   (3 failures)
//   10:09:37.195  provider_failover session 263    github-copilot -> claude
//
// Copilot was healthy throughout; Clay killed its own stream and then blamed
// the vendor, marked a working route unhealthy, and moved a live session to a
// different provider. The owner saw only "Claude process error: ACP connection
// closed".
//
// The fix is a one-way shutdown latch consulted by recordFailure(), set in
// gracefulShutdown() before shutdownProjects() runs.
//
// NOTE ON WHY THIS IS NOT A MESSAGE FILTER: "ACP connection closed" is a
// genuine provider failure when the daemon is up, and must still fail over.
// The final test below is the one that would catch a regression to text
// matching, so it deliberately uses the exact same reason string as the
// suppressed cases.

var test = require("node:test");
var assert = require("node:assert");
require("./helpers/isolated-clay-home");

var providerHealth = require("../lib/provider-health");
var failoverSignals = require("../lib/sdk-provider-failover-signals");
require("../lib/recovery-log").recordRecoveryEvent = function () {};

var T0 = 1000000;
var COPILOT = { providerRouteId: "claude-github-copilot", model: "claude-opus-5" };

// The literal message from the 09-04 log.
var ABORT = "provider-error:ACP connection closed";

function copilotHealth() {
  return providerHealth.getRouteHealth("github-copilot", COPILOT.providerRouteId, COPILOT.model);
}

function abortThreeTimes() {
  providerHealth.recordFailure("github-copilot", ABORT,
    Object.assign({ now: T0 }, COPILOT));
  providerHealth.recordFailure("github-copilot", ABORT,
    Object.assign({ now: T0 + 30000 }, COPILOT));
  providerHealth.recordFailure("github-copilot", ABORT,
    Object.assign({ now: T0 + 66000 }, COPILOT));
}

// --- The control ------------------------------------------------------------
// Establishes that this input really does condemn the route, so the suppression
// test below is proving the latch works rather than exercising an input that
// was harmless all along.

test("CONTROL: three stream aborts with the daemon up still mark the route unhealthy", function () {
  providerHealth._reset();

  abortThreeTimes();

  var health = copilotHealth();
  assert.strictEqual(health.state, "unhealthy",
    "a real provider failure must still condemn the route - this is the behaviour we are keeping");
  assert.strictEqual(health.consecutiveFailures, 3);
});

// --- The fix ----------------------------------------------------------------

test("the same three aborts during shutdown leave the route healthy", function () {
  providerHealth._reset();

  providerHealth.markLocalShutdown();
  abortThreeTimes();

  var health = copilotHealth();
  assert.strictEqual(health.state, "healthy",
    "aborts caused by our own teardown must not be scored against the provider");
  assert.strictEqual(health.consecutiveFailures, 0, "no failure may be counted at all");
  assert.strictEqual(health.lastError, null, "shutdown noise must not be recorded as a provider error");
});

test("no failover is queued for a session whose stream we aborted ourselves", function () {
  providerHealth._reset();
  providerHealth.markLocalShutdown();

  // Shaped like the real session 263 that got moved to claude-anthropic.
  var session = {
    providerRouteId: COPILOT.providerRouteId,
    verifiedModel: COPILOT.model,
    onQueryComplete: function () {},
  };

  failoverSignals.recordProviderFailure(session, "github-copilot", ABORT, { now: T0 });
  failoverSignals.recordProviderFailure(session, "github-copilot", ABORT, { now: T0 + 30000 });
  failoverSignals.recordProviderFailure(session, "github-copilot", ABORT, { now: T0 + 66000 });

  assert.strictEqual(session.providerFailoverPending, undefined,
    "the pending-failover handoff is what actually moved session 263 off Copilot");

  var queued = failoverSignals.queuePendingProviderFailover(session, {
    queueProviderFailover: function () { return true; },
  });
  assert.strictEqual(queued, false, "there must be nothing for the failover queue to pick up");
});

test("the latch suppresses every vendor and scope, not just the route that hit it", function () {
  providerHealth._reset();
  providerHealth.markLocalShutdown();

  // Vendor-scoped: an auth-shaped reason routes to the vendor record.
  providerHealth.recordFailure("claude", "authentication failed", { now: T0 });
  providerHealth.recordFailure("claude", "authentication failed", { now: T0 + 1000 });
  providerHealth.recordFailure("claude", "authentication failed", { now: T0 + 2000 });
  assert.strictEqual(providerHealth.getHealth("claude").state, "healthy");

  // Route/model-scoped on a different vendor.
  providerHealth.recordFailure("codex", "stream disconnected",
    { now: T0, providerRouteId: "codex-openai", model: "gpt-5-6-sol" });
  assert.strictEqual(
    providerHealth.getRouteHealth("codex", "codex-openai", "gpt-5-6-sol").state, "healthy");

  // An immediate/strong failure must not bypass the latch either.
  providerHealth.recordFailure("github-copilot", ABORT,
    Object.assign({ now: T0, immediate: true, strong: true }, COPILOT));
  assert.strictEqual(copilotHealth().state, "healthy",
    "immediate failures skip the threshold, so they need the latch checked first");
});

test("the latch is one-way and survives until the process exits", function () {
  providerHealth._reset();
  assert.strictEqual(providerHealth.isLocalShutdown(), false);

  providerHealth.markLocalShutdown();
  assert.strictEqual(providerHealth.isLocalShutdown(), true);

  // Nothing un-shuts-down. A success during teardown must not re-arm scoring.
  providerHealth.recordSuccess("github-copilot", COPILOT);
  providerHealth.markLocalShutdown();
  abortThreeTimes();
  assert.strictEqual(copilotHealth().state, "healthy");
  assert.strictEqual(providerHealth.isLocalShutdown(), true);
});

test("a fresh daemon scores failures again - the latch does not leak across resets", function () {
  providerHealth._reset();
  providerHealth.markLocalShutdown();
  providerHealth._reset();

  assert.strictEqual(providerHealth.isLocalShutdown(), false,
    "_reset must clear the latch or every later test in a run is silently disarmed");

  abortThreeTimes();
  assert.strictEqual(copilotHealth().state, "unhealthy",
    "the very same reason string must still condemn a route in a healthy process - "
    + "if this fails, the fix has regressed into matching the message text");
});
