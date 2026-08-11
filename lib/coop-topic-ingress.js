// Canonical Coop TopicRef ingress is explicit and validated per message.

function prepareIngress(ctx, ws, msg, session) {
  var route = ctx.validateCoopTopicIngress ? ctx.validateCoopTopicIngress(session, msg, ws) : { ok: true };
  if (!route.ok) {
    if (ctx.coopControl && ctx.coopControl.isCoopConversation(session)) {
      ctx.coopControl.recordAttention(session, route.code || "topic_target_unavailable");
    }
    ctx.sendTo(ws, { type: "error", text: "The selected Coop topic target is unavailable. Coop did not fall back to another conversation or project." });
    return false;
  }
  if (route.topicRef) msg.coopTopicRef = route.topicRef;
  if (route.projectRef) msg.coopProjectRef = route.projectRef;
  // The logical parent inside the routed topic, resolved before the message is
  // appended so it names the topic's state as the owner saw it when sending.
  // Absent when the topic has nothing owner-relevant to reply to yet -- never
  // substituted with the canonical tail, which belongs to another conversation.
  if (route.topicAnchor) msg.coopTopicAnchor = route.topicAnchor;
  return true;
}

// Claims the just-appended canonical event for the routed topic. Called with
// the event's own index, immediately after the push, so the topic lens contains
// the owner's message without waiting for post-`done` extraction. Append-only:
// this adds one membership reference and rewrites no history.
function bindMessage(ctx, session, msg, eventIndex) {
  if (typeof ctx.bindCoopTopicMessage !== "function") return false;
  return ctx.bindCoopTopicMessage(session, msg, eventIndex);
}

module.exports = {
  bindMessage: bindMessage,
  prepareIngress: prepareIngress,
};
