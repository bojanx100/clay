var executionFence = require("./coop-control-fence");
var failQueryStart = require("./sdk-bridge-query-start-failure").failQueryStart;
var prepareSessionAdapter = require("./sdk-bridge-query-vendor").prepareSessionAdapter;
var queryOptions = require("./sdk-bridge-query-options");
var launchQuery = require("./sdk-bridge-query-launch").launchQuery;
var attachVendorReadiness = require("./sdk-bridge-vendor-readiness").attachVendorReadiness;

function pushMessage(session, text, images) {
  session.lastActivityAt = Date.now();
  var canPush = !!(session.queryInstance &&
    typeof session.queryInstance.pushMessage === "function");
  try {
    console.log("[clay-paste] pushMessage: session=" + session.localId +
      " textLen=" + ((text || "").length) + " delivered=" + canPush +
      " buffered=" + (!canPush && !!session._queryStarting));
  } catch (e) {}
  if (canPush) {
    session.queryInstance.pushMessage(text, images);
    return true;
  }
  if (session._queryStarting) {
    session.pendingPush = session.pendingPush || [];
    session.pendingPush.push({ text: text, images: images || null });
    return true;
  }
  return false;
}

function failedControlledPreparation(ctx, session, error, fence) {
  failQueryStart({ session: session, error: error, handle: null, controlledFence: fence,
    onProcessingChanged: ctx.onProcessingChanged, sendAndRecord: ctx.sendAndRecord, sm: ctx.sm });
  return { ok: false, reason: "provider_start_failed" };
}

function attachBridgeQueryStart(ctx) {
  var adapters = ctx.adapters;
  var sm = ctx.sm;
  var vendorReadiness = ctx.vendorReadiness || attachVendorReadiness(ctx);

  function sendReadyModelInfo(vendor, session) {
    if (typeof ctx.sendModelInfoForVendor !== "function") return;
    var models = sm.modelsByVendor[vendor] || [];
    var first = models[0];
    var model = typeof first === "string" ? first : (first && (first.value || first.model || first.id)) || "";
    ctx.sendModelInfoForVendor(vendor, model, session);
  }

  function ensureVendorReady(vendor, linuxUser, session) {
    if (!vendor) return Promise.resolve(null);
    return vendorReadiness.ensure(vendor, linuxUser).then(function (details) {
      if (details.adapter) sendReadyModelInfo(vendor, session);
      return details.adapter;
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

  async function startQueryInner(session, text, images, linuxUser) {
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

  async function startQuery(session, text, images, linuxUser) {
    session._queryStarting = true;
    try {
      return await startQueryInner(session, text, images, linuxUser);
    } finally {
      session._queryStarting = false;
      if (!session.queryInstance && session.pendingPush && session.pendingPush.length) {
        session.pendingPush = [];
      }
    }
  }

  return {
    ensureVendorReady: ensureVendorReady,
    pushMessage: pushMessage,
    startQuery: startQuery,
  };
}

module.exports = { attachBridgeQueryStart: attachBridgeQueryStart };
