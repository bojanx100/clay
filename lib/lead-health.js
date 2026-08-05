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
// Purity contract: parseHealthEvents/deriveHealth take data in;
// readHealthSnapshot and its bounded session scanner are read-only.

var fs = require("fs");
var path = require("path");

// Ignore transitions older than this. Two reasons: (a) a daemon restart
// resets the in-process registry to healthy WITHOUT logging a transition,
// so old unhealthy marks outlive reality; (b) quota windows re-log on the
// next rejected send anyway, refreshing a genuinely bad vendor's mark.
// 24h balances the two (verified against live log 2026-08-04: codex's
// stale Aug-1 mark dropped, claude's fresh credits-exhausted mark kept).
var DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
var SESSION_HEAD_BYTES = 64 * 1024;
var SESSION_TAIL_BYTES = 128 * 1024;
var MAX_SESSION_FILES = 512;

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

function applySessionSuccesses(health, latest, successes) {
  for (var i = 0; i < successes.length; i++) {
    var success = successes[i];
    var transition = success && latest[success.vendor];
    if (!transition) continue;
    if (success.startedAt > transition.at && success.at > transition.at) {
      health[success.vendor] = "healthy";
    }
  }
}

// deriveHealth(events, opts) -> { vendor: "healthy"|"degraded"|"unhealthy" }
//   opts.now: injected clock (ms), required for staleness.
//   opts.maxAgeMs: staleness window (default 24 hours).
//   opts.successes: completed provider sessions started after a transition.
// Last transition per vendor wins; stale transitions are dropped entirely
// (missing vendor = assume healthy, same convention as lead-routing).
function deriveHealth(events, opts) {
  var now = (opts && opts.now) || 0;
  var maxAgeMs = (opts && opts.maxAgeMs) || DEFAULT_MAX_AGE_MS;
  var successes = opts && opts.successes || [];
  var latest = {};
  for (var i = 0; i < (events || []).length; i++) {
    var ev = events[i];
    if (now - ev.at > maxAgeMs) continue;
    if (!latest[ev.vendor] || ev.at >= latest[ev.vendor].at) latest[ev.vendor] = ev;
  }
  var health = {};
  for (var vendor in latest) health[vendor] = latest[vendor].to;
  applySessionSuccesses(health, latest, successes);
  return health;
}

function readBoundedSession(file, size) {
  var fd = fs.openSync(file, "r");
  try {
    if (size <= SESSION_HEAD_BYTES + SESSION_TAIL_BYTES) {
      return fs.readFileSync(fd, "utf8");
    }
    var head = Buffer.alloc(SESSION_HEAD_BYTES);
    var tail = Buffer.alloc(SESSION_TAIL_BYTES);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return head.toString("utf8") + "\n" + tail.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function firstSessionMeta(lines) {
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('"type":"meta"') === -1) continue;
    try { return JSON.parse(lines[i]); } catch (e) {}
  }
  return null;
}

function lastSessionResult(lines) {
  for (var ri = lines.length - 1; ri >= 0; ri--) {
    if (lines[ri].indexOf('"type":"result"') === -1) continue;
    try { return JSON.parse(lines[ri]); } catch (e) {}
  }
  return null;
}

function parseSessionSuccess(text) {
  var lines = String(text || "").split("\n");
  var meta = firstSessionMeta(lines);
  var result = lastSessionResult(lines);
  var startedAt = meta && Number(meta.createdAt);
  var completedAt = result && Number(result._ts || result.at);
  if (!meta || !meta.vendor || !Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null;
  return { vendor: meta.vendor, startedAt: startedAt, at: completedAt };
}

function recentSessionFiles(sessionRoot, now, maxAgeMs) {
  var candidates = [];
  var projects;
  try { projects = fs.readdirSync(sessionRoot, { withFileTypes: true }); } catch (e) { return candidates; }
  for (var pi = 0; pi < projects.length; pi++) {
    if (!projects[pi].isDirectory()) continue;
    var projectDir = path.join(sessionRoot, projects[pi].name);
    var files;
    try { files = fs.readdirSync(projectDir, { withFileTypes: true }); } catch (e) { continue; }
    for (var fi = 0; fi < files.length; fi++) {
      if (!files[fi].isFile() || !files[fi].name.endsWith(".jsonl")) continue;
      var file = path.join(projectDir, files[fi].name);
      var stat;
      try { stat = fs.statSync(file); } catch (e) { continue; }
      if (now - stat.mtimeMs > maxAgeMs) continue;
      candidates.push({ file: file, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  candidates.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
  return candidates.slice(0, MAX_SESSION_FILES);
}

function readRecentSessionSuccesses(sessionRoot, opts) {
  var now = opts.now;
  var files = recentSessionFiles(sessionRoot, now, opts.maxAgeMs);
  var successes = [];
  for (var i = 0; i < files.length; i++) {
    var text;
    try { text = readBoundedSession(files[i].file, files[i].size); } catch (e) { continue; }
    var success = parseSessionSuccess(text);
    if (success && now - success.at <= opts.maxAgeMs) successes.push(success);
  }
  return successes;
}

// readHealthSnapshot(logPath, opts) -> health map (empty on any read error:
// no data means assume healthy, never block the tick on a missing log).
function readHealthSnapshot(logPath, opts) {
  var text;
  try { text = fs.readFileSync(logPath, "utf8"); } catch (e) { return {}; }
  var now = (opts && opts.now) || Date.now();
  var maxAgeMs = opts && opts.maxAgeMs || DEFAULT_MAX_AGE_MS;
  var sessionRoot = opts && opts.sessionRoot || path.join(path.dirname(logPath), "sessions");
  return deriveHealth(parseHealthEvents(text), {
    now: now,
    maxAgeMs: maxAgeMs,
    successes: readRecentSessionSuccesses(sessionRoot, { now: now, maxAgeMs: maxAgeMs }),
  });
}

module.exports = {
  parseHealthEvents: parseHealthEvents,
  deriveHealth: deriveHealth,
  readRecentSessionSuccesses: readRecentSessionSuccesses,
  readHealthSnapshot: readHealthSnapshot,
};
