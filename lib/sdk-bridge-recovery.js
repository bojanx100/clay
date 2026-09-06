// Module-scope so importers (e.g. cli-sessions.js rollout import) can map the
// raw synthetic prompt back to its display label when it surfaces in a Codex
// rollout — the rollout records what the MODEL received, not Clay's label.
var RESUME_AFTER_INTERRUPT_PROMPT = "Your previous response was interrupted by a connection or stream failure before it finished — this was not a user request to stop. Silently resume exactly where you left off and complete the interrupted work. Do not restart from scratch, do not re-ask the user for confirmation, and do not treat any error text as a new task.";
var RESUME_DISPLAY_LABEL = "↻ Resuming the interrupted response";
var streamPolicy = require("./sdk-bridge-stream-policy");

function attachBridgeRecovery(ctx) {
  var opts = ctx.opts;
  var resumeAfterInterruptPrompt = RESUME_AFTER_INTERRUPT_PROMPT;
  var resumeDisplayLabel = RESUME_DISPLAY_LABEL;
  var rateLimitResumeLabel = "↻ Continuing after rate limit";
  var maxConsecutiveAutoResumes = 5;

  // Connectivity failures that a single retry usually clears. These must never
  // be mistaken for a provider outage: they carry no reset time, so treating
  // one as a hard provider failure sends the session down the rate-limit
  // scheduling path and parks it for hours.
  //
  // The "stream disconnected" / "error sending request for url" pair is what
  // the Codex CLI emits once its own internal reconnect ladder
  // ("Reconnecting... 5/5") gives up against chatgpt.com/backend-api.
  var TRANSIENT_STREAM_ERROR_MARKERS = [
    "socket connection was closed",
    "econnreset",
    "etimedout",
    "econnrefused",
    "fetch failed",
    "network error",
    "premature close",
    "terminated",
    "socket hang up",
    "stream disconnected",
    "error sending request",
    "connection closed before message completed",
  ];

  function isTransientStreamError(errDetail) {
    if (!errDetail) return false;
    var errLower = String(errDetail).toLowerCase();
    if (streamPolicy.isSessionResumeBusyError(errLower)) return true;
    for (var i = 0; i < TRANSIENT_STREAM_ERROR_MARKERS.length; i++) {
      if (errLower.indexOf(TRANSIENT_STREAM_ERROR_MARKERS[i]) !== -1) return true;
    }
    return false;
  }

  function autoResumeAllowed(session) {
    if (session.contextRecovery) return false;
    if (require("./project-coordinator-update-state").hasPendingCoordinatorReports(session)) return false;
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
