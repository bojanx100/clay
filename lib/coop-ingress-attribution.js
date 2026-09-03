// Exact, reference-only Thread attribution for Coop's foreground ingress lane.

function threadId(value) {
  var id = value && (value.threadId || value.topicId);
  return typeof id === "string" && id ? id : "";
}

function addRef(refs, seen, value) {
  var id = threadId(value);
  if (!id || id === "uncategorised-conversations" || seen[id]) return;
  seen[id] = true;
  refs.push({ threadId: id });
}

function addStoredRefs(refs, seen, value) {
  var list = Array.isArray(value && value.threadRefs) ? value.threadRefs : [];
  for (var i = 0; i < list.length; i++) addRef(refs, seen, list[i]);
  addRef(refs, seen, value && value.coopThreadRef);
  addRef(refs, seen, value && value.coopTopicRef);
  addRef(refs, seen, value && value.threadRef);
  addRef(refs, seen, value && value.topicRef);
}

function topicContainsEvent(topic, storageId, eventIndex) {
  var turns = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  for (var i = 0; i < turns.length; i++) {
    if (turns[i].sessionStorageId === storageId &&
        turns[i].startEventIndex <= eventIndex && turns[i].endEventIndex >= eventIndex) return true;
  }
  var events = Array.isArray(topic && topic.eventRefs) ? topic.eventRefs : [];
  for (var j = 0; j < events.length; j++) {
    if (events[j].sessionStorageId === storageId && events[j].eventIndex === eventIndex) return true;
  }
  return false;
}

function addIndexedRefs(refs, seen, topicIndex, storageId, eventIndex) {
  if (!topicIndex || typeof topicIndex.load !== "function" || !storageId || eventIndex < 0) return;
  var state = topicIndex.load();
  var ids = Object.keys(state && state.topics || {}).sort();
  for (var i = 0; i < ids.length; i++) {
    var topic = state.topics[ids[i]];
    if (!topic || topic.status === "merged" || !topicContainsEvent(topic, storageId, eventIndex)) continue;
    addRef(refs, seen, topic.threadRef || topic.topicRef);
  }
}

function ingressThreadRefs(session, ingressId, topicIndex) {
  if (!session || !ingressId) return [];
  var refs = [];
  var seen = {};
  var queue = Array.isArray(session.pendingCoopIngress) ? session.pendingCoopIngress : [];
  for (var qi = 0; qi < queue.length; qi++) {
    if (queue[qi] && queue[qi].ingressId === ingressId) addStoredRefs(refs, seen, queue[qi]);
  }
  var history = Array.isArray(session.history) ? session.history : [];
  for (var hi = history.length - 1; hi >= 0; hi--) {
    var item = history[hi];
    if (!item || item.type !== "user_message" ||
        (item.coopIngressId !== ingressId && item.coopContinuationIngressId !== ingressId)) continue;
    addStoredRefs(refs, seen, item);
    addIndexedRefs(refs, seen, topicIndex,
      session.storageId || session.cliSessionId, hi);
    break;
  }
  return refs;
}

function queuedThreadRefs(session, topicIndex) {
  var refs = [];
  var seen = {};
  var queue = Array.isArray(session && session.pendingCoopIngress) ? session.pendingCoopIngress : [];
  for (var i = 0; i < queue.length; i++) {
    var ingressRefs = ingressThreadRefs(session, queue[i] && queue[i].ingressId, topicIndex);
    for (var ri = 0; ri < ingressRefs.length; ri++) addRef(refs, seen, ingressRefs[ri]);
  }
  return refs;
}

function clientAttribution(session, topicIndex) {
  var state = session && session.coopConversationIngress || {};
  return {
    activeThreadRefs: ingressThreadRefs(session, state.activeIngressId, topicIndex),
    queuedThreadRefs: queuedThreadRefs(session, topicIndex),
  };
}

module.exports = {
  clientAttribution: clientAttribution,
  ingressThreadRefs: ingressThreadRefs,
  queuedThreadRefs: queuedThreadRefs,
};
