import { store } from './store.js';
import { topicRefKey } from './sidebar-coop-topic-model.js';
import { getWs } from './ws-ref.js';

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
