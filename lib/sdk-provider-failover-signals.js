var providerHealth = require("./provider-health");

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
    var limitFailure = /rate|limit|credit|quota/i.test(String(reason || ""));
    var pending = {
      vendor: vendor,
      reason: reason,
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
  activeModel: activeModel,
  exactHealthOptions: exactHealthOptions,
  recordProviderFailure: recordProviderFailure,
  queuePendingProviderFailover: queuePendingProviderFailover,
};
