// Coop fan-in delivery: delivers terminal/needs-attention task-transition
// events to the canonical Coop session so it can independently reconcile
// before creating its own single owner-facing notification.
//
// Canonical Coop sessions (coopHome / coop channels) only ever exist inside
// the "lead" project (see server-lead.js / project-coop-channels.js), but a
// Coop-controlled coordinator or worker can live in ANY project (Clay,
// Webapp, Urban Stay, ...). A project's own session manager only knows
// about its own sessions, so same-project delivery cannot reach a
// cross-project Coop session on its own. lib/server-cross-project.js
// already provides a process-wide router (bound to the daemon's live
// projects Map) for exactly this; this module uses it when the local
// project is not "lead" itself, and delivers locally (fast path) when it
// is, keeping single-project behavior byte-for-byte unchanged.
//
// Delivery is best-effort-immediate with a durable outbox: any event that
// fails to deliver right away (unknown/removed target project, Coop
// session not attached yet, transient error) is kept as a pending record
// on disk and retried by the caller (normally the coop watchdog's tick)
// via retryPending(), and survives a daemon restart because pending state
// is persisted alongside the delivered log.
var fs = require("fs");
var path = require("path");
var config = require("./config");
var LEAD_SLUG = require("./server-lead").LEAD_SLUG;
var LEAD_PROJECT_ID = require("./project-identity").LEAD_PROJECT_ID;

var DELIVERY_DIR = path.join(config.CONFIG_DIR, "coop-fanin");
var LEGACY_DELIVERY_FILE = path.join(config.CONFIG_DIR, "coop-fanin-delivery.json");

// The outbox is scoped per project slug: attachCoopFanIn is instantiated
// once per project (every project runs its own task orchestrator / coop
// relay), and every project can independently have pending or delivered
// fan-in events. A single shared file across all projects would have each
// project's saveState() silently clobber every other project's persisted
// state (last writer wins) -- this keeps each project's outbox on its own
// file so cross-project delivery is genuinely durable in a real
// multi-project daemon, not just in a single-instance test.
function deliveryFileForSlug(slug) {
  var safeSlug = (typeof slug === "string" && slug) ?
    slug.replace(/[^a-zA-Z0-9_-]/g, "_") : "unknown-project";
  return path.join(DELIVERY_DIR, safeSlug + ".json");
}

function attachCoopFanIn(ctx) {
  var sm = ctx.sm;
  var slug = ctx.slug || null;
  var crossProject = ctx.crossProject || null;
  var getProjectId = ctx.getProjectId || function () {
    return sm && typeof sm.getProjectId === "function" ? sm.getProjectId() : null;
  };
  var queueCoordinatorUpdate = ctx.queueCoordinatorUpdate;
  var now = ctx.now || Date.now;
  var deliveryFile = ctx.deliveryFile || deliveryFileForSlug(slug);
  var deliveredIds = {};
  var failedIds = {};
  var records = [];
  var failed = [];
  var pending = {}; // eventId -> event

  function shouldUseLegacyFile() {
    // One-time migration: earlier builds always wrote to the single
    // shared legacy file, and only the "lead" project ever actually used
    // it in practice. Seed the lead project's per-slug outbox from it so
    // any prior pending/delivered state isn't lost by this scoping change.
    return !ctx.deliveryFile && slug === "lead" && !fs.existsSync(deliveryFile) &&
      fs.existsSync(LEGACY_DELIVERY_FILE);
  }

  function indexDeliveredList(list) {
    var index = {};
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].eventId) index[list[i].eventId] = true;
    }
    return index;
  }

  function indexPendingList(list) {
    var index = {};
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].eventId) index[list[i].eventId] = list[i];
    }
    return index;
  }

  function indexFailedList(list) {
    var index = {};
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].eventId) index[list[i].eventId] = true;
    }
    return index;
  }

  function loadState() {
    var sourceFile = shouldUseLegacyFile() ? LEGACY_DELIVERY_FILE : deliveryFile;
    try {
      var parsed = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
      records = Array.isArray(parsed && parsed.delivered) ? parsed.delivered : [];
      failed = Array.isArray(parsed && parsed.failed) ? parsed.failed : [];
      pending = indexPendingList(Array.isArray(parsed && parsed.pending) ? parsed.pending : []);
      deliveredIds = indexDeliveredList(records);
      failedIds = indexFailedList(failed);
    } catch (e) {
      records = [];
      deliveredIds = {};
      failedIds = {};
      pending = {};
      failed = [];
    }
  }

  function saveState() {
    fs.mkdirSync(path.dirname(deliveryFile), { recursive: true });
    var tmp = deliveryFile + "." + process.pid + "." + now() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      delivered: records,
      failed: failed,
      pending: Object.keys(pending).map(function (id) { return pending[id]; }),
    }, null, 2));
    fs.renameSync(tmp, deliveryFile);
  }

  function storageIdForSession(session) {
    return session && (session.storageId || session.cliSessionId) || null;
  }

  function localSessionByStorageId(storageId) {
    if (!storageId || !sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
    var found = null;
    sm.sessions.forEach(function (session) {
      if (!found && storageIdForSession(session) === storageId) found = session;
    });
    return found;
  }

  function eventMessage(event) {
    return [
      "[Coop fan-in event]",
      "A Coop-controlled descendant session reached a terminal or attention task state.",
      "Reconcile this event before deciding whether the owner needs a notification.",
      "<coop_fanin_event>",
      JSON.stringify(event),
      "</coop_fanin_event>",
    ].join("\n");
  }

  function typedEnvelope(event) {
    var projectId = getProjectId();
    if (!projectId || !crossProject || typeof crossProject.createEnvelope !== "function") return null;
    return crossProject.createEnvelope({
      eventId: event.eventId,
      source: { projectId: projectId, sessionStorageId: event.sessionStorageId },
      destination: { projectId: LEAD_PROJECT_ID, sessionStorageId: event.coopSessionStorageId },
      bindingRevision: Number.isInteger(event.bindingRevision) ? event.bindingRevision : 1,
      createdAt: Number.isFinite(event.occurredAt) ? event.occurredAt : now(),
      payload: { type: "coordinator_update", text: eventMessage(event) },
    });
  }

  function markDelivered(event) {
    deliveredIds[event.eventId] = true;
    records.push({
      eventId: event.eventId,
      deliveredAt: now(),
      coopSessionStorageId: event.coopSessionStorageId || null,
      sessionStorageId: event.sessionStorageId || null,
      taskId: event.taskId || null,
      status: event.status || null,
    });
    delete pending[event.eventId];
    saveState();
  }

  function markPending(event) {
    pending[event.eventId] = event;
    saveState();
  }

  function markFailed(event, reason) {
    failedIds[event.eventId] = true;
    failed.push({
      eventId: event.eventId,
      failedAt: now(),
      reason: reason || "delivery_error",
      coopSessionStorageId: event.coopSessionStorageId || null,
      sessionStorageId: event.sessionStorageId || null,
      taskId: event.taskId || null,
    });
    if (failed.length > 256) failed.splice(0, failed.length - 256);
    delete pending[event.eventId];
    saveState();
  }

  function hasDelivered(eventId) {
    return !!deliveredIds[String(eventId || "")];
  }

  function getDeliveredEventIds() {
    // The watchdog uses this as a terminal-handled index. A dead-letter must
    // stop repeated fan-in attempts just as a delivered event does; its
    // durable transport dead-letter remains the visible attention evidence.
    return Object.keys(deliveredIds).concat(Object.keys(failedIds));
  }

  function getPendingEventIds() {
    return Object.keys(pending);
  }

  function localAttempt(event) {
    var localCoopSession = localSessionByStorageId(event.coopSessionStorageId);
    if (!localCoopSession) return { ok: false, delivered: false, reason: "coop_session_missing" };
    queueCoordinatorUpdate(localCoopSession, eventMessage(event));
    return { ok: true, delivered: true };
  }

  function typedFailure(typedResult) {
    var reason = typedResult && typedResult.reason;
    return {
      ok: false,
      delivered: false,
      reason: reason || "delivery_error",
      terminal: !!(typedResult && typedResult.deadLettered && !typedResult.retryable),
    };
  }

  function typedAttempt(envelope) {
    var typedResult = crossProject.deliverEnvelope(envelope);
    if (typedResult && typedResult.ok) return { ok: true, delivered: true };
    return typedFailure(typedResult);
  }

  function legacyAttempt(event) {
    var result;
    try {
      result = crossProject.deliver(LEAD_SLUG, event.coopSessionStorageId, eventMessage(event));
    } catch (e) {
      return { ok: false, delivered: false, reason: "delivery_error: " + e.message };
    }
    if (!result || !result.ok) {
      return { ok: false, delivered: false, reason: (result && result.reason) || "delivery_failed" };
    }
    return { ok: true, delivered: true };
  }

  // Attempts one delivery for a well-formed, not-yet-delivered event.
  // Returns { ok, delivered } and never throws.
  function attemptDelivery(event) {
    if (slug === LEAD_SLUG) return localAttempt(event);
    if (!crossProject || typeof crossProject.deliver !== "function") {
      return { ok: false, delivered: false, reason: "no_cross_project_router" };
    }
    var envelope = typedEnvelope(event);
    if (envelope && typeof crossProject.deliverEnvelope === "function") return typedAttempt(envelope);
    return legacyAttempt(event);
  }

  function deliverEvent(event) {
    if (!event || !event.eventId || !event.coopSessionStorageId) {
      return { ok: false, delivered: false, reason: "invalid_event" };
    }
    if (hasDelivered(event.eventId)) return { ok: true, delivered: false, duplicate: true };
    if (failedIds[event.eventId]) return { ok: false, delivered: false, failed: true };
    var result = attemptDelivery(event);
    if (result.delivered) {
      markDelivered(event);
      return result;
    }
    if (result.terminal) {
      markFailed(event, result.reason);
      return Object.assign({}, result, { deadLettered: true });
    }
    // Not delivered yet: keep durably pending so the 60s watchdog (or a
    // restart replay) retries it instead of losing the event.
    markPending(event);
    return Object.assign({}, result, { pending: true });
  }

  // Retries every currently-pending event once. Called by the watchdog
  // tick and on startup (restart replay) so a target project that was not
  // yet attached (or a transient failure) gets picked back up without
  // needing a brand-new transition to re-trigger delivery.
  function retryPending() {
    var ids = Object.keys(pending);
    var delivered = [];
    for (var i = 0; i < ids.length; i++) {
      var event = pending[ids[i]];
      if (!event) continue;
      if (hasDelivered(event.eventId)) { delete pending[event.eventId]; continue; }
      if (failedIds[event.eventId]) { delete pending[event.eventId]; continue; }
      var result = attemptDelivery(event);
      if (result.delivered) {
        markDelivered(event);
        delivered.push(event.eventId);
      } else if (result.terminal) {
        markFailed(event, result.reason);
      }
    }
    return delivered;
  }

  function hasPendingWork() {
    return Object.keys(pending).length > 0;
  }

  loadState();

  return {
    deliverEvent: deliverEvent,
    getDeliveredEventIds: getDeliveredEventIds,
    getPendingEventIds: getPendingEventIds,
    hasDelivered: hasDelivered,
    hasPendingWork: hasPendingWork,
    retryPending: retryPending,
  };
}

module.exports = {
  attachCoopFanIn: attachCoopFanIn,
};
