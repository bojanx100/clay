var { withClaudeFallbackModels } = require("./claude-defaults");
var modelCatalogCache = require("./model-catalog-cache");
var reconcileProviderRoutes =
  require("./provider-route-readiness").reconcileProviderRoutes;
var routeForVendor = require("./provider-routes").routeForVendor;
var yoke = require("./yoke");

function attachVendorReadiness(ctx) {
  var adapters = ctx.adapters;
  var sm = ctx.sm;
  var pending = {};
  var refreshing = {};
  var readyResults = {};

  function rememberVerification(vendor, status, details) {
    sm.providerVerificationByVendor = sm.providerVerificationByVendor || {};
    details = details || {};
    sm.providerVerificationByVendor[vendor] = {
      status: status,
      checkedAt: Date.now(),
      modelCount: Math.max(0, Number(details.modelCount) || 0),
      error: String(details.error || ""),
    };
  }

  function keyFor(vendor, linuxUser) {
    return vendor + "|" + (linuxUser || "");
  }

  function supportsOsUserIsolation(vendor) {
    var info = yoke.getVendorInfo(vendor);
    return !info || info.osUserIsolation !== false;
  }

  function initOptions(linuxUser) {
    return {
      cwd: ctx.cwd,
      dangerouslySkipPermissions: ctx.dangerouslySkipPermissions,
      linuxUser: linuxUser || undefined,
      clayPort: ctx.clayPort,
      clayTls: ctx.clayTls,
      clayAuthToken: ctx.clayAuthToken,
      slug: ctx.slug,
      env: typeof ctx.getRuntimeEnv === "function" ?
        ctx.getRuntimeEnv({ linuxUser: linuxUser || null }) : process.env,
    };
  }

  // `provenance` is the adapter's own account of where `models` came from.
  // Absent means "live" for the adapters that only ever report live results;
  // "fallback-seed" means the adapter substituted a hardcoded table for a
  // failed discovery, which must neither be persisted over a proven catalog
  // nor marked verified for the route.
  function rememberModels(vendor, models, provenance) {
    sm.modelsByVendor = sm.modelsByVendor || {};
    var discovered = modelCatalogCache.applyDiscovery(vendor, models || [], provenance);
    sm.modelsByVendor[vendor] = vendor === "claude"
      ? withClaudeFallbackModels(discovered) : discovered;
    var route = routeForVendor(vendor);
    var live = !provenance || provenance === "live-discovery";
    if (route && route.allowMetaModel && live && Array.isArray(models) && models.length) {
      sm.verifiedModelsByRoute = sm.verifiedModelsByRoute || {};
      sm.verifiedModelsByRoute[route.id] = {
        models: models.slice(),
        verified: true,
        source: "live-initialization",
      };
    }
  }

  function rememberResult(vendor, result) {
    result = result || {};
    sm.capabilitiesByVendor = sm.capabilitiesByVendor || {};
    sm.capabilitiesByVendor[vendor] = result.capabilities || {};
    if (Array.isArray(result.models)) rememberModels(vendor, result.models, result.modelsProvenance);
  }

  function adapterModelsProvenance(vendorAdapter) {
    if (!vendorAdapter || typeof vendorAdapter.modelsProvenance !== "function") return undefined;
    try { return vendorAdapter.modelsProvenance(); } catch (error) { return undefined; }
  }

  function refreshRoutes() {
    reconcileProviderRoutes(sm, Object.keys(adapters));
  }

  async function initialize(vendor, linuxUser) {
    if (!vendor) return { adapter: null, result: {} };
    if (linuxUser && !supportsOsUserIsolation(vendor)) return { adapter: null, result: {} };
    rememberVerification(vendor, "verifying");
    var options = initOptions(linuxUser);
    try {
      var vendorAdapter = adapters[vendor] || null;
      if (!vendorAdapter) vendorAdapter = await yoke.lazyCreateAdapter(adapters, vendor, options);
      if (!vendorAdapter) {
        rememberVerification(vendor, "error", { error: "Clay could not start this provider runtime." });
        return { adapter: null, result: {} };
      }

      var result = {};
      if (typeof vendorAdapter.init === "function") {
        result = (await vendorAdapter.init(options)) || {};
      }
      rememberResult(vendor, result);
      if (!Array.isArray(result.models) && typeof vendorAdapter.supportedModels === "function") {
        rememberModels(vendor, await vendorAdapter.supportedModels(),
          adapterModelsProvenance(vendorAdapter));
      }
      var models = sm.modelsByVendor && sm.modelsByVendor[vendor] || [];
      if (!models.length) {
        throw new Error("Provider initialized without a usable model catalog.");
      }
      rememberVerification(vendor, "ready", { modelCount: models.length });
      refreshRoutes();
      return { adapter: vendorAdapter, result: result };
    } catch (error) {
      rememberVerification(vendor, "error", { error: error && error.message || String(error) });
      throw error;
    }
  }

  function ensure(vendor, linuxUser) {
    if (!vendor) return Promise.resolve({ adapter: null, result: {} });
    var key = keyFor(vendor, linuxUser);
    if (readyResults[key]) return Promise.resolve(readyResults[key]);
    if (!pending[key]) {
      pending[key] = Promise.resolve().then(function () {
        return initialize(vendor, linuxUser);
      }).then(function (details) {
        if (details.adapter) readyResults[key] = details;
        return details;
      }).finally(function () {
        delete pending[key];
      });
    }
    return pending[key];
  }

  function invalidate(vendor) {
    var keys = Object.keys(readyResults);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(vendor + "|") === 0) delete readyResults[keys[i]];
    }
  }

  function refresh(vendor, linuxUser) {
    if (!vendor) return Promise.resolve({ adapter: null, result: {} });
    var key = keyFor(vendor, linuxUser);
    if (!refreshing[key]) {
      refreshing[key] = Promise.resolve(pending[key]).catch(function () {
        return null;
      }).then(async function () {
        yoke.invalidateAuthCache();
        var vendorAdapter = adapters[vendor] || null;
        var options = initOptions(linuxUser);
        if (vendorAdapter && vendor === "codex" && typeof vendorAdapter.refreshCredential === "function") {
          await vendorAdapter.refreshCredential(options);
        }
        invalidate(vendor);
        return ensure(vendor, linuxUser);
      }).finally(function () {
        delete refreshing[key];
      });
    }
    return refreshing[key];
  }

  return {
    ensure: ensure,
    refresh: refresh,
    invalidate: invalidate,
  };
}

module.exports = {
  attachVendorReadiness: attachVendorReadiness,
};
