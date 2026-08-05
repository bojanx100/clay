// Daemon-level cross-project router.
//
// `deliver()` is the Slice 3 text compatibility adapter. New callers use the
// durable typed envelope API, which resolves ProjectRef/SessionRef identity
// rather than a mutable slug or runtime local id.
var recoveryLog = require("./recovery-log");
var createDurableDelivery = require("./cross-project-delivery").createDurableDelivery;

function createCrossProjectRouter(opts) {
  var options = opts || {};
  var getProjectContext = options.getProjectContext || function () { return null; };
  var getProjectContextById = options.getProjectContextById || function (projectId) {
    return getProjectContext(projectId);
  };
  var recordRecoveryEvent = typeof options.recordRecoveryEvent === "function"
    ? options.recordRecoveryEvent : recoveryLog.recordCrossProjectDeadLetter;
  var registeredProjectResolvers = [];

  function resolveProjectContextById(projectId) {
    var resolved = getProjectContextById(projectId);
    if (resolved) return resolved;
    for (var i = 0; i < registeredProjectResolvers.length; i++) {
      var candidate = registeredProjectResolvers[i];
      if (candidate.getProjectId() === projectId) return candidate;
    }
    return null;
  }

  function registerProjectResolver(resolver) {
    if (!resolver || typeof resolver.getProjectId !== "function") return function () {};
    registeredProjectResolvers.push(resolver);
    return function () {
      var index = registeredProjectResolvers.indexOf(resolver);
      if (index !== -1) registeredProjectResolvers.splice(index, 1);
    };
  }

  var durable = createDurableDelivery({
    getProjectContextById: resolveProjectContextById,
    canDeliverEnvelope: options.canDeliverEnvelope,
    recordRecoveryEvent: recordRecoveryEvent,
    deliveryFile: options.deliveryFile,
    now: options.now,
    maxAttempts: options.maxAttempts,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
  });

  function deadLetter(targetSlug, sessionStorageId, reason) {
    try {
      recordRecoveryEvent({
        kind: "cross_project_dead_letter",
        targetSlug: targetSlug || null,
        sessionStorageId: sessionStorageId || null,
        reason: reason,
      });
    } catch (e) {}
    return { ok: false, reason: reason };
  }

  // Legacy text adapter. It intentionally preserves Slice 3 response codes
  // so existing plugins and the fan-in fallback do not change behavior.
  function deliver(targetSlug, sessionStorageId, text) {
    if (!targetSlug || !sessionStorageId) return deadLetter(targetSlug, sessionStorageId, "missing-target");
    var ctx = getProjectContext(targetSlug);
    if (!ctx) return deadLetter(targetSlug, sessionStorageId, "unknown-project");
    if (typeof ctx.deliverCoordinatorUpdate !== "function") {
      return deadLetter(targetSlug, sessionStorageId, "target-not-capable");
    }
    try {
      if (!ctx.deliverCoordinatorUpdate(sessionStorageId, text)) {
        return deadLetter(targetSlug, sessionStorageId, "session-not-found");
      }
    } catch (e) {
      return deadLetter(targetSlug, sessionStorageId, "delivery-error: " + e.message);
    }
    return { ok: true };
  }

  return {
    deliver: deliver,
    createEnvelope: durable.createEnvelope,
    deliverEnvelope: durable.deliverEnvelope,
    retryPending: durable.retryPending,
    getPendingEventIds: durable.getPendingEventIds,
    getDeadLetters: durable.getDeadLetters,
    getDeliveryState: durable.getState,
    registerProjectResolver: registerProjectResolver,
  };
}

module.exports = { createCrossProjectRouter: createCrossProjectRouter };
