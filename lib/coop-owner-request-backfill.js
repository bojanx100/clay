// Reconstructs owner-request records from the canonical Coop transcript.
//
// The ledger only starts recording from the moment it is wired in, but the
// owner's outstanding requests predate it -- and those are exactly the ones
// they care about. This replays the same rules the live path applies, over
// history that already happened, so an audit and a live recording agree.
//
// The classification that matters is whether a turn ANSWERED. Clay writes
// `done` with code 0 on paths where nobody replied: an aborted turn emits
// thinking_stop + info("Conversation interrupted"/"Interrupted") + done(0).
// A turn only answered when it produced genuine assistant output before its
// terminator -- the same rule as coop-conversation-control.answeringEvent.

var projectIdentity = require("./project-identity");

// The SAME set coop-conversation-control.answeringEvent uses, and for the same
// reason: `result` is cost/usage bookkeeping, not the assistant speaking. This
// module exists so an audit and a live recording agree, so the two sets must
// not drift -- with `result` in here the audit called a silent turn answered
// while the live path correctly called it unanswered.
var ASSISTANT_OUTPUT = { delta: true, delta_replace: true, plan_content: true };
var INTERRUPTED = /interrupted/i;

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
function automaticContinuationStart(history, doneIndex, boundary) {
  var queued = false;
  for (var i = doneIndex + 1; i < boundary; i++) {
    var event = history[i];
    if (!event) continue;
    if (event.type === "scheduled_message_queued") {
      queued = !!event.autoAction;
      continue;
    }
    if (event.type === "scheduled_message_cancelled") {
      queued = false;
      continue;
    }
    if (event.type !== "user_message") continue;
    if (event.coopContinuationIngressId || queued) return i;
    return -1;
  }
  return -1;
}

// One owner turn, resolved against the events that followed it.
//
//   answered    -- terminated with assistant output;
//   superseded  -- the owner's next message arrived before this turn terminated,
//                  i.e. they withdrew it by replacing it;
//   unanswered  -- terminated with no reply (aborted, interrupted or errored),
//                  or never terminated at all.
function resolveTurn(history, start, boundary) {
  var spoke = false;
  for (var i = start + 1; i < boundary; i++) {
    var event = history[i];
    if (!event) continue;
    if (ASSISTANT_OUTPUT[event.type]) spoke = true;
    if (event.type === "info" && INTERRUPTED.test(String(event.text || ""))) {
      // An explicit interruption notice: whatever partial output preceded it,
      // the turn did not finish answering.
      spoke = false;
    }
    if (event.type === "done") {
      var continuation = automaticContinuationStart(history, i, boundary);
      if (continuation >= 0) {
        // A partial pre-retry delta did not complete the owner-facing reply.
        // The resumed turn needs its own visible output, exactly as live
        // markIngressAnswered requires after the retained ingress is restored.
        spoke = false;
        i = continuation;
        continue;
      }
      return { state: !event.code && spoke ? "answered" : "unanswered",
        doneEventIndex: i, code: event.code || 0, spoke: spoke };
    }
  }
  return { state: boundary < history.length ? "superseded" : "in_flight",
    doneEventIndex: -1, code: null, spoke: spoke };
}

function auditOwnerRequests(history) {
  var list = Array.isArray(history) ? history : [];
  var ingresses = ingressEvents(list);
  var audited = [];
  for (var k = 0; k < ingresses.length; k++) {
    var current = ingresses[k];
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

// Applies an independently audited, finite historical population. Unlike the
// generic backfill above, this does not guess whether a later reply covered a
// repeated owner message: every terminal disposition and answer event must be
// supplied as canonical evidence. Existing terminal facts must already agree,
// which makes retries safe and makes a conflicting audit fail closed.
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

// Writes the audit into the ledger. Idempotent: record() is keyed by ingress
// id, and neither markAnswered nor supersede can move a request that already
// reached a terminal response state. A request that is genuinely unanswered is
// left unanswered -- that is the point.
function backfillOwnerRequests(ledger, session, options) {
  var opts = options || {};
  var storageId = projectIdentity.sessionStorageId(session);
  if (!ledger || !storageId) return { ok: false, reason: "unavailable", counts: {} };
  var history = session && Array.isArray(session.history) ? session.history : [];
  var audited = auditOwnerRequests(history);
  var counts = { recorded: 0, answered: 0, superseded: 0, unanswered: 0, skipped: 0 };
  var sessionRef = { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: storageId };
  for (var i = 0; i < audited.length; i++) {
    var entry = audited[i];
    if (!entry.ingressId) { counts.skipped++; continue; }
    var created = ledger.record({
      ingressId: entry.ingressId,
      ingressSequence: entry.ingressSequence,
      ingressKind: entry.ingressKind,
      sessionRef: sessionRef,
      receivedAt: entry.receivedAt,
      requestRef: { projectId: sessionRef.projectId, sessionStorageId: storageId,
        eventIndex: entry.eventIndex },
    });
    if (!created) { counts.skipped++; continue; }
    counts.recorded++;
    if (entry.topicRef) {
      ledger.classify(entry.ingressId, {
        // A backfilled turn cannot re-run the classifier, and guessing would
        // invent execution intent. The topic it actually landed on is a fact;
        // whether it was new at the time is not, so it reads as a reuse.
        kind: "existing_topic",
        topicRef: entry.topicRef,
        projectRefs: entry.projectRef ? [entry.projectRef] : (opts.projectRefs || []),
        source: "transcript_backfill",
      });
    }
    if (entry.state === "answered") {
      ledger.markAnswered(entry.ingressId, { eventIndex: entry.doneEventIndex, at: entry.receivedAt });
      counts.answered++;
    } else if (entry.state === "superseded") {
      ledger.supersede(entry.ingressId, "owner_interrupt");
      counts.superseded++;
    } else {
      counts.unanswered++;
    }
  }
  return { ok: true, counts: counts, audited: audited };
}

module.exports = {
  auditOwnerRequests: auditOwnerRequests,
  backfillOwnerRequests: backfillOwnerRequests,
  reconcileOwnerRequestEvidence: reconcileOwnerRequestEvidence,
  resolveTurn: resolveTurn,
};
