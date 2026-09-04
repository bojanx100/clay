var providerHealth = require("./provider-health");

// Only a limit-shaped failure (rate limit, quota, credits) has a meaningful
// "reset time" — the provider told us when access returns. A connectivity or
// stream failure has none, and reusing a stale rate-limit reset for one parks
// the session for hours over a blip. Every consumer of failure.resetsAt must
// gate on this.
var LIMIT_FAILURE_PATTERN = /rate|limit|credit|quota/i;

function isLimitFailureReason(reason) {
  return LIMIT_FAILURE_PATTERN.test(String(reason || ""));
}

// Prefer the verdict stamped at record time; fall back to the reason text for
// failure objects built outside recordProviderFailure.
function isLimitFailure(failure) {
  if (!failure) return false;
  if (typeof failure.isLimitFailure === "boolean") return failure.isLimitFailure;
  return isLimitFailureReason(failure.reason);
}

function activeModel(session) {
  if (!session) return null;
  return session.verifiedModel || session.requestedModel || session.model || null;
}

function exactHealthOptions(session, opts) {
  return Object.assign({}, opts || {}, {
    providerRouteId: session && session.providerRouteId || null,
    model: activeModel(session),
  });
}

function recordProviderFailure(session, vendor, reason, opts) {
  var healthOpts = exactHealthOptions(session, opts);
  var health = providerHealth.recordFailure(vendor, reason, healthOpts);
  if (health.state === providerHealth.UNHEALTHY) {
    var limitFailure = isLimitFailureReason(reason);
    var pending = {
      vendor: vendor,
      reason: reason,
      isLimitFailure: limitFailure,
      resetsAt: limitFailure ? (session.rateLimitLastResetsAt || session.rateLimitResetsAt || null) : null,
    };
    if (healthOpts.providerRouteId) pending.providerRouteId = healthOpts.providerRouteId;
    if (healthOpts.model) pending.model = healthOpts.model;
    session.providerFailoverPending = pending;
  }
  return health;
}

function queuePendingProviderFailover(session, opts) {
  var failure = session.providerFailoverPending || null;
  session.providerFailoverPending = null;
  if (!failure) return false;
  var enabled = session.onQueryComplete ||
    (typeof opts.getAutoContinueSetting === "function" && opts.getAutoContinueSetting(session));
  if (!enabled || typeof opts.queueProviderFailover !== "function") return false;
  return !!opts.queueProviderFailover(session, failure);
}

module.exports = {
  isLimitFailureReason: isLimitFailureReason,
  isLimitFailure: isLimitFailure,
  activeModel: activeModel,
  exactHealthOptions: exactHealthOptions,
  recordProviderFailure: recordProviderFailure,
  queuePendingProviderFailover: queuePendingProviderFailover,
};
