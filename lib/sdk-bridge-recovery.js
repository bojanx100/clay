function attachBridgeRecovery(ctx) {
  var opts = ctx.opts;
  var resumeAfterInterruptPrompt = "Your previous response was interrupted by a connection or stream failure before it finished — this was not a user request to stop. Silently resume exactly where you left off and complete the interrupted work. Do not restart from scratch, do not re-ask the user for confirmation, and do not treat any error text as a new task.";
  var resumeDisplayLabel = "↻ Resuming the interrupted response";
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

module.exports = { attachBridgeRecovery: attachBridgeRecovery };
