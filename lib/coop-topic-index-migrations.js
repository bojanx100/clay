// Exactly-once index-stamped migrations and durable owner dispositions for
// the Coop topic index. Split from coop-topic-index.js, which grew past the
// 500-line module limit; this file owns everything that writes disposition
// records or migration stamps, while the index keeps identity, membership and
// projection.
//
// Every function here operates on the live index instance through the seam
// object created by createTopicIndex: { load, save, now, resolve }. Nothing
// here reads files or resolves sessions on its own.

var projectIdentity = require("./project-identity");
var crypto = require("crypto");
var lineage = require("./coop-topic-lineage");
var topicAnchors = require("./coop-topic-anchors");
var topicRetrofit = require("./coop-topic-retrofit");
var topicDisposition = require("./coop-topic-disposition");
var topicConsolidation = require("./coop-topic-consolidation");
var topicClosure = require("./coop-topic-closure");

// Bounded durable request-dedup log. Enough to absorb reconnect resends and
// double-click bursts; a decision older than the window has long been
// reflected back to the client through the projection.
var MAX_DISPOSITION_REQUESTS = 32;

function canonicalGuard(seam, session) {
  var storageId = projectIdentity.sessionStorageId(session);
  if (!session || !session.coopHome || !storageId) return { ok: false, code: "canonical_coop_required" };
  var index = seam.load();
  if (index.canonicalSessionStorageId &&
      !lineage.sessionExtendsCanonical(session, index.canonicalSessionStorageId)) {
    return { ok: false, code: "canonical_session_mismatch" };
  }
  return { ok: true, index: index, storageId: storageId };
}

// Explicit, standalone anchor reconciliation. Deliberately NOT part of
// ensureRetro's hot path (called on every connection/select) -- reconciling
// there would write anchorAudit onto topics minted between selects (e.g. via
// classifyCanonicalIngress) as a side effect of an otherwise read-mostly
// operation, which is surprising and untestable as "no state change on a
// rejected action". This is meant to be invoked once at startup/migration
// time, or on demand, against the canonical session's history. Idempotent
// and versioned: unaffected topics are left untouched on repeat calls.
function reconcileTopicAnchors(seam, session) {
  var guard = canonicalGuard(seam, session);
  if (!guard.ok) return guard;
  var history = session || [];
  var summary = topicAnchors.reconcileAnchors(guard.index, { historyFor: function () { return history; }, now: seam.now });
  var changed = summary.verified > 0 || summary.suppressed > 0;
  if (changed) seam.save();
  return { ok: true, changed: changed, summary: summary };
}

// Explicit, standalone title retrofit for topics minted before the
// classifier fixes (contraction collapse, fuller stopword list,
// low-information routing). Deliberately requires anchors to have been
// reconciled first in practice (callers should run reconcileTopicAnchors
// beforehand), since it only ever acts on already-proven anchors -- but it
// re-derives proven refs itself here too, so calling it alone is safe, just
// possibly a no-op for topics anchors have not yet reconciled. Idempotent
// and versioned exactly like reconcileTopicAnchors: unaffected topics are
// left untouched on repeat calls, and a topic once retitled or merged is
// never revisited.
function retrofitTopicTitles(seam, session) {
  var guard = canonicalGuard(seam, session);
  if (!guard.ok) return guard;
  var history = session || [];
  var report = topicRetrofit.retrofitTitles(guard.index, { historyFor: function () { return history; }, now: seam.now });
  var changed = report.retitled > 0 || report.mergedToUncategorised > 0;
  if (changed) seam.save();
  return { ok: true, changed: changed, report: report };
}

// Exactly-once, index-stamped title migration. reconcileTopicAnchors and
// retrofitTopicTitles are callable-on-demand and per-topic idempotent, but
// nothing in the daemon reliably invoked them: the message-ingress hook sits
// behind routing that genuine owner Coop traffic provably bypassed (owner
// evidence: a real canonical owner message left zero audits). This runs on
// the projection path instead -- the one path that demonstrably executes with
// the daemon's authoritative cached canonical session -- and stamps the index
// (state.titleRetrofit) so the migration body runs exactly once per schema
// version, across reloads and restarts, without owner test messages or
// external file mutation. Fails closed without stamping when the canonical
// history is unavailable, so an early empty-history call can never suppress
// every topic and burn the once-only stamp doing it.
function ensureTitleRetrofit(seam, session) {
  var guard = canonicalGuard(seam, session);
  if (!guard.ok) return guard;
  var index = guard.index;
  var stamp = index.titleRetrofit;
  if (stamp && stamp.schemaVersion === topicRetrofit.TITLE_RETROFIT_SCHEMA_VERSION) {
    return { ok: true, changed: false, alreadyComplete: true };
  }
  var history = session || [];
  var items = Array.isArray(session && session.history) ? session.history : [];
  if (items.length === 0) return { ok: false, code: "canonical_history_unavailable" };
  var reconciled = reconcileTopicAnchors(seam, session);
  if (!reconciled.ok) return reconciled;
  var report = topicRetrofit.retrofitTitles(index, { historyFor: function () { return history; }, now: seam.now });
  index.titleRetrofit = {
    schemaVersion: topicRetrofit.TITLE_RETROFIT_SCHEMA_VERSION,
    completedAt: seam.now(),
    retitled: report.retitled,
    mergedToUncategorised: report.mergedToUncategorised,
  };
  seam.save();
  return { ok: true, changed: report.retitled > 0 || report.mergedToUncategorised > 0, report: report };
}

// Exactly-once, index-stamped disposition backfill, same contract as
// ensureTitleRetrofit and running on the same proven projection path.
// Historical topics predate durable topic->task links (production evidence:
// zero of 23 orchestration tasks carried a coopTopicRef), so their resolution
// cannot be proven. This records that durably per topic instead of leaving
// the state blank or guessing Working: linked topics derive live state from
// their tasks, unlinked open topics get an inspectable "unlinked_historical"
// needs-input record, and existing dispositions -- including explicit owner
// decisions -- are never overwritten. Fails closed without stamping when the
// canonical history is unavailable, exactly like the title retrofit, so a
// partially-loaded session cannot burn the stamp.
function ensureDispositionBackfill(seam, session) {
  var guard = canonicalGuard(seam, session);
  if (!guard.ok) return guard;
  var index = guard.index;
  var stamp = index.dispositionBackfill;
  if (stamp && stamp.schemaVersion === topicDisposition.DISPOSITION_SCHEMA_VERSION) {
    return { ok: true, changed: false, alreadyComplete: true };
  }
  var items = Array.isArray(session && session.history) ? session.history : [];
  if (items.length === 0) return { ok: false, code: "canonical_history_unavailable" };
  var report = topicDisposition.backfillDispositions(index, {
    tasks: Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [],
    now: seam.now,
  });
  index.dispositionBackfill = {
    schemaVersion: topicDisposition.DISPOSITION_SCHEMA_VERSION,
    completedAt: seam.now(),
    linked: report.linked,
    defaulted: report.defaulted,
    kept: report.kept,
  };
  seam.save();
  return { ok: true, changed: report.defaulted > 0, report: report };
}

// Exactly-once, index-stamped topic consolidation, same contract as
// ensureTitleRetrofit and ensureDispositionBackfill and running on the same
// proven projection path. The classifier fix stops new sprawl but cannot undo
// what the old >=2-overlap rule already minted: 33 distinct topics holding one
// turn each, which is the owner complaint ("we can't have 7 topics for one
// session"). This folds those fragments into the conversation they belong to.
//
// Fails closed without stamping when the canonical history is unavailable, so a
// partially-loaded session cannot burn the stamp. The pass itself needs no
// history -- it groups on stored keywords alone -- but an empty history means the
// canonical session is not really loaded, and running a structural merge against
// a possibly-incomplete index and then recording it as done is precisely the
// failure the other two migrations guard against.
function ensureTopicConsolidation(seam, session) {
  var guard = canonicalGuard(seam, session);
  if (!guard.ok) return guard;
  var index = guard.index;
  var stamp = index.topicConsolidation;
  if (stamp && stamp.schemaVersion === topicConsolidation.CONSOLIDATION_SCHEMA_VERSION) {
    return { ok: true, changed: false, alreadyComplete: true };
  }
  var items = Array.isArray(session && session.history) ? session.history : [];
  if (items.length === 0) return { ok: false, code: "canonical_history_unavailable" };
  var report = topicConsolidation.consolidateTopics(index, { now: seam.now });
  index.topicConsolidation = {
    schemaVersion: topicConsolidation.CONSOLIDATION_SCHEMA_VERSION,
    completedAt: seam.now(),
    merged: report.merged,
    keptNoHost: report.keptNoHost,
    openBefore: report.openBefore,
    openAfter: report.openAfter,
  };
  seam.save();
  return { ok: true, changed: report.merged > 0, report: report };
}

// Owner ingress 134, as a question rather than a sweep. Selects the topics that
// track nothing (no matching session, no linked execution) and records that exact
// set as a durable proposal; nothing is closed until confirmTopicClosures is
// called with the proposal's own id. See coop-topic-closure.js for why this is
// deliberately two-touch.
function proposeTopicClosures(seam, session, options) {
  var guard = canonicalGuard(seam, session);
  if (!guard.ok) return guard;
  var opts = options || {};
  var proposed = topicClosure.proposeClosures(guard.index, {
    sessions: opts.sessions, hasMatchingSession: opts.hasMatchingSession, now: seam.now,
    // Authoritative evidence the selector fails safe on.
    tasks: opts.tasks, bindings: opts.bindings, sessionEvidence: opts.sessionEvidence,
    outstandingTopicIds: opts.outstandingTopicIds,
  });
  seam.save();
  return proposed;
}

// The owner's ruling on a recorded closure proposal. Confirming closes exactly
// the set the proposal named; declining closes nothing. Both are persisted, so a
// resend after a reconnect or restart replays the outcome instead of sweeping
// twice.
function confirmTopicClosures(seam, decision, evidence) {
  var index = seam.load();
  // The SAME evidence the proposal was built from. Passing only `now` made
  // confirmation evaluate against nothing and close every candidate.
  var applied = topicClosure.applyClosureProposal(index, decision,
    Object.assign({}, evidence || {}, { now: seam.now }));
  if (!applied.ok) return applied;
  if (!applied.duplicate) seam.save();
  return applied;
}

function topicIdOf(ref) {
  if (!ref) return "";
  return String(ref.topicId || ref.topicKey || ref.id || ref.key || "").trim();
}

function recordedRequest(index, requestId, topicId) {
  var log = Array.isArray(index.dispositionRequests) ? index.dispositionRequests : [];
  for (var i = 0; i < log.length; i++) {
    var entry = log[i];
    if (entry && entry.requestId === requestId) {
      // The same request id aimed at a different topic is not a resend of the
      // recorded decision; it is a conflicting reuse and must not replay the
      // other topic's result.
      if (entry.topicId !== topicId) return { conflict: true };
      return { entry: entry };
    }
  }
  return null;
}

function rememberRequest(index, entry) {
  var log = Array.isArray(index.dispositionRequests) ? index.dispositionRequests : [];
  log.push(entry);
  if (log.length > MAX_DISPOSITION_REQUESTS) log.splice(0, log.length - MAX_DISPOSITION_REQUESTS);
  index.dispositionRequests = log;
}

// One explicit owner decision on one topic. Authority and the displayed-state
// staleness check belong to the connection layer; this resolves, deduplicates
// by durable request id, enforces the revision precondition, applies and
// persists. The dedup log lives in the index file itself, so a resend after a
// reconnect OR a daemon restart returns the recorded outcome instead of
// writing a second record.
function applyTopicDisposition(seam, ref, decision) {
  var result = seam.resolve(ref, true);
  if (!result.ok) return result;
  var index = seam.load();
  var requestId = decision && decision.requestId != null ? String(decision.requestId) : "";
  var topicId = topicIdOf(result.ref);
  if (requestId) {
    var seen = recordedRequest(index, requestId, topicId);
    if (seen && seen.conflict) return { ok: false, code: "request_conflict" };
    if (seen) return { ok: true, topicRef: result.ref, disposition: seen.entry.disposition, duplicate: true };
  }
  var applied = topicDisposition.applyOwnerDecision(result.topic, decision, { now: seam.now });
  if (!applied.ok) return applied;
  if (requestId) {
    rememberRequest(index, { requestId: requestId, topicId: topicId, disposition: applied.disposition });
  }
  seam.save();
  return { ok: true, topicRef: result.ref, disposition: applied.disposition };
}

// Daemon-owned repair path for a disposition and conventional topic status as
// one ledger transaction. It is intentionally narrower than the interactive
// management API: the caller must name the current status and disposition
// revision, and a durable request id makes retries exact no-ops.
function reconcileTopicDisposition(seam, ref, decision) {
  var result = seam.resolve(ref, true);
  if (!result.ok) return result;
  var index = seam.load();
  var requestId = decision && decision.requestId != null
    ? String(decision.requestId) : "";
  var topicId = topicIdOf(result.ref);
  var expectedStatus = String(decision && decision.expectedStatus || "");
  var targetStatus = String(decision && decision.status || "");
  if (!requestId || (expectedStatus !== "open" && expectedStatus !== "closed") ||
      (targetStatus !== "open" && targetStatus !== "closed")) {
    return { ok: false, code: "invalid_reconciliation" };
  }
  var effect = {
    topicId: topicId,
    expectedStatus: expectedStatus,
    status: targetStatus,
    verb: String(decision && decision.verb || ""),
    note: topicDisposition.cleanNote(decision && decision.note),
    expectedRevision: Number(decision && decision.expectedRevision),
  };
  var effectFingerprint = crypto.createHash("sha256")
    .update(JSON.stringify(effect)).digest("hex");
  var seen = recordedRequest(index, requestId, topicId);
  if (seen && seen.conflict) return { ok: false, code: "request_conflict" };
  if (seen) {
    if (seen.entry.reconciliationFingerprint &&
        seen.entry.reconciliationFingerprint !== effectFingerprint) {
      return { ok: false, code: "request_conflict" };
    }
    return { ok: true, topicRef: result.ref, disposition: seen.entry.disposition,
      status: result.topic.status, duplicate: true };
  }
  if (result.topic.status !== expectedStatus) {
    return { ok: false, code: "stale_topic_status", currentStatus: result.topic.status };
  }
  var applied = topicDisposition.applyOwnerDecision(result.topic, decision, { now: seam.now });
  if (!applied.ok) return applied;
  result.topic.status = targetStatus;
  result.topic.updatedAt = applied.disposition.at;
  rememberRequest(index, { requestId: requestId, topicId: topicId,
    disposition: applied.disposition, status: targetStatus,
    reconciliationFingerprint: effectFingerprint });
  seam.save();
  return { ok: true, topicRef: result.ref, disposition: applied.disposition,
    status: targetStatus };
}

module.exports = {
  MAX_DISPOSITION_REQUESTS: MAX_DISPOSITION_REQUESTS,
  reconcileTopicAnchors: reconcileTopicAnchors,
  retrofitTopicTitles: retrofitTopicTitles,
  ensureTitleRetrofit: ensureTitleRetrofit,
  ensureDispositionBackfill: ensureDispositionBackfill,
  ensureTopicConsolidation: ensureTopicConsolidation,
  proposeTopicClosures: proposeTopicClosures,
  confirmTopicClosures: confirmTopicClosures,
  applyTopicDisposition: applyTopicDisposition,
  reconcileTopicDisposition: reconcileTopicDisposition,
};
