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

var projectIdentity = require("./project-identity");
var normalizeTopicRef = require("./coop-topic-ref").normalizeTopicRefInput;
var normalizeAttentionCode = require("./coop-work-activity").normalizeAttentionCode;
var records = require("./coop-owner-request-records");

var STATES = records.STATES;
var CLASSIFICATIONS = records.CLASSIFICATIONS;
var OUTCOME_TO_STATE = records.OUTCOME_TO_STATE;
var MAX_RECORDS = records.MAX_RECORDS;
var clone = records.clone;
var cleanText = records.cleanText;
var emptyLinks = records.emptyLinks;
var expectsExecutionFor = records.expectsExecutionFor;
var finite = records.finite;
var ingressId = records.ingressId;
var ingressKind = records.ingressKind;
var loadState = records.loadState;
var normalizeClaim = records.normalizeClaim;
var normalizeEventRef = records.normalizeEventRef;
var normalizeOutcome = records.normalizeOutcome;
var normalizeProjectRefs = records.normalizeProjectRefs;
var normalizeRecord = records.normalizeRecord;
var outstanding = records.outstanding;
var pushUnique = records.pushUnique;
var sessionKey = records.sessionKey;
var taskKey = records.taskKey;
var writeState = records.writeState;
var defaultFile = records.defaultFile;
var fs = require("fs");

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
