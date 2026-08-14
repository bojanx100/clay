// Validation, normalization and persistence for the owner-request ledger.
//
// Split out of coop-owner-requests.js at the 500-line module limit. Everything
// here is pure over plain data or touches only the state file, so the ledger
// module above it is just lifecycle rules -- and the shapes the daemon writes
// are the same shapes a reload validates, through one validator rather than
// two that can drift.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");
var normalizeTopicRef = require("./coop-topic-ref").normalizeTopicRefInput;
var normalizeAttentionCode = require("./coop-work-activity").normalizeAttentionCode;
var SCHEMA = "clay.coop_owner_requests";
var VERSION = 1;

// `coop:<sessionStorageId>:<sequence>`, minted by coop-conversation-control's
// reserveIngress. Bounded so a malformed caller cannot key a record on prose.
var INGRESS_ID_RE = /^coop:[A-Za-z0-9._-]{1,128}:[0-9]{1,12}$/;

// The owner-facing lifecycle of one request. Deliberately the same vocabulary
// coop-topic-state.js projects, plus "open" (recorded, nothing linked yet) and
// "attention" (a typed route/staffing failure the owner has to unblock).
var STATES = {
  open: true, working: true, needs_input: true, done: true, attention: true,
};

// How the request was routed. "conversational" is the one kind that expects no
// execution at all -- a small answer the foreground turn gives directly.
var CLASSIFICATIONS = {
  conversational: true, existing_topic: true, new_topic: true,
};

// Terminal execution outcomes projected onto the request. A completed execution
// resolves the WORK; it never resolves the owner's question, so it moves
// `state` and leaves `response` untouched.
var OUTCOME_TO_STATE = {
  completed: "done",
  failed: "attention",
  blocked: "attention",
  unavailable: "attention",
  unrouted: "attention",
  needs_input: "needs_input",
  waiting_user: "needs_input",
};

// Records are small and reference-only, but the Coop session is permanent, so
// the file still needs a ceiling. Pruning only ever drops requests that are
// both answered and terminal: an outstanding request is never evicted to make
// room, however old it is.
var MAX_RECORDS = 2000;

function defaultFile() {
  return path.join(config.CONFIG_DIR, "lead", "coop-owner-requests.json");
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, limit || 500);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ingressId(value) {
  return typeof value === "string" && INGRESS_ID_RE.test(value) ? value : "";
}

function ingressKind(value) {
  return value === "voice" ? "voice" : "text";
}

// A canonical event reference: which session, which event index. This is the
// whole of what the ledger keeps about the request body.
function normalizeEventRef(value) {
  var sessionRef = projectIdentity.normalizeSessionRef(value);
  if (!sessionRef) return null;
  var eventIndex = value && value.eventIndex;
  if (!Number.isInteger(eventIndex) || eventIndex < 0) return null;
  return {
    projectId: sessionRef.projectId,
    sessionStorageId: sessionRef.sessionStorageId,
    eventIndex: eventIndex,
  };
}

function normalizeProjectRefs(values) {
  var list = Array.isArray(values) ? values : [];
  var byId = {};
  var refs = [];
  for (var i = 0; i < list.length; i++) {
    var ref = projectIdentity.normalizeProjectRef(list[i]);
    if (!ref || byId[ref.projectId]) continue;
    byId[ref.projectId] = true;
    refs.push(ref);
  }
  return refs;
}

function sessionKey(ref) {
  return String(ref.projectId) + ":" + String(ref.sessionStorageId);
}

function taskKey(ref) {
  return String(ref.projectId) + ":" + String(ref.taskId);
}

function pushUnique(list, ref, keyOf) {
  if (!ref) return false;
  var wanted = keyOf(ref);
  for (var i = 0; i < list.length; i++) {
    if (keyOf(list[i]) === wanted) return false;
  }
  list.push(ref);
  return true;
}

function emptyLinks() {
  return { coordinators: [], tasks: [], sessions: [] };
}

function normalizeLinks(value) {
  var source = value && typeof value === "object" ? value : {};
  var links = emptyLinks();
  var coordinators = Array.isArray(source.coordinators) ? source.coordinators : [];
  var tasks = Array.isArray(source.tasks) ? source.tasks : [];
  var sessions = Array.isArray(source.sessions) ? source.sessions : [];
  for (var i = 0; i < coordinators.length; i++) {
    pushUnique(links.coordinators, projectIdentity.normalizeSessionRef(coordinators[i]), sessionKey);
  }
  for (var j = 0; j < tasks.length; j++) {
    pushUnique(links.tasks, projectIdentity.normalizeTaskRef(tasks[j]), taskKey);
  }
  for (var k = 0; k < sessions.length; k++) {
    pushUnique(links.sessions, projectIdentity.normalizeSessionRef(sessions[k]), sessionKey);
  }
  return links;
}

// Four response states, not two.
//
//   unanswered  -- the owner is still owed a reply;
//   answered    -- a completed owner-facing turn replied;
//   superseded  -- the owner themselves withdrew the question, by interrupting
//                  the reply with their next message or by stopping the turn.
//   not_required -- a legitimate informational message for which no reply was
//                   expected.
//
// Superseded exists because the alternative is a request that can never leave
// unanswered. Interrupting Coop mid-reply is routine, and without a terminal
// state for it one interrupt pins the owner's queue -- and the Lead tick that
// defers to that queue -- forever. It is deliberately NOT "answered": nobody
// replied, and keeping that distinction is the entire point of this ledger.
function normalizeResponse(value) {
  var source = value && typeof value === "object" ? value : {};
  var state = source.state === "answered" || source.state === "superseded" ||
    source.state === "not_required"
    ? source.state : "unanswered";
  return {
    state: state,
    answeredAt: state === "answered" ? finite(source.answeredAt) : null,
    responseRef: state === "answered" ? normalizeEventRef(source.responseRef) : null,
    supersededAt: state === "superseded" ? finite(source.supersededAt) : null,
    supersededBy: state === "superseded" ? cleanText(source.supersededBy, 40) : "",
  };
}

function normalizeClassification(value) {
  var source = value && typeof value === "object" ? value : null;
  if (!source || !CLASSIFICATIONS[source.kind]) return null;
  return {
    kind: source.kind,
    source: cleanText(source.source, 64),
    at: finite(source.at),
  };
}

function normalizeImplementationDecision(value) {
  var source = value && typeof value === "object" ? value : null;
  var intents = { build: true, fix: true, implement: true, hand_off: true,
    ship: true, deploy: true, code: true };
  if (!source || !intents[source.intent]) return null;
  return { intent: source.intent, source: cleanText(source.source, 64), at: finite(source.at) };
}

function hasExecutionEvidence(source, links, outcome) {
  if (outcome) return true;
  return !!(links.coordinators.length || links.tasks.length || links.sessions.length ||
    source && source.expectsExecution === true && source.state === "working");
}

function expectsExecutionFor(decision, source, links, outcome) {
  return !!decision || hasExecutionEvidence(source || {}, links || emptyLinks(), outcome || null);
}

function normalizeOutcome(value) {
  var source = value && typeof value === "object" ? value : null;
  if (!source) return null;
  var status = cleanText(source.status, 40);
  if (!status) return null;
  return { status: status, at: finite(source.at), summary: cleanText(source.summary, 500) };
}

// Rebuild one record from disk. Anything unrecognised is dropped rather than
// trusted: a hand-edited or partially-written file must not be able to inject
// prose or an unknown state into the owner-facing surface.
function normalizeRecord(value) {
  var source = value && typeof value === "object" ? value : {};
  var id = ingressId(source.ingressId);
  if (!id) return null;
  var sessionRef = projectIdentity.normalizeSessionRef(source.sessionRef);
  if (!sessionRef) return null;
  var classification = normalizeClassification(source.classification);
  var implementationDecision = normalizeImplementationDecision(source.implementationDecision);
  var links = normalizeLinks(source.links);
  var outcome = normalizeOutcome(source.outcome);
  var sequence = Number(source.ingressSequence);
  return {
    ingressId: id,
    ingressSequence: Number.isInteger(sequence) && sequence > 0 ? sequence : 0,
    ingressKind: ingressKind(source.ingressKind),
    sessionRef: sessionRef,
    requestRef: normalizeEventRef(source.requestRef),
    receivedAt: finite(source.receivedAt),
    updatedAt: finite(source.updatedAt),
    response: normalizeResponse(source.response),
    classification: classification,
    implementationDecision: implementationDecision,
    topicRef: normalizeTopicRef(source.topicRef),
    projectRefs: normalizeProjectRefs(source.projectRefs),
    expectsExecution: expectsExecutionFor(implementationDecision, source, links, outcome),
    links: links,
    state: STATES[source.state] ? source.state : "open",
    attention: normalizeAttentionCode(source.attention) || null,
    outcome: outcome,
  };
}

function writeState(fsImpl, file, state) {
  var directory = path.dirname(file);
  var temp = file + ".tmp." + process.pid + "." + crypto.randomUUID();
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fsImpl.renameSync(temp, file);
}

// One topic claim per (topic, project). The ledger lifecycle additionally
// converges every claim for a ProjectRef onto that project's one durable
// coordinator, while portfolio bindings may create bounded task coordinators.
function normalizeClaim(value) {
  var source = value && typeof value === "object" ? value : {};
  // Accepts both the caller's shape (topicRef/projectRef) and the persisted
  // shape (topicId/projectId), so a reload round-trips through one validator
  // rather than a second, quietly divergent one.
  var topicRef = normalizeTopicRef(source.topicRef || { topicId: source.topicId });
  var projectRef = projectIdentity.normalizeProjectRef(
    source.projectRef || { projectId: source.projectId });
  var coordinator = projectIdentity.normalizeSessionRef(source.coordinator);
  if (!topicRef || !projectRef || !coordinator) return null;
  if (coordinator.projectId !== projectRef.projectId) return null;
  var ingressIds = [];
  var supplied = Array.isArray(source.ingressIds) ? source.ingressIds : [];
  for (var i = 0; i < supplied.length; i++) {
    var id = ingressId(supplied[i]);
    if (id && ingressIds.indexOf(id) === -1) ingressIds.push(id);
  }
  return {
    topicId: topicRef.topicId,
    projectId: projectRef.projectId,
    coordinator: coordinator,
    claimedAt: finite(source.claimedAt),
    ingressIds: ingressIds,
    transferredAt: finite(source.transferredAt),
    transferReason: cleanText(source.transferReason, 40),
  };
}

// A file this module cannot parse, or one written by a future version, is
// preserved beside itself rather than silently overwritten by the next write.
// For a ledger whose entire purpose is that an unanswered owner cannot age out
// of view, quietly starting from empty is the one failure mode that must leave
// evidence behind.
function quarantine(fsImpl, file, reason) {
  try {
    if (!fsImpl.existsSync(file)) return;
    var aside = file + ".unreadable." + reason;
    fsImpl.renameSync(file, aside);
    console.warn("[coop-owner-requests] Preserved an unreadable ledger at " + aside +
      " (" + reason + "); starting a new one.");
  } catch (e) {}
}

function loadState(fsImpl, file) {
  var records = [];
  var claims = [];
  var reconciliations = [];
  try {
    var raw;
    try { raw = fsImpl.readFileSync(file, "utf8"); }
    catch (missing) {
      // No file yet is the ordinary first-run case, not a corrupt ledger.
      return { schema: SCHEMA, version: VERSION, requests: records, coordinators: claims,
        reconciliationRequests: reconciliations };
    }
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (broken) {
      quarantine(fsImpl, file, "parse");
      return { schema: SCHEMA, version: VERSION, requests: records, coordinators: claims,
        reconciliationRequests: reconciliations };
    }
    if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.requests) ||
        parsed.version !== VERSION) {
      quarantine(fsImpl, file, "schema");
      return { schema: SCHEMA, version: VERSION, requests: records, coordinators: claims,
        reconciliationRequests: reconciliations };
    }
    {
      for (var i = 0; i < parsed.requests.length; i++) {
        var record = normalizeRecord(parsed.requests[i]);
        if (record) records.push(record);
      }
      var stored = Array.isArray(parsed.coordinators) ? parsed.coordinators : [];
      for (var j = 0; j < stored.length; j++) {
        var claim = normalizeClaim(stored[j]);
        // First claim wins on reload too, so a hand-edited duplicate cannot
        // introduce the second coordinator this table exists to prevent.
        if (claim && !claims.some(function (existing) {
          return existing.topicId === claim.topicId && existing.projectId === claim.projectId;
        })) claims.push(claim);
      }
      var requests = Array.isArray(parsed.reconciliationRequests)
        ? parsed.reconciliationRequests : [];
      for (var k = 0; k < requests.length; k++) {
        var request = requests[k];
        if (!request || typeof request.requestId !== "string" ||
            typeof request.fingerprint !== "string" ||
            !INGRESS_ID_RE.test(request.ingressId || "")) continue;
        reconciliations.push({
          requestId: cleanText(request.requestId, 160),
          ingressId: request.ingressId,
          fingerprint: cleanText(request.fingerprint, 64),
        });
      }
    }
  } catch (e) {}
  return { schema: SCHEMA, version: VERSION, requests: records, coordinators: claims,
    reconciliationRequests: reconciliations.slice(-64),
    ledgerRevision: Number.isInteger(parsed && parsed.ledgerRevision)
      ? parsed.ledgerRevision : 0,
    ledgerDigest: parsed && typeof parsed.ledgerDigest === "string" ? parsed.ledgerDigest : "" };
}

// An outstanding request is one the owner is still owed something on: either no
// answer yet, or an answer given but the work behind it still unresolved. A
// superseded request is owed nothing -- the owner withdrew it themselves.
function outstanding(record) {
  if (record.response.state === "unanswered") return true;
  if (record.response.state === "superseded" || record.response.state === "not_required") return false;
  return record.state !== "done" && record.state !== "open";
}
module.exports = {
  SCHEMA: SCHEMA,
  VERSION: VERSION,
  STATES: STATES,
  CLASSIFICATIONS: CLASSIFICATIONS,
  OUTCOME_TO_STATE: OUTCOME_TO_STATE,
  MAX_RECORDS: MAX_RECORDS,
  clone: clone,
  cleanText: cleanText,
  defaultFile: defaultFile,
  emptyLinks: emptyLinks,
  expectsExecutionFor: expectsExecutionFor,
  finite: finite,
  ingressId: ingressId,
  ingressKind: ingressKind,
  loadState: loadState,
  normalizeClaim: normalizeClaim,
  normalizeEventRef: normalizeEventRef,
  normalizeOutcome: normalizeOutcome,
  normalizeImplementationDecision: normalizeImplementationDecision,
  normalizeProjectRefs: normalizeProjectRefs,
  normalizeRecord: normalizeRecord,
  outstanding: outstanding,
  pushUnique: pushUnique,
  sessionKey: sessionKey,
  taskKey: taskKey,
  writeState: writeState,
};
