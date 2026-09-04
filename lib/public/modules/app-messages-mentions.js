import { showToast } from './utils.js';
import { setMentionActive } from './sidebar-mates.js';
import { updateCrossProjectBlink } from './app-favicon.js';
import { finalizeAssistantBlock } from './app-rendering.js';
import { handleMentionStart, handleMentionActivity, handleMentionStream, handleMentionDone, handleMentionError, renderMentionUser, renderMentionResponse, renderUserMention } from './mention.js';

export function handleMentionMessage(msg) {
  switch (msg.type) {
    case "mention_processing":
      if (msg.mateId) {
        setMentionActive(msg.mateId, msg.active);
        var mateContainers = document.querySelectorAll('.icon-strip-mate[data-user-id="' + msg.mateId + '"]');
        for (var mi = 0; mi < mateContainers.length; mi++) {
          var dot = mateContainers[mi].querySelector(".icon-strip-status");
          if (msg.active) {
            if (dot) dot.classList.add("processing");
            mateContainers[mi].classList.add("mention-active");
          } else {
            if (dot) dot.classList.remove("processing");
            mateContainers[mi].classList.remove("mention-active");
          }
        }
        updateCrossProjectBlink();
      }
      return true;

    case "mention_start":
      handleMentionStart(msg);
      return true;

    case "mention_activity":
      handleMentionActivity(msg);
      return true;

    case "mention_stream":
      handleMentionStream(msg);
      return true;

    case "mention_done":
      handleMentionDone(msg);
      return true;

    case "mention_error":
      handleMentionError(msg);
      if (msg.error) showToast("@Mention: " + msg.error, "error");
      return true;

    case "mention_user":
      finalizeAssistantBlock();
      renderMentionUser(msg);
      return true;

    case "mention_response":
      finalizeAssistantBlock();
      renderMentionResponse(msg);
      return true;

    case "user_mention":
      finalizeAssistantBlock();
      renderUserMention(msg);
      return true;

    case "user_mention_error":
      if (msg.error) showToast("@Mention: " + msg.error, "error");
      return true;

    default:
      return false;
  }
}
