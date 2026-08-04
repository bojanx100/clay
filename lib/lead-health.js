// Lead provider-health snapshot from the recovery log.
//
// The daemon tracks vendor health in-process (lib/provider-health.js) and
// mirrors every state transition to the recovery log as a typed
// `provider_health` event. The Lead's tick runs in its own process, so it
// cannot see the daemon's registry — but it can replay the log. This module
// derives the { vendor: state } snapshot that lead-routing expects from
// those events (boss incident 2026-08-04: Claude credits exhausted for 64h
// while the Lead kept routing t4 work to claude/fable).
//
// Purity contract: parseHealthEvents/deriveHealth take data in; only
// readHealthSnapshot touches the filesystem (read-only).

var fs = require("fs");

// Ignore transitions older than this. Two reasons: (a) a daemon restart
// resets the in-process registry to healthy WITHOUT logging a transition,
// so old unhealthy marks outlive reality; (b) quota windows re-log on the
// next rejected send anyway, refreshing a genuinely bad vendor's mark.
// 24h balances the two (verified against live log 2026-08-04: codex's
// stale Aug-1 mark dropped, claude's fresh credits-exhausted mark kept).
var DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// parseHealthEvents(text) -> [{ at(ms), vendor, to }]
// Tolerates junk lines — the log is best-effort by design.
function parseHealthEvents(text) {
  var events = [];
  var lines = String(text || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('"provider_health"') === -1) continue;
    var ev;
    try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
    if (!ev || ev.kind !== "provider_health" || !ev.vendor || !ev.to) continue;
    var at = Date.parse(ev.at || "");
    if (isNaN(at)) continue;
    events.push({ at: at, vendor: ev.vendor, to: ev.to });
  }
  return events;
}

// deriveHealth(events, opts) -> { vendor: "healthy"|"degraded"|"unhealthy" }
//   opts.now: injected clock (ms), required for staleness.
//   opts.maxAgeMs: staleness window (default 7 days).
// Last transition per vendor wins; stale transitions are dropped entirely
// (missing vendor = assume healthy, same convention as lead-routing).
function deriveHealth(events, opts) {
  var now = (opts && opts.now) || 0;
  var maxAgeMs = (opts && opts.maxAgeMs) || DEFAULT_MAX_AGE_MS;
  var latest = {};
  for (var i = 0; i < (events || []).length; i++) {
    var ev = events[i];
    if (now - ev.at > maxAgeMs) continue;
    if (!latest[ev.vendor] || ev.at >= latest[ev.vendor].at) latest[ev.vendor] = ev;
  }
  var health = {};
  for (var vendor in latest) health[vendor] = latest[vendor].to;
  return health;
}

// readHealthSnapshot(logPath, opts) -> health map (empty on any read error:
// no data means assume healthy, never block the tick on a missing log).
function readHealthSnapshot(logPath, opts) {
  var text;
  try { text = fs.readFileSync(logPath, "utf8"); } catch (e) { return {}; }
  return deriveHealth(parseHealthEvents(text), {
    now: (opts && opts.now) || Date.now(),
    maxAgeMs: opts && opts.maxAgeMs,
  });
}

module.exports = {
  parseHealthEvents: parseHealthEvents,
  deriveHealth: deriveHealth,
  readHealthSnapshot: readHealthSnapshot,
};
