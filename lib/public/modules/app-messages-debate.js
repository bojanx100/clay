import { store } from './store.js';
import { showToast } from './utils.js';
import { showDebateSticky, showDebateConcludeConfirm, showDebateUserFloor, updateDebateRound, renderDebateUserFloorDone, setDebatePauseState, showDebateEndedMode, exitDebateEndedMode } from './app-debate-ui.js';
import { handleDebatePreparing, handleDebateBriefReady, renderDebateBriefReady, handleDebateStarted, renderDebateStarted, handleDebateTurn, handleDebateActivity, handleDebateStream, handleDebateTurnDone, handleDebateCommentQueued, handleDebateCommentInjected, renderDebateCommentInjected, handleDebateResumed, handleDebateEnded, renderDebateEnded, handleDebateError, renderDebateUserResume, renderDebateConclusion, renderMcpDebateProposal } from './debate.js';
import { dispatchDebateMessage, routeDebateHistory, routeDebateLive } from './app-messages-debate-handlers.js';

function isReplayingHistory() {
  return !!store.get('replayingHistory');
}

function handleDebatePreparingMessage(msg) {
  if (!isReplayingHistory()) showDebateSticky("preparing", msg);
  handleDebatePreparing(msg);
}

function handleDebateBriefReadyMessage(msg) {
  routeDebateHistory(msg, isReplayingHistory(), renderDebateBriefReady, handleDebateBriefReady);
}

function handleDebateStartedMessage(msg) {
  if (!isReplayingHistory()) showDebateSticky("live", msg);
  routeDebateHistory(msg, isReplayingHistory(), renderDebateStarted, handleDebateStarted);
}

function handleDebateTurnMessage(msg) {
  handleDebateTurn(msg);
  if (msg.round) updateDebateRound(msg.round);
}

function handleDebateTurnDoneMessage(msg) {
  if (msg.round) updateDebateRound(msg.round);
  handleDebateTurnDone(msg);
}

function handleDebateCommentInjectedMessage(msg) {
  routeDebateHistory(msg, isReplayingHistory(), renderDebateCommentInjected, handleDebateCommentInjected);
}

function handleDebateResumedMessage(msg) {
  handleDebateResumed(msg);
  if (isReplayingHistory()) exitDebateEndedMode();
  if (!isReplayingHistory()) showDebateSticky("live", msg);
}

function handleDebateEndedMessage(msg) {
  if (!isReplayingHistory()) showDebateSticky("ended", msg);
  routeDebateHistory(msg, isReplayingHistory(), function (replayMsg) {
    renderDebateEnded(replayMsg);
    showDebateEndedMode(replayMsg);
  }, handleDebateEnded);
}

function handleDebateConcludeConfirmMessage(msg) {
  routeDebateLive(msg, isReplayingHistory(), showDebateConcludeConfirm);
}

function handleDebateUserFloorMessage(msg) {
  routeDebateLive(msg, isReplayingHistory(), showDebateUserFloor);
}

function handleDebatePauseStateMessage(msg) {
  routeDebateLive(msg, isReplayingHistory(), function (liveMsg) {
    setDebatePauseState(liveMsg.paused, liveMsg.holding);
  });
}

function handleDebateProposalPendingMessage(msg) {
  // Server re-sends still-pending proposals on (re)connect (F-7); the
  // renderer dedupes by proposalId.
  if (msg.briefData) renderMcpDebateProposal(msg.briefData.proposalId || null, msg.briefData);
}

function handleDebateErrorMessage(msg) {
  handleDebateError(msg);
  if (msg.error) showToast("Debate: " + msg.error, "error");
}

var debateMessageHandlers = {
  debate_preparing: handleDebatePreparingMessage,
  debate_brief_ready: handleDebateBriefReadyMessage,
  debate_started: handleDebateStartedMessage,
  debate_turn: handleDebateTurnMessage,
  debate_activity: handleDebateActivity,
  debate_stream: handleDebateStream,
  debate_turn_done: handleDebateTurnDoneMessage,
  debate_hand_raised: function () {},
  debate_comment_queued: handleDebateCommentQueued,
  debate_comment_injected: handleDebateCommentInjectedMessage,
  debate_conclude_confirm: handleDebateConcludeConfirmMessage,
  debate_user_floor: handleDebateUserFloorMessage,
  debate_user_floor_done: renderDebateUserFloorDone,
  debate_user_resume: renderDebateUserResume,
  debate_resumed: handleDebateResumedMessage,
  debate_ended: handleDebateEndedMessage,
  debate_pause_state: handleDebatePauseStateMessage,
  debate_proposal_pending: handleDebateProposalPendingMessage,
  debate_conclusion: renderDebateConclusion,
  debate_error: handleDebateErrorMessage,
};

export function handleDebateMessage(msg) {
  return dispatchDebateMessage(msg, debateMessageHandlers);
}
