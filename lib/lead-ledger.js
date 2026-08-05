// Lead event ledger (CTO orchestrator brick 7 — Phase 2).
//
// The Lead's durable memory: every orchestration decision and outcome is a
// typed event appended to a JSONL ledger. The standup composes from these
// events; the loop consults them to avoid double-staffing; restarts lose
// nothing. Same doctrine as everywhere else in the Lead: typed events are
// the record — prose is not.
//
// Isolated state per roadmap §1.1: lives under <CONFIG_DIR>/lead/ and
// nothing outside the Lead reads or writes it. Deleting the directory
// resets the Lead's memory and touches nothing else in Clay.
//
// Event envelope (appendEvent fills seq; caller provides the rest):
//   { seq, at, type, item?, route?, taskId?, verificationDepth?, evidence?,
//     reason?, willRetryAtTier?, note? }
// Types used by the loop: staffed | completed | blocked | failed |
//   standup_composed | lead_note
//
// The dirPath is injectable for tests; production uses leadDir() below.

var fs = require("fs");
var path = require("path");
var config = require("./config");
var trust = require("./lead-trust");

function leadDir() {
  return path.join(config.CONFIG_DIR, "lead");
}

function ledgerPath(dir) {
  return path.join(dir || leadDir(), "ledger.jsonl");
}

function prepareEvent(ev, opts) {
  if (!ev || !ev.type) return null;
  if (ev.type !== trust.TRUST_EVENT_TYPE) return ev;
  var input = {};
  for (var key in ev) input[key] = ev[key];
  if (opts && opts.now !== undefined) input.at = opts.now;
  return trust.normalizeTrustObservation(input);
}

function recordFor(input, last, opts) {
  var record = {};
  for (var key in input) record[key] = input[key];
  record.seq = last ? (last.seq + 1) : 1;
  record.at = (opts && opts.now !== undefined) ? opts.now : (record.at || 0);
  if (record.type !== trust.TRUST_EVENT_TYPE) return record;
  var normalized = trust.normalizeTrustObservation(record);
  if (!normalized) return null;
  normalized.seq = record.seq;
  return normalized;
}

// Append one typed event. Returns the persisted event (with seq/at filled).
// opts: { dir, now } injectable for tests.
function appendEvent(ev, opts) {
  var input = prepareEvent(ev, opts);
  if (!input) return null;
  var dir = (opts && opts.dir) || leadDir();
  var file = ledgerPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  var last = null;
  // seq = last seq + 1; cheap tail read keeps appends O(1)-ish for the
  // ledger sizes a single-boss Lead produces (hundreds of events/week).
  var events = readEvents({ dir: dir });
  if (events.length) last = events[events.length - 1];
  var record = recordFor(input, last, opts);
  if (!record) return null;
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
  return record;
}

// Typed convenience wrapper. Invalid observations are rejected before they
// can enter the durable ledger; appendEvent remains the compatibility API for
// unrelated event types.
function appendTrustObservation(observation, opts) {
  return appendEvent(observation, opts);
}

// Read all events (optionally { sinceSeq, sinceAt, type }). Corrupt lines
// are skipped, never fatal: a torn final write after a crash must not brick
// the Lead's memory (partial-tail recovery, same rule as the Voice ledger).
function readLedger(file) {
  var raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return []; }
  return raw.split("\n");
}

function parseEventLine(line) {
  if (!line) return null;
  var ev;
  try { ev = JSON.parse(line); } catch (e) { return null; }
  return ev && ev.type ? ev : null;
}

function eventMatches(ev, opts) {
  if (opts && opts.sinceSeq && !(ev.seq > opts.sinceSeq)) return false;
  if (opts && opts.sinceAt && !(ev.at > opts.sinceAt)) return false;
  if (opts && opts.type && ev.type !== opts.type) return false;
  return true;
}

function readEvents(opts) {
  var dir = (opts && opts.dir) || leadDir();
  var lines = readLedger(ledgerPath(dir));
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var ev = parseEventLine(lines[i]);
    if (ev && eventMatches(ev, opts)) out.push(ev);
  }
  return out;
}

// Read only explicitly typed trust observations. Channel-less legacy trust
// observations are normalized to text by lead-trust; unrelated ledger events
// are ignored rather than guessed to be trust evidence.
function readTrustObservations(opts) {
  var events = readEvents(opts);
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var observation = trust.normalizeTrustObservation(events[i]);
    if (observation) out.push(observation);
  }
  return out;
}

// Events since the last standup_composed marker — exactly what the standup
// composer wants as its input window.
function eventsSinceLastStandup(opts) {
  var events = readEvents(opts ? { dir: opts.dir } : undefined);
  var lastStandupSeq = 0;
  for (var i = 0; i < events.length; i++) {
    if (events[i].type === "standup_composed") lastStandupSeq = events[i].seq;
  }
  var out = [];
  for (var j = 0; j < events.length; j++) {
    if (events[j].seq > lastStandupSeq && events[j].type !== "standup_composed") out.push(events[j]);
  }
  return out;
}

// Items currently in flight: staffed with no terminal event after it.
// Returns [{ item, route, taskId, at }].
function inFlight(opts) {
  var events = readEvents(opts ? { dir: opts.dir } : undefined);
  var open = {};
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (!ev.item || !ev.item.id) continue;
    if (ev.type === "staffed") open[ev.item.id] = ev;
    else if (ev.type === "completed" || ev.type === "blocked" || ev.type === "failed") delete open[ev.item.id];
  }
  var out = [];
  for (var id in open) out.push(open[id]);
  return out;
}

// Failure count per item id — feeds the routing escalation (each failed
// attempt bumps the tier on the next staffing).
function failureCount(itemId, opts) {
  var events = readEvents(opts ? { dir: opts.dir } : undefined);
  var n = 0;
  for (var i = 0; i < events.length; i++) {
    if (events[i].type === "failed" && events[i].item && events[i].item.id === itemId) n++;
  }
  return n;
}

module.exports = {
  leadDir: leadDir,
  appendEvent: appendEvent,
  appendTrustObservation: appendTrustObservation,
  readEvents: readEvents,
  readTrustObservations: readTrustObservations,
  eventsSinceLastStandup: eventsSinceLastStandup,
  inFlight: inFlight,
  failureCount: failureCount,
};
