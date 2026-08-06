// Module-scope so importers (e.g. cli-sessions.js rollout import) can map the
// raw synthetic prompt back to its display label when it surfaces in a Codex
// rollout — the rollout records what the MODEL received, not Clay's label.
var RESUME_AFTER_INTERRUPT_PROMPT = "Your previous response was interrupted by a connection or stream failure before it finished — this was not a user request to stop. Silently resume exactly where you left off and complete the interrupted work. Do not restart from scratch, do not re-ask the user for confirmation, and do not treat any error text as a new task.";
var RESUME_DISPLAY_LABEL = "↻ Resuming the interrupted response";

function attachBridgeRecovery(ctx) {
  var opts = ctx.opts;
  var resumeAfterInterruptPrompt = RESUME_AFTER_INTERRUPT_PROMPT;
  var resumeDisplayLabel = RESUME_DISPLAY_LABEL;
  var rateLimitResumeLabel = "↻ Continuing after rate limit";
  var maxConsecutiveAutoResumes = 5;

  function isTransientStreamError(errDetail) {
    if (!errDetail) return false;
    var errLower = String(errDetail).toLowerCase();
    return errLower.indexOf("socket connection was closed") !== -1
      || errLower.indexOf("econnreset") !== -1
      || errLower.indexOf("etimedout") !== -1
      || errLower.indexOf("econnrefused") !== -1
      || errLower.indexOf("fetch failed") !== -1
      || errLower.indexOf("network error") !== -1
      || errLower.indexOf("premature close") !== -1
      || errLower.indexOf("terminated") !== -1
      || errLower.indexOf("socket hang up") !== -1;
  }

  function autoResumeAllowed(session) {
    var execution = session && session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
    if (execution && execution.mode === "direct_leaf") return false;
    return (session._consecutiveAutoResumes || 0) < maxConsecutiveAutoResumes;
  }

  function scheduleInterruptResume(session) {
    session._consecutiveAutoResumes = (session._consecutiveAutoResumes || 0) + 1;
    session._transientRetryUsed = false;
    session.streamEndedAutoRetryQueued = false;
    opts.scheduleMessage(session, "continue", Date.now(), resumeAfterInterruptPrompt, resumeDisplayLabel, { autoAction: true });
  }

  return {
    isTransientStreamError: isTransientStreamError,
    autoResumeAllowed: autoResumeAllowed,
    scheduleInterruptResume: scheduleInterruptResume,
    rateLimitResumeLabel: rateLimitResumeLabel,
  };
}

module.exports = {
  attachBridgeRecovery: attachBridgeRecovery,
  RESUME_AFTER_INTERRUPT_PROMPT: RESUME_AFTER_INTERRUPT_PROMPT,
  RESUME_DISPLAY_LABEL: RESUME_DISPLAY_LABEL,
};
