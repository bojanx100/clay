// project-auto-launch-activity.js - Recent activity log for the auto-launch
// schedule so the sidebar chip can show "what ran today" with a full
// recent-history view for review. Each event records the recipe, item title,
// summary, session id and timestamp.
//
// The client decides what counts as "today" (local midnight) and groups the
// history by day, so this module just keeps a capped, newest-first log.
//
// State lives server-side per project in .clay/tasks/auto-launch-activity.json:
//   { "events": [ { id, type, recipeId, autoKind, number, url, title,
//                   sessionId, storageId, summary, ts }, ... up to 200,
//                   newest first ] }

var fs = require("fs");
var path = require("path");

var MAX_EVENTS = 200;

// started   - a session was actually created (carries sessionId/storageId)
// completed  - that session finished its workflow
// proposed   - handed to Coop as a candidate; no session exists
// blocked    - policy or authority refused it
// failed     - a launch was attempted and produced no session
var KNOWN_TYPES = {
  started: true, completed: true, proposed: true, blocked: true,
  failed: true, unknown: true,
};

function createActivityStore(cwd) {
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var file = path.join(tasksDir, "auto-launch-activity.json");
  var seq = 0;

  function readEvents() {
    try {
      var p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (p && Array.isArray(p.events)) return p.events;
    } catch (e) {}
    return [];
  }

  function write(events) {
    try {
      fs.mkdirSync(tasksDir, { recursive: true });
      var tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ events: events }, null, 2) + "\n");
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error("[auto-launch-activity] save failed:", e.message);
    }
  }

  function record(info) {
    info = info || {};
    var events = readEvents();
    var ev = {
      id: "al_" + Date.now() + "_" + (seq++),
      // A real vocabulary, not "completed or else started".
      //
      // This coercion is what produced the trialview/v2#2517 signature: under
      // Coop the controller PROPOSES rather than launches, but every proposal
      // was relabelled "started" — with sessionId:null and storageId:null,
      // because a proposal has no session — once every five minutes for hours.
      // The feed said work was starting while nothing ever started.
      //
      // An unrecognized type is recorded as "unknown" rather than silently
      // becoming "started": inventing a launch that did not happen is exactly
      // the failure this replaces.
      type: KNOWN_TYPES[info.type] ? info.type : "unknown",
      recipeId: info.recipeId || "",
      autoKind: info.autoKind || "issue",
      number: info.number != null ? info.number : null,
      url: info.url || "",
      title: info.title || "",
      sessionId: info.sessionId != null ? info.sessionId : null,
      // Persistent session reference. localId is a throwaway counter that gets
      // reassigned on every restart, so navigation must resolve by storageId.
      storageId: info.storageId || null,
      summary: info.summary || "",
      // Why a non-launch outcome happened. Without this a "failed" or
      // "blocked" entry is indistinguishable from any other and the feed
      // cannot explain itself.
      reason: info.reason || "",
      ts: Date.now(),
    };
    // "started" asserts a session exists. Recording one without a session is
    // how the feed came to claim hours of launches that never happened, so it
    // is downgraded rather than trusted.
    if (ev.type === "started" && ev.sessionId == null && ev.storageId == null) {
      ev.type = "failed";
      ev.reason = ev.reason || "session_not_created";
    }
    events.unshift(ev);
    if (events.length > MAX_EVENTS) events = events.slice(0, MAX_EVENTS);
    write(events);
    return ev;
  }

  function payload() {
    return { events: readEvents() };
  }

  function clear() {
    write([]);
  }

  return { record: record, payload: payload, clear: clear };
}

module.exports = { createActivityStore: createActivityStore };
