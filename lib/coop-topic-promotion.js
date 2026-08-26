// When a quiet automatic Coop topic earns an owner-visible row.
//
// Automatic classification mints a topic for every owner turn that does not
// match anything existing. That is right for the durable index -- no canonical
// turn should be unreachable -- but wrong for the sidebar: a single passing
// remark used to mint a permanent row, and those fragments accumulated forever.
//
// So minting and showing are separated here. A one-turn automatic topic stays
// durable and searchable but claims no row until there is evidence the owner
// treats it as a real thread:
//
//   * a second owner-relevant turn   -- they came back to it;
//   * explicit owner routing         -- they aimed a message at this exact lens;
//   * linked work                    -- an execution link or a linked task;
//   * a recorded owner disposition   -- they ruled on it.
//
// Nothing is lost either way: the durable index keeps every membership, so the
// topic appears the moment any of those lands.
//
// Deliberately NOT evidence: an explicit close. Closing a quiet one-turn topic
// is the owner dismissing it, so counting closure would make tidying up ADD rows
// to the Done section -- the opposite of the intent. That is what "closure does
// not worsen projection noise" means.

var topicRelevance = require("./coop-topic-relevance");
var lineage = require("./coop-topic-lineage");
var queueAuthorization = require("./coop-queue-authorization");

// Automatic topics carry an auto-prefixed id. Canonical ingress derives that id
// from durable turn evidence; the classifier retains the title fingerprint only
// for legacy callers that have no canonical anchor. The prefix separates them
// from curated seeds, which share source "automatic" but keep stable, readable
// ids, and from manual/split topics, which are deliberate owner acts.
var AUTOMATIC_ID_PREFIX = "auto-";

// One turn is a passing remark; two is a thread the owner came back to.
var PROMOTION_TURN_THRESHOLD = 2;

function isAutomaticallyMinted(topic) {
  var id = topic && topic.topicRef && topic.topicRef.topicId;
  return !!(topic && topic.source === "automatic" && typeof id === "string" &&
    id.indexOf(AUTOMATIC_ID_PREFIX) === 0);
}

// How many of this topic's turn spans open on a record the owner would recognise
// as conversation. Membership is stored as canonical spans, so each one resolves
// back to its opening history record -- the same rule topicHasRelevantTurn uses,
// counted rather than short-circuited. Internal narration is excluded because it
// is already dropped from replay, so counting it would promote a topic whose lens
// is still effectively a single remark.
function ownerRelevantTurnCount(topic, history) {
  var turnRefs = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  var count = 0;
  for (var i = 0; i < turnRefs.length; i++) {
    var ref = turnRefs[i] || {};
    var resolved = lineage.recordAt(history, ref.sessionStorageId || "", ref.startEventIndex);
    if (!resolved || !resolved.record) continue;
    if (!topicRelevance.isInternalHistoryItem(resolved.record)) count += 1;
  }
  return count;
}

function hasQueueAuthorization(topic, history) {
  return !!queueAuthorization.authorizationEventForTopic(topic, history);
}

// `view` is the already-computed public projection of this topic, used only for
// its linked-work count: tasks link to a topic by coopTopicRef rather than
// through relatedExecutions, so that count is the only place task evidence is
// visible here.
function isProjectable(topic, view, options) {
  if (!isAutomaticallyMinted(topic)) return true;
  // Queue authorization is actionable owner control, not a passing remark.
  // Its foreground reply may be priority-interrupted before extraction can
  // create a completed turn span, but send-time event membership still proves
  // the exact owner event and must keep its Thread reachable.
  if (hasQueueAuthorization(topic, options && options.history)) return true;
  if (topic.explicitlyRouted === true) return true;
  if (topic.ownerDisposition && typeof topic.ownerDisposition === "object" &&
      (topic.ownerDisposition.status === "done" ||
        topic.ownerDisposition.status === "needs_input")) return true;
  // When projection has a session resolver, only ACL-visible, non-hidden
  // top-level sessions count as promotion evidence. Raw durable references may
  // point at archived/hidden sessions and must not keep a quiet topic alive.
  if (options && typeof options.resolveRelatedSession === "function") {
    if (view && Array.isArray(view.relatedSessions) && view.relatedSessions.length) return true;
  } else if (Array.isArray(topic.relatedExecutions) && topic.relatedExecutions.length) {
    // Direct index consumers without a resolver retain the historical
    // reference-only behavior; they cannot inspect session visibility.
    return true;
  }
  if (view && Number(view.linkedWorkCount) > 0) return true;
  // Without history there is no way to tell a one-turn topic from a busy one, so
  // withholding it would hide real threads on the strength of a guess.
  if (!options || !options.history) return true;
  return ownerRelevantTurnCount(topic, options.history) >= PROMOTION_TURN_THRESHOLD;
}

// Durable evidence that the owner deliberately aimed something at this exact
// lens, recorded on the topic itself.
//
// The write path is distinguishable from a read: new-message ingress must land in
// an OPEN topic (Phase 1), while selection, replay and drill-through deliberately
// admit closed ones so a resolved topic stays reviewable. So an admitted explicit
// route that did NOT ask for closed topics is, by construction, the owner routing
// new work here rather than reviewing old work. Callers may say so outright with
// recordExplicitRoute, which always wins.
//
// Set-once and never unset, so this costs at most one extra write per topic for
// the lifetime of the index. It deliberately does not touch updatedAt: that
// tracks membership, and the turn this route carries will bump it on arrival.
//
// Returns true when the caller must persist.
function recordExplicitRoute(topic, options, includeClosed) {
  var requested = options && options.recordExplicitRoute;
  var wanted = typeof requested === "boolean" ? requested : !includeClosed;
  if (!wanted || !topic || topic.explicitlyRouted === true) return false;
  topic.explicitlyRouted = true;
  return true;
}

module.exports = {
  AUTOMATIC_ID_PREFIX: AUTOMATIC_ID_PREFIX,
  PROMOTION_TURN_THRESHOLD: PROMOTION_TURN_THRESHOLD,
  isAutomaticallyMinted: isAutomaticallyMinted,
  hasQueueAuthorization: hasQueueAuthorization,
  isProjectable: isProjectable,
  ownerRelevantTurnCount: ownerRelevantTurnCount,
  recordExplicitRoute: recordExplicitRoute,
};
