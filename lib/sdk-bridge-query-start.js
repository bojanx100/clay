var withClaudeFallbackModels = require("./claude-defaults").withClaudeFallbackModels;
var modelCatalogCache = require("./model-catalog-cache");
var executionFence = require("./coop-control-fence");
var failQueryStart = require("./sdk-bridge-query-start-failure").failQueryStart;
var prepareSessionAdapter = require("./sdk-bridge-query-vendor").prepareSessionAdapter;
var queryOptions = require("./sdk-bridge-query-options");
var launchQuery = require("./sdk-bridge-query-launch").launchQuery;
var listProviderRoutes = require("./provider-routes").listProviderRoutes;

function failedControlledPreparation(ctx, session, error, fence) {
  failQueryStart({ session: session, error: error, handle: null, controlledFence: fence,
    onProcessingChanged: ctx.onProcessingChanged, sendAndRecord: ctx.sendAndRecord, sm: ctx.sm });
  return { ok: false, reason: "provider_start_failed" };
}

function attachBridgeQueryStart(ctx) {
  var adapters = ctx.adapters;
  var sm = ctx.sm;
  var vendorReadyPromises = {};

  function supportsOsUserIsolation(vendor) {
    var info = require("./yoke").getVendorInfo(vendor);
    return !info || info.osUserIsolation !== false;
  }

  function rememberAdapterReady(vendor, result) {
    if (!vendor || !result) return;
    sm.modelsByVendor = sm.modelsByVendor || {};
    sm.capabilitiesByVendor = sm.capabilitiesByVendor || {};
    if (Array.isArray(result.models)) {
      var discovered = modelCatalogCache.applyDiscovery(vendor, result.models);
      sm.modelsByVendor[vendor] = vendor === "claude" ? withClaudeFallbackModels(discovered) : discovered;
    }
    sm.capabilitiesByVendor[vendor] = result.capabilities || {};
  }

  function sendReadyModelInfo(vendor, session) {
    if (typeof ctx.sendModelInfoForVendor !== "function") return;
    var models = sm.modelsByVendor[vendor] || [];
    var first = models[0];
    var model = typeof first === "string" ? first : (first && (first.value || first.model || first.id)) || "";
    ctx.sendModelInfoForVendor(vendor, model, session);
  }

  async function prepareVendor(vendor, linuxUser) {
    if (!vendor) return null;
    if (linuxUser && !supportsOsUserIsolation(vendor)) return null;
    var vendorAdapter = adapters[vendor] || null;
    var initOptions = { cwd: ctx.cwd, dangerouslySkipPermissions: ctx.dangerouslySkipPermissions,
      linuxUser: linuxUser || undefined, clayPort: ctx.clayPort, clayTls: ctx.clayTls,
      clayAuthToken: ctx.clayAuthToken, slug: ctx.slug };
    if (!vendorAdapter) {
      vendorAdapter = await require("./yoke").lazyCreateAdapter(adapters, vendor, initOptions);
    }
    if (vendorAdapter && vendorAdapter._clayReadyResult) {
      rememberAdapterReady(vendor, vendorAdapter._clayReadyResult);
    }
    var needsReadyMetadata = !sm.capabilitiesByVendor || !sm.capabilitiesByVendor[vendor]
      || !sm.modelsByVendor || !sm.modelsByVendor[vendor];
    if (vendorAdapter && needsReadyMetadata && !vendorAdapter._clayReadyResult &&
        typeof vendorAdapter.init === "function") {
      var readyResult = (await vendorAdapter.init(initOptions)) || {};
      vendorAdapter._clayReadyResult = readyResult;
      rememberAdapterReady(vendor, readyResult);
    }
    if (!vendorAdapter) return null;
    sm.availableVendors = Object.keys(adapters);
    sm.providerRoutes = listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
    sm.modelsByVendor = sm.modelsByVendor || {};
    if (!sm.modelsByVendor[vendor] && typeof vendorAdapter.supportedModels === "function") {
      var discovered = await vendorAdapter.supportedModels();
      var resolved = modelCatalogCache.applyDiscovery(vendor, discovered);
      sm.modelsByVendor[vendor] = vendor === "claude" ? withClaudeFallbackModels(resolved) : resolved;
    }
    return vendorAdapter;
  }

  function ensureVendorReady(vendor, linuxUser, session) {
    if (!vendor) return Promise.resolve(null);
    if (adapters[vendor] && sm.modelsByVendor && sm.modelsByVendor[vendor]
        && sm.capabilitiesByVendor && sm.capabilitiesByVendor[vendor]) {
      sendReadyModelInfo(vendor, session);
      return Promise.resolve(adapters[vendor]);
    }
    var key = vendor + "|" + (linuxUser || "");
    if (!vendorReadyPromises[key]) {
      vendorReadyPromises[key] = Promise.resolve().then(function () {
        return prepareVendor(vendor, linuxUser);
      }).finally(function () { delete vendorReadyPromises[key]; });
    }
    return vendorReadyPromises[key].then(function (adapter) {
      if (adapter) sendReadyModelInfo(vendor, session);
      return adapter;
    });
  }

  function startupContext() {
    return Object.assign({}, ctx, {
      adapter: ctx.adapter,
      adapters: adapters,
      ensureVendorReady: ensureVendorReady,
      isMate: !!ctx.isMate,
      sm: sm,
    });
  }

  async function startQuery(session, text, images, linuxUser) {
    var controlledFence = executionFence.fenceFor(session);
    if (controlledFence) controlledFence.assert("provider_start");
    var startCtx = startupContext();
    try {
      var provider = await prepareSessionAdapter(startCtx, session, linuxUser, controlledFence);
      if (Object.prototype.hasOwnProperty.call(provider, "result")) return provider.result;
      executionFence.assertAction(session, "provider_start", controlledFence);
      console.log("[sdk-bridge] startQuery: vendor=" + provider.adapter.vendor + " session=" +
        session.localId + " text=" + (text || "").substring(0, 50));
      session.lastLinuxUser = linuxUser || null;
      var prepared = await queryOptions.prepareQuery(startCtx, session, text, linuxUser, controlledFence);
      executionFence.assertAction(session, "provider_start", controlledFence);
      var query = queryOptions.buildQueryOptions(startCtx, session, text, linuxUser,
        controlledFence, prepared);
      return launchQuery(startCtx, session, provider.adapter, query, text, images,
        linuxUser, controlledFence);
    } catch (error) {
      if (!controlledFence) throw error;
      return failedControlledPreparation(startCtx, session, error, controlledFence);
    }
  }

  return { ensureVendorReady: ensureVendorReady, startQuery: startQuery };
}

module.exports = { attachBridgeQueryStart: attachBridgeQueryStart };
