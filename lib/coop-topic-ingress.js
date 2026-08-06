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
  return true;
}

module.exports = {
  prepareIngress: prepareIngress,
};
