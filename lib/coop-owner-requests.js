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

  // Transactional. prune() rewrites state.requests BEFORE the write, so a
  // failed write used to leave the eviction applied in memory while disk still
  // held the record -- memory silently losing a record that reload restores.
  // Callers roll back their own mutation; only persist() knows about the prune,
  // so persist() has to be able to undo it.
  function persist() {
    var requestsBefore = state.requests;
    var coordinatorsBefore = state.coordinators;
    prune();
    try { writeState(fsImpl, file, state); return true; }
    catch (e) {
      // Restore the collections themselves. Individual record contents are the
      // caller's to restore; what is undone here is membership.
      state.requests = requestsBefore;
      state.coordinators = coordinatorsBefore;
      reindex();
      return false;
    }
  }

  // A mutation is only real once it reaches disk. Previously touch() applied
  // the change in memory, ignored a failed write and handed back a record
  // claiming success -- so a full disk left the ledger reporting an owner
  // answered in-process and unanswered after the next restart, with nothing
  // anywhere saying so. The record is snapshotted before mutation and restored
  // if the write fails, so memory and disk cannot disagree.
  function touch(record, snapshot) {
    record.updatedAt = now();
    if (persist()) return clone(record);
    if (snapshot) restore(record, snapshot);
    return null;
  }

  // In-place restore: callers hold the live object, so it has to be repaired
  // rather than replaced.
  function restore(record, snapshot) {
    var keys = Object.keys(record);
    for (var i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, keys[i])) delete record[keys[i]];
    }
    var restored = Object.keys(snapshot);
    for (var j = 0; j < restored.length; j++) record[restored[j]] = snapshot[restored[j]];
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
      // recordUnroutable creates a record with no requestRef, so this branch is
      // how the canonical event reference arrives -- it has to reach disk.
      var late = normalizeEventRef(source.requestRef);
      if (!existing.requestRef && late) {
        var snapshot = clone(existing);
        existing.requestRef = late;
        // A masked failure here loses the canonical event reference, which is
        // the entire content of a reference-only record.
        return touch(existing, snapshot);
      }
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
      // Same key set normalizeResponse produces on load, so a record created
      // in memory and the same record read back from disk are identical. They
      // diverged, which made any strict convergence check impossible.
      response: { state: "unanswered", answeredAt: null, responseRef: null,
        supersededAt: null, supersededBy: "" },
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
    // A record that never reached disk was never created.
    if (!persist()) {
      state.requests.pop();
      delete index[id];
      return null;
    }
    return clone(next);
  }

  // The ONE transition to answered. Called from the owner-facing turn
  // completing, never from anything that starts, advances or finishes work.
  function markAnswered(id, options) {
    var found = find(id);
    if (!found) return null;
    var snapshot = clone(found);
    // First answer wins: a later turn in the same lane is a follow-up, not a
    // restatement of when this request was satisfied. A superseded request is
    // terminal too -- the owner withdrew it, and a later turn must not be able
    // to relabel that withdrawal as an answer nobody gave.
    if (found.response.state !== "unanswered") return clone(found);
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
      supersededAt: null,
      supersededBy: "",
    };
    return touch(found, snapshot);
  }

  // The owner withdrew the question themselves -- they interrupted the reply
  // with their next message, or stopped the turn. Terminal, and pointedly not
  // "answered": nobody replied. Without this a single interrupt leaves a
  // request that can never leave unanswered, pinning the owner's queue and the
  // Lead tick that defers to it forever.
  function supersede(id, reason) {
    var found = find(id);
    if (!found) return null;
    var snapshot = clone(found);
    if (found.response.state !== "unanswered") return clone(found);
    found.response = {
      state: "superseded",
      answeredAt: null,
      responseRef: null,
      supersededAt: now(),
      supersededBy: cleanText(reason, 40) || "owner_interrupt",
    };
    return touch(found, snapshot);
  }

  function classify(id, options) {
    var found = find(id);
    if (!found) return null;
    var snapshot = clone(found);
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
    return touch(found, snapshot);
  }

  // Execution linkage only. Deliberately cannot touch `response`.
  // Mutation only, no write. Separated from linkExecution so a caller can
  // compose several mutations into ONE durable transaction: claimCoordinator
  // used to link (which persisted the whole state, including its just-pushed
  // claim) and only then persist again, so a failure of the SECOND write left
  // the claim durable on disk while the API reported persistence_failed.
  function applyLinks(found, options) {
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
  }

  function linkExecution(id, options) {
    var found = find(id);
    if (!found) return null;
    var snapshot = clone(found);
    applyLinks(found, options);
    return touch(found, snapshot);
  }

  function setState(id, next) {
    var found = find(id);
    if (!found) return null;
    var snapshot = clone(found);
    if (!STATES[next]) return clone(found);
    found.state = next;
    if (next !== "attention") found.attention = null;
    return touch(found, snapshot);
  }

  // A typed route/staffing failure the owner has to unblock. The code comes
  // from coop-work-activity's closed vocabulary, so no prose lands on disk.
  function recordAttention(id, reason) {
    var found = find(id);
    if (!found) return null;
    var snapshot = clone(found);
    found.state = "attention";
    found.attention = normalizeAttentionCode(reason) || "attention_required";
    return touch(found, snapshot);
  }

  // Fan-in from a project coordinator or worker. Moves the request's work
  // state; never claims the owner was answered.
  function applyOutcome(id, options) {
    var found = find(id);
    if (!found) return null;
    var snapshot = clone(found);
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
    return touch(found, snapshot);
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
      var reusedBefore = existing.ingressIds.slice();
      var reusedRecord = linkId ? find(linkId) : null;
      var reusedSnapshot = reusedRecord ? clone(reusedRecord) : null;
      if (linkId && existing.ingressIds.indexOf(linkId) === -1) existing.ingressIds.push(linkId);
      if (reusedRecord) applyLinks(reusedRecord, { coordinator: existing.coordinator, projectRefs: [{ projectId: claim.projectId }] });
      if (!persist()) {
        existing.ingressIds = reusedBefore;
        if (reusedRecord) restore(reusedRecord, reusedSnapshot);
        return { ok: false, reason: "persistence_failed" };
      }
      return { ok: true, created: false, reused: true, coordinator: clone(existing.coordinator) };
    }
    claim.claimedAt = claim.claimedAt || now();
    if (linkId) claim.ingressIds.push(linkId);
    state.coordinators.push(claim);
    var linkedRecord = linkId ? find(linkId) : null;
    var linkedSnapshot = linkedRecord ? clone(linkedRecord) : null;
    if (linkedRecord) applyLinks(linkedRecord, { coordinator: claim.coordinator, projectRefs: [{ projectId: claim.projectId }] });
    // A claim that never reached disk is not a claim. Reporting one would let
    // a restart silently un-own a (topic, project) pair every in-process
    // caller believed was durably taken -- and a different task could then
    // claim it, producing exactly the two coordinators this table prevents.
    if (!persist()) {
      state.coordinators.pop();
      if (linkedRecord) restore(linkedRecord, linkedSnapshot);
      return { ok: false, reason: "persistence_failed" };
    }
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
    // Snapshot every record this touches, so a failed write can be undone
    // whole. Without it a closure that never reached disk still read as done
    // in-process until the next restart silently disagreed.
    var undo = [];
    for (var i = 0; i < state.requests.length; i++) {
      var entry = state.requests[i];
      if (!entry.topicRef || entry.topicRef.topicId !== wanted.topicId) continue;
      if (entry.state === "needs_input" || entry.state === "attention") {
        preserved.push(clone(entry));
        continue;
      }
      if (entry.state !== "done") {
        undo.push({ record: entry, snapshot: clone(entry) });
        entry.state = "done";
        entry.updatedAt = now();
        changed = true;
      }
      settled.push(clone(entry));
    }
    if (changed && !persist()) {
      for (var u = 0; u < undo.length; u++) restore(undo[u].record, undo[u].snapshot);
      return { ok: false, reason: "persistence_failed", settled: [], preserved: [], changed: false };
    }
    return { ok: true, settled: settled, preserved: preserved, changed: changed };
  }

  // Follow a topic merge. Merging seals the source topic and points it at its
  // canonical target; a request filed under the alias is still the owner asking
  // about the canonical topic, so leaving it behind makes forTopic() and the
  // owner overview silently under-report the work.
  //
  // Idempotent, and it never touches response state: aliasing changes which
  // topic a request belongs to, never whether anyone answered it.
  // Swap one coordinator for another across every request link. Used when a
  // merge collapses two claims onto the same (topic, project): the losing
  // coordinator must stop appearing as a second owner of the same work.
  // Re-point ONLY the requests belonging to the topic being merged. The
  // losing coordinator may legitimately serve other topics; rewriting those
  // silently moved an unrelated topic's request onto a coordinator that does
  // not hold its claim, leaving that topic reading as two coordinators.
  function repointCoordinatorLinks(losing, winning, topicId) {
    var from = projectIdentity.normalizeSessionRef(losing);
    var to = projectIdentity.normalizeSessionRef(winning);
    if (!from || !to) return;
    for (var i = 0; i < state.requests.length; i++) {
      var owner = state.requests[i].topicRef;
      if (topicId && (!owner || owner.topicId !== topicId)) continue;
      var links = state.requests[i].links.coordinators;
      var next = [];
      var changed = false;
      for (var j = 0; j < links.length; j++) {
        if (sessionKey(links[j]) === sessionKey(from)) { changed = true; continue; }
        next.push(links[j]);
      }
      if (!changed) continue;
      pushUnique(next, clone(to), sessionKey);
      state.requests[i].links.coordinators = next;
      state.requests[i].updatedAt = now();
    }
  }

  function retopic(fromTopicRef, toTopicRef) {
    var from = normalizeTopicRef(fromTopicRef);
    var to = normalizeTopicRef(toTopicRef);
    if (!from || !to || from.topicId === to.topicId) {
      return { ok: false, reason: "invalid_alias", requests: 0, coordinators: 0 };
    }
    var movedRequests = 0;
    var movedClaims = 0;
    // A merge is all-or-nothing. It moves owner-response state, task and
    // session links, and coordinator claims at once; half of that surviving a
    // failed write would leave requests pointing at a topic whose claims still
    // live under the old id -- cardinality intact in neither place. Snapshot
    // both collections and restore them together.
    var undo = [];
    var claimsBefore = state.coordinators.map(clone);
    var linksBefore = state.requests.map(function (entry) { return clone(entry.links); });
    for (var i = 0; i < state.requests.length; i++) {
      var entry = state.requests[i];
      if (!entry.topicRef || entry.topicRef.topicId !== from.topicId) continue;
      undo.push({ record: entry, snapshot: clone(entry) });
      entry.topicRef = clone(to);
      entry.updatedAt = now();
      movedRequests++;
    }
    var kept = [];
    for (var j = 0; j < state.coordinators.length; j++) {
      var claim = state.coordinators[j];
      if (claim.topicId !== from.topicId) { kept.push(claim); continue; }
      // The canonical topic may already own this (topic, project). One
      // coordinator per pair is the whole rule, so a rival arriving by merge is
      // dropped rather than quietly kept as a second claim.
      var existing = findClaim(to.topicId, claim.projectId);
      if (existing) {
        // The canonical topic already owns this pair. Re-point every request
        // that was linked to the losing coordinator, so the surface shows the
        // one coordinator actually handling the work instead of two.
        repointCoordinatorLinks(claim.coordinator, existing.coordinator, to.topicId);
        movedClaims++;
        continue;
      }
      claim.topicId = to.topicId;
      kept.push(claim);
      movedClaims++;
    }
    state.coordinators = kept;
    if ((movedRequests || movedClaims) && !persist()) {
      for (var u = 0; u < undo.length; u++) restore(undo[u].record, undo[u].snapshot);
      // repointCoordinatorLinks rewrote links on records the topic loop never
      // touched, so links are restored across every record, not just moved ones.
      for (var r = 0; r < state.requests.length; r++) state.requests[r].links = linksBefore[r];
      state.coordinators = claimsBefore;
      reindex();
      return { ok: false, reason: "persistence_failed", requests: 0, coordinators: 0 };
    }
    return { ok: true, requests: movedRequests, coordinators: movedClaims };
  }

  // Hand a (topic, project) claim from a retired coordinator to its replacement
  // on the same binding.
  //
  // This exists because the cardinality rule and deterministic rehydration
  // collide: the claim is keyed on the coordinator's session storage id, so a
  // fresh session taking over the same work reads as a RIVAL and is refused --
  // and with strict verdict handling its execution is marked unavailable. The
  // rule would block the recovery it is meant to protect. A transfer is the
  // narrow, explicit exception: same topic, same project, named predecessor,
  // still exactly one coordinator afterwards.
  function transferCoordinator(options) {
    var input = options || {};
    var topic = normalizeTopicRef(input.topicRef);
    var project = projectIdentity.normalizeProjectRef(input.projectRef);
    var from = projectIdentity.normalizeSessionRef(input.from);
    var to = projectIdentity.normalizeSessionRef(input.to);
    if (!topic || !project || !from || !to) return { ok: false, reason: "invalid_transfer" };
    // A replacement must live in the same project as the work it takes over.
    if (to.projectId !== project.projectId) return { ok: false, reason: "project_mismatch" };
    var claim = findClaim(topic.topicId, project.projectId);
    if (!claim) return { ok: false, reason: "no_claim" };
    // Naming the predecessor is what makes this safe: a transfer can only ever
    // replace the coordinator the caller believes is there.
    if (claim.coordinator.sessionStorageId !== from.sessionStorageId) {
      return { ok: false, reason: "predecessor_mismatch", coordinator: clone(claim.coordinator) };
    }
    if (from.sessionStorageId === to.sessionStorageId) {
      return { ok: true, coordinator: clone(claim.coordinator), unchanged: true };
    }
    var claimBefore = clone(claim);
    var linksBefore = state.requests.map(function (entry) { return clone(entry.links); });
    claim.coordinator = clone(to);
    claim.transferredAt = now();
    claim.transferReason = cleanText(input.reason, 40) || "coordinator_replaced";
    // Owner requests must point at the coordinator actually doing the work, not
    // the retired session. Scoped to this topic, like every other repoint.
    repointCoordinatorLinks(from, to, topic.topicId);
    if (!persist()) {
      restoreClaim(claim, claimBefore);
      for (var i = 0; i < state.requests.length; i++) state.requests[i].links = linksBefore[i];
      return { ok: false, reason: "persistence_failed" };
    }
    return { ok: true, coordinator: clone(to), previous: claimBefore.coordinator };
  }

  function restoreClaim(claim, snapshot) {
    var keys = Object.keys(claim);
    for (var i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, keys[i])) delete claim[keys[i]];
    }
    var restored = Object.keys(snapshot);
    for (var j = 0; j < restored.length; j++) claim[restored[j]] = snapshot[restored[j]];
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
      if (query.unansweredOnly && entry.response.state !== "unanswered") return false;
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
      if (state.requests[i].response.state === "unanswered") return true;
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
    retopic: retopic,
    setState: setState,
    supersede: supersede,
    transferCoordinator: transferCoordinator,
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
  MAX_RECORDS: MAX_RECORDS,
  createCoopOwnerRequests: attachCoopOwnerRequests,
  getDefaultOwnerRequests: getDefaultOwnerRequests,
  classificationFor: classificationFor,
  CLASSIFICATIONS: CLASSIFICATIONS,
  STATES: STATES,
  OUTCOME_TO_STATE: OUTCOME_TO_STATE,
  normalizeRecord: normalizeRecord,
};
