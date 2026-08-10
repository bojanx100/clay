// The canonical Coop TopicRef normalizer, and nothing else.
//
// Deliberately a LEAF: no requires, no state, no I/O. Every layer that has to
// recognise a topic reference shares this one definition -- the orchestration
// task graph, the tool handlers, and the durable portfolio execution binding
// store -- so the reference-only shape cannot drift between them.
//
// It lives alone precisely because of who needs it. The normalizer first sat in
// orchestration-task-graph.js, which meant the durable binding store had to
// require the orchestration graph to validate a two-field object, transitively
// pulling coop-work-activity and the whole eleven-module topic subsystem into a
// low-level persistence layer. That is backwards layering: a store that owns
// idempotency and tombstones must not depend on the graph that happens to be its
// busiest caller. A leaf module inverts it -- both sides depend on this, and
// neither depends on the other.

// Reference-only, like every other canonical ref: an id and nothing else, so a
// task or binding record can never carry topic content. The aliases are accepted
// because callers across the client, MCP and automation surfaces have all named
// this field differently over time; the OUTPUT is always exactly { topicId }.
function normalizeTopicRefInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var topicId = String(value.topicId || value.topicKey || value.id || value.key || "").trim();
  return topicId ? { topicId: topicId } : null;
}

module.exports = {
  normalizeTopicRefInput: normalizeTopicRefInput,
};
