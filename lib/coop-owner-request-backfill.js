// Reconstructs owner-request records from the canonical Coop transcript using
// the same visible-answer rules as the live conversation controller.
var crypto = require("node:crypto");
var projectIdentity = require("./project-identity");
var sameOwnerRequest = require("./coop-conversation-control").sameOwnerRequest;
var explicitImplementationDecision = require("./coop-thread-lifecycle").explicitImplementationDecision;

// The SAME set coop-conversation-control.answeringEvent uses, and for the same
// reason: `result` is cost/usage bookkeeping, not the assistant speaking. This
// module exists so an audit and a live recording agree, so the two sets must
// not drift -- with `result` in here the audit called a silent turn answered
// while the live path correctly called it unanswered.
var ASSISTANT_OUTPUT = { delta: true, delta_replace: true, plan_content: true };
var INTERRUPTED = /interrupted/i;

// One independently audited repair for the canonical bootstrap transcript.
// Digests bind each exact durable event without copying owner text. If
// compaction or editing changes any event, the migration fails
// closed and leaves the response outstanding.
var OWNER_REQUEST_MIGRATIONS = [{
  migrationId: "2026-08-15-coop-bootstrap-responses",
  sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af",
  requests: [
    { sequence: 281, eventIndex: 147824, digest: "e2bb9d7a2ac23f4b5c1ae3156130bf8be1e791fce5a2bf33f617647d07274476" },
    { sequence: 283, eventIndex: 147993, digest: "2e50a7409ff9b53fe74ebf3e6192734a0d7214ce58b93a437340d328b9b88490" },
    { sequence: 286, eventIndex: 149261, digest: "200cfde96791666792edbe1cf43d6e3ee1466b78fbccb8671430a7f10996637e" },
    { sequence: 287, eventIndex: 149369, digest: "9e178c64edbcab94fe99c28e2fd3ae20c1114cf0cf51c920f185d9cfa377d314" },
    { sequence: 289, eventIndex: 149581, digest: "43fe2dc15646c692ed26ae0bac4c7df66241fa392819cabe0acd2d9939cb784a" },
    { sequence: 290, eventIndex: 149612, digest: "244b0be441f5c9aeb755709f24f6ab8ad7305af6b60fe9467ae365402f523813" },
  ],
  evidence: {
    answered: [
      { sequence: 283, responseEventIndex: 149181,
        responseDigest: "93b381ca8ac9b3066c7c7075ee677f75bfb7943f6e74812cbb57b7618dcff4ef" },
      { sequence: 286, responseEventIndex: 149429,
        responseDigest: "d70780f0013bb5b95b9c75421128c759bd1c249407a8aabe024c34a2a4de8365" },
      { sequence: 287, responseEventIndex: 149429,
        responseDigest: "d70780f0013bb5b95b9c75421128c759bd1c249407a8aabe024c34a2a4de8365" },
      { sequence: 289, responseEventIndex: 150039,
        responseDigest: "4582f618bf6148f0f61a322d49c7a47b22e0e35c29e38a564c4a8563d756587e" },
      { sequence: 290, responseEventIndex: 150039,
        responseDigest: "4582f618bf6148f0f61a322d49c7a47b22e0e35c29e38a564c4a8563d756587e" },
    ],
  },
}];

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
  if (!visibleAnswerEvent(responseEvent)) return { reason: "invalid_response_ref" };
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

function eventDigest(event) {
  if (!event) return "";
  return crypto.createHash("sha256").update([
    String(event.type || ""), String(event._ts || ""),
    String(event.text || event.content || ""),
  ].join("\n")).digest("hex");
}

function canonicalCoopSession(sm, storageId) {
  var found = null;
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
  sm.sessions.forEach(function (session) {
    if (found || !session || session.coopHome !== true) return;
    if (!storageId || projectIdentity.sessionStorageId(session) === storageId) found = session;
  });
  return found;
}

function verifyMigrationEvent(history, expected, response) {
  var eventIndex = response ? expected.responseEventIndex : expected.eventIndex;
  var digest = response ? expected.responseDigest : expected.digest;
  var event = history[eventIndex];
  if (!event || eventDigest(event) !== digest) return false;
  if (!response) {
    return event.type === "user_message" && event.coopIngressSequence === expected.sequence;
  }
  return visibleAnswerEvent(event);
}

function verifyMigration(session, migration) {
  var history = Array.isArray(session && session.history) ? session.history : [];
  var requests = Array.isArray(migration.requests) ? migration.requests : [];
  for (var i = 0; i < requests.length; i++) {
    if (!verifyMigrationEvent(history, requests[i], false)) return "request_evidence_changed";
  }
  var answered = migration.evidence && Array.isArray(migration.evidence.answered) ?
    migration.evidence.answered : [];
  for (var ai = 0; ai < answered.length; ai++) {
    if (!verifyMigrationEvent(history, answered[ai], true)) return "response_evidence_changed";
  }
  return "";
}

function selectMigrations(migrations, storageId) {
  var selected = { migrations: [], sequences: [] };
  for (var i = 0; i < migrations.length; i++) {
    var migration = migrations[i];
    if (!migration || migration.sessionStorageId !== storageId) continue;
    selected.migrations.push(migration);
    var requests = Array.isArray(migration.requests) ? migration.requests : [];
    for (var ri = 0; ri < requests.length; ri++) selected.sequences.push(requests[ri].sequence);
  }
  return selected;
}

function applyMigration(ledger, session, migration) {
  return Object.assign({ migrationId: migration.migrationId || "" },
    reconcileOwnerRequestEvidence(ledger, session, migration.evidence || {}));
}

// Runs synchronously after the Lead session manager has restored its canonical Coop transcript.
function migrateOwnerRequestHistory(ledger, sm, options) {
  var opts = options || {};
  var migrations = Array.isArray(opts.migrations) ? opts.migrations : OWNER_REQUEST_MIGRATIONS;
  var expectedStorageId = opts.sessionStorageId ||
    (migrations[0] && migrations[0].sessionStorageId) || null;
  var session = canonicalCoopSession(sm, expectedStorageId);
  if (!ledger || !session) return { ok: false, reason: "coop_session_missing", migrations: [] };
  var storageId = projectIdentity.sessionStorageId(session);
  var selected = selectMigrations(migrations, storageId);
  for (var i = 0; i < selected.migrations.length; i++) {
    var migration = selected.migrations[i];
    var reason = verifyMigration(session, migration);
    if (reason) {
      return { ok: false, reason: "migration_evidence_changed",
        backfill: { ok: false, reason: "migration_evidence_changed", counts: {} },
        migrations: [{ migrationId: migration.migrationId || "", ok: false, reason: reason }] };
    }
  }
  var backfilled = backfillOwnerRequests(ledger, session,
    Object.assign({}, opts, { ingressSequences: selected.sequences }));
  var results = [];
  var ok = backfilled.ok === true;
  for (var ri = 0; ri < selected.migrations.length; ri++) {
    var result = applyMigration(ledger, session, selected.migrations[ri]);
    if (!result.ok) ok = false;
    results.push(result);
  }
  return { ok: ok, backfill: backfilled, migrations: results };
}
module.exports = {
  auditOwnerRequests: auditOwnerRequests,
  backfillOwnerRequests: backfillOwnerRequests,
  migrateOwnerRequestHistory: migrateOwnerRequestHistory,
  reconcileOwnerRequestEvidence: reconcileOwnerRequestEvidence,
  resolveTurn: resolveTurn,
};
