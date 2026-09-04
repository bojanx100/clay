// Versioned cleanup for deterministic replay of derived topic memberships.

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function mergeTargets(topics) {
  var targets = {};
  var ids = Object.keys(topics || {});
  for (var i = 0; i < ids.length; i++) {
    var target = topicId(topics[ids[i]] && topics[ids[i]].mergedInto);
    if (target) targets[target] = true;
  }
  return targets;
}

function isLegacyOpaqueAutomatic(id, topic, targets) {
  return /^auto-[a-f0-9]{24}$/.test(id) && topic && topic.source === "automatic" &&
    topic.status === "open" && !targets[id] &&
    /^Automatic conversation [a-f0-9]{10}$/.test(String(topic.title || ""));
}

function prepareRetroUpgrade(index, version) {
  if (index.retro && index.retro.version === version) return false;
  var topics = index.topics || {};
  var targets = mergeTargets(topics);
  var ids = Object.keys(topics);
  for (var i = 0; i < ids.length; i++) {
    var topic = topics[ids[i]];
    if (isLegacyOpaqueAutomatic(ids[i], topic, targets)) {
      delete topics[ids[i]];
      continue;
    }
    if (!topic || topic.source !== "automatic") continue;
    // Only open automatic topics are re-derived by the retro extraction pass.
    // Closed and merged topics no longer accrete membership, so clearing their
    // refs here would empty them permanently and drop them out of Done/history.
    if (topic.status !== "open") continue;
    topic.eventRefs = [];
    topic.turnRefs = [];
  }
  index.retro = { version: version, completedEventCount: 0, bySession: {} };
  return true;
}

module.exports = { prepareRetroUpgrade: prepareRetroUpgrade };
