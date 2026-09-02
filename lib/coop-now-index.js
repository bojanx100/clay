// coop-now-index.js - The owner's "Now" index: one deterministic, bounded
// projection of what is genuinely current, keyed strictly by canonical topic.
//
// Two kinds of entry, in this order:
//
//   1. attention -- canonical topics with genuine owner attention/decision
//      evidence: a linked task that is blocked/waiting/failed, work finished
//      and awaiting acceptance, or a live action-queue decision that carries a
//      durable link to the topic. Historical topics whose Needs input comes
//      only from an unlinked disposition record are NOT attention: nothing
//      current is asking for the owner, so they stay in the topic list.
//
//   2. working -- canonical topics with genuinely active linked or foreground
//      work, stated exactly: "Working now".
//
// One entry per canonical TopicRef, attention winning when a topic is both
// active and actionable. Everything else is excluded by construction: quiet
// unlinked historical topics, terminal accepted/completed/closed work,
// coordinator/task implementation noise (the queue already lifts owner
// decisions off coordinators), and any queue item without a resolvable
// canonical topic destination -- a row that cannot open its topic is noise,
// not orientation.

var MAX_NOW_ITEMS = 20;

// State sources that prove a CURRENT owner question, as opposed to a recorded
// historical one. Vocabulary from coop-topic-state.js.
var ATTENTION_SOURCES = {
  task_attention: true,
  task_awaiting_acceptance: true,
};

// Truthful one-line reasons, same vocabulary the queue rows used. The reason
// orients ("where should I look first"), it never asks the question -- that
// belongs next to the evidence in the topic surface.
var STATUS_REASONS = {
  needs_input: "Needs your answer",
  waiting_user: "Waiting for your answer",
  blocked: "Blocked — needs you",
  failed: "Failed — decide what happens next",
};

var REASON_WORKING = "Working now";
var REASON_ACCEPTANCE = "Worker finished — review the result";
var REASON_ATTENTION = "Needs your attention";

function topicIdOf(ref) {
  if (!ref) return "";
  return String(ref.topicId || ref.topicKey || ref.id || ref.key || "").trim();
}

// Queue items indexed by the canonical topic they durably link to. Items with
// no topicRef never reach the Now index: they are raw task rows, and the
// owner's contract is that the index contains topics, not tasks.
function queueItemsByTopic(actionItems) {
  var byTopic = {};
  var list = Array.isArray(actionItems) ? actionItems : [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var topicId = topicIdOf(item && item.topicRef);
    if (!topicId) continue;
    if (!byTopic[topicId]) byTopic[topicId] = [];
    byTopic[topicId].push(item);
  }
  return byTopic;
}

// The reason for an attention entry, most specific evidence first: a linked
// acceptance item names the truthful next step; a linked decision item names
// its durable status; otherwise the topic's own state source decides.
function attentionReason(topic, linkedItems) {
  var items = linkedItems || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i] && items[i].kind === "acceptance") return REASON_ACCEPTANCE;
  }
  for (var j = 0; j < items.length; j++) {
    var status = items[j] && String(items[j].status || "");
    if (STATUS_REASONS[status]) return STATUS_REASONS[status];
  }
  if (topic.stateSource === "task_awaiting_acceptance") return REASON_ACCEPTANCE;
  if (topic.stateSource === "task_attention") return REASON_ATTENTION;
  return REASON_ATTENTION;
}

function exactSessionRef(item) {
  var ref = item && item.destination && item.destination.ref;
  if (!ref || !ref.projectId || !ref.sessionStorageId) return null;
  return { projectId: ref.projectId, sessionStorageId: ref.sessionStorageId };
}

// A topic can collect more than one owner action. Prefer the first action that
// carries an openable canonical session, because the card must take the owner
// to the live task they are being asked about rather than a topic-only shell.
function actionForCard(items) {
  var list = Array.isArray(items) ? items : [];
  for (var i = 0; i < list.length; i++) {
    if (exactSessionRef(list[i])) return list[i];
  }
  return list[0] || null;
}

function entryFor(topic, kind, reason, action) {
  var item = action || null;
  var entry = {
    topicRef: { topicId: topicIdOf(topic.topicRef) },
    projectRef: topic.projectRef || null,
    title: String(topic.title || "Untitled topic"),
    kind: kind,
    reason: reason,
    updatedAt: typeof topic.updatedAt === "number" ? topic.updatedAt : 0,
  };
  if (item) {
    entry.projectTitle = String(item.projectTitle || "Project");
    entry.status = String(item.status || "needs_input");
    entry.taskId = String(item.taskId || "");
    entry.sessionRef = exactSessionRef(item);
  }
  return entry;
}

// Deterministic within a bucket: oldest first, so the index does not reshuffle
// under the owner while they work down it, with the TopicRef as tiebreak.
function sortEntries(entries) {
  return entries.slice().sort(function (a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    var ka = a.topicRef.topicId;
    var kb = b.topicRef.topicId;
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });
}

// topics: the client topic projection (each row already carries workState and
// its inspectable stateSource). actionItems: the owner action queue, whose
// topic-linked entries are attention evidence. Both are already ACL-filtered
// by the caller.
function buildNowIndex(topics, actionItems) {
  var list = Array.isArray(topics) ? topics : [];
  var byTopic = queueItemsByTopic(actionItems);
  var attention = [];
  var working = [];
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    var topic = list[i];
    var topicId = topicIdOf(topic && topic.topicRef);
    // Strictly one entry per canonical TopicRef; no resolvable topic, no row.
    if (!topicId || seen[topicId]) continue;
    seen[topicId] = true;
    // Terminal work never reads as current, whatever else points at it.
    if (topic.workState === "done") continue;
    var linked = byTopic[topicId] || null;
    // Genuine attention: a live topic-linked queue decision (whatever the
    // topic's motion state -- attention wins when a topic is both active and
    // actionable), or a current task-derived Needs input.
    var isAttention = !!linked ||
      (topic.workState === "needs_input" && ATTENTION_SOURCES[topic.stateSource]);
    if (isAttention) {
      attention.push(entryFor(topic, "attention", attentionReason(topic, linked), actionForCard(linked)));
      continue;
    }
    if (topic.workState === "working") {
      working.push(entryFor(topic, "working", REASON_WORKING));
      continue;
    }
    // Everything else is quiet: recorded historical Needs input, unproven
    // topics, anything without current evidence. The topic list still shows
    // them; the Now index deliberately does not.
  }
  return sortEntries(attention).concat(sortEntries(working)).slice(0, MAX_NOW_ITEMS);
}

module.exports = {
  MAX_NOW_ITEMS: MAX_NOW_ITEMS,
  buildNowIndex: buildNowIndex,
};
