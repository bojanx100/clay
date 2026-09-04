import { store } from './store.js';
import { topicRefKey } from './sidebar-coop-topic-model.js';
import { getWs, sendWsJson } from './ws-ref.js';
import { globalProjectRefKey, requestRecoveredMainCoopLens } from './global-coop-projection.js';
import { createMainAuthorityDisclosureProjector } from './coop-lens-relevance.js';

var TOPIC_STREAM_TYPES = {
  user_message: true,
  message_uuid: true,
  plan_content: true,
  context_preview: true,
  status: true,
  compacting: true,
  thinking_start: true,
  thinking_delta: true,
  thinking_stop: true,
  delta: true,
  delta_replace: true,
  result: true,
  context_usage: true,
  done: true,
  stderr: true,
  error: true,
  system_info: true,
  sdk_notification: true,
  thinking_tokens: true,
  informational: true,
  permission_denied: true,
  model_refusal: true,
  process_conflict: true,
  context_overflow: true,
  auth_required: true,
  process_killed: true,
};

var mainAuthorityDisclosureProjector = createMainAuthorityDisclosureProjector();

// Main replay is projected on the server. This applies the same projection to
// live assistant stream records before rendering; All and Topic lenses retain
// their original transcript text.
export function projectMainCoopStreamMessage(msg) {
  if (!store.get("activeCoopHome") || store.get("activeCoopLensScope") !== "main" ||
      store.get("replayingHistory")) {
    mainAuthorityDisclosureProjector.reset();
    return msg;
  }
  return mainAuthorityDisclosureProjector.project(msg);
}

function activeTopicKey() {
  return topicRefKey(store.get('activeCoopTopicRef') ||
    (store.get('activeCoopLens') || {}).topicRef);
}

function incomingTopicKey(msg) {
  return topicRefKey(msg && (msg.coopTopicRef || msg.topicRef));
}

export function resetCoopTopicLiveTurn(visible) {
  store.set({ coopTopicLiveTurnVisible: typeof visible === "boolean" ? visible : null });
}

export function refreshCoopTopicsAfterLiveTurn() {
  if (!store.get('activeCoopHome') || store.get('replayingHistory')) return false;
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify({ type: "coop_topic_projection_request" }));
  return true;
}

// A typed owner-decision stage is the only exception to the normal rule that
// hides automated Lead ticks inside a selected Topic. The server sends this
// only after persisting an exact decision scope and response-turn link, so it
// cannot turn arbitrary assistant prose into a visible owner request.
export function handleCoopOwnerDecisionStaged(msg) {
  if (!msg || msg.type !== "coop_owner_decision_staged" ||
      !store.get("activeCoopHome") || store.get("replayingHistory")) return false;
  var selected = activeTopicKey();
  var staged = incomingTopicKey(msg);
  if (!selected || selected !== staged) return true;
  resetCoopTopicLiveTurn(true);
  return true;
}

// A send can race a Thread close, merge, or projection change after the client
// captured its exact destination. Recover only when the rejection still names
// the committed lens. A delayed rejection must never replace a newer selection.
export function recoverRejectedCoopIngress(topicRef, projectRef, send) {
  if (!store.get("activeCoopHome") || store.get("pendingCoopSelection")) return false;
  var rejectedTopic = topicRefKey(topicRef);
  var rejectedProject = globalProjectRefKey(projectRef);
  if (!rejectedTopic && !rejectedProject) return false;
  var lens = store.get("activeCoopLens") || {};
  var activeTopic = topicRefKey(store.get("activeCoopTopicRef") || lens.topicRef);
  var activeProject = globalProjectRefKey(store.get("activeCoopProjectRef") || lens.projectRef);
  if (rejectedTopic ? activeTopic !== rejectedTopic : !!activeTopic) return false;
  if (rejectedProject && activeProject !== rejectedProject) return false;
  store.set({ activeCoopTopicStale: true });
  return requestRecoveredMainCoopLens(send);
}

export function handleRejectedCoopIngress(msg) {
  if (!msg || !msg.recoverCoopMain) return false;
  var topicRef = msg.coopTopicRef || msg.topicRef || msg.coopThreadRef || msg.threadRef || null;
  var recovered = recoverRejectedCoopIngress(topicRef,
    msg.coopProjectRef || msg.projectRef || null, function (message) {
    return sendWsJson(message);
  });
  if (!recovered) return false;
  if (msg.retryDraft && typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(new CustomEvent("clay:restore-input-draft", {
      detail: msg.retryDraft,
    }));
  }
  return true;
}

export function shouldSuppressCoopTopicStream(msg) {
  if (!msg || !TOPIC_STREAM_TYPES[msg.type] || store.get('replayingHistory')) return false;
  var selected = store.get('activeCoopHome') ? activeTopicKey() : "";
  if (!selected) {
    if (msg.type === "done" || msg.type === "user_message") resetCoopTopicLiveTurn();
    return false;
  }
  if (msg.type === "user_message") {
    var visible = incomingTopicKey(msg) === selected;
    resetCoopTopicLiveTurn(visible);
    return !visible;
  }
  var suppress = store.get('coopTopicLiveTurnVisible') === false;
  if (msg.type === "done") resetCoopTopicLiveTurn();
  return suppress;
}
