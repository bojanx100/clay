// Canonical Coop Thread ingress is classified independently from execution.

var threadLifecycle = require("./coop-thread-lifecycle");
var threadIntent = require("./coop-thread-intent");
var itemApproval = require("./coop-item-approval");
var hasOwn = Object.prototype.hasOwnProperty;

var COMPOSER_SCOPES = {
  canonical: true,
  main: true,
  project: true,
  topic: true,
};

function hasTopicRef(msg) {
  return !!(msg && (msg.coopThreadRef || msg.threadRef || msg.coopTopicRef || msg.topicRef));
}

function hasProjectRef(msg) {
  return !!(msg && (msg.coopProjectRef || msg.projectRef));
}

function clearRouteRefs(msg) {
  delete msg.coopThreadRef;
  delete msg.threadRef;
  delete msg.coopTopicRef;
  delete msg.topicRef;
  delete msg.coopProjectRef;
  delete msg.projectRef;
}

function clearDerivedRouteFields(msg) {
  delete msg.coopThreadTitle;
  delete msg.coopThreadState;
  delete msg.coopTopicAnchor;
  delete msg.coopClassification;
  delete msg.coopThreadIntent;
  delete msg.coopThreadControlResult;
  delete msg.coopImplementationDecision;
  delete msg.coopIncludeClosedThread;
  delete msg.coopContextualThreadTarget;
}

// The composer records its visible lens at send time. For Main and All that
// scope wins over every ref in the packet: an old client-state ref is never a
// valid reason to attach a general conversation message to a Thread.
function normalizeComposerScope(msg, session) {
  if (!session || !session.coopHome) return { ok: true, scope: null, unscoped: false };
  if (!hasOwn.call(msg || {}, "coopComposerScope") ||
      !hasOwn.call(COMPOSER_SCOPES, msg.coopComposerScope)) {
    return { ok: false, code: "composer_scope_required" };
  }
  var replyAnchor = msg && msg.coopTopicAnchor || null;
  clearDerivedRouteFields(msg);
  var scope = msg.coopComposerScope;
  if (scope === "main" || scope === "canonical") {
    clearRouteRefs(msg);
    var unscoped = { ok: true, scope: scope, unscoped: true };
    if (replyAnchor) unscoped.replyAnchor = replyAnchor;
    return unscoped;
  }
  if (scope === "topic" && !hasTopicRef(msg)) return { ok: false, code: "composer_thread_required" };
  if (scope === "project" && (!hasProjectRef(msg) || hasTopicRef(msg))) {
    return { ok: false, code: "composer_project_scope_invalid" };
  }
  var selected = { ok: true, scope: scope, unscoped: false };
  if (replyAnchor) selected.replyAnchor = replyAnchor;
  return selected;
}

function prepareIngress(ctx, ws, msg, session) {
  var scope = normalizeComposerScope(msg, session);
  if (!scope.ok) {
    ctx.sendTo(ws, { type: "error", text: "The Coop composer scope is unavailable. Reload the conversation before sending." });
    return false;
  }
  var explicitTarget = hasTopicRef(msg);
  if (!explicitTarget && scope.unscoped && threadIntent.isControlShaped(msg && msg.text) &&
      typeof ctx.resolveCoopThreadIntentTarget === "function") {
    var contextualTarget = ctx.resolveCoopThreadIntentTarget(session, {
      replyAnchor: scope.replyAnchor || null,
    });
    if (contextualTarget && contextualTarget.ok) {
      msg.coopThreadRef = contextualTarget.threadRef;
      msg.coopTopicRef = contextualTarget.topicRef;
      if (contextualTarget.projectRef) msg.coopProjectRef = contextualTarget.projectRef;
      msg.coopContextualThreadTarget = true;
      explicitTarget = true;
    }
  }
  var parsedIntent = threadIntent.parse(msg && msg.text, { explicitTarget: explicitTarget });
  if (parsedIntent) msg.coopThreadIntent = parsedIntent;
  // Reopen and undo may intentionally address a retained closed Thread. That
  // escape hatch still requires an explicitly selected ref: contextual Main
  // resolution considers open Threads only, even though it also produces a
  // concrete target before this check.
  if (explicitTarget && parsedIntent && parsedIntent.kind !== "ambiguous") {
    msg.coopIncludeClosedThread = true;
  }
  var route = ctx.validateCoopTopicIngress ? ctx.validateCoopTopicIngress(session, msg, ws) : { ok: true };
  delete msg.coopContextualThreadTarget;
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
  // A fully qualified named item approval is not a conversational turn merely
  // because it began in Main. It still receives no broad implementation
  // decision here: the item-approval boundary later replays each exact task,
  // ProjectRef and revision before admitting anything. This classification only
  // keeps the canonical owner ingress discoverable for that typed boundary.
  var exactItemApprovals = itemApproval.explicitItemApprovals(msg.text);
  msg.coopClassification = route.classification ||
    (route.topicRef || exactItemApprovals.length ? "existing_topic" : "conversational");
  // Main is intentionally route-free, but an explicit owner command there is
  // still an implementation decision. The typed delegation that follows will
  // bind this ingress to one exact project/topic/task scope before admission.
  msg.coopImplementationDecision = explicitTarget || scope.unscoped
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
  normalizeComposerScope: normalizeComposerScope,
  prepareIngress: prepareIngress,
};
