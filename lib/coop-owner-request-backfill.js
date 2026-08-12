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

var ASSISTANT_OUTPUT = { delta: true, delta_replace: true, result: true, plan_content: true };
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
  resolveTurn: resolveTurn,
};
