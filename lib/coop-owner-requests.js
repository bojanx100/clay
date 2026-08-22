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
var ledgerFile = require("./coop-control-ledger-file");
var ownerReconciliation = require("./coop-owner-request-reconciliation");
var threadCorrections = require("./coop-owner-request-thread-corrections");

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
var normalizeImplementationDecision = records.normalizeImplementationDecision;
var normalizeImplementationScope = records.normalizeImplementationScope;
var implementationScopesFor = records.implementationScopesFor;
var normalizeProjectRefs = records.normalizeProjectRefs;
var normalizeRecord = records.normalizeRecord;
var outstanding = records.outstanding;
var pushUnique = records.pushUnique;
var sessionKey = records.sessionKey;
var sameImplementationScope = records.sameImplementationScope;
var taskKey = records.taskKey;
var defaultFile = records.defaultFile;
var fs = require("fs");

// The half of the approval carry-forward rule that can be proved from two scopes
// alone: the retry has to be the SAME work at the next revision. Same target
// project, same Thread, same task, and the immediately next `bindingRevision` --
// so an approval can never be replayed sideways onto another task, project, or
// Thread, walked backwards onto a revision the owner has already seen the
// outcome of, or skip an unreviewed revision.
//
// The other half -- that the exact approved binding failed and that no matching
// scope completed at or after the approval -- lives in the binding store, which
// this module cannot read. `server-cross-project.approvalCarriesForward` checks
// it there and both halves must hold; neither is sufficient. This function
// therefore stays fail-closed on its own terms rather than trusting the caller's
// intent: a caller that asks for a carry-forward it has not earned still gets
// refused here if the identity or the ordering is wrong.
//
// Exported and lifted out of the ledger closure because the ROUTER needs the
// same question answered before it will propose a route at all
// (project-task-orchestrator-external-delegation.unscopedIngressCoverage). Two
// copies of an authorization condition drift, and a router that silently
// disagreed with admission is exactly how the carry-forward shipped half-wired:
// admission was ready to allow the retry while the router refused to hand it a
// route, so the rule never fired in production.
function carryForwardEligible(current, next) {
  if (!current || !next || !current.projectRef || !next.projectRef ||
      !current.topicRef || !next.topicRef) return false;
  // Two absent identities must never compare equal. The ledger's own scopes are
  // normalized and always carry both, but this predicate is now called with a
  // scope assembled from raw dispatch input as well.
  if (!current.projectRef.projectId || !next.projectRef.projectId) return false;
  if (!current.topicRef.topicId || !next.topicRef.topicId) return false;
  if (!current.portfolioTaskId || !next.portfolioTaskId) return false;
  var from = Number(current.bindingRevision);
  var to = Number(next.bindingRevision);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  return current.projectRef.projectId === next.projectRef.projectId &&
    current.topicRef.topicId === next.topicRef.topicId &&
    String(current.portfolioTaskId) === String(next.portfolioTaskId) &&
    to === from + 1;
}

function attachCoopOwnerRequests(options) {
  var opts = options || {};
  var file = opts.file || defaultFile();
  var fsImpl = opts.fs || fs;
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var state = loadState(fsImpl, file);
  var index = {};
  var transactionIdentity = null;

  function reindex() {
    index = {};
    for (var i = 0; i < state.requests.length; i++) {
      index[state.requests[i].ingressId] = state.requests[i];
    }
  }
  reindex();

  function refresh() {
    state = loadState(fsImpl, file);
    reindex();
    return state;
  }

  function mutate(fallback, operation) {
    try {
      return ledgerFile.withLock(file, function () {
        refresh();
        transactionIdentity = ledgerFile.readIdentity(fsImpl, file);
        try { return operation(); }
        finally { transactionIdentity = null; }
      }, opts.lockOptions);
    } catch (error) {
      refresh();
      return typeof fallback === "function" ? fallback(error) : fallback;
    }
  }

  function read(operation, fallback) {
    try { refresh(); return operation(); }
    catch (error) { return fallback; }
  }

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
    try {
      var expected = transactionIdentity || ledgerFile.readIdentity(fsImpl, file);
      var committed = ledgerFile.commitJson(fsImpl, file, state, expected);
      if (!committed.ok) throw new Error(committed.code);
      transactionIdentity = committed.identity;
      return true;
    }
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
      implementationDecision: null,
      implementationScope: null,
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

  function reconcileResponse(input) {
    var source = input || {};
    var found = find(source.ingressId);
    var snapshot = found ? clone(found) : null;
    var reconciliationRequests = clone(state.reconciliationRequests || []);
    var result = ownerReconciliation.apply(state, found, source, now);
    if (!result.ok || !result.changed) return result;
    if (persist()) return result;
    restore(found, snapshot);
    state.reconciliationRequests = reconciliationRequests;
    return { ok: false, code: "persistence_failed" };
  }

  // A message can be legitimate owner input without asking for a reply. Keep
  // the raw reference for audit, but do not leave it in the response queue.
  // This is intentionally separate from answered: no assistant output is
  // invented for an informational message.
  function markNoResponseRequired(id) {
    var found = find(id);
    if (!found) return null;
    var snapshot = clone(found);
    if (found.response.state !== "unanswered") return clone(found);
    found.response = {
      state: "not_required",
      answeredAt: null,
      responseRef: null,
      supersededAt: null,
      supersededBy: "",
    };
    found.state = "done";
    found.attention = null;
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
    var decision = normalizeImplementationDecision(input.implementationDecision &&
      Object.assign({}, input.implementationDecision, {
        source: input.implementationDecision.source || "explicit_owner_turn",
        at: input.implementationDecision.at || now(),
      }));
    // One owner ingress has one durable implementation decision. Transcript
    // replay and restart backfill may rediscover it, but must not restamp or
    // replace the first normalized decision that reached disk.
    if (decision && !found.implementationDecision) found.implementationDecision = decision;
    found.expectsExecution = expectsExecutionFor(found.implementationDecision, found,
      found.links, found.outcome);
    var topicRef = normalizeTopicRef(input.topicRef);
    if (topicRef) found.topicRef = topicRef;
    // Project grouping is navigation context. Only implementationDecision grants
    // execution admission, so a project mention can remain without staffing it.
    found.projectRefs = normalizeProjectRefs(input.projectRefs);
    return touch(found, snapshot);
  }

  // An owner command gains execution authority only when the typed dispatch
  // atomically names its exact destination and task identity. A verified named
  // approval may supply its decision here too, but only after coop-item-approval
  // independently resolved one pending task revision. The scope is validated
  // before either field changes, so an invalid dispatch cannot leave a broad
  // implementation decision behind. An ordinary implementation turn gets one
  // scope. A named item approval may retain several independent exact scopes
  // from that same owner turn; each one still has its own ProjectRef, Thread,
  // task, revision, and idempotency key. A retry may only replace its matching
  // task scope through the existing carry-forward predicate.
  function scopeImplementation(id, options) {
    var found = find(id);
    var input = options && typeof options === "object" ? options : {};
    var suppliedDecision = normalizeImplementationDecision(input.implementationDecision &&
      Object.assign({}, input.implementationDecision, {
        source: input.implementationDecision.source || "explicit_item_approval",
        at: input.implementationDecision.at || now(),
      }));
    var namedApproval = !!(suppliedDecision && suppliedDecision.intent === "implement" &&
      suppliedDecision.source === "explicit_item_approval");
    if (!found || (!namedApproval &&
        (!found.implementationDecision || found.expectsExecution !== true))) {
      return { ok: false, reason: "owner_implementation_decision_required" };
    }
    var scope = normalizeImplementationScope(options);
    if (!scope) return { ok: false, reason: "invalid_owner_implementation_scope" };
    var scopes = implementationScopesFor(found);
    var carriedForward = false;
    var related = -1;
    for (var i = 0; i < scopes.length; i++) {
      if (sameImplementationScope(scopes[i], scope)) {
        return { ok: true, reused: true, request: clone(found) };
      }
      if (scopes[i].projectRef.projectId === scope.projectRef.projectId &&
          scopes[i].topicRef.topicId === scope.topicRef.topicId &&
          scopes[i].portfolioTaskId === scope.portfolioTaskId) {
        related = i;
      }
    }
    if (related !== -1) {
      if (input.carryForward !== true || !carryForwardEligible(scopes[related], scope)) {
        return { ok: false, reason: "owner_implementation_scope_mismatch" };
      }
      carriedForward = true;
    } else if (scopes.length && !namedApproval) {
      // A generic owner directive cannot silently turn into a multi-item
      // blanket grant. Only the item-approval boundary, which independently
      // replays the exact owner wording, may add another scope to this ingress.
      return { ok: false, reason: "owner_implementation_scope_mismatch" };
    }
    var snapshot = clone(found);
    if (!found.implementationDecision && namedApproval) {
      found.implementationDecision = suppliedDecision;
    }
    if (related !== -1) scopes[related] = scope;
    else scopes.push(scope);
    // Preserve the original singular projection for legacy readers. New
    // readers use implementationScopesFor(), so no later exact approval is
    // hidden behind that compatibility field.
    found.implementationScope = clone(scopes[0]);
    if (scopes.length > 1) found.implementationScopes = scopes.map(clone);
    else delete found.implementationScopes;
    if (!found.topicRef) found.topicRef = clone(scope.topicRef);
    found.projectRefs = normalizeProjectRefs(found.projectRefs.concat([scope.projectRef]));
    found.classification = {
      kind: "existing_topic",
      // The carry-forward is durable rather than implicit: the record says on
      // disk that this scope replaced an earlier revision's, so a later reader
      // can tell an owner-approved retry from an original approval.
      source: carriedForward ? "owner_directed_execution_carry_forward"
        : (namedApproval ? "owner_named_approval" : "owner_directed_execution"),
      at: now(),
    };
    found.expectsExecution = true;
    var persisted = touch(found, snapshot);
    return persisted ? { ok: true, reused: false, carriedForward: carriedForward,
      request: persisted } : { ok: false, reason: "persistence_failed" };
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

  function findProjectClaim(projectId) {
    var found = null;
    for (var i = 0; i < state.coordinators.length; i++) {
      var claim = state.coordinators[i];
      if (claim.projectId !== projectId) continue;
      if (!found || (claim.claimedAt || 0) < (found.claimedAt || 0)) found = claim;
    }
    return found;
  }

  function conflictsWithProjectCoordinator(projectClaim, claim) {
    if (!projectClaim) return false;
    return projectClaim.coordinator.sessionStorageId !== claim.coordinator.sessionStorageId;
  }

  function invalidClaimResult(options) {
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

  function reuseCoordinatorClaim(existing, linkId, projectId) {
    var ingressIdsBefore = existing.ingressIds.slice();
    var record = linkId ? find(linkId) : null;
    var recordBefore = record ? clone(record) : null;
    if (linkId && existing.ingressIds.indexOf(linkId) === -1) existing.ingressIds.push(linkId);
    if (record) applyLinks(record, { coordinator: existing.coordinator,
      projectRefs: [{ projectId: projectId }] });
    if (!persist()) {
      existing.ingressIds = ingressIdsBefore;
      if (record) restore(record, recordBefore);
      return { ok: false, reason: "persistence_failed" };
    }
    return { ok: true, created: false, reused: true,
      coordinator: clone(existing.coordinator) };
  }

  function createCoordinatorClaim(claim, linkId) {
    claim.claimedAt = claim.claimedAt || now();
    if (linkId) claim.ingressIds.push(linkId);
    state.coordinators.push(claim);
    var record = linkId ? find(linkId) : null;
    var recordBefore = record ? clone(record) : null;
    if (record) applyLinks(record, { coordinator: claim.coordinator,
      projectRefs: [{ projectId: claim.projectId }] });
    if (!persist()) {
      state.coordinators.pop();
      if (record) restore(record, recordBefore);
      return { ok: false, reason: "persistence_failed" };
    }
    return { ok: true, created: true, reused: false,
      coordinator: clone(claim.coordinator) };
  }

  // Idempotent, first-project-claim-wins. Every topic in one project routes
  // through the same durable coordinator; bounded work lives in child task
  // coordinators rather than rival roots.
  function claimCoordinator(options) {
    var claim = normalizeClaim(options);
    if (!claim) return invalidClaimResult(options);
    var linkId = ingressId(options && options.ingressId);
    var existing = findClaim(claim.topicId, claim.projectId);
    var projectClaim = findProjectClaim(claim.projectId);
    if (conflictsWithProjectCoordinator(projectClaim, claim)) {
      return { ok: false, reason: "coordinator_exists", coordinator: clone(projectClaim.coordinator) };
    }
    return existing ? reuseCoordinatorClaim(existing, linkId, claim.projectId) :
      createCoordinatorClaim(claim, linkId);
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

  function threadCorrectionSeam() {
    return { state: state, find: find, persist: persist, reindex: reindex, now: now };
  }

  function retopic(fromTopicRef, toTopicRef) {
    var from = normalizeTopicRef(fromTopicRef);
    var to = normalizeTopicRef(toTopicRef);
    if (!from || !to || from.topicId === to.topicId) {
      return { ok: false, reason: "invalid_alias", requests: 0, coordinators: 0 };
    }
    var correction = threadCorrections.snapshot(threadCorrectionSeam(), from, to, "merge");
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
    threadCorrections.finishSnapshot(threadCorrectionSeam(), correction);
    return { ok: true, requests: movedRequests, coordinators: movedClaims, undo: correction };
  }

  // Hand one project's durable coordinator role to its replacement. The named
  // topic proves the caller's expected predecessor, then every topic claim for
  // that ProjectRef moves atomically so the transfer cannot create two roots.
  //
  // This exists because the cardinality rule and deterministic rehydration
  // collide: the claim is keyed on the coordinator's session storage id, so a
  // fresh session taking over the same work reads as a RIVAL and is refused --
  // and with strict verdict handling its execution is marked unavailable. The
  // rule would block the recovery it is meant to protect. A transfer is the
  // narrow, explicit exception: same topic, same project, named predecessor,
  // still exactly one coordinator afterwards.
  function transferProjectClaims(projectId, from, to, transferredAt, transferReason) {
    for (var i = 0; i < state.coordinators.length; i++) {
      var candidate = state.coordinators[i];
      if (candidate.projectId !== projectId ||
          candidate.coordinator.sessionStorageId !== from.sessionStorageId) continue;
      candidate.coordinator = clone(to);
      candidate.transferredAt = transferredAt;
      candidate.transferReason = transferReason;
      repointCoordinatorLinks(from, to, candidate.topicId);
    }
  }

  function restoreCoordinatorCollections(claimsBefore, linksBefore) {
    state.coordinators = claimsBefore;
    for (var i = 0; i < state.requests.length; i++) state.requests[i].links = linksBefore[i];
  }

  function transferCoordinator(options) {
    var input = options || {};
    var topic = normalizeTopicRef(input.topicRef);
    var project = projectIdentity.normalizeProjectRef(input.projectRef);
    var from = projectIdentity.normalizeSessionRef(input.from);
    var to = projectIdentity.normalizeSessionRef(input.to);
    if (!topic || !project || !from || !to) return { ok: false, reason: "invalid_transfer" };
    // The canonical root may be a Lead-resident control-plane session with an
    // explicit ProjectRef. Target-local coordinators remain readable during
    // migration, but a replacement must be either target-local or in Coop.
    if (to.projectId !== project.projectId && to.projectId !== projectIdentity.LEAD_PROJECT_ID) {
      return { ok: false, reason: "project_mismatch" };
    }
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
    var claimsBefore = state.coordinators.map(clone);
    var linksBefore = state.requests.map(function (entry) { return clone(entry.links); });
    var transferredAt = now();
    var transferReason = cleanText(input.reason, 40) || "coordinator_replaced";
    transferProjectClaims(project.projectId, from, to, transferredAt, transferReason);
    if (!persist()) {
      restoreCoordinatorCollections(claimsBefore, linksBefore);
      return { ok: false, reason: "persistence_failed" };
    }
    return { ok: true, coordinator: clone(to), previous: clone(from) };
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

  function canonicalProjectCoordinator(projectRef) {
    var project = projectIdentity.normalizeProjectRef(projectRef);
    if (!project) return null;
    var claim = findProjectClaim(project.projectId);
    return claim ? clone(claim.coordinator) : null;
  }

  function migrateProjectCoordinatorClaims() {
    var canonical = {};
    var claimsBefore = state.coordinators.map(clone);
    var linksBefore = state.requests.map(function (entry) { return clone(entry.links); });
    var changed = false;
    for (var i = 0; i < state.coordinators.length; i++) {
      var claim = state.coordinators[i];
      var current = canonical[claim.projectId];
      if (!current || (claim.claimedAt || 0) < (current.claimedAt || 0)) {
        canonical[claim.projectId] = claim;
      }
    }
    for (var j = 0; j < state.coordinators.length; j++) {
      var candidate = state.coordinators[j];
      var owner = canonical[candidate.projectId];
      if (!owner || owner.coordinator.sessionStorageId ===
          candidate.coordinator.sessionStorageId) continue;
      var previous = clone(candidate.coordinator);
      candidate.coordinator = clone(owner.coordinator);
      candidate.transferredAt = now();
      candidate.transferReason = "project_coordinator_migration";
      repointCoordinatorLinks(previous, owner.coordinator, candidate.topicId);
      changed = true;
    }
    if (!changed) return true;
    if (persist()) return true;
    state.coordinators = claimsBefore;
    for (var k = 0; k < state.requests.length; k++) state.requests[k].links = linksBefore[k];
    return false;
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
      if (entry.topicRef && entry.topicRef.topicId === wanted.topicId) return true;
      var scopes = implementationScopesFor(entry);
      for (var i = 0; i < scopes.length; i++) {
        if (scopes[i].topicRef.topicId === wanted.topicId) return true;
      }
      return false;
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

  mutate(false, migrateProjectCoordinatorClaims);

  return {
    applyCoordinatorOutcome: function (input) { return mutate([], function () { return applyCoordinatorOutcome(input); }); },
    applyOutcome: function (id, input) { return mutate(null, function () { return applyOutcome(id, input); }); },
    canonicalCoordinator: function (topic, project) { return read(function () { return canonicalCoordinator(topic, project); }, null); },
    canonicalProjectCoordinator: function (project) { return read(function () { return canonicalProjectCoordinator(project); }, null); },
    claimCoordinator: function (input) { return mutate({ ok: false, reason: "persistence_failed" }, function () { return claimCoordinator(input); }); },
    classify: function (id, input) { return mutate(null, function () { return classify(id, input); }); },
    coordinatorsForTopic: function (topic) { return read(function () { return coordinatorsForTopic(topic); }, []); },
    file: file,
    forTopic: function (topic) { return read(function () { return forTopic(topic); }, []); },
    get: function (id) { return read(function () { return get(id); }, null); },
    hasUnansweredOwnerRequests: function () { return read(hasUnansweredOwnerRequests, false); },
    identity: function () { return ledgerFile.readIdentity(fsImpl, file); },
    linkExecution: function (id, input) { return mutate(null, function () { return linkExecution(id, input); }); },
    list: function (input) { return read(function () { return list(input); }, []); },
    listCoordinators: function () { return read(listCoordinators, []); },
    markAnswered: function (id, input) { return mutate(null, function () { return markAnswered(id, input); }); },
    markNoResponseRequired: function (id) { return mutate(null, function () { return markNoResponseRequired(id); }); },
    projectRefsForTopic: function (topic) { return read(function () { return projectRefsForTopic(topic); }, []); },
    reconcileResponse: function (input) { return mutate({ ok: false, code: "persistence_failed" }, function () { return reconcileResponse(input); }); },
    record: function (input) { return mutate(null, function () { return record(input); }); },
    recordAttention: function (id, reason) { return mutate(null, function () { return recordAttention(id, reason); }); },
    reconcileTopicClosure: function (topic) { return mutate({ ok: false, reason: "persistence_failed", settled: [], preserved: [] }, function () { return reconcileTopicClosure(topic); }); },
    retopic: function (from, to) { return mutate({ ok: false, reason: "persistence_failed", requests: 0, coordinators: 0 }, function () { return retopic(from, to); }); },
    retopicTurn: function (from, to, turn, history) { return mutate({ ok: false, reason: "persistence_failed", requests: 0 }, function () { return threadCorrections.retopicTurn(threadCorrectionSeam(), from, to, turn, history); }); },
    restoreThreadCorrections: function (corrections) { return mutate({ ok: false, reason: "persistence_failed", requests: 0 }, function () { return threadCorrections.restore(threadCorrectionSeam(), corrections); }); },
    setState: function (id, next) { return mutate(null, function () { return setState(id, next); }); },
    scopeImplementation: function (id, input) { return mutate({ ok: false, reason: "persistence_failed" }, function () { return scopeImplementation(id, input); }); },
    supersede: function (id, reason) { return mutate(null, function () { return supersede(id, reason); }); },
    transferCoordinator: function (input) { return mutate({ ok: false, reason: "persistence_failed" }, function () { return transferCoordinator(input); }); },
    unanswered: function () { return read(unanswered, []); },
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
  carryForwardEligible: carryForwardEligible,
  classificationFor: classificationFor,
  CLASSIFICATIONS: CLASSIFICATIONS,
  implementationScopesFor: implementationScopesFor,
  STATES: STATES,
  OUTCOME_TO_STATE: OUTCOME_TO_STATE,
  normalizeRecord: normalizeRecord,
};
