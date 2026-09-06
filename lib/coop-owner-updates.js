// Owner-facing reports are explicit conversation records. Their Thread scope
// comes from delivered execution evidence, never from prose or a supplied topic.
var feedback = require("./coop-task-feedback");
var sessionHistory = require("./coop-session-history");
var plane = require("./coop-control-plane");

function viewFor(manager, session) {
  return manager.getHistoryView ? manager.getHistoryView(session) :
    sessionHistory.forSession(session, manager.sessions);
}

function evidence(view) {
  var byId = Object.create(null);
  (view.history || []).forEach(function (item) {
    if (!item || item.type !== "user_message" || item.internalOnly !== true ||
        !Array.isArray(item.coordinatorUpdateIds)) return;
    (item.coordinatorFeedback || []).forEach(function (value) {
      var ref = feedback.normalized(value);
      if (!ref || item.coordinatorUpdateIds.indexOf(ref.eventId) === -1) return;
      if (byId[ref.eventId] && JSON.stringify(byId[ref.eventId]) !== JSON.stringify(ref)) {
        byId[ref.eventId] = false;
      } else if (byId[ref.eventId] !== false) byId[ref.eventId] = ref;
    });
  });
  return byId;
}

function indexesForTopic(view, wanted) {
  var id = wanted && wanted.topicId;
  if (!id) return [];
  var refs = evidence(view);
  var indexes = [];
  (view.history || []).forEach(function (item, index) {
    if (!item || item.type !== "coop_owner_update" || !Array.isArray(item.feedbackEventIds)) return;
    if (item.feedbackEventIds.some(function (eventId) {
      return refs[eventId] && refs[eventId].coopTopicRef.topicId === id;
    })) indexes.push(index);
  });
  return indexes;
}

function pending(manager, session) {
  var view = viewFor(manager, session);
  var refs = evidence(view);
  (view.history || []).forEach(function (item) {
    if (item && item.type === "coop_owner_update") (item.feedbackEventIds || []).forEach(function (id) {
      delete refs[id];
    });
  });
  return Object.keys(refs).filter(function (id) { return refs[id]; }).map(function (id) { return refs[id]; });
}

function publish(manager, session, input) {
  if (plane.canonicalCoop(manager) !== session) return { ok: false, reason: "canonical_coop_required" };
  var replyId = input && input.replyId;
  var text = input && input.text;
  var ids = input && input.feedbackEventIds || [];
  if (typeof replyId !== "string" || !replyId.trim() || replyId.length > 128 ||
      typeof text !== "string" || !text.trim() || text.length > 16000 ||
      !Array.isArray(ids) || ids.length > 32 || ids.some(function (id, index) {
        return typeof id !== "string" || !id || id.length > 256 || ids.indexOf(id) !== index;
      })) return { ok: false, reason: "invalid_owner_update" };
  var view = viewFor(manager, session);
  var previous = view.history.find(function (item) {
    return item && item.type === "coop_owner_update" && item.replyId === replyId;
  });
  var ordered = ids.slice().sort();
  if (previous) return { ok: previous.text === text &&
    JSON.stringify(previous.feedbackEventIds) === JSON.stringify(ordered),
  duplicate: true, reason: previous.text === text &&
    JSON.stringify(previous.feedbackEventIds) === JSON.stringify(ordered) ? "" : "owner_update_conflict" };
  var available = evidence(view);
  if (ordered.some(function (id) { return !available[id]; })) {
    return { ok: false, reason: "feedback_evidence_missing" };
  }
  var record = { type: "coop_owner_update", replyId: replyId, text: text,
    feedbackEventIds: ordered,
    feedbackRefs: ordered.map(function (id) { return available[id]; }), _ts: Date.now() };
  session.history.push(record);
  try {
    if (manager.saveSessionFile(session, { durable: true }) !== true) throw new Error("save_failed");
  } catch (error) {
    session.history.pop();
    session._historyNeedsRewrite = true;
    return { ok: false, reason: "owner_update_persistence_failed" };
  }
  if (manager.sendToSession) manager.sendToSession(session, record);
  return { ok: true, replyId: replyId, feedbackEventIds: ordered };
}

module.exports = { publish: publish, pending: pending, indexesForTopic: indexesForTopic };
