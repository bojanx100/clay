// Converts the durable grouped Topic projection into its bounded client shape.

function clientCanonicalEvent(ref) {
  var eventRef = Object.assign({
    eventKey: "canonical:" + ref.sessionStorageId + ":" + ref.eventIndex,
  }, ref);
  return {
    eventRef: eventRef,
    title: "Canonical event " + (ref.eventIndex + 1),
    sessionRef: { projectId: ref.projectId, sessionStorageId: ref.sessionStorageId },
  };
}

function clientTopic(topic, group) {
  var refs = Array.isArray(topic.eventRefs) ? topic.eventRefs : [];
  var first = topic.firstEventRef || refs[0] || null;
  var last = topic.lastEventRef || refs[refs.length - 1] || null;
  var previews = [];
  if (first) previews.push(first);
  if (last && (!first || last.eventIndex !== first.eventIndex || last.sessionStorageId !== first.sessionStorageId)) {
    previews.push(last);
  }
  return {
    topicRef: topic.topicRef,
    threadRef: topic.threadRef || { threadId: topic.topicRef.topicId },
    threadState: topic.threadState || (topic.status === "closed" ? "closed" : "exploring"),
    closeOutcome: topic.closeOutcome || null,
    lastTurnRef: topic.lastTurnRef || null,
    projectRef: group.projectRef || null,
    group: group.kind,
    title: topic.title,
    status: topic.status,
    workState: topic.workState || "",
    awaitingAcceptance: !!topic.awaitingAcceptance,
    stateSource: topic.stateSource || "",
    ownerDisposition: topic.ownerDisposition || null,
    unread: topic.unreadCount || 0,
    attention: !!topic.attention,
    rollingSummary: topic.rollingSummary || "",
    decisions: topic.decisions || [],
    currentActivity: topic.currentActivity || "",
    relatedSessions: topic.relatedSessions || [],
    executionProjectRefs: topic.executionProjectRefs || [],
    eventCount: Number.isInteger(topic.eventCount) ? topic.eventCount : refs.length,
    turnCount: Number.isInteger(topic.turnCount) ? topic.turnCount : (topic.turnRefs || []).length,
    firstEventRef: first,
    lastEventRef: last,
    canonicalEvents: previews.map(clientCanonicalEvent),
    updatedAt: topic.updatedAt || null,
  };
}

function clientTopics(indexProjection) {
  var groups = indexProjection && Array.isArray(indexProjection.groups) ? indexProjection.groups : [];
  var topics = [];
  for (var gi = 0; gi < groups.length; gi++) {
    var items = Array.isArray(groups[gi].topics) ? groups[gi].topics : [];
    for (var ti = 0; ti < items.length; ti++) topics.push(clientTopic(items[ti], groups[gi]));
  }
  return topics;
}

module.exports = { clientTopics: clientTopics };
