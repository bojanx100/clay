// One-time repair for Threads closed before closure retired them properly.
//
// Two paths used to close a record by assigning topic.status directly and never
// advancing threadState: the owner's confirmed bulk sweep
// (coop-topic-closure.applyClosureProposal) and the daemon's ledger
// reconciliation (coop-topic-index-migrations.reconcileTopicDisposition). Both
// now go through coop-thread-lifecycle.applyRecordStatus, so the damage is no
// longer produced -- but records written before that fix are still on disk, and
// the migration normalizer cannot heal them: initializeThread infers threadState
// from status ONLY when threadState is absent or invalid, and a damaged record's
// threadState is a perfectly valid "exploring".
//
// Split out of coop-thread-lifecycle.js to keep that module under the 500-line
// limit, and because this is legacy repair rather than a live lifecycle rule.
// Delivered to the owner through scripts/heal-closed-thread-states.js.

var threadLifecycle = require("./coop-thread-lifecycle");

var THREAD_STATES = threadLifecycle.THREAD_STATES;
var CLOSE_OUTCOMES = threadLifecycle.CLOSE_OUTCOMES;

// Every threadState that keeps a record in the owner's Threads rail. The rail
// filter is a denylist -- coopTopicSections drops handed_off and closed and
// keeps everything else -- so a record closed by a status-only write leaks
// whenever its threadState is one of these, not just when it is "exploring".
var LEAKING_THREAD_STATES = {};
LEAKING_THREAD_STATES[THREAD_STATES.EXPLORING] = true;
LEAKING_THREAD_STATES[THREAD_STATES.PARKED] = true;

// Repairs records that carry status "closed" with a threadState that says
// otherwise. Idempotent by construction: healing lands threadState "closed",
// which the predicate below then skips, so a re-run reports zero changes.
//
// By default it repairs only the records that actually leak into the Threads
// rail (exploring, parked). A closed/handed_off record is inconsistent too but
// is already filtered out of the rail, and completing its close is an
// owner-visible judgement about real linked work, so it takes an explicit
// includeHandedOff opt-in rather than riding along.
//
// closeOutcome cannot be inferred from a damaged record -- the outcome is the
// one thing the status-only write never recorded -- so the caller supplies a
// per-thread classification, with a default for anything unclassified.
function healClosedThreadStates(state, options) {
  var opts = options || {};
  var overrides = opts.closeOutcomes && typeof opts.closeOutcomes === "object"
    ? opts.closeOutcomes : {};
  var selected = null;
  if (Array.isArray(opts.threadIds)) {
    selected = {};
    for (var si = 0; si < opts.threadIds.length; si++) selected[String(opts.threadIds[si])] = true;
  }
  var fallback = threadLifecycle.validCloseOutcome(opts.closeOutcome)
    ? opts.closeOutcome : CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED;
  var topics = state && state.topics && typeof state.topics === "object" ? state.topics : {};
  var ids = Object.keys(selected || topics).sort();
  var healed = [];
  var skippedHandedOff = [];
  for (var i = 0; i < ids.length; i++) {
    if (selected && !selected[ids[i]]) continue;
    var thread = topics[ids[i]];
    if (!thread || typeof thread !== "object") continue;
    if (thread.status !== "closed") continue;
    if (thread.threadState === THREAD_STATES.CLOSED) continue;
    if (!LEAKING_THREAD_STATES[thread.threadState] && !opts.includeHandedOff) {
      // Damaged but not leaking: handed_off today.
      skippedHandedOff.push(ids[i]);
      continue;
    }
    var outcome = threadLifecycle.validCloseOutcome(overrides[ids[i]])
      ? overrides[ids[i]] : fallback;
    var before = {
      threadState: thread.threadState || null,
      closeOutcome: thread.closeOutcome || null,
      hidden: !!thread.hidden,
    };
    var applied = threadLifecycle.applyThreadTransition(thread, THREAD_STATES.CLOSED,
      outcome, opts.now);
    if (!applied.changed) continue;
    healed.push({
      threadId: ids[i],
      threadRef: { threadId: ids[i] },
      before: before,
      after: {
        threadState: thread.threadState,
        closeOutcome: thread.closeOutcome,
        hidden: !!thread.hidden,
      },
    });
  }
  return { changed: healed.length > 0, healed: healed, skippedHandedOff: skippedHandedOff };
}

// Cross-store repair ordering: settle owner requests first, then heal exactly
// the previewed topic set. This is intentionally retryable rather than atomic:
// a failure can leave some request settlements committed, but every topic stays
// repairable so a fresh process can replay the idempotent ledger work and finish.
function healWithOwnerRequests(index, ownerRequests, options) {
  if (!index || typeof index.load !== "function" ||
      typeof index.healClosedThreadStates !== "function") {
    return { ok: false, code: "invalid_topic_index" };
  }
  if (!ownerRequests || typeof ownerRequests.reconcileTopicClosure !== "function") {
    return { ok: false, code: "invalid_owner_request_ledger" };
  }
  var opts = options || {};
  var copy = JSON.parse(JSON.stringify(index.load()));
  var preview = healClosedThreadStates(copy, opts);
  if (preview.healed.length && typeof opts.beforeWrite === "function") {
    opts.beforeWrite(preview);
  }
  var settlements = [];
  for (var i = 0; i < preview.healed.length; i++) {
    var id = preview.healed[i].threadId;
    var settled;
    try { settled = ownerRequests.reconcileTopicClosure({ topicId: id }); }
    catch (e) { settled = { ok: false, reason: "threw: " + e.message }; }
    if (!settled || settled.ok !== true) {
      return { ok: false, code: "owner_request_reconcile_failed", threadId: id,
        reason: settled && settled.reason || "unknown", preview: preview,
        settlements: settlements };
    }
    settlements.push({ threadId: id, result: settled });
  }
  var healOptions = Object.assign({}, opts, {
    threadIds: preview.healed.map(function (entry) { return entry.threadId; }),
  });
  delete healOptions.beforeWrite;
  var report = index.healClosedThreadStates(healOptions);
  return Object.assign({}, report, { preview: preview, settlements: settlements });
}

module.exports = {
  LEAKING_THREAD_STATES: LEAKING_THREAD_STATES,
  healClosedThreadStates: healClosedThreadStates,
  healWithOwnerRequests: healWithOwnerRequests,
};
