// Compatibility shim for the retired explicit Thread decision surface.
// Lifecycle commands are ordinary owner messages; this module intentionally
// creates no DOM and sends no action payloads.

function topicIdOf(ref) {
  if (!ref) return "";
  return String(ref.topicId || ref.topicKey || ref.id || ref.key || "").trim();
}

export function topicActionItems(topic, items) {
  var wanted = topicIdOf(topic && topic.topicRef);
  var list = Array.isArray(items) ? items : [];
  return list.filter(function (item) {
    return topicIdOf(item && item.topicRef) === wanted;
  });
}

export function buildTopicDecisionSurface() {
  return null;
}

export function renderCoopTopicDecisionSurface() {
  var host = typeof document !== "undefined" ? document.getElementById("coop-topic-decision") : null;
  if (host && host.parentNode) host.parentNode.removeChild(host);
  return false;
}
