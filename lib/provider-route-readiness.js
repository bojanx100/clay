// Pure provider-route readiness reconciliation shared by startup and worker
// scheduling. This module deliberately does not load SDK adapters.

var listProviderRoutes = require("./provider-routes").listProviderRoutes;

function uniqueVendors(values) {
  var result = [];
  var list = Array.isArray(values) ? values : [];
  for (var i = 0; i < list.length; i++) {
    var vendor = String(list[i] || "").trim();
    if (vendor && result.indexOf(vendor) === -1) result.push(vendor);
  }
  return result;
}

function inferredVendors(routes, field) {
  var result = [];
  var list = Array.isArray(routes) ? routes : [];
  for (var i = 0; i < list.length; i++) {
    var route = list[i];
    var inferred = route && (route[field] === true ||
      typeof route[field] === "undefined" && route.enabled === true);
    if (inferred && result.indexOf(route.vendor) === -1) result.push(route.vendor);
  }
  return result;
}

function routeById(routes, id) {
  for (var i = 0; i < routes.length; i++) {
    if (routes[i] && routes[i].id === id) return routes[i];
  }
  return null;
}

// A manager can schedule before browser warmup refreshes providerRoutes. Treat
// an available adapter as installation evidence, rebuild readiness from the
// live vendor sets, and carry forward only verified catalog provenance.
function reconcileProviderRoutes(sm, availableOverride) {
  var state = sm || {};
  var current = Array.isArray(state.providerRoutes) ? state.providerRoutes : [];
  var hasReadinessEvidence = Array.isArray(availableOverride) ||
    Array.isArray(state.availableVendors) || Array.isArray(state.installedVendors) ||
    current.length > 0;
  if (!hasReadinessEvidence) return current;
  var available = Array.isArray(availableOverride) ? uniqueVendors(availableOverride) :
    (Array.isArray(state.availableVendors) ? uniqueVendors(state.availableVendors) :
      inferredVendors(current, "available"));
  var installed = Array.isArray(state.installedVendors) ?
    uniqueVendors(state.installedVendors) : inferredVendors(current, "installed");
  for (var i = 0; i < available.length; i++) {
    if (installed.indexOf(available[i]) === -1) installed.push(available[i]);
  }
  var routes = listProviderRoutes(available, installed);
  for (var j = 0; j < routes.length; j++) {
    var previous = routeById(current, routes[j].id);
    var legacyInjectedCatalog = previous &&
      typeof previous.catalogVerified === "undefined" &&
      !previous.provider && !previous.modelFamily;
    if (!routes[j].catalogVerified && previous &&
        (previous.catalogVerified === true || legacyInjectedCatalog)) {
      routes[j].catalogVerified = true;
      routes[j].catalogSource = previous.catalogSource || "live";
    }
  }
  state.availableVendors = available;
  state.installedVendors = installed;
  state.providerRoutes = routes;
  return routes;
}

module.exports = { reconcileProviderRoutes: reconcileProviderRoutes };
