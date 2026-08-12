// Durable owner-request ledger keyed by Coop ingress id.
//
// This is the authoritative record of what the owner asked for and whether the
// owner has been answered. Everything else in the Coop stack -- the topic
// index, the session ledger, portfolio bindings, orchestration tasks -- records
// what the SYSTEM did. None of them records what the OWNER is still owed, which
// is why an unanswered request used to be invisible the moment a worker
// started.
//
// Two rules make this ledger worth having:
//
//   1. Reference-only, exactly like coop-topic-index.js. The ledger stores
//      canonical event references (project + session storage id + event index)
//      and bounded codes. It never copies what the owner wrote; the canonical
//      transcript remains the single source of that text.
//
//   2. Starting work is NOT answering. linkExecution(), setState("working") and
//      a completed applyOutcome() all leave `response.state` alone. Only
//      markAnswered(), driven by the owner-facing turn completing, may flip it.
//      Without this separation "Coop is busy" reads as "the owner got a reply",
//      which is exactly the failure this ledger exists to prevent.

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

function normalizeResponse(value) {
  var source = value && typeof value === "object" ? value : {};
  var answered = source.state === "answered";
  return {
    state: answered ? "answered" : "unanswered",
    answeredAt: answered ? finite(source.answeredAt) : null,
    responseRef: answered ? normalizeEventRef(source.responseRef) : null,
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

function expectsExecutionFor(classification) {
  if (!classification) return false;
  return classification.kind === "existing_topic" || classification.kind === "new_topic";
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
    topicRef: normalizeTopicRef(source.topicRef),
    projectRefs: normalizeProjectRefs(source.projectRefs),
    expectsExecution: expectsExecutionFor(classification),
    links: normalizeLinks(source.links),
    state: STATES[source.state] ? source.state : "open",
    attention: normalizeAttentionCode(source.attention) || null,
    outcome: normalizeOutcome(source.outcome),
  };
}

function writeState(fsImpl, file, state) {
  var directory = path.dirname(file);
  var temp = file + ".tmp." + process.pid + "." + crypto.randomUUID();
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fsImpl.renameSync(temp, file);
}

// One canonical coordinator per (topic, project). Portfolio bindings already
// guarantee one active binding per portfolio TASK, which is a different and
// weaker property: it cannot stop a follow-up on the same topic from staffing a
// second coordinator in the same project under a new task id.
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
  };
}

function loadState(fsImpl, file) {
  var records = [];
  var claims = [];
  try {
    var parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (parsed && parsed.schema === SCHEMA && parsed.version === VERSION &&
        Array.isArray(parsed.requests)) {
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
    }
  } catch (e) {}
  return { schema: SCHEMA, version: VERSION, requests: records, coordinators: claims };
}

// An outstanding request is one the owner is still owed something on: either no
// answer yet, or an answer given but the work behind it still unresolved.
function outstanding(record) {
  return record.response.state !== "answered" ||
    (record.state !== "done" && record.state !== "open");
}

function attachCoopOwnerRequests(options) {
  var opts = options || {};
  var file = opts.file || defaultFile();
  var fsImpl = opts.fs || fs;
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var state = loadState(fsImpl, file);
  var index = {};

  function reindex() {
    index = {};
    for (var i = 0; i < state.requests.length; i++) {
      index[state.requests[i].ingressId] = state.requests[i];
    }
  }
  reindex();

  // Never evicts an outstanding request: the whole point of the ledger is that
  // an unanswered owner cannot age out of view.
  function prune() {
    if (state.requests.length <= MAX_RECORDS) return;
    var keep = [];
    var settled = [];
    for (var i = 0; i < state.requests.length; i++) {
      if (outstanding(state.requests[i])) keep.push(state.requests[i]);
      else settled.push(state.requests[i]);
    }
    var room = Math.max(0, MAX_RECORDS - keep.length);
    settled.sort(function (left, right) {
      return (left.ingressSequence || 0) - (right.ingressSequence || 0);
    });
    state.requests = keep.concat(settled.slice(Math.max(0, settled.length - room)));
    state.requests.sort(function (left, right) {
      return (left.ingressSequence || 0) - (right.ingressSequence || 0);
    });
    reindex();
  }

  function persist() {
    prune();
    try { writeState(fsImpl, file, state); return true; }
    catch (e) { return false; }
  }

  function touch(record) {
    record.updatedAt = now();
    persist();
    return clone(record);
  }

  function find(id) {
    var key = ingressId(id);
    return key && Object.prototype.hasOwnProperty.call(index, key) ? index[key] : null;
  }

  // Idempotent by ingress id. A replayed ingress (restart rebuild, duplicate
  // reservation) must find its existing record rather than reset an answer.
  function record(input) {
    var source = input && typeof input === "object" ? input : {};
    var id = ingressId(source.ingressId);
    if (!id) return null;
    var sessionRef = projectIdentity.normalizeSessionRef(source.sessionRef);
    if (!sessionRef) return null;
    var existing = find(id);
    if (existing) {
      // Late-arriving detail is welcome; established facts are not overwritten.
      if (!existing.requestRef) existing.requestRef = normalizeEventRef(source.requestRef);
      return clone(existing);
    }
    var sequence = Number(source.ingressSequence);
    var next = {
      ingressId: id,
      ingressSequence: Number.isInteger(sequence) && sequence > 0 ? sequence : 0,
      ingressKind: ingressKind(source.ingressKind),
      sessionRef: sessionRef,
      requestRef: normalizeEventRef(source.requestRef),
      receivedAt: finite(source.receivedAt) || now(),
      updatedAt: now(),
      response: { state: "unanswered", answeredAt: null, responseRef: null },
      classification: null,
      topicRef: normalizeTopicRef(source.topicRef),
      projectRefs: normalizeProjectRefs(source.projectRefs),
      expectsExecution: false,
      links: emptyLinks(),
      state: "open",
      attention: null,
      outcome: null,
    };
    state.requests.push(next);
    index[id] = next;
    persist();
    return clone(next);
  }

  // The ONE transition to answered. Called from the owner-facing turn
  // completing, never from anything that starts, advances or finishes work.
  function markAnswered(id, options) {
    var found = find(id);
    if (!found) return null;
    // First answer wins: a later turn in the same lane is a follow-up, not a
    // restatement of when this request was satisfied.
    if (found.response.state === "answered") return clone(found);
    var input = options || {};
    var eventIndex = input.eventIndex;
    var responseRef = Number.isInteger(eventIndex) && eventIndex >= 0
      ? normalizeEventRef({
        projectId: found.sessionRef.projectId,
        sessionStorageId: found.sessionRef.sessionStorageId,
        eventIndex: eventIndex,
      }) : null;
    found.response = {
      state: "answered",
      answeredAt: finite(input.at) || now(),
      responseRef: responseRef,
    };
    return touch(found);
  }

  function classify(id, options) {
    var found = find(id);
    if (!found) return null;
    var input = options || {};
    if (!CLASSIFICATIONS[input.kind]) return clone(found);
    var classification = {
      kind: input.kind,
      source: cleanText(input.source, 64),
      at: finite(input.at) || now(),
    };
    found.classification = classification;
    found.expectsExecution = expectsExecutionFor(classification);
    var topicRef = normalizeTopicRef(input.topicRef);
    if (topicRef) found.topicRef = topicRef;
    // A conversational turn is answered in the foreground and routes to no
    // project. Carrying ProjectRefs here would invite execution the owner never
    // asked for, which is the "do not spawn for trivial answers" rule.
    found.projectRefs = classification.kind === "conversational"
      ? [] : normalizeProjectRefs(input.projectRefs);
    return touch(found);
  }

  // Execution linkage only. Deliberately cannot touch `response`.
  function linkExecution(id, options) {
    var found = find(id);
    if (!found) return null;
    var input = options || {};
    pushUnique(found.links.coordinators,
      projectIdentity.normalizeSessionRef(input.coordinator), sessionKey);
    pushUnique(found.links.tasks,
      projectIdentity.normalizeTaskRef(input.task), taskKey);
    pushUnique(found.links.sessions,
      projectIdentity.normalizeSessionRef(input.session), sessionKey);
    var projectRefs = normalizeProjectRefs(
      (input.projectRefs || []).concat(found.projectRefs));
    if (projectRefs.length) found.projectRefs = projectRefs;
    return touch(found);
  }

  function setState(id, next) {
    var found = find(id);
    if (!found) return null;
    if (!STATES[next]) return clone(found);
    found.state = next;
    if (next !== "attention") found.attention = null;
    return touch(found);
  }

  // A typed route/staffing failure the owner has to unblock. The code comes
  // from coop-work-activity's closed vocabulary, so no prose lands on disk.
  function recordAttention(id, reason) {
    var found = find(id);
    if (!found) return null;
    found.state = "attention";
    found.attention = normalizeAttentionCode(reason) || "attention_required";
    return touch(found);
  }

  // Fan-in from a project coordinator or worker. Moves the request's work
  // state; never claims the owner was answered.
  function applyOutcome(id, options) {
    var found = find(id);
    if (!found) return null;
    var input = options || {};
    var outcome = normalizeOutcome({
      status: input.status, summary: input.summary, at: finite(input.at) || now(),
    });
    if (!outcome) return clone(found);
    found.outcome = outcome;
    var mapped = OUTCOME_TO_STATE[outcome.status];
    if (mapped) {
      found.state = mapped;
      if (mapped !== "attention") found.attention = null;
    }
    return touch(found);
  }

  function bySequence(left, right) {
    return (left.ingressSequence || 0) - (right.ingressSequence || 0);
  }

  function findClaim(topicId, projectId) {
    for (var i = 0; i < state.coordinators.length; i++) {
      var claim = state.coordinators[i];
      if (claim.topicId === topicId && claim.projectId === projectId) return claim;
    }
    return null;
  }

  // Idempotent, first-claim-wins. A repeat claim by the same coordinator is a
  // reuse; a claim by a DIFFERENT one is refused and told which coordinator is
  // canonical, so the caller routes the follow-up there instead of staffing a
  // rival for work already in flight.
  function claimCoordinator(options) {
    var claim = normalizeClaim(options);
    if (!claim) {
      var attempted = options || {};
      var topicRef = normalizeTopicRef(attempted.topicRef);
      var projectRef = projectIdentity.normalizeProjectRef(attempted.projectRef);
      var coordinator = projectIdentity.normalizeSessionRef(attempted.coordinator);
      if (topicRef && projectRef && coordinator &&
          coordinator.projectId !== projectRef.projectId) {
        return { ok: false, reason: "project_mismatch" };
      }
      return { ok: false, reason: "invalid_claim" };
    }
    var linkId = ingressId(options && options.ingressId);
    var existing = findClaim(claim.topicId, claim.projectId);
    if (existing) {
      if (existing.coordinator.sessionStorageId !== claim.coordinator.sessionStorageId) {
        return { ok: false, reason: "coordinator_exists", coordinator: clone(existing.coordinator) };
      }
      if (linkId && existing.ingressIds.indexOf(linkId) === -1) existing.ingressIds.push(linkId);
      if (linkId) linkExecution(linkId, { coordinator: existing.coordinator, projectRefs: [{ projectId: claim.projectId }] });
      persist();
      return { ok: true, created: false, reused: true, coordinator: clone(existing.coordinator) };
    }
    claim.claimedAt = claim.claimedAt || now();
    if (linkId) claim.ingressIds.push(linkId);
    state.coordinators.push(claim);
    if (linkId) linkExecution(linkId, { coordinator: claim.coordinator, projectRefs: [{ projectId: claim.projectId }] });
    persist();
    return { ok: true, created: true, reused: false, coordinator: clone(claim.coordinator) };
  }

  // Closing a topic settles the requests it resolved, and ONLY those.
  //
  // Deliberately preserved, because closing a topic is not the same as the
  // owner being satisfied:
  //   * a request still needing the owner's decision (needs_input/attention)
  //     keeps that state -- closing must not hide work the owner has to act on;
  //   * an unanswered request stays unanswered and therefore stays queryable,
  //     however the topic was closed.
  // Idempotent: a second close finds nothing left to settle.
  function reconcileTopicClosure(topicRef) {
    var wanted = normalizeTopicRef(topicRef);
    if (!wanted) return { ok: false, reason: "invalid_topic_ref", settled: [], preserved: [] };
    var settled = [];
    var preserved = [];
    var changed = false;
    for (var i = 0; i < state.requests.length; i++) {
      var entry = state.requests[i];
      if (!entry.topicRef || entry.topicRef.topicId !== wanted.topicId) continue;
      if (entry.state === "needs_input" || entry.state === "attention") {
        preserved.push(clone(entry));
        continue;
      }
      if (entry.state !== "done") {
        entry.state = "done";
        entry.updatedAt = now();
        changed = true;
      }
      settled.push(clone(entry));
    }
    if (changed) persist();
    return { ok: true, settled: settled, preserved: preserved, changed: changed };
  }

  function listCoordinators() {
    return state.coordinators.map(clone);
  }

  function canonicalCoordinator(topicRef, projectRef) {
    var topic = normalizeTopicRef(topicRef);
    var project = projectIdentity.normalizeProjectRef(projectRef);
    if (!topic || !project) return null;
    var claim = findClaim(topic.topicId, project.projectId);
    return claim ? clone(claim.coordinator) : null;
  }

  // Fan-in from one project coordinator back onto the owner's requests. Only
  // requests that expect execution are touched: a conversational turn was
  // answered in the foreground and must never be dragged into an execution
  // outcome it did not ask for.
  function applyCoordinatorOutcome(options) {
    var input = options || {};
    var topic = normalizeTopicRef(input.topicRef);
    if (!topic) return [];
    var project = projectIdentity.normalizeProjectRef(input.projectRef);
    var updated = [];
    for (var i = 0; i < state.requests.length; i++) {
      var entry = state.requests[i];
      if (!entry.topicRef || entry.topicRef.topicId !== topic.topicId) continue;
      if (!entry.expectsExecution) continue;
      if (project && entry.projectRefs.length &&
          !entry.projectRefs.some(function (ref) { return ref.projectId === project.projectId; })) continue;
      var record = applyOutcome(entry.ingressId, {
        status: input.status, summary: input.summary, at: input.at,
      });
      if (record) updated.push(record);
    }
    return updated.sort(bySequence);
  }

  function get(id) {
    var found = find(id);
    return found ? clone(found) : null;
  }

  function list(options) {
    var query = options || {};
    return state.requests.filter(function (entry) {
      if (query.state && entry.state !== query.state) return false;
      if (query.unansweredOnly && entry.response.state === "answered") return false;
      if (query.outstandingOnly && !outstanding(entry)) return false;
      return true;
    }).sort(bySequence).map(clone);
  }

  // Oldest first: the owner who has waited longest leads. This ordering IS the
  // priority rule -- a routine Lead tick consults this list before anything it
  // would have done on its own schedule.
  function unanswered() {
    return list({ unansweredOnly: true });
  }

  function hasUnansweredOwnerRequests() {
    for (var i = 0; i < state.requests.length; i++) {
      if (state.requests[i].response.state !== "answered") return true;
    }
    return false;
  }

  function forTopic(topicRef) {
    var wanted = normalizeTopicRef(topicRef);
    if (!wanted) return [];
    return state.requests.filter(function (entry) {
      return !!entry.topicRef && entry.topicRef.topicId === wanted.topicId;
    }).sort(bySequence).map(clone);
  }

  // Every coordinator this topic is bound to -- the claims table first, since
  // it is the authoritative one-per-(topic, project) record, then any coordinator
  // a request was linked to directly. This is what makes an owner follow-up
  // reuse the existing coordinator instead of staffing a second one.
  function coordinatorsForTopic(topicRef) {
    var wanted = normalizeTopicRef(topicRef);
    if (!wanted) return [];
    var refs = [];
    for (var i = 0; i < state.coordinators.length; i++) {
      if (state.coordinators[i].topicId !== wanted.topicId) continue;
      pushUnique(refs, clone(state.coordinators[i].coordinator), sessionKey);
    }
    var matched = forTopic(wanted);
    for (var j = 0; j < matched.length; j++) {
      var coordinators = matched[j].links.coordinators;
      for (var k = 0; k < coordinators.length; k++) {
        pushUnique(refs, coordinators[k], sessionKey);
      }
    }
    return refs;
  }

  function projectRefsForTopic(topicRef) {
    var matched = forTopic(topicRef);
    var refs = [];
    for (var i = 0; i < matched.length; i++) {
      refs = refs.concat(matched[i].projectRefs);
    }
    return normalizeProjectRefs(refs);
  }

  return {
    applyCoordinatorOutcome: applyCoordinatorOutcome,
    applyOutcome: applyOutcome,
    canonicalCoordinator: canonicalCoordinator,
    claimCoordinator: claimCoordinator,
    classify: classify,
    coordinatorsForTopic: coordinatorsForTopic,
    file: file,
    forTopic: forTopic,
    get: get,
    hasUnansweredOwnerRequests: hasUnansweredOwnerRequests,
    linkExecution: linkExecution,
    list: list,
    listCoordinators: listCoordinators,
    markAnswered: markAnswered,
    projectRefsForTopic: projectRefsForTopic,
    record: record,
    recordAttention: recordAttention,
    reconcileTopicClosure: reconcileTopicClosure,
    setState: setState,
    unanswered: unanswered,
  };
}

// One ledger per daemon, exactly like the topic index. The canonical Coop
// session is a single permanent conversation, so a second instance would mean
// two disagreeing answers to "is the owner still owed a reply".
var defaultLedger = null;

function getDefaultOwnerRequests() {
  if (!defaultLedger) defaultLedger = attachCoopOwnerRequests();
  return defaultLedger;
}

// Derives the durable classification for one owner turn from the routing
// decision the topic index already made. Kept here so the ingress seam and the
// tests exercise one rule: a low-information turn is conversational however it
// was routed, a freshly minted topic is new, and everything else reuses.
function classificationFor(route, isLowInformation) {
  if (isLowInformation) return "conversational";
  if (route && route.created) return "new_topic";
  return "existing_topic";
}

module.exports = {
  attachCoopOwnerRequests: attachCoopOwnerRequests,
  createCoopOwnerRequests: attachCoopOwnerRequests,
  getDefaultOwnerRequests: getDefaultOwnerRequests,
  classificationFor: classificationFor,
  CLASSIFICATIONS: CLASSIFICATIONS,
  STATES: STATES,
  OUTCOME_TO_STATE: OUTCOME_TO_STATE,
  normalizeRecord: normalizeRecord,
};
