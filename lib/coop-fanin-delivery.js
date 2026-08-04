var fs = require("fs");
var path = require("path");
var config = require("./config");

var DELIVERY_FILE = path.join(config.CONFIG_DIR, "coop-fanin-delivery.json");

function attachCoopFanIn(ctx) {
  var sm = ctx.sm;
  var queueCoordinatorUpdate = ctx.queueCoordinatorUpdate;
  var now = ctx.now || Date.now;
  var deliveryFile = ctx.deliveryFile || DELIVERY_FILE;
  var deliveredIds = {};
  var records = [];

  function loadState() {
    try {
      var parsed = JSON.parse(fs.readFileSync(deliveryFile, "utf8"));
      var list = Array.isArray(parsed && parsed.delivered) ? parsed.delivered : [];
      records = list;
      deliveredIds = {};
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].eventId) deliveredIds[list[i].eventId] = true;
      }
    } catch (e) {
      records = [];
      deliveredIds = {};
    }
  }

  function saveState() {
    fs.mkdirSync(path.dirname(deliveryFile), { recursive: true });
    var tmp = deliveryFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ delivered: records }, null, 2));
    fs.renameSync(tmp, deliveryFile);
  }

  function storageIdForSession(session) {
    return session && (session.storageId || session.cliSessionId) || null;
  }

  function sessionByStorageId(storageId) {
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
    saveState();
  }

  function hasDelivered(eventId) {
    return !!deliveredIds[String(eventId || "")];
  }

  function getDeliveredEventIds() {
    return Object.keys(deliveredIds);
  }

  function deliverEvent(event) {
    if (!event || !event.eventId || !event.coopSessionStorageId) {
      return { ok: false, delivered: false, reason: "invalid_event" };
    }
    if (hasDelivered(event.eventId)) return { ok: true, delivered: false, duplicate: true };
    var coopSession = sessionByStorageId(event.coopSessionStorageId);
    if (!coopSession) return { ok: false, delivered: false, reason: "coop_session_missing" };
    queueCoordinatorUpdate(coopSession, eventMessage(event));
    markDelivered(event);
    return { ok: true, delivered: true };
  }

  loadState();

  return {
    deliverEvent: deliverEvent,
    getDeliveredEventIds: getDeliveredEventIds,
    hasDelivered: hasDelivered,
  };
}

module.exports = {
  attachCoopFanIn: attachCoopFanIn,
};
