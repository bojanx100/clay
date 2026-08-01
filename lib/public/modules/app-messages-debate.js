import { store } from './store.js';
import { showToast } from './utils.js';
import { showDebateSticky, showDebateConcludeConfirm, showDebateUserFloor, updateDebateRound, renderDebateUserFloorDone, setDebatePauseState } from './app-debate-ui.js';
import { handleDebatePreparing, handleDebateBriefReady, renderDebateBriefReady, handleDebateStarted, renderDebateStarted, handleDebateTurn, handleDebateActivity, handleDebateStream, handleDebateTurnDone, handleDebateCommentQueued, handleDebateCommentInjected, renderDebateCommentInjected, handleDebateResumed, handleDebateEnded, renderDebateEnded, handleDebateError, renderDebateUserResume, renderDebateConclusion } from './debate.js';

export function handleDebateMessage(msg) {
  switch (msg.type) {
    case "debate_preparing":
      if (!store.get('replayingHistory')) showDebateSticky("preparing", msg);
      handleDebatePreparing(msg);
      return true;

    case "debate_brief_ready":
      if (store.get('replayingHistory')) {
        renderDebateBriefReady(msg);
      } else {
        handleDebateBriefReady(msg);
      }
      return true;

    case "debate_started":
      if (!store.get('replayingHistory')) showDebateSticky("live", msg);
      if (store.get('replayingHistory')) {
        renderDebateStarted(msg);
      } else {
        handleDebateStarted(msg);
      }
      return true;

    case "debate_turn":
      handleDebateTurn(msg);
      if (msg.round) updateDebateRound(msg.round);
      return true;

    case "debate_activity":
      handleDebateActivity(msg);
      return true;

    case "debate_stream":
      handleDebateStream(msg);
      return true;

    case "debate_turn_done":
      if (msg.round) updateDebateRound(msg.round);
      handleDebateTurnDone(msg);
      return true;

    case "debate_hand_raised":
      return true;

    case "debate_comment_queued":
      handleDebateCommentQueued(msg);
      return true;

    case "debate_comment_injected":
      if (store.get('replayingHistory')) {
        renderDebateCommentInjected(msg);
      } else {
        handleDebateCommentInjected(msg);
      }
      return true;

    case "debate_conclude_confirm":
      if (!store.get('replayingHistory')) showDebateConcludeConfirm(msg);
      return true;

    case "debate_user_floor":
      if (!store.get('replayingHistory')) showDebateUserFloor(msg);
      return true;

    case "debate_user_floor_done":
      renderDebateUserFloorDone(msg);
      return true;

    case "debate_user_resume":
      renderDebateUserResume(msg);
      return true;

    case "debate_resumed":
      handleDebateResumed(msg);
      if (!store.get('replayingHistory')) showDebateSticky("live", msg);
      return true;

    case "debate_ended":
      if (!store.get('replayingHistory')) showDebateSticky("ended", msg);
      if (store.get('replayingHistory')) {
        renderDebateEnded(msg);
      } else {
        handleDebateEnded(msg);
      }
      return true;

    case "debate_pause_state":
      if (!store.get('replayingHistory')) setDebatePauseState(msg.paused, msg.holding);
      return true;

    case "debate_conclusion":
      renderDebateConclusion(msg);
      return true;

    case "debate_error":
      handleDebateError(msg);
      if (msg.error) showToast("Debate: " + msg.error, "error");
      return true;

    default:
      return false;
  }
}
