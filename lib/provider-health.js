// Process-wide, per-provider (vendor) health state machine.
//
// A provider outage is GLOBAL: when Anthropic (claude), OpenAI (codex) or
// GitHub Copilot degrades, every project and every session driving that vendor
// sees it at once. So health is tracked per vendor in a single module-level
// registry shared through the require cache — NOT per session and NOT per
// project.
//
// THIS SLICE IS TRACKING ONLY. It observes the failure/success signals the
// stream bridge already classifies and moves each vendor through
// healthy -> degraded -> unhealthy. It performs NO failover, emits NO user
// notice and changes NO behaviour. A later slice consumes `recoveredAt` and
// the unhealthy transition to drive failover and the "healthy again" notice;
// here we only record them.

var recoveryLog = require("./recovery-log");

var HEALTHY = "healthy";
var DEGRADED = "degraded";
var UNHEALTHY = "unhealthy";

var DEFAULT_FAILURE_THRESHOLD = 3;
var DEFAULT_FAILURE_WINDOW_MS = 120000;

// Tunable config (process-wide, mirrors the global nature of the registry).
var failureThreshold = DEFAULT_FAILURE_THRESHOLD;
var failureWindowMs = DEFAULT_FAILURE_WINDOW_MS;

// vendor -> health record. Lives at module scope so it is shared across every
// importer in the process.
var registry = {};

function nowMs(opts) {
  if (opts && typeof opts.now === "number") return opts.now;
  return Date.now();
}

function freshRecord() {
  return {
    state: HEALTHY,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastError: null,
    unhealthySince: null,
    recoveredAt: null,
  };
}

function keyFor(vendor) {
  return vendor || "claude";
}

function getRecord(vendor) {
  var key = keyFor(vendor);
  if (!registry[key]) registry[key] = freshRecord();
  return registry[key];
}

// Keep the stored reason short and single-line so the record stays cheap to log
// and inspect.
function shortReason(reason) {
  if (!reason) return null;
  return String(reason).replace(/\s+/g, " ").trim().slice(0, 120);
}

function logTransition(vendor, fromState, toState, rec) {
  try {
    recoveryLog.recordRecoveryEvent({
      kind: "provider_health",
      vendor: keyFor(vendor),
      from: fromState,
      to: toState,
      consecutiveFailures: rec.consecutiveFailures,
      lastError: rec.lastError || null,
    });
  } catch (e) {
    // Health logging must never disrupt the stream path.
  }
}

// Apply configurable thresholds. Called at bridge-creation time with values
// read from daemon config; safe to call repeatedly (health is process-wide).
function configure(opts) {
  if (!opts) return;
  if (typeof opts.failureThreshold === "number" && opts.failureThreshold > 0) {
    failureThreshold = Math.floor(opts.failureThreshold);
  }
  if (typeof opts.failureWindowMs === "number" && opts.failureWindowMs > 0) {
    failureWindowMs = Math.floor(opts.failureWindowMs);
  }
}

// Record a qualifying failure for `vendor`. `reason` is a short human string
// stored as `lastError`. `opts`:
//   - now:    inject the clock (ms) for tests / determinism.
//   - strong: this is an immediately-strong signal (e.g. auto-resume gave up).
//             A strong failure always extends the streak even if the previous
//             failure has already aged out of the rolling window.
function recordFailure(vendor, reason, opts) {
  var key = keyFor(vendor);
  var rec = getRecord(key);
  var now = nowMs(opts);
  var strong = !!(opts && opts.strong);

  var withinWindow = rec.lastFailureAt != null
    && (now - rec.lastFailureAt) <= failureWindowMs;

  if (rec.consecutiveFailures === 0) {
    // First failure of a fresh streak.
    rec.consecutiveFailures = 1;
  } else if (withinWindow || strong) {
    // Still inside the rolling window (or a strong signal that ignores it):
    // extend the current streak.
    rec.consecutiveFailures = rec.consecutiveFailures + 1;
  } else {
    // The previous failure aged out of the window: restart the streak.
    rec.consecutiveFailures = 1;
  }

  rec.lastFailureAt = now;
  rec.lastError = shortReason(reason);

  var prevState = rec.state;
  if (rec.consecutiveFailures >= failureThreshold) {
    rec.state = UNHEALTHY;
    if (prevState !== UNHEALTHY) {
      rec.unhealthySince = now;
      rec.recoveredAt = null;
      logTransition(key, prevState, UNHEALTHY, rec);
    }
  } else {
    // Any qualifying failure while healthy drops the vendor to degraded.
    rec.state = DEGRADED;
  }

  return rec;
}

// Record a clean turn completion for `vendor`. Resets the streak and returns
// the vendor to healthy. If the vendor was unhealthy, stamp `recoveredAt` (the
// hook a later slice uses for the "healthy again" notice — recorded, not
// notified here).
function recordSuccess(vendor, opts) {
  var key = keyFor(vendor);
  var rec = getRecord(key);
  var now = nowMs(opts);
  var prevState = rec.state;

  rec.consecutiveFailures = 0;
  rec.lastError = null;
  rec.state = HEALTHY;

  if (prevState === UNHEALTHY) {
    rec.recoveredAt = now;
    rec.unhealthySince = null;
    logTransition(key, prevState, HEALTHY, rec);
  }

  return rec;
}

// Snapshot (copy) of a single vendor's health.
function getHealth(vendor) {
  return Object.assign({}, getRecord(vendor));
}

// Snapshot (copy) of every tracked vendor's health, keyed by vendor.
function getAllHealth() {
  var out = {};
  for (var k in registry) {
    if (Object.prototype.hasOwnProperty.call(registry, k)) {
      out[k] = Object.assign({}, registry[k]);
    }
  }
  return out;
}

// Test helper: wipe the registry and restore default config.
function _reset() {
  registry = {};
  failureThreshold = DEFAULT_FAILURE_THRESHOLD;
  failureWindowMs = DEFAULT_FAILURE_WINDOW_MS;
}

module.exports = {
  recordFailure: recordFailure,
  recordSuccess: recordSuccess,
  getHealth: getHealth,
  getAllHealth: getAllHealth,
  configure: configure,
  _reset: _reset,
  HEALTHY: HEALTHY,
  DEGRADED: DEGRADED,
  UNHEALTHY: UNHEALTHY,
};
