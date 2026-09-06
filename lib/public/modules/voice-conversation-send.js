// Use the normal authenticated message/queue protocol, without modifying the
// typed draft, attaching staged files, or parsing speech as composer commands.
import { store } from './store.js';
import { sendWsJson } from './ws-ref.js';
import { isCurrentVoiceConversationRouting } from './voice-conversation-routing.js';

export function sendVoiceText(text, routing, clientMessageId) {
  if (!store.get("connected") || !isCurrentVoiceConversationRouting(routing) ||
      typeof text !== "string" || !text.trim() || !clientMessageId) return false;
  var payload = {
    type: "message", text: text.trim(), intent: "chat", ingressType: "voice",
    clientMessageId: clientMessageId, sessionId: routing.sessionId,
  };
  if (routing.canonicalCoop) {
    payload.coopComposerScope = routing.scope;
    if (routing.topicRef) payload.coopTopicRef = routing.topicRef;
    if (routing.projectRef) payload.coopProjectRef = routing.projectRef;
  }
  if (store.get("currentVendor")) payload.vendor = store.get("currentVendor");
  return sendWsJson(payload);
}
