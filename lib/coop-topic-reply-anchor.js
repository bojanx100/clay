// Topic-aware reply threading: the logical parent of a message sent from a
// topic lens.
//
// Canonical Coop history is one append-only log. A message sent from Topic A
// lands at its physical tail, next to whatever unrelated general-chat or
// Topic B traffic happened to arrive last. That placement is correct storage
// and the wrong conversation: logically the message answers the last thing
// said inside Topic A, which may be hundreds of events earlier. Physical
// append order and logical reply association are separate concerns, and only
// the first one was ever recorded -- so the message read as unrelated tail
// content in general chat instead of a reply in its own thread.
//
// This module derives the missing half: the reply anchor. It never writes
// history, never reorders it, and never re-points an anchor already stamped.
// An anchor is computed once, at ingress, and persisted on the NEW event only.
//
// Fail closed. A topic with no owner-relevant member yet yields no anchor, and
// an anchor whose target no longer matches its fingerprint is dropped at read
// time rather than re-pointed. The tempting fallback -- "anchor to the last
// thing in canonical history" -- is exactly the cross-topic misattribution
// this exists to prevent: that record usually belongs to another topic.

var relevance = require("./coop-topic-relevance");
var lineage = require("./coop-topic-lineage");
var projectIdentity = require("./project-identity");

// Bumped when the anchor SHAPE changes. A reader that does not recognise the
// version ignores the anchor (fail closed) instead of guessing its layout.
var ANCHOR_VERSION = 1;

function historyOf(session) {
  return Array.isArray(session && session.history) ? session.history : [];
}

function storageIdOf(session) {
  return lineage.storageIdOf(session);
}

// Every canonical index a topic claims, narrowed to the owner-relevant subset.
//
// Shared with the topic lens replay (coop-topic-connection.boundedMembershipIndexes)
// deliberately: the anchor must name a record the owner can actually see in
// that topic. If this derivation and the lens derivation ever disagreed, the
// chip would point at a message the topic does not show.
function topicMembershipIndexes(topic, session) {
  var history = historyOf(session);
  var seen = {};
  var indexes = [];
  function add(index) {
    if (!Number.isInteger(index) || index < 0 || index >= history.length || seen[index]) return;
    seen[index] = true;
    indexes.push(index);
  }
  // startEventIndex/endEventIndex are inclusive (coop-topic-extraction.completeTurns
  // sets startEventIndex to the owner user_message's own index).
  var turns = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  for (var ti = 0; ti < turns.length; ti++) {
    var turn = turns[ti] || {};
    for (var eventIndex = turn.startEventIndex; eventIndex <= turn.endEventIndex; eventIndex++) {
      add(lineage.absoluteIndexFor(session, turn.sessionStorageId || storageIdOf(session), eventIndex));
    }
  }
  var refs = Array.isArray(topic && topic.eventRefs) ? topic.eventRefs : [];
  for (var ri = 0; ri < refs.length; ri++) {
    if (!refs[ri]) continue;
    add(lineage.absoluteIndexFor(session, refs[ri].sessionStorageId || storageIdOf(session), refs[ri].eventIndex));
  }
  indexes.sort(function (a, b) { return a - b; });
  return relevance.ownerRelevantIndexes(history, indexes);
}

// The durable fingerprint of the anchored record. `_ts` plus type plus
// clientMessageId is what lets a later read tell "still the same record" from
// "some other record now sits at this index".
function fingerprintOf(record) {
  return {
    type: String((record && record.type) || ""),
    ts: record && typeof record._ts === "number" ? record._ts : null,
    clientMessageId: record && typeof record.clientMessageId === "string" ? record.clientMessageId : "",
  };
}

function topicIdOf(ref) {
  if (!ref || typeof ref !== "object") return "";
  return typeof ref.topicId === "string" ? ref.topicId.trim() : "";
}

// A turn starts at an owner-authored message. Reused from the membership-anchor
// rule so "which turn is this a reply to" and "which turn does membership start
// at" cannot answer differently.
function isOwnerTurnStart(record) {
  return !!(record && record.type === "user_message" && relevance.hasOwnerProvenance(record));
}

// The reply anchor for a message about to be appended to `session` under
// `topicRef`: the latest owner turn start the topic already holds.
//
// Turn granularity, not "last member event", and that choice is load-bearing.
// Owner-relevance keeps `done` and streaming `delta` records -- they are
// conversation, not narration -- so the topic's last MEMBER is routinely a
// `done` marker, which the transcript renders no block for. An anchor pointing
// at it would name a record the owner cannot see and cannot be jumped to. An
// owner turn start is always rendered, is the same record the membership rule
// already proves against (coop-topic-anchors.isOwnerTurnStart), and is what
// "a reply in this thread" actually means.
//
// Returns null -- never a guess -- when the topic holds no owner turn yet (a
// brand new topic, or one whose only traffic is internal). The caller stamps
// the result on the new event and nothing else.
function buildReplyAnchor(topicRef, topic, session) {
  var topicId = topicIdOf(topicRef);
  var storageId = storageIdOf(session);
  if (!topicId || !storageId || !topic) return null;
  var history = historyOf(session);
  var indexes = topicMembershipIndexes(topic, session);
  for (var i = indexes.length - 1; i >= 0; i--) {
    var location = lineage.locationForAbsoluteIndex(session, indexes[i]);
    var record = location && location.record;
    if (!isOwnerTurnStart(record)) continue;
    var print = fingerprintOf(record);
    return {
      version: ANCHOR_VERSION,
      topicId: topicId,
      sessionStorageId: location.sessionStorageId || storageId,
      eventIndex: location.eventIndex,
      type: print.type,
      ts: print.ts,
      clientMessageId: print.clientMessageId,
    };
  }
  return null;
}

// Reads a persisted anchor back into its canonical shape. Anything unrecognised
// -- wrong version, missing ids, non-integer index -- is discarded rather than
// partially honoured.
function normalizeReplyAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== ANCHOR_VERSION) return null;
  var topicId = typeof value.topicId === "string" ? value.topicId.trim() : "";
  var storageId = typeof value.sessionStorageId === "string" ? value.sessionStorageId.trim() : "";
  if (!topicId || !storageId || !Number.isInteger(value.eventIndex) || value.eventIndex < 0) return null;
  return {
    version: ANCHOR_VERSION,
    topicId: topicId,
    sessionStorageId: storageId,
    eventIndex: value.eventIndex,
    type: typeof value.type === "string" ? value.type : "",
    ts: typeof value.ts === "number" ? value.ts : null,
    clientMessageId: typeof value.clientMessageId === "string" ? value.clientMessageId : "",
  };
}

// Does the anchor still name the record it was stamped against? Compared by
// fingerprint, not by index alone: an index that now lands on a different
// record is a drifted anchor, and a drifted anchor must be dropped, never
// followed. That is the difference between "no thread shown" and "this message
// is shown as a reply to someone else's conversation".
function anchorResolves(anchor, history) {
  var normalized = normalizeReplyAnchor(anchor);
  if (!normalized) return false;
  var resolved = lineage.recordAt(history, normalized.sessionStorageId, normalized.eventIndex);
  var record = resolved && resolved.record;
  if (!record) return false;
  var print = fingerprintOf(record);
  if (print.type !== normalized.type) return false;
  if (normalized.ts !== null && print.ts !== normalized.ts) return false;
  if (normalized.clientMessageId && print.clientMessageId !== normalized.clientMessageId) return false;
  return true;
}

// The anchor a persisted history item may be rendered or reasoned with. Three
// independent gates, each of which fails closed on its own:
//   1. the item must claim a topic at all,
//   2. the anchor must claim the SAME topic (a mismatch is cross-topic
//      attribution and is refused outright),
//   3. the anchored record must still be there and still be itself.
function anchorForItem(item, history) {
  if (!item || typeof item !== "object") return null;
  var anchor = normalizeReplyAnchor(item.coopTopicAnchor);
  if (!anchor) return null;
  if (anchor.topicId !== topicIdOf(item.coopTopicRef)) return null;
  if (Array.isArray(history) && !anchorResolves(anchor, history)) return null;
  return anchor;
}

// The reference-only projection of an anchor: what the agent sees inside
// <coop_topic_context> and what the client renders a chip from. Content is
// deliberately absent -- an anchor points at a record, it does not copy it.
function anchorContextPayload(anchor) {
  var normalized = normalizeReplyAnchor(anchor);
  if (!normalized) return null;
  return {
    topicId: normalized.topicId,
    sessionStorageId: normalized.sessionStorageId,
    eventIndex: normalized.eventIndex,
  };
}

// Stamps the reply anchor onto an ingress route result, in place.
//
// Only for EXPLICIT topic routing -- a topicRef the owner's client actually
// selected. A canonical send with no topic is classified heuristically
// (coop-topic-index.classifyCanonicalIngress), and threading general chat onto
// a guessed topic's last turn would attach it to a conversation the owner
// never chose. Explicit intent is the only thing allowed to create a durable
// reply relationship.
// Threading is an enhancement to the owner's message, never a precondition for
// sending it, so a failure here degrades to "no anchor" rather than to a
// rejected turn. Reported loudly, because a silently anchor-less topic is the
// original bug wearing a different hat.
function replyAnchorForRoute(index, session, result) {
  if (!result || !result.ok || !result.topicRef) return result;
  if (!index || typeof index.resolve !== "function") return result;
  try {
    // Open topics only, matching new-message ingress: a closed topic accepts no
    // new turn, so it must not hand out an anchor either.
    var resolved = index.resolve(result.topicRef, false);
    if (!resolved || !resolved.ok) return result;
    var anchor = buildReplyAnchor(result.topicRef, resolved.topic, session);
    if (anchor) result.topicAnchor = anchor;
  } catch (e) {
    console.warn("[coop-topic] reply anchor unavailable for topic " +
      topicIdOf(result.topicRef) + ": " + e.message);
  }
  return result;
}

// Claims a just-appended canonical event for the routed topic.
//
// Extraction also claims this turn, but only once it completes: until a `done`
// lands -- and permanently, if the daemon restarts mid-turn -- the topic lens
// replayed without the owner's own message while general chat showed it at the
// tail. That gap is the reported bug. Binding at send time closes it.
//
// Forward-only and idempotent: one membership reference is appended for the new
// event, the index dedupes by event key, and no existing record is rewritten.
function bindTopicMembership(index, session, msg, eventIndex) {
  if (!session || !session.coopHome || !msg || !msg.coopTopicRef) return false;
  if (!Number.isInteger(eventIndex) || eventIndex < 0) return false;
  var storageId = storageIdOf(session);
  if (!storageId) return false;
  if (!index || typeof index.addEventMembership !== "function") return false;
  // This runs between the history push and the session-file append, so a throw
  // here would cost the owner their message for the sake of topic bookkeeping.
  // Membership is recoverable -- extraction still claims the turn on `done` --
  // and the message is not, so the message wins.
  try {
    var result = index.addEventMembership(msg.coopTopicRef, [{
      projectId: projectIdentity.LEAD_PROJECT_ID,
      sessionStorageId: storageId,
      eventIndex: eventIndex,
    }], session);
    return !!(result && result.ok);
  } catch (e) {
    console.warn("[coop-topic] send-time membership binding failed for topic " +
      topicIdOf(msg.coopTopicRef) + ": " + e.message);
    return false;
  }
}

module.exports = {
  ANCHOR_VERSION: ANCHOR_VERSION,
  bindTopicMembership: bindTopicMembership,
  replyAnchorForRoute: replyAnchorForRoute,
  anchorContextPayload: anchorContextPayload,
  anchorForItem: anchorForItem,
  anchorResolves: anchorResolves,
  buildReplyAnchor: buildReplyAnchor,
  fingerprintOf: fingerprintOf,
  isOwnerTurnStart: isOwnerTurnStart,
  normalizeReplyAnchor: normalizeReplyAnchor,
  topicMembershipIndexes: topicMembershipIndexes,
};
