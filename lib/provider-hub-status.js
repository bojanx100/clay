var providerRoutes = require("./provider-routes");

var DIRECT_AUTH_PROBES = {
  claude: true,
  codex: true,
};

function boundedText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function routesForVendor(routes, vendor) {
  var result = [];
  for (var i = 0; i < routes.length; i++) {
    if (routes[i] && routes[i].vendor === vendor) result.push(routes[i]);
  }
  return result;
}

function anyRoute(routes, predicate) {
  for (var i = 0; i < routes.length; i++) {
    if (predicate(routes[i])) return true;
  }
  return false;
}

function authenticationError(error) {
  var text = String(error || "").toLowerCase();
  return /not logged in|unauthenticated|authentication required|sign[ -]?in required|please (?:log in|login)|invalid (?:credential|token|api key)|missing (?:credential|token|api key)/.test(text);
}

function selectedInstallCommand(info, platform) {
  var commands = info && info.installCommands || {};
  return commands[platform] || "";
}

function verificationFor(sm, vendor) {
  var map = sm && sm.providerVerificationByVendor || {};
  var value = map[vendor];
  if (!value || typeof value !== "object") return null;
  return {
    status: value.status === "ready" || value.status === "verifying" || value.status === "error"
      ? value.status : "error",
    checkedAt: Number(value.checkedAt) || null,
    modelCount: Math.max(0, Number(value.modelCount) || 0),
    error: boundedText(value.error, 240),
  };
}

function providerState(vendor, installed, supported, auth, verification) {
  if (!supported) return "unsupported";
  if (!installed) return "missing";
  if (verification && verification.status === "verifying") return "verifying";
  if (verification && verification.status === "ready") return "ready";
  if (verification && verification.status === "error") {
    return authenticationError(verification.error) ? "login-required" : "error";
  }
  if (DIRECT_AUTH_PROBES[vendor] && auth === false) return "login-required";
  return "installed";
}

function authenticatedState(vendor, auth, verification) {
  if (verification && verification.status === "ready") return true;
  if (verification && verification.status === "error" && authenticationError(verification.error)) return false;
  if (DIRECT_AUTH_PROBES[vendor]) return auth === true;
  return null;
}

function providerEntry(vendor, info, opts, routes) {
  var installed = !!opts.installed[vendor];
  var supported = !(opts.linuxUser && info.osUserIsolation === false);
  var vendorRoutes = routesForVendor(routes, vendor);
  var verification = verificationFor(opts.sm, vendor);
  var models = opts.sm && opts.sm.modelsByVendor && opts.sm.modelsByVendor[vendor] || [];
  var auth = opts.auth[vendor];
  var state = providerState(vendor, installed, supported, auth, verification);
  var authenticated = authenticatedState(vendor, auth, verification);
  var catalogVerified = anyRoute(vendorRoutes, function (route) { return route.catalogVerified === true; });
  var routeEnabled = anyRoute(vendorRoutes, function (route) { return route.enabled === true; });
  var freeAllowancePotential = anyRoute(vendorRoutes, function (route) {
    var source = providerRoutes.routeForId(route.id);
    return !!(source && source.freeAllowancePotential);
  });
  return {
    vendor: vendor,
    displayName: boundedText(info.displayName || vendor, 80),
    description: boundedText(info.description, 260),
    binaryName: boundedText(info.binaryName, 80),
    avatar: boundedText(info.avatar, 240),
    homepage: boundedText(info.homepage, 300),
    docsUrl: boundedText(info.docsUrl, 300),
    loginCommand: boundedText(info.loginCommand, 300),
    loginHint: boundedText(info.loginHint, 260),
    state: state,
    installed: installed,
    authenticated: authenticated,
    supported: supported,
    routeEnabled: routeEnabled,
    catalogVerified: catalogVerified,
    ready: state === "ready",
    freeAllowancePotential: freeAllowancePotential,
    installCommand: selectedInstallCommand(info, opts.platform),
    routeIds: vendorRoutes.map(function (route) { return route.id; }),
    models: models.slice(0, 12),
    verification: verification,
    steps: {
      cli: installed,
      login: authenticated === true,
      models: catalogVerified || !!(verification && verification.modelCount > 0),
      ready: state === "ready",
    },
  };
}

function buildProviderHubStatus(opts) {
  opts = opts || {};
  var registry = opts.registry || {};
  var sm = opts.sm || {};
  var installed = opts.installed || {};
  var auth = opts.auth || {};
  var platform = opts.platform || process.platform;
  var routes = providerRoutes.listProviderRoutes(
    sm.availableVendors || [], sm.installedVendors || [], sm);
  var vendors = Object.keys(registry);
  var providers = [];
  for (var i = 0; i < vendors.length; i++) {
    providers.push(providerEntry(vendors[i], registry[vendors[i]], {
      auth: auth,
      installed: installed,
      linuxUser: opts.linuxUser || null,
      platform: platform,
      sm: sm,
    }, routes));
  }
  return {
    platform: platform,
    routingProfile: sm.providerRoutingProfile || "balanced",
    providers: providers,
  };
}

module.exports = {
  authenticationError: authenticationError,
  buildProviderHubStatus: buildProviderHubStatus,
};
