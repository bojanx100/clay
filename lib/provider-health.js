// Process-wide provider health scoped at two levels:
//   1. vendor-wide for failures that truly affect shared provider access
//      (authentication, network reachability, or a provider-wide outage), and
//   2. exact provider route + model for quota and stream failures.
//
// A Fable quota rejection must not disable Opus on the same Claude route, and
// a Codex stream disconnect must not disable every Codex-capable route. The
// require cache makes both registries process-wide while keeping projects from
// owning divergent health state.

var recoveryLog = require("./recovery-log");

var HEALTHY = "healthy";
var DEGRADED = "degraded";
var UNHEALTHY = "unhealthy";

var DEFAULT_FAILURE_THRESHOLD = 3;
var DEFAULT_FAILURE_WINDOW_MS = 120000;
var DEFAULT_ROUTE_BY_VENDOR = {
  claude: "claude-anthropic",
  codex: "codex-openai",
};

var failureThreshold = DEFAULT_FAILURE_THRESHOLD;
var failureWindowMs = DEFAULT_FAILURE_WINDOW_MS;
var vendorRegistry = {};
var targetRegistry = {};
var localShutdown = false;
var eventRecorder = function (event) { recoveryLog.recordRecoveryEvent(event); };

function nowMs(opts) {
  if (opts && typeof opts.now === "number") return opts.now;
  return Date.now();
}

function vendorKey(vendor) {
  return vendor || "claude";
}

function routeKey(vendor, opts) {
  return String(opts && (opts.providerRouteId || opts.routeId) ||
    DEFAULT_ROUTE_BY_VENDOR[vendorKey(vendor)] || vendorKey(vendor));
}

function modelKey(model) {
  var value = String(model || "").toLowerCase().trim();
  if (!value) return "*";
  if (value === "best" || value === "fable" || value.indexOf("fable") !== -1) return "fable";
  return value.replace(/[_.]/g, "-");
}

function targetKey(vendor, opts) {
  return vendorKey(vendor) + "|" + routeKey(vendor, opts) + "|" + modelKey(opts && opts.model);
}

function freshRecord(scope, vendor, providerRouteId, model) {
  return {
    state: HEALTHY,
    scope: scope,
    vendor: vendorKey(vendor),
    providerRouteId: providerRouteId || null,
    model: model || null,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastError: null,
    unhealthySince: null,
    recoveredAt: null,
    unavailableUntil: null,
    clockInjected: false,
  };
}

function getVendorRecord(vendor) {
  var key = vendorKey(vendor);
  if (!vendorRegistry[key]) vendorRegistry[key] = freshRecord("vendor", key, null, null);
  return vendorRegistry[key];
}

function getTargetRecord(vendor, opts) {
  var key = targetKey(vendor, opts);
  if (!targetRegistry[key]) {
    targetRegistry[key] = freshRecord("route-model", vendor, routeKey(vendor, opts), modelKey(opts && opts.model));
  }
  return targetRegistry[key];
}

function shortReason(reason) {
  if (!reason) return null;
  return String(reason).replace(/\s+/g, " ").trim().slice(0, 120);
}

function sharedFailure(reason, opts) {
  if (opts && opts.scope === "vendor") return true;
  if (opts && (opts.scope === "route-model" || opts.scope === "route")) return false;
  if (!opts || !(opts.providerRouteId || opts.routeId || opts.model)) return true;
  return /\b(auth(?:entication|orization)?|unauthorized|forbidden|credential|login|dns|network|connection refused|provider[- ]wide|provider unavailable|api unavailable|service outage|service unavailable|http 50[23])\b/i.test(String(reason || ""));
}

// This message is emitted by Clay's local bridge while it is down or still
// starting. It says nothing about the provider route or model, so counting it
// as a provider failure can falsely fail over a healthy route.
function localRuntimeFailure(reason) {
  return /\bapp[- ]server not started\b/i.test(String(reason || ""));
}

// Tearing the daemon down aborts every in-flight provider stream. Those aborts
// arrive here as ordinary stream failures ("ACP connection closed", "session
// closed", a truncated read) and used to be scored against the provider that
// was serving the turn.
//
// Observed 2026-09-04: six daemon restarts in one working period
// (pids 61877 -> 45660 -> 67768 -> 89408 -> 6193 -> 45993) each killed the
// turn in flight. Three of those aborts landed on claude-github-copilot inside
// the 120s window, which drove claude-opus-5 healthy -> degraded -> UNHEALTHY
// and failed session 263 over to claude-anthropic. Copilot was never at fault.
//
// This is deliberately a shutdown latch and NOT a message pattern: "ACP
// connection closed" is a genuine provider failure when the daemon is up, so
// matching on the text would suppress real failover. Only the local lifecycle
// can tell the two apart, and only the process that is shutting down knows.
// One-way, like the shutdown gate's own latch: nothing un-shuts-down.
function markLocalShutdown() {
  localShutdown = true;
}

function isLocalShutdown() {
  return localShutdown;
}

function logTransition(rec, fromState, toState) {
  try {
    eventRecorder({
      kind: "provider_health",
      vendor: rec.vendor,
      providerRouteId: rec.providerRouteId,
      model: rec.model,
      scope: rec.scope,
      from: fromState,
      to: toState,
      consecutiveFailures: rec.consecutiveFailures,
      lastError: rec.lastError || null,
      unavailableUntil: rec.unavailableUntil || null,
    });
  } catch (e) {
    // Health logging must never disrupt the stream path.
  }
}

function configure(opts) {
  if (!opts) return;
  if (typeof opts.failureThreshold === "number" && opts.failureThreshold > 0) {
    failureThreshold = Math.floor(opts.failureThreshold);
  }
  if (typeof opts.failureWindowMs === "number" && opts.failureWindowMs > 0) {
    failureWindowMs = Math.floor(opts.failureWindowMs);
  }
  if (typeof opts.recordRecoveryEvent === "function") {
    eventRecorder = opts.recordRecoveryEvent;
  }
}

function recordFailure(vendor, reason, opts) {
  var options = opts || {};
  if (localShutdown || localRuntimeFailure(reason)) {
    return getHealth(vendor, options);
  }
  var rec = sharedFailure(reason, options)
    ? getVendorRecord(vendor)
    : getTargetRecord(vendor, options);
  var now = nowMs(options);
  rec.clockInjected = typeof options.now === "number";
  var strong = !!options.strong;

  if (typeof options.unavailableUntil === "number" && options.unavailableUntil > now) {
    rec.unavailableUntil = Math.max(rec.unavailableUntil || 0, options.unavailableUntil);
  }

  var withinWindow = rec.lastFailureAt != null && (now - rec.lastFailureAt) <= failureWindowMs;
  if (rec.consecutiveFailures === 0) rec.consecutiveFailures = 1;
  else if (withinWindow || strong) rec.consecutiveFailures = rec.consecutiveFailures + 1;
  else rec.consecutiveFailures = 1;

  rec.lastFailureAt = now;
  rec.lastError = shortReason(reason);

  var prevState = rec.state;
  if (options.immediate || rec.consecutiveFailures >= failureThreshold) {
    rec.state = UNHEALTHY;
    if (prevState !== UNHEALTHY) {
      rec.unhealthySince = now;
      rec.recoveredAt = null;
    }
  } else {
    rec.state = DEGRADED;
  }
  if (prevState !== rec.state) logTransition(rec, prevState, rec.state);
  return rec;
}

function recoverRecord(rec, now) {
  var prevState = rec.state;
  if (prevState === UNHEALTHY && rec.unavailableUntil && now < rec.unavailableUntil) return rec;
  rec.consecutiveFailures = 0;
  rec.lastError = null;
  rec.state = HEALTHY;
  rec.unavailableUntil = null;
  if (prevState === UNHEALTHY || prevState === DEGRADED) {
    if (prevState === UNHEALTHY) rec.recoveredAt = now;
    rec.unhealthySince = null;
    logTransition(rec, prevState, HEALTHY);
  }
  return rec;
}

function recoverExpiredQuota(rec, now, explicitNow) {
  if (rec && rec.clockInjected && !explicitNow) return rec;
  if (rec && rec.unavailableUntil && now >= rec.unavailableUntil) recoverRecord(rec, now);
  return rec;
}

function recordSuccess(vendor, opts) {
  var options = opts || {};
  var now = nowMs(options);
  if (options.providerRouteId || options.routeId || options.model) {
    var exact = targetRegistry[targetKey(vendor, options)];
    var routeWide = targetRegistry[targetKey(vendor, {
      providerRouteId: options.providerRouteId || options.routeId,
      model: null,
    })];
    if (exact) recoverRecord(exact, now);
    if (routeWide && routeWide !== exact) recoverRecord(routeWide, now);
    // A successful live turn also proves that shared provider access has
    // recovered, but it says nothing about other route/model quota buckets.
    recoverRecord(getVendorRecord(vendor), now);
    return exact || getTargetRecord(vendor, options);
  }
  return recoverRecord(getVendorRecord(vendor), now);
}

function stateRank(state) {
  if (state === UNHEALTHY) return 2;
  if (state === DEGRADED) return 1;
  return 0;
}

function effectiveHealth(vendor, providerRouteId, model, opts) {
  var now = nowMs(opts);
  var explicitNow = !!(opts && typeof opts.now === "number");
  var vendorRec = recoverExpiredQuota(getVendorRecord(vendor), now, explicitNow);
  var exact = targetRegistry[targetKey(vendor, {
    providerRouteId: providerRouteId,
    model: model,
  })];
  var routeWide = model ? targetRegistry[targetKey(vendor, {
    providerRouteId: providerRouteId,
    model: null,
  })] : null;
  if (exact) recoverExpiredQuota(exact, now, explicitNow);
  if (routeWide) recoverExpiredQuota(routeWide, now, explicitNow);
  var target = exact;
  if (routeWide && (!target || stateRank(routeWide.state) > stateRank(target.state))) target = routeWide;
  var selected = target && stateRank(target.state) > stateRank(vendorRec.state) ? target : vendorRec;
  var result = Object.assign({}, selected);
  result.vendorState = vendorRec.state;
  result.targetState = target ? target.state : HEALTHY;
  return result;
}

function getHealth(vendor, opts) {
  if (opts && (opts.providerRouteId || opts.routeId || opts.model)) {
    return effectiveHealth(vendor, opts.providerRouteId || opts.routeId, opts.model, opts);
  }
  return Object.assign({}, recoverExpiredQuota(getVendorRecord(vendor), nowMs(opts),
    !!(opts && typeof opts.now === "number")));
}

function getRouteHealth(vendor, providerRouteId, model, opts) {
  return effectiveHealth(vendor, providerRouteId, model, opts);
}

function getAllHealth() {
  var out = {};
  for (var key in vendorRegistry) {
    if (Object.prototype.hasOwnProperty.call(vendorRegistry, key)) {
      out[key] = Object.assign({}, recoverExpiredQuota(vendorRegistry[key], Date.now(), false));
    }
  }
  return out;
}

function getAllRouteHealth() {
  var out = {};
  for (var key in targetRegistry) {
    if (Object.prototype.hasOwnProperty.call(targetRegistry, key)) {
      out[key] = Object.assign({}, recoverExpiredQuota(targetRegistry[key], Date.now(), false));
    }
  }
  return out;
}

function _reset() {
  vendorRegistry = {};
  targetRegistry = {};
  failureThreshold = DEFAULT_FAILURE_THRESHOLD;
  failureWindowMs = DEFAULT_FAILURE_WINDOW_MS;
  localShutdown = false;
}

module.exports = {
  recordFailure: recordFailure,
  recordSuccess: recordSuccess,
  markLocalShutdown: markLocalShutdown,
  isLocalShutdown: isLocalShutdown,
  getHealth: getHealth,
  getRouteHealth: getRouteHealth,
  getAllHealth: getAllHealth,
  getAllRouteHealth: getAllRouteHealth,
  modelKey: modelKey,
  configure: configure,
  _reset: _reset,
  HEALTHY: HEALTHY,
  DEGRADED: DEGRADED,
  UNHEALTHY: UNHEALTHY,
};
