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

// Ignore transitions older than this. A daemon restart resets the in-process
// registry to healthy WITHOUT logging a transition, so old unhealthy marks
// outlive reality. Timed quota windows are bounded by unavailableUntil below.
// 24h balances this against genuinely fresh provider failures.
var DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
var SESSION_HEAD_BYTES = 64 * 1024;
var SESSION_TAIL_BYTES = 128 * 1024;
var MAX_SESSION_FILES = 512;

var providerHealth = require("./provider-health");

function routeModelKey(providerRouteId, model) {
  return "route:" + String(providerRouteId || "unknown") + "|model:" + providerHealth.modelKey(model);
}

function eventKey(event) {
  if (event && event.providerRouteId) return routeModelKey(event.providerRouteId, event.model);
  return event && event.vendor || "claude";
}

function parseHealthLine(line) {
  if (line.indexOf('"provider_health"') === -1) return null;
  var ev;
  try { ev = JSON.parse(line); } catch (e) { return null; }
  if (!ev || ev.kind !== "provider_health" || !ev.vendor || !ev.to) return null;
  var at = Date.parse(ev.at || "");
  if (isNaN(at)) return null;
  return {
    at: at,
    vendor: ev.vendor,
    providerRouteId: ev.providerRouteId || null,
    model: ev.model || null,
    scope: ev.scope || (ev.providerRouteId ? "route-model" : "vendor"),
    unavailableUntil: Number(ev.unavailableUntil) || null,
    to: ev.to,
  };
}

// parseHealthEvents(text) -> [{ at(ms), vendor, providerRouteId, model, to }]
// Tolerates junk lines — the log is best-effort by design.
function parseHealthEvents(text) {
  var events = [];
  var lines = String(text || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var event = parseHealthLine(lines[i]);
    if (event) events.push(event);
  }
  return events;
}

function applySessionSuccesses(health, latest, successes) {
  for (var i = 0; i < successes.length; i++) {
    var success = successes[i];
    if (!success) continue;
    var keys = [success.vendor];
    if (success.providerRouteId) keys.push(routeModelKey(success.providerRouteId, success.model));
    for (var ki = 0; ki < keys.length; ki++) {
      var transition = latest[keys[ki]];
      if (!transition) continue;
      if (transition.unavailableUntil && success.at < transition.unavailableUntil) continue;
      if (success.startedAt > transition.at && success.at > transition.at) {
        health[keys[ki]] = "healthy";
      }
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
    if (ev.unavailableUntil && now >= ev.unavailableUntil) continue;
    if (now - ev.at > maxAgeMs && !(ev.unavailableUntil && ev.unavailableUntil > now)) continue;
    var key = eventKey(ev);
    if (!latest[key] || ev.at >= latest[key].at) latest[key] = ev;
  }
  var health = {};
  for (var key in latest) health[key] = latest[key].to;
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

function lastTurnStart(lines, completedAt) {
  for (var i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf('"type":"user_message"') === -1) continue;
    try {
      var entry = JSON.parse(lines[i]);
      var at = Number(entry && (entry._ts || entry.at));
      if (Number.isFinite(at) && at <= completedAt) return at;
    } catch (e) {}
  }
  return null;
}

function parseSessionSuccess(text) {
  var lines = String(text || "").split("\n");
  var meta = firstSessionMeta(lines);
  var result = lastSessionResult(lines);
  var completedAt = result && Number(result._ts || result.at);
  var startedAt = Number.isFinite(completedAt) ? lastTurnStart(lines, completedAt) : null;
  if (!Number.isFinite(startedAt)) startedAt = meta && Number(meta.createdAt);
  if (!meta || !meta.vendor || !Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null;
  return {
    vendor: meta.vendor,
    providerRouteId: meta.providerRouteId || null,
    model: meta.verifiedModel || meta.requestedModel || meta.model || null,
    startedAt: startedAt,
    at: completedAt,
  };
}

function genericHealthFamily(model) {
  var generic = String(model || "").toLowerCase();
  if (generic === "best" || generic === "fable") return "fable";
  if (["opus", "sonnet", "haiku"].indexOf(generic) !== -1) return generic;
  return null;
}

function worseHealth(left, right) {
  if (left === "unhealthy" || right === "unhealthy") return "unhealthy";
  if (left === "degraded" || right === "degraded") return "degraded";
  return "healthy";
}

function genericFamilyHealth(snapshot, providerRouteId, family) {
  if (!family || !snapshot) return "healthy";
  var prefix = "route:" + String(providerRouteId || "unknown") + "|model:";
  var result = "healthy";
  for (var key in snapshot) {
    if (key.indexOf(prefix) !== 0 || key.slice(prefix.length).indexOf(family) === -1) continue;
    result = worseHealth(result, snapshot[key]);
  }
  return result;
}

function healthForCandidate(snapshot, vendor, providerRouteId, model) {
  var vendorState = snapshot && snapshot[vendor] || "healthy";
  var targetState = snapshot && snapshot[routeModelKey(providerRouteId, model)] || "healthy";
  targetState = worseHealth(targetState,
    genericFamilyHealth(snapshot, providerRouteId, genericHealthFamily(model)));
  return worseHealth(vendorState, targetState);
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
  routeModelKey: routeModelKey,
  healthForCandidate: healthForCandidate,
};
