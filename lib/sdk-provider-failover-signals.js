var providerHealth = require("./provider-health");

function recordProviderFailure(session, vendor, reason, opts) {
  var health = providerHealth.recordFailure(vendor, reason, opts);
  if (health.state === providerHealth.UNHEALTHY) {
    session.providerFailoverPending = {
      vendor: vendor,
      reason: reason,
    };
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
  recordProviderFailure: recordProviderFailure,
  queuePendingProviderFailover: queuePendingProviderFailover,
};
