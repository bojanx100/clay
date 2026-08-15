var { withClaudeFallbackModels } = require("./claude-defaults");
var modelCatalogCache = require("./model-catalog-cache");
var { listProviderRoutes } = require("./provider-routes");
var yoke = require("./yoke");

function attachVendorReadiness(ctx) {
  var adapters = ctx.adapters;
  var sm = ctx.sm;
  var pending = {};
  var refreshing = {};
  var readyResults = {};

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
    };
  }

  function rememberModels(vendor, models) {
    sm.modelsByVendor = sm.modelsByVendor || {};
    var discovered = modelCatalogCache.applyDiscovery(vendor, models || []);
    sm.modelsByVendor[vendor] = vendor === "claude"
      ? withClaudeFallbackModels(discovered) : discovered;
  }

  function rememberResult(vendor, result) {
    result = result || {};
    sm.capabilitiesByVendor = sm.capabilitiesByVendor || {};
    sm.capabilitiesByVendor[vendor] = result.capabilities || {};
    if (Array.isArray(result.models)) rememberModels(vendor, result.models);
  }

  function refreshRoutes() {
    sm.availableVendors = Object.keys(adapters);
    sm.providerRoutes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
  }

  async function initialize(vendor, linuxUser) {
    if (!vendor) return { adapter: null, result: {} };
    if (linuxUser && !supportsOsUserIsolation(vendor)) return { adapter: null, result: {} };
    var options = initOptions(linuxUser);
    var vendorAdapter = adapters[vendor] || null;
    if (!vendorAdapter) vendorAdapter = await yoke.lazyCreateAdapter(adapters, vendor, options);
    if (!vendorAdapter) return { adapter: null, result: {} };

    var result = {};
    if (typeof vendorAdapter.init === "function") {
      result = (await vendorAdapter.init(options)) || {};
    }
    rememberResult(vendor, result);
    if (!Array.isArray(result.models) && typeof vendorAdapter.supportedModels === "function") {
      rememberModels(vendor, await vendorAdapter.supportedModels());
    }
    refreshRoutes();
    return { adapter: vendorAdapter, result: result };
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

module.exports = { attachVendorReadiness: attachVendorReadiness };
