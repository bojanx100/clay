// Reconstructs owner-request records from the canonical Coop transcript using
// the same visible-answer rules as the live conversation controller.
var projectIdentity = require("./project-identity");
var ownerRequestMigrations = require("./coop-owner-request-migrations");
var ownerEventResolution = require("./coop-owner-event-resolution");
var sameOwnerRequest = require("./coop-conversation-control").sameOwnerRequest;
var explicitImplementationDecision = require("./coop-thread-lifecycle").explicitImplementationDecision;

// The SAME set coop-conversation-control.answeringEvent uses, and for the same
// reason: `result` is cost/usage bookkeeping, not the assistant speaking. This
// module exists so an audit and a live recording agree, so the two sets must
// not drift -- with `result` in here the audit called a silent turn answered
// while the live path correctly called it unanswered.
var ASSISTANT_OUTPUT = { delta: true, delta_replace: true, plan_content: true };
var INTERRUPTED = /interrupted/i;

var OWNER_REQUEST_MIGRATIONS = ownerRequestMigrations.defaults;

function ingressEvents(history) {
  var list = Array.isArray(history) ? history : [];
  var found = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (item && item.type === "user_message" && item.coopIngressSequence) {
      found.push({ eventIndex: i, event: item });
    }
  }
  return found;
}

// A retry is recorded as a terminal `done`, then a queued/sent automatic
// message starts the same logical owner turn again. The first `done` is only
// recovery bookkeeping. Follow it to the synthetic user-message boundary and
// require fresh visible assistant output after that boundary before settling
// the original owner ingress.
function automaticContinuationStart(history, doneIndex, boundary, ingressId) {
  var queuedIngressId = "";
  for (var i = doneIndex + 1; i < boundary; i++) {
    var event = history[i];
    if (!event) continue;
    if (event.type === "scheduled_message_queued") {
      queuedIngressId = event.coopContinuationIngressId === ingressId ? ingressId : "";
      continue;
    }
    if (event.type === "scheduled_message_cancelled") {
      queuedIngressId = "";
      continue;
    }
    if (event.type !== "user_message") continue;
    if (event.coopContinuationIngressId === ingressId || queuedIngressId === ingressId) return i;
    return -1;
  }
  return -1;
}

function resolveTurn(history, start, boundary) {
  var ingress = history[start] || {};
  var ingressId = ingress.coopIngressId || "";
  var dispatchedAt = Number(ingress.coopIngressDispatchedAt);
  var hasDispatchTime = isFinite(dispatchedAt) && dispatchedAt > 0;
  var spoke = false;
  var related = true;
  for (var i = start + 1; i < boundary; i++) {
    var event = history[i];
    if (!event) continue;
    if (event.type === "user_message") {
      if (event.coopContinuationIngressId === ingressId) {
        spoke = false;
        related = true;
      } else {
        spoke = false;
        related = false;
      }
      continue;
    }
    if (ASSISTANT_OUTPUT[event.type]) spoke = true;
    if (event.type === "info" && INTERRUPTED.test(String(event.text || ""))) {
      // An explicit interruption notice: whatever partial output preceded it,
      // the turn did not finish answering.
      spoke = false;
    }
    if (event.type === "done") {
      // Queued owner ingress is recorded when received but dispatched only
      // after the interrupted turn's terminator. That older `done` precedes the
      // request's dispatch timestamp and cannot answer or terminate it.
      if (hasDispatchTime && Number(event._ts) < dispatchedAt) {
        spoke = false;
        related = true;
        continue;
      }
      var continuation = automaticContinuationStart(history, i, boundary, ingressId);
      if (continuation >= 0) {
        // A resumed turn needs fresh visible output.
        spoke = false;
        related = true;
        i = continuation;
        continue;
      }
      return { state: !event.code && spoke && related ? "answered" : "unanswered",
        doneEventIndex: i, code: event.code || 0, spoke: spoke };
    }
  }
  var interruptedRepeat = boundary < history.length &&
    sameOwnerRequest(ingress, history[boundary]);
  return { state: interruptedRepeat ? "superseded" :
    (boundary < history.length ? "unanswered" : "in_flight"),
    doneEventIndex: -1, code: null, spoke: spoke };
}

function requestedSequenceSet(options) {
  var requested = options && Array.isArray(options.ingressSequences) ?
    options.ingressSequences : null;
  if (!requested) return null;
  var allowed = {};
  for (var i = 0; i < requested.length; i++) allowed[requested[i]] = true;
  return allowed;
}

function implementationDecisionForEvent(event) {
  var decision = event.coopImplementationDecision || explicitImplementationDecision(event.text);
  if (!decision) return null;
  return Object.assign({}, decision, {
    source: decision.source || "explicit_owner_turn",
    at: decision.at || event._ts || null,
  });
}

function auditOwnerRequests(history, options) {
  var list = Array.isArray(history) ? history : [];
  var ingresses = ingressEvents(list);
  var allowed = requestedSequenceSet(options);
  var audited = [];
  for (var k = 0; k < ingresses.length; k++) {
    var current = ingresses[k];
    if (allowed && !allowed[current.event.coopIngressSequence]) continue;
    var boundary = k + 1 < ingresses.length ? ingresses[k + 1].eventIndex : list.length;
    var resolved = resolveTurn(list, current.eventIndex, boundary);
    var event = current.event;
    audited.push({
      ingressId: event.coopIngressId || "",
      ingressSequence: event.coopIngressSequence,
      ingressKind: event.coopIngressKind || "text",
      eventIndex: current.eventIndex,
      receivedAt: event._ts || null,
      topicRef: event.coopTopicRef || null,
      projectRef: event.coopProjectRef || null,
      implementationDecision: implementationDecisionForEvent(event),
      state: resolved.state,
      doneEventIndex: resolved.doneEventIndex,
    });
  }
  return audited;
}

function bySequence(history) {
  var found = {};
  var ingresses = ingressEvents(history);
  for (var i = 0; i < ingresses.length; i++) {
    var sequence = ingresses[i].event.coopIngressSequence;
    if (Number.isInteger(sequence) && !found[sequence]) found[sequence] = ingresses[i];
  }
  return found;
}

// The canonical transcript records worker delivery as a user-message event.
// A completed direct-leaf report is nevertheless owner-visible assistant work;
// it is valid response evidence only when the caller names that exact event.
function visibleAnswerEvent(event) {
  if (!event) return false;
  if (ASSISTANT_OUTPUT[event.type]) return true;
  return event.type === "user_message" &&
    /^\[Clay direct-leaf completed\]/.test(String(event.text || ""));
}

function evidenceEntries(items, kind) {
  var list = Array.isArray(items) ? items : [];
  var found = {};
  for (var i = 0; i < list.length; i++) {
    var item = kind === "answered" ? list[i] : { sequence: list[i] };
    var sequence = item && item.sequence;
    if (!Number.isInteger(sequence) || sequence < 1 || found[sequence]) return null;
    if (kind === "answered" &&
        (!Number.isInteger(item.responseEventIndex) || item.responseEventIndex < 0)) return null;
    found[sequence] = item;
  }
  return found;
}

function reconciliationRecord(ledger, ingress, storageId) {
  if (!ingress || !ingress.event || !ingress.event.coopIngressId) return null;
  var record = ledger.get(ingress.event.coopIngressId);
  if (!record || !record.sessionRef || record.sessionRef.sessionStorageId !== storageId) return null;
  return record.ingressSequence === ingress.event.coopIngressSequence ? record : null;
}

function evidenceGroups(input) {
  var source = input || {};
  var groups = {
    answered: evidenceEntries(source.answered, "answered"),
    superseded: evidenceEntries(source.superseded, "superseded"),
    informational: evidenceEntries(source.informational, "informational"),
  };
  return groups.answered && groups.superseded && groups.informational ? groups : null;
}

function evidenceSequences(groups) {
  var all = {};
  var result = [];
  var values = Object.keys(groups);
  for (var i = 0; i < values.length; i++) {
    var sequences = Object.keys(groups[values[i]]);
    for (var j = 0; j < sequences.length; j++) {
      var sequence = Number(sequences[j]);
      if (all[sequence]) return null;
      all[sequence] = true;
      result.push(sequence);
    }
  }
  return result;
}

function answeredEvidenceChange(record, answer, history) {
  var responseEvent = history[answer.responseEventIndex];
  var rangeStart = answer.responseStartEventIndex;
  var visibleRange = Number.isInteger(rangeStart) && rangeStart >= 0 &&
    responseEvent && responseEvent.type === "done" && !responseEvent.code;
  if (visibleRange) {
    var spoke = false;
    for (var i = rangeStart; i < answer.responseEventIndex; i++) {
      if (!history[i] || history[i].type === "user_message" || history[i].type === "done") {
        visibleRange = false;
        break;
      }
      if (visibleAnswerEvent(history[i])) spoke = true;
    }
    visibleRange = visibleRange && spoke;
  }
  if (!visibleRange && !visibleAnswerEvent(responseEvent)) return { reason: "invalid_response_ref" };
  if (record.response.state === "answered") {
    var existing = record.response.responseRef;
    if (!existing || existing.eventIndex !== answer.responseEventIndex) {
      return { reason: "conflicting_terminal_state" };
    }
  } else if (record.response.state !== "unanswered") {
    return { reason: "conflicting_terminal_state" };
  }
  return { change: { kind: "answered", ingressId: record.ingressId,
    eventIndex: answer.responseEventIndex, at: responseEvent._ts || null } };
}

function terminalEvidenceChange(record, kind) {
  var terminalState = kind === "superseded" ? "superseded" : "not_required";
  if (record.response.state !== "unanswered" && record.response.state !== terminalState) {
    return { reason: "conflicting_terminal_state" };
  }
  return { change: { kind: kind, ingressId: record.ingressId } };
}

function evidenceChange(record, sequence, groups, history) {
  if (groups.answered[sequence]) {
    return answeredEvidenceChange(record, groups.answered[sequence], history);
  }
  var kind = groups.superseded[sequence] ? "superseded" : "informational";
  return terminalEvidenceChange(record, kind);
}

function preflightEvidence(ledger, storageId, history, groups) {
  var ingresses = bySequence(history);
  var requested = evidenceSequences(groups);
  if (!requested) return { reason: "overlapping_evidence" };
  var changes = [];
  for (var i = 0; i < requested.length; i++) {
    var sequence = requested[i];
    var record = reconciliationRecord(ledger, ingresses[sequence], storageId);
    if (!record) return { reason: "missing_ingress", sequence: sequence };
    var next = evidenceChange(record, sequence, groups, history);
    if (next.reason) return { reason: next.reason, sequence: sequence };
    changes.push(next.change);
  }
  return { changes: changes };
}

function applyEvidenceChanges(ledger, changes) {
  var counts = { answered: 0, superseded: 0, informational: 0, unchanged: 0 };
  for (var i = 0; i < changes.length; i++) {
    var change = changes[i];
    var before = ledger.get(change.ingressId);
    if (change.kind === "answered") {
      ledger.markAnswered(change.ingressId, { eventIndex: change.eventIndex, at: change.at });
    } else if (change.kind === "superseded") {
      ledger.supersede(change.ingressId, "owner_interrupt");
    } else {
      ledger.markNoResponseRequired(change.ingressId);
    }
    var after = ledger.get(change.ingressId);
    if (!after) return { ok: false, reason: "persistence_failed", counts: counts };
    if (before && before.response.state === after.response.state) counts.unchanged++;
    else counts[change.kind]++;
  }
  return { ok: true, counts: counts };
}

// Applies a finite audit whose exact answer events must be named by the caller.
function reconcileOwnerRequestEvidence(ledger, session, evidence) {
  var storageId = projectIdentity.sessionStorageId(session);
  var history = session && Array.isArray(session.history) ? session.history : [];
  if (!ledger || !storageId) return { ok: false, reason: "unavailable", counts: {} };

  var groups = evidenceGroups(evidence);
  if (!groups) {
    return { ok: false, reason: "invalid_evidence", counts: {} };
  }
  var preflight = preflightEvidence(ledger, storageId, history, groups);
  if (preflight.reason) return { ok: false, reason: preflight.reason,
    sequence: preflight.sequence, counts: {} };
  return applyEvidenceChanges(ledger, preflight.changes);
}

function indexLedgerRecords(ledger) {
  var indexed = {};
  var records = typeof ledger.list === "function" ? ledger.list() : [];
  for (var i = 0; i < records.length; i++) indexed[records[i].ingressId] = records[i];
  return indexed;
}

function classifyBackfilledEntry(ledger, entry, existing, options) {
  var classification = existing && existing.classification || {};
  ledger.classify(entry.ingressId, {
    kind: classification.kind || "existing_topic",
    at: classification.at || entry.receivedAt,
    topicRef: existing && existing.topicRef || entry.topicRef,
    projectRefs: existing ? existing.projectRefs :
      (entry.projectRef ? [entry.projectRef] : (options.projectRefs || [])),
    implementationDecision: entry.implementationDecision,
    source: classification.source || "transcript_backfill",
  });
}

function recordAuditedEntry(ledger, entry, existingById, sessionRef, options) {
  if (!entry.ingressId) return "skipped";
  var existing = existingById[entry.ingressId] || null;
  var created = existing || ledger.record({
    ingressId: entry.ingressId,
    ingressSequence: entry.ingressSequence,
    ingressKind: entry.ingressKind,
    sessionRef: sessionRef,
    receivedAt: entry.receivedAt,
    requestRef: Object.assign({}, sessionRef, { eventIndex: entry.eventIndex }),
  });
  if (!created) return "skipped";
  existingById[entry.ingressId] = created;
  var needsClassification = !existing || !existing.classification ||
    (entry.implementationDecision && !existing.implementationDecision);
  if (entry.topicRef && needsClassification) {
    classifyBackfilledEntry(ledger, entry, existing, options);
  }
  if (entry.state === "answered") {
    ledger.markAnswered(entry.ingressId, { eventIndex: entry.doneEventIndex, at: entry.receivedAt });
    return "answered";
  }
  if (entry.state === "superseded") {
    ledger.supersede(entry.ingressId, "owner_interrupt");
    return "superseded";
  }
  return "unanswered";
}

// Writes the audit into the ledger. Idempotent: record() is keyed by ingress
// id, and neither markAnswered nor supersede can move a request that already
// reached a terminal response state. A request that is genuinely unanswered is
// left unanswered -- that is the point.
function backfillOwnerRequests(ledger, session, options) {
  var opts = options || {};
  var storageId = projectIdentity.sessionStorageId(session);
  if (!ledger || !storageId) return { ok: false, reason: "unavailable", counts: {} };
  var history = session && Array.isArray(session.history) ? session.history : [];
  var audited = auditOwnerRequests(history, opts);
  var counts = { recorded: 0, answered: 0, superseded: 0, unanswered: 0, skipped: 0 };
  var sessionRef = { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: storageId };
  var existingById = indexLedgerRecords(ledger);
  for (var i = 0; i < audited.length; i++) {
    var result = recordAuditedEntry(ledger, audited[i], existingById, sessionRef, opts);
    counts[result]++;
    if (result !== "skipped") counts.recorded++;
  }
  return { ok: true, counts: counts, audited: audited };
}

function selectMigrations(migrations, storageId) {
  var selected = { migrations: [], sequences: [] };
  for (var i = 0; i < migrations.length; i++) {
    var migration = migrations[i];
    if (!migration || migration.sessionStorageId !== storageId) continue;
    selected.migrations.push(migration);
    if (migration.requestReplay === false) continue;
    var requests = Array.isArray(migration.requests) ? migration.requests : [];
    for (var ri = 0; ri < requests.length; ri++) selected.sequences.push(requests[ri].sequence);
  }
  return selected;
}

function matchesExpectedIngress(event, expected) {
  if (!event || !event.coopIngressId) return false;
  if (event.coopIngressSequence !== expected.sequence) return false;
  return !expected.ingressId || event.coopIngressId === expected.ingressId;
}

// The pinned eventIndex is a coordinate into a transcript the persistence layer
// re-indexes on every reload (delta coalescing), so it rots and never recovers.
// Where the entry names the ingress, resolve by that immutable identity once the
// offset stops landing on it; the sequence and ingress-id checks are re-applied
// to whatever comes back, and an entry with no ingress id stays strict.
function locateExpectedIngress(history, expected) {
  var event = history[expected.eventIndex];
  if (matchesExpectedIngress(event, expected)) {
    return { event: event, eventIndex: expected.eventIndex };
  }
  if (!expected.ingressId) return null;
  var index = ownerEventResolution.resolveIndexByIngressId(history, expected.ingressId);
  if (index < 0) return null;
  return matchesExpectedIngress(history[index], expected) ?
    { event: history[index], eventIndex: index } : null;
}

function prepareExactMigrationRequests(ledger, session, migration) {
  if (!migration || migration.requestReplay !== false) return { ok: true, recorded: 0 };
  var history = Array.isArray(session && session.history) ? session.history : [];
  var storageId = projectIdentity.sessionStorageId(session);
  var requests = Array.isArray(migration.requests) ? migration.requests : [];
  var prepared = [];
  var recorded = 0;
  for (var i = 0; i < requests.length; i++) {
    var expected = requests[i];
    var located = locateExpectedIngress(history, expected);
    if (!located) return { ok: false, reason: "request_evidence_changed", recorded: recorded };
    var event = located.event;
    // Fetched by ingress id, so identity already matches; what is checked here is
    // that it was recorded against this session and the expected owner turn. Its
    // stored requestRef.eventIndex is deliberately NOT compared: it is the same
    // rotting coordinate, and a drifted offset on an otherwise identity-correct
    // record used to abort the whole startup backfill. Nothing is lost --
    // verifyMigration already proved this event's content by digest.
    var existing = ledger.get(event.coopIngressId);
    if (existing && (!existing.requestRef ||
        existing.requestRef.projectId !== projectIdentity.LEAD_PROJECT_ID ||
        existing.requestRef.sessionStorageId !== storageId ||
        existing.ingressSequence !== expected.sequence)) {
      return { ok: false, reason: "request_ref_mismatch", recorded: recorded };
    }
    prepared.push({ event: event, eventIndex: located.eventIndex, existing: existing });
  }
  for (var pi = 0; pi < prepared.length; pi++) {
    var item = prepared[pi];
    if (!item.existing) {
      var created = ledger.record({
        ingressId: item.event.coopIngressId,
        ingressSequence: item.event.coopIngressSequence,
        ingressKind: item.event.coopIngressKind,
        sessionRef: { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: storageId },
        requestRef: {
          projectId: projectIdentity.LEAD_PROJECT_ID,
          sessionStorageId: storageId,
          // The resolved coordinate, not the pinned one: recording a known-stale
          // offset would seed the next reader with the same rot.
          eventIndex: item.eventIndex,
        },
        receivedAt: item.event._ts,
        topicRef: item.event.coopTopicRef,
      });
      if (!created) return { ok: false, reason: "persistence_failed", recorded: recorded };
      recorded++;
    }
  }
  return { ok: true, recorded: recorded };
}

function applyMigration(ledger, session, migration) {
  return Object.assign({ migrationId: migration.migrationId || "" },
    reconcileOwnerRequestEvidence(ledger, session, migration.evidence || {}));
}

// Assembles the canary detail for a failed startup migration.
//
// migrateOwnerRequestHistory reports two layers of cause: a generic top-level
// `reason` ("migration_evidence_changed") and, on each per-migration entry, the
// discriminating one (`request_evidence_changed` vs `response_evidence_changed`)
// plus the migrationId that produced it. The caller used to prefer the top-level
// reason, which is truthy whenever evidence verification trips -- so the only
// detail worth having never reached ~/.clay/recovery-events-dev.log, and
// diagnosing a wedged migration meant re-deriving it by hand against the live
// store. Keep both: the wrapper for classification, the entries for the cause.
function describeMigrationFailure(result) {
  if (!result || result.ok === true) return null;
  var entries = (Array.isArray(result.migrations) ? result.migrations : [])
    .filter(function (item) { return !item || item.ok !== true; });
  if (entries.length) {
    return { reason: result.reason || null,
      migrations: entries.map(function (item) {
        return { migrationId: (item && item.migrationId) || "",
          reason: (item && item.reason) || null };
      }) };
  }
  if (result.reason) return result.reason;
  if (result.backfill && result.backfill.ok !== true && result.backfill.reason) {
    return result.backfill.reason;
  }
  return result;
}

// Runs synchronously after the Lead session manager has restored its canonical Coop transcript.
function migrateOwnerRequestHistory(ledger, sm, options) {
  var opts = options || {};
  var migrations = Array.isArray(opts.migrations) ? opts.migrations : OWNER_REQUEST_MIGRATIONS;
  var expectedStorageId = opts.sessionStorageId ||
    (migrations[0] && migrations[0].sessionStorageId) || null;
  var session = ownerRequestMigrations.canonicalCoopSession(sm, expectedStorageId);
  if (!ledger || !session) return { ok: false, reason: "coop_session_missing", migrations: [] };
  var storageId = projectIdentity.sessionStorageId(session);
  var selected = selectMigrations(migrations, storageId);
  for (var i = 0; i < selected.migrations.length; i++) {
    var migration = selected.migrations[i];
    var reason = ownerRequestMigrations.verifyMigration(session, migration);
    if (reason) {
      return { ok: false, reason: "migration_evidence_changed",
        backfill: { ok: false, reason: "migration_evidence_changed", counts: {} },
        migrations: [{ migrationId: migration.migrationId || "", ok: false, reason: reason }] };
    }
  }
  // Re-point drifted requestRef offsets before anything else reads them. The
  // offsets rot on every delta-coalescing rewrite (cf7f197ee1), and while every
  // consumer resolves by identity anyway, leaving the stored coordinate wrong
  // keeps handing each new reader the same rot. Resolution is per-session, so
  // this repairs predecessor-session refs across the compacted lineage too.
  //
  // Reported, never fatal: a stale offset is the pre-existing status quo, not a
  // reason to abort startup and leave the ledger unbackfilled.
  var repointed = ownerRequestMigrations.repairDriftedRequestRefs(ledger, sm);
  if (!repointed.ok) {
    console.error("[coop-owner-requests] requestRef repoint failed:",
      JSON.stringify({ reason: repointed.reason,
        unresolved: repointed.unresolved.length }));
  }
  var backfilled = backfillOwnerRequests(ledger, session,
    Object.assign({}, opts, { ingressSequences: selected.sequences }));
  var results = [];
  var ok = backfilled.ok === true;
  for (var ri = 0; ri < selected.migrations.length; ri++) {
    var prepared = prepareExactMigrationRequests(ledger, session, selected.migrations[ri]);
    var result = prepared.ok ? applyMigration(ledger, session, selected.migrations[ri]) :
      { ok: false, reason: prepared.reason, counts: {} };
    result.prepared = prepared.recorded;
    if (!result.ok) ok = false;
    results.push(result);
  }
  return { ok: ok, backfill: backfilled, migrations: results, repointed: repointed };
}
module.exports = {
  auditOwnerRequests: auditOwnerRequests,
  backfillOwnerRequests: backfillOwnerRequests,
  describeMigrationFailure: describeMigrationFailure,
  migrateOwnerRequestHistory: migrateOwnerRequestHistory,
  reconcileOwnerRequestEvidence: reconcileOwnerRequestEvidence,
  resolveTurn: resolveTurn,
};
