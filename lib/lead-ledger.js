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
//   project_completed | project_completion_revoked | worker_completed |
//   portfolio_completed | standup_composed | lead_note
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

function completionData(event) {
  return event && event.data && typeof event.data === "object" ? event.data : event || {};
}

function completionField(event, name) {
  var data = completionData(event);
  return event && event[name] !== undefined ? event[name] : data[name];
}

function bindingReference(binding) {
  return binding && (binding.mode === "project_coordinator" ? binding.coordinator : binding.worker);
}

function sameBinding(event, binding) {
  return String(completionField(event, "portfolioTaskId") || "") === binding.portfolioTaskId &&
    Number(completionField(event, "bindingRevision")) === binding.bindingRevision;
}

function latestBindingEvent(events, binding, types) {
  for (var i = events.length - 1; i >= 0; i--) {
    if (types[events[i].type] && sameBinding(events[i], binding)) return events[i];
  }
  return null;
}

function hasCompletionEvidence(event, integrationRequired) {
  var summary = String(completionField(event, "summary") || "").trim();
  var verification = String(completionField(event, "verification") || "").trim();
  var escalation = String(completionField(event, "escalationRequired") || "no").trim();
  var integration = String(completionField(event, "integrationVerification") || "").trim();
  var graphDigest = String(completionField(event, "graphDigest") || "").trim();
  var completionRevision = Number(completionField(event, "completionRevision"));
  return !!(summary && verification && /^no\b/i.test(escalation) &&
    (!integrationRequired || (/^yes\b/i.test(integration) && graphDigest && completionRevision > 0)));
}

function bindingBlockReason(binding) {
  if (!binding || binding.status !== "active") return "binding_unavailable";
  if (!bindingReference(binding)) return "missing_reference";
  if (/^(?:pending|running|reviewing)$/i.test(String(binding.executionStatus || ""))) {
    return "active_execution";
  }
  return "";
}

function inboxHasSequenceGap(inbox) {
  var targets = inbox && inbox.streams || {};
  var targetKeys = Object.keys(targets);
  for (var i = 0; i < targetKeys.length; i++) {
    if (Object.keys(targets[targetKeys[i]].buffered || {}).length) return true;
  }
  return false;
}

function deliveryFailure(input) {
  var delivery = input && (input.deliveryState || input.delivery) || {};
  if (Array.isArray(input && input.deliveryFailures) && input.deliveryFailures.length) return true;
  if (Array.isArray(delivery.deadLetters) && delivery.deadLetters.length) return true;
  if (Object.keys(delivery.outbox || {}).length) return true;
  var inboxes = delivery.inbox || {};
  var keys = Object.keys(inboxes);
  for (var i = 0; i < keys.length; i++) if (inboxHasSequenceGap(inboxes[keys[i]])) return true;
  return false;
}

function completionBlockReason(binding, events) {
  var project = binding.mode === "project_coordinator";
  var types = project
    ? { project_completed: true, project_completion_revoked: true }
    : { worker_completed: true, worker_completion_revoked: true };
  var event = latestBindingEvent(events, binding, types);
  if (!event) return project ? "project_unverified" : "worker_unverified";
  if (/revoked$/.test(event.type)) return "completion_revoked";
  if (!hasCompletionEvidence(event, project)) return "completion_unverified";
  return "";
}

// This is a read-only verdict. Coop calls appendPortfolioCompletion only after
// this function is green; project coordinators and workers cannot write it.
function portfolioPreflight(value, bindings) {
  if (!bindings.length) return "no_bindings";
  if (deliveryFailure(value)) return "delivery_failure";
  if (Array.isArray(value.referenceFailures) && value.referenceFailures.length) return "reference_failure";
  return "";
}

function unresolvedBindings(bindings, events) {
  var unresolved = [];
  for (var i = 0; i < bindings.length; i++) {
    var reason = bindingBlockReason(bindings[i]) || completionBlockReason(bindings[i], events);
    if (reason) unresolved.push({
      portfolioTaskId: bindings[i] && bindings[i].portfolioTaskId || "",
      bindingRevision: bindings[i] && bindings[i].bindingRevision || null,
      reason: reason,
    });
  }
  return unresolved;
}

function portfolioCompletionGate(input) {
  var value = input || {};
  var bindings = Array.isArray(value.bindings) ? value.bindings : [];
  var events = Array.isArray(value.events) ? value.events : [];
  var preflight = portfolioPreflight(value, bindings);
  if (preflight) return { eligible: false, reason: preflight, unresolved: [] };
  var unresolved = unresolvedBindings(bindings, events);
  return unresolved.length ? { eligible: false, reason: unresolved[0].reason, unresolved: unresolved } :
    { eligible: true, reason: "", unresolved: [] };
}

function appendPortfolioCompletion(input, opts) {
  var value = input || {};
  if (value.owner !== "coop") return { ok: false, reason: "owner_required" };
  var events = Array.isArray(value.events) ? value.events : readEvents(opts);
  var gate = portfolioCompletionGate(Object.assign({}, value, { events: events }));
  if (!gate.eligible) return { ok: false, reason: gate.reason, gate: gate };
  var event = appendEvent({
    type: "portfolio_completed",
    portfolioTaskId: value.portfolioTaskId || null,
    bindingRevisions: value.bindings.map(function (binding) {
      return { portfolioTaskId: binding.portfolioTaskId, bindingRevision: binding.bindingRevision };
    }),
    owner: "coop",
    verification: String(value.verification || "").trim(),
  }, opts);
  return event ? { ok: true, event: event, gate: gate } : { ok: false, reason: "persistence_failed" };
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
  portfolioCompletionGate: portfolioCompletionGate,
  appendPortfolioCompletion: appendPortfolioCompletion,
};
