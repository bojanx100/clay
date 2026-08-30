// Vendor presentation metadata is hydrated from the server's YOKE registry.
// Claude is the only bootstrap fallback needed before the initial info frame.
export var VENDOR_AVATARS = { claude: "/claude-code-avatar.png" };
export var VENDOR_NAMES = { claude: "Claude Code" };
export var VENDOR_ORDER = ["claude"];
export var VENDOR_HOMEPAGES = { claude: "https://claude.com/product/claude-code" };
var registryOrder = ["claude"];

function replaceMap(target, next) {
  var oldKeys = Object.keys(target);
  for (var i = 0; i < oldKeys.length; i++) delete target[oldKeys[i]];
  var nextKeys = Object.keys(next);
  for (var j = 0; j < nextKeys.length; j++) target[nextKeys[j]] = next[nextKeys[j]];
}

export function applyVendorRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return;
  var avatars = {};
  var names = {};
  var homepages = {};
  var order = Object.keys(registry);
  for (var i = 0; i < order.length; i++) {
    var vendor = order[i];
    var info = registry[vendor] || {};
    names[vendor] = info.displayName || vendor;
    avatars[vendor] = info.avatar || VENDOR_AVATARS.claude;
    homepages[vendor] = info.homepage || "";
  }
  replaceMap(VENDOR_AVATARS, avatars);
  replaceMap(VENDOR_NAMES, names);
  replaceMap(VENDOR_HOMEPAGES, homepages);
  registryOrder.splice(0, registryOrder.length);
  for (var oi = 0; oi < order.length; oi++) registryOrder.push(order[oi]);
  VENDOR_ORDER.splice(0, VENDOR_ORDER.length);
  for (var j = 0; j < order.length; j++) VENDOR_ORDER.push(order[j]);
}

function readinessRank(provider) {
  if (!provider) return 4;
  if (provider.ready || provider.state === "ready") return 0;
  if (provider.state === "verifying") return 1;
  if (provider.installed) return 2;
  return 3;
}

function providerMap(providers) {
  var result = {};
  for (var i = 0; i < (providers || []).length; i++) {
    var provider = providers[i];
    if (provider && provider.vendor) result[provider.vendor] = provider;
  }
  return result;
}

function registryIndex(vendor, fallback) {
  var index = registryOrder.indexOf(vendor);
  return index === -1 ? fallback : index;
}

export function sortProvidersByReadiness(providers) {
  return (providers || []).map(function (provider, index) {
    return { provider: provider, index: index };
  }).sort(function (a, b) {
    var rank = readinessRank(a.provider) - readinessRank(b.provider);
    if (rank) return rank;
    var registryRank = registryIndex(a.provider && a.provider.vendor, a.index) -
      registryIndex(b.provider && b.provider.vendor, b.index);
    return registryRank || a.index - b.index;
  }).map(function (entry) { return entry.provider; });
}

export function applyProviderReadiness(providers) {
  var ordered = sortProvidersByReadiness(providers);
  var seen = {};
  VENDOR_ORDER.splice(0, VENDOR_ORDER.length);
  for (var i = 0; i < ordered.length; i++) {
    var vendor = ordered[i] && ordered[i].vendor;
    if (!vendor || seen[vendor]) continue;
    seen[vendor] = true;
    VENDOR_ORDER.push(vendor);
  }
  for (var j = 0; j < registryOrder.length; j++) {
    if (seen[registryOrder[j]]) continue;
    VENDOR_ORDER.push(registryOrder[j]);
  }
}

export function sortProviderRoutesByReadiness(routes, providers) {
  var byVendor = providerMap(providers);
  return (routes || []).map(function (route, index) {
    return { route: route, index: index };
  }).sort(function (a, b) {
    var rank = readinessRank(byVendor[a.route && a.route.vendor]) -
      readinessRank(byVendor[b.route && b.route.vendor]);
    return rank || a.index - b.index;
  }).map(function (entry) { return entry.route; });
}
