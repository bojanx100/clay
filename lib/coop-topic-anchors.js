// Topic membership anchors, and what to do when they no longer point at what
// they claim.
//
// Membership is persisted as event-index spans into a canonical session's
// history. Indexes are positional, so anything that shifts history invalidates
// every anchor after the shift point -- and nothing in the record proves what it
// was supposed to point AT. Measured on the owner's real index: all 1124
// turnRefs name the correct canonical session, yet their startEventIndex values
// land on `auth_required`, `tool_result`, `delta`, `done` and
// `scheduled_message_sent` records rather than on owner turn starts. That is
// what produced sentence-fragment titles and let internal-derived topics pass
// admission: both read whatever record the drifted index happened to hit.
//
// The rule here is prove-or-suppress. An anchor is honoured only when the record
// it points at IS an owner turn start. Anything else is unproven and is withheld
// from owner projection -- never re-pointed by guesswork, because a plausible
// re-anchor silently reattributes one owner's conversation to another topic.
//
// Nothing in this module mutates canonical history. It reads history and
// annotates the topic index only.

var relevance = require("./coop-topic-relevance");

// Bumped when the proving rule itself changes, so a re-run after an upgrade
// re-evaluates instead of trusting a verdict reached under older rules.
var ANCHOR_SCHEMA_VERSION = 1;

// The live admission path (coop-topic-extraction.completeTurns) sets
// startEventIndex to the owner user_message's OWN index -- offset 0, inclusive.
// That is the canonical, current-and-future convention, and it is what every
// topic minted from here on will use.
//
// The owner's real persisted index instead resolves at offset 0 zero times and
// at offset +1 (the NEXT record after start) 600/1124 times (53.4%), with
// endEventIndex landing on done/result 88.3% of the time -- a legacy artifact
// from an earlier off-by-one in how those spans were recorded, not corruption
// and not today's admission behaviour. Treating +1 as the ONLY rule would
// silently break every future-created topic (which is correctly anchored at
// offset 0); treating 0 as the only rule reproduced the original bug and would
// have suppressed all 43 real open topics.
//
// So proving tries offset 0 first (the canonical rule, checked for every
// topic including ones minted after this fix) and falls back to offset +1
// only when 0 fails to resolve to an owner turn start (accommodating already-
// persisted legacy spans without guessing which span is legacy).
var ANCHOR_OFFSETS = [0, 1];

var REASON_PROVEN = "anchor_proven";
var REASON_OUT_OF_RANGE = "anchor_out_of_range";
var REASON_NOT_TURN_START = "anchor_not_owner_turn_start";
var REASON_NO_HISTORY = "anchor_history_unavailable";

// A turn starts at an owner-authored message. That is the only record type a
// membership span can legitimately begin at, and owner provenance is what
// separates it from an injected control prompt wearing the same type.
function isOwnerTurnStart(record) {
  if (!record || record.type !== "user_message") return false;
  return relevance.hasOwnerProvenance(record);
}

// The durable fingerprint of an anchor, so a later run can tell "still correct"
// from "correct by coincidence after another shift". _ts is the only stable
// per-record identifier the history carries.
function anchorFingerprint(record) {
  if (!record) return null;
  return {
    type: String(record.type || ""),
    ts: typeof record._ts === "number" ? record._ts : null,
    clientMessageId: typeof record.clientMessageId === "string" ? record.clientMessageId : "",
  };
}

// The candidate index for a given offset, or null if out of range. Kept
// separate from proving so callers (and tests) can inspect exactly which
// index a given offset resolves to without re-deriving the arithmetic.
function candidateIndex(ref, offset, historyLength) {
  var start = ref && ref.startEventIndex;
  if (!Number.isInteger(start)) return null;
  var index = start + offset;
  if (index < 0 || index >= historyLength) return null;
  return index;
}

// Verdict for a single membership span. Deliberately returns a reason rather
// than a boolean: the reason is what makes a suppression auditable afterwards.
// Tries each offset in ANCHOR_OFFSETS order and stops at the first one that
// resolves to an owner turn start; the fingerprint reported on failure is
// always the canonical (offset 0) record, since that is what a human auditing
// a suppression needs to see.
function proveAnchor(history, ref) {
  var items = Array.isArray(history) ? history : null;
  if (!items) return { proven: false, reason: REASON_NO_HISTORY, fingerprint: null };
  var canonicalIndex = candidateIndex(ref, ANCHOR_OFFSETS[0], items.length);
  if (canonicalIndex === null) {
    return { proven: false, reason: REASON_OUT_OF_RANGE, fingerprint: null };
  }
  for (var oi = 0; oi < ANCHOR_OFFSETS.length; oi++) {
    var index = candidateIndex(ref, ANCHOR_OFFSETS[oi], items.length);
    if (index === null) continue;
    var record = items[index];
    if (isOwnerTurnStart(record)) {
      return {
        proven: true,
        reason: REASON_PROVEN,
        offset: ANCHOR_OFFSETS[oi],
        fingerprint: anchorFingerprint(record),
      };
    }
  }
  return {
    proven: false,
    reason: REASON_NOT_TURN_START,
    fingerprint: anchorFingerprint(items[canonicalIndex]),
  };
}

// Splits a topic's memberships into the ones that can be trusted and the ones
// that cannot. Membership itself is never deleted -- the durable index keeps
// every record so a future re-derivation still has the evidence, and so a
// suppression can be explained rather than just observed.
function classifyTopicAnchors(topic, history) {
  var refs = topic && Array.isArray(topic.turnRefs) ? topic.turnRefs : [];
  var proven = [];
  var unproven = [];
  for (var i = 0; i < refs.length; i++) {
    var verdict = proveAnchor(history, refs[i]);
    if (verdict.proven) proven.push({ index: i, ref: refs[i], fingerprint: verdict.fingerprint });
    else unproven.push({ index: i, ref: refs[i], reason: verdict.reason, fingerprint: verdict.fingerprint });
  }
  return { proven: proven, unproven: unproven };
}

// A topic is projectable only if at least one membership is proven. Zero proven
// anchors means nothing about it can be trusted -- not its title, not its state,
// not its transcript -- so it is withheld rather than shown with fabricated
// content derived from whatever record the drifted index hit.
function topicHasProvenAnchor(topic, history) {
  var refs = topic && Array.isArray(topic.turnRefs) ? topic.turnRefs : [];
  for (var i = 0; i < refs.length; i++) {
    if (proveAnchor(history, refs[i]).proven) return true;
  }
  return false;
}

// Only the proven spans, for callers that build a transcript or a title. An
// unproven span contributes nothing rather than contributing the wrong thing.
function provenTurnRefs(topic, history) {
  return classifyTopicAnchors(topic, history).proven.map(function (entry) { return entry.ref; });
}

// Annotates the index with a durable, auditable verdict per topic. Idempotent
// and restart-safe: re-running with the same history and the same schema
// version rewrites the same values, and a topic already verified at this
// version with an unchanged anchor count is left untouched so repeated
// migrations cannot churn the file.
function reconcileAnchors(index, options) {
  var opts = options || {};
  var historyFor = typeof opts.historyFor === "function" ? opts.historyFor : function () { return null; };
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var topics = index && index.topics;
  var list = Array.isArray(topics) ? topics : (topics ? Object.keys(topics).map(function (k) { return topics[k]; }) : []);

  var summary = { checked: 0, verified: 0, suppressed: 0, unchanged: 0, partial: 0 };
  for (var i = 0; i < list.length; i++) {
    var topic = list[i];
    if (!topic) continue;
    summary.checked += 1;
    var refs = Array.isArray(topic.turnRefs) ? topic.turnRefs : [];
    var existing = topic.anchorAudit;
    // Skip only when the previous verdict was reached under THIS rule version
    // against the same number of anchors. A schema bump or an appended
    // membership forces a fresh evaluation.
    if (existing && existing.schemaVersion === ANCHOR_SCHEMA_VERSION &&
        existing.anchorCount === refs.length) {
      summary.unchanged += 1;
      continue;
    }
    var history = historyFor(topic);
    var split = classifyTopicAnchors(topic, history);
    var audit = {
      schemaVersion: ANCHOR_SCHEMA_VERSION,
      checkedAt: now(),
      anchorCount: refs.length,
      provenCount: split.proven.length,
      unprovenCount: split.unproven.length,
      // Fail closed: no proven anchor means the topic is not projectable.
      projectable: split.proven.length > 0,
      reason: split.proven.length > 0
        ? (split.unproven.length > 0 ? "partial_anchors_proven" : REASON_PROVEN)
        : (split.unproven[0] && split.unproven[0].reason || REASON_NO_HISTORY),
      // A bounded sample, so a suppression can be explained without re-deriving.
      examples: split.unproven.slice(0, 3).map(function (entry) {
        return { startEventIndex: entry.ref && entry.ref.startEventIndex, reason: entry.reason,
          found: entry.fingerprint && entry.fingerprint.type || "" };
      }),
    };
    topic.anchorAudit = audit;
    if (!audit.projectable) summary.suppressed += 1;
    else if (audit.unprovenCount > 0) { summary.verified += 1; summary.partial += 1; }
    else summary.verified += 1;
  }
  return summary;
}

// What the projection consults. Absent an audit the topic is evaluated live, so
// a fresh index that has never been reconciled still fails closed rather than
// being trusted by default.
function isProjectable(topic, history) {
  // Trust the durable verdict only while it still describes the topic it
  // audited: an appended membership since the audit (anchorCount drift) must
  // force a live re-proof, or a topic audited before its first turn would stay
  // suppressed forever after genuinely earning one.
  if (topic && topic.anchorAudit && topic.anchorAudit.schemaVersion === ANCHOR_SCHEMA_VERSION &&
      topic.anchorAudit.anchorCount === (Array.isArray(topic.turnRefs) ? topic.turnRefs.length : 0)) {
    return !!topic.anchorAudit.projectable;
  }
  return topicHasProvenAnchor(topic, history);
}

module.exports = {
  ANCHOR_SCHEMA_VERSION: ANCHOR_SCHEMA_VERSION,
  ANCHOR_OFFSETS: ANCHOR_OFFSETS,
  candidateIndex: candidateIndex,
  REASON_NOT_TURN_START: REASON_NOT_TURN_START,
  REASON_OUT_OF_RANGE: REASON_OUT_OF_RANGE,
  REASON_NO_HISTORY: REASON_NO_HISTORY,
  REASON_PROVEN: REASON_PROVEN,
  anchorFingerprint: anchorFingerprint,
  classifyTopicAnchors: classifyTopicAnchors,
  isOwnerTurnStart: isOwnerTurnStart,
  isProjectable: isProjectable,
  proveAnchor: proveAnchor,
  provenTurnRefs: provenTurnRefs,
  reconcileAnchors: reconcileAnchors,
  topicHasProvenAnchor: topicHasProvenAnchor,
};
