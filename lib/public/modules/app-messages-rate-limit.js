import { store } from './store.js';
import { setStatus } from './app-connection.js';
import { addSystemMessage, showSuggestionChips } from './app-rendering.js';
import { setScheduleBtnDisabled } from './input.js';
import { handleRateLimitEvent, updateRateLimitUsage, addScheduledMessageBubble, removeScheduledMessageBubble, handleFastModeState } from './app-rate-limit.js';

export function handleRateLimitMessage(msg) {
  switch (msg.type) {
    case "rate_limit":
      if (!store.get('replayingHistory')) handleRateLimitEvent(msg);
      if (!store.get('replayingHistory') && msg.status === "rejected") {
        if (msg.isUsingOverage) {
          addSystemMessage("Rate limited. Clay is continuing with available usage credits.", false);
        } else {
          addSystemMessage("Rate limited. Check usage credits or wait for the provider to allow another request.", false);
        }
      }
      return true;

    case "rate_limit_usage":
      updateRateLimitUsage(msg);
      return true;

    case "scheduled_message_queued":
      addScheduledMessageBubble(msg.text, msg.resetsAt);
      setScheduleBtnDisabled(true);
      return true;

    case "scheduled_message_sent":
      removeScheduledMessageBubble();
      setScheduleBtnDisabled(false);
      setStatus("processing");
      return true;

    case "scheduled_message_cancelled":
      removeScheduledMessageBubble();
      setScheduleBtnDisabled(false);
      return true;

    case "auto_continue_scheduled":
      return true;

    case "auto_continue_fired":
      setStatus("processing");
      return true;

    case "prompt_suggestion":
      showSuggestionChips(msg.suggestion);
      return true;

    case "fast_mode_state":
      handleFastModeState(msg.state);
      return true;

    default:
      return false;
  }
}
