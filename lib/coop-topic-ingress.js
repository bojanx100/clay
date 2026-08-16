// Canonical Coop Thread ingress is classified independently from execution.

var threadLifecycle = require("./coop-thread-lifecycle");
var threadIntent = require("./coop-thread-intent");

function prepareIngress(ctx, ws, msg, session) {
  var explicitTarget = !!(msg && (msg.coopThreadRef || msg.threadRef || msg.coopTopicRef || msg.topicRef));
  var parsedIntent = threadIntent.parse(msg && msg.text, { explicitTarget: explicitTarget });
  if (parsedIntent) msg.coopThreadIntent = parsedIntent;
  // Reopen and undo may intentionally address a retained closed Thread. The
  // route still has to carry the exact client-selected ref; Main never gets
  // this escape hatch because it has no explicit target.
  if (explicitTarget && parsedIntent && parsedIntent.kind !== "ambiguous") {
    msg.coopIncludeClosedThread = true;
  }
  var route = ctx.validateCoopTopicIngress ? ctx.validateCoopTopicIngress(session, msg, ws) : { ok: true };
  if (!route.ok) {
    if (ctx.coopControl && ctx.coopControl.isCoopConversation(session)) {
      ctx.coopControl.recordAttention(session, route.code || "topic_target_unavailable");
    }
    ctx.sendTo(ws, { type: "error", text: "The selected Coop Thread is unavailable. Coop did not fall back to another conversation or project." });
    return false;
  }
  if (route.topicRef) msg.coopTopicRef = route.topicRef;
  if (route.threadRef) msg.coopThreadRef = route.threadRef;
  if (route.threadTitle) msg.coopThreadTitle = route.threadTitle;
  if (route.threadState) msg.coopThreadState = route.threadState;
  if (route.projectRef) msg.coopProjectRef = route.projectRef;
  // The durable routing decision for the owner-request ledger. An explicitly
  // selected lens is a reuse by definition, so a route that did not classify
  // (the explicit-TopicRef branch) reads as existing_topic rather than blank.
  msg.coopClassification = route.classification ||
    (route.topicRef ? "existing_topic" : "conversational");
  msg.coopImplementationDecision = explicitTarget
    ? threadLifecycle.explicitImplementationDecision(msg.text) : null;
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
