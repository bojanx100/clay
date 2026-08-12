// Query-stream cleanup and continuation scheduling, extracted so the stream
// event loop stays reviewable and below the server module size limit.

var handoffContext = require("./handoff-context");

function closeOwnedQuery(session, query) {
  var ownsTurn = session.queryInstance === query;
  try { if (typeof query.close === "function") query.close(); } catch (error) {}
  if (ownsTurn) session.queryInstance = null;
  return ownsTurn;
}

function clearPendingState(session, clearInteractiveToolWaits, ownsTurn) {
  session.messageQueue = null;
  session.taskStopRequested = false;
  session.steerInterruptRequested = false;
  session.pendingPermissions = {};
  var keepAskUser = {};
  for (var tid in session.pendingAskUser) {
    var pending = session.pendingAskUser[tid];
    if (pending && pending.mode === "mcp") keepAskUser[tid] = pending;
  }
  session.pendingAskUser = keepAskUser;
  session.pendingElicitations = {};
  session.pendingUserDialogs = {};
  clearInteractiveToolWaits(session);
  if (ownsTurn) {
    session.blocks = {};
    session.activeTaskToolIds = {};
    session.taskIdMap = {};
  }
}

function resetCopilotAfterHandoff(session, sm) {
  if (session.vendor === "github-copilot" && session.copilotResetAfterCurrentHandoffTurn &&
      !session.copilotHandoffNativeReset) {
    console.warn("[sdk-bridge] Dropping GitHub Copilot native session that received handoff transcript: " +
      (session.cliSessionId || "unknown"));
    session.cliSessionId = null;
    session.copilotHandoffNativeReset = true;
    session.copilotResetAfterCurrentHandoffTurn = false;
    try { sm.saveSessionFile(session); } catch (error) {}
    if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
  } else if (session.copilotResetAfterCurrentHandoffTurn) {
    session.copilotResetAfterCurrentHandoffTurn = false;
  }
}

function restoreFailedHandoff(session, sm, ownsTurn) {
  if (!ownsTurn || session._turnSawActivity || !session._handoffContextStash) return;
  if (handoffContext.restoreHandoffAfterFailedTurn(session)) {
    console.warn("[sdk-bridge] Restoring handoff context after failed post-switch turn for session " +
      session.localId);
    try { sm.saveSessionFile(session); } catch (error) {}
  }
}

function scheduleProviderFailure(input, enabled, failure) {
  var session = input.session;
  if (!failure || !enabled || session.destroying ||
      typeof input.opts.failoverAndContinue !== "function") return null;
  return !!input.opts.failoverAndContinue(session, failure);
}

function scheduleUsageCredits(input, enabled) {
  var session = input.session;
  if (!session.rateLimitUseCreditsPending || !enabled || session.destroying) return null;
  session.rateLimitUseCreditsPending = false;
  session.rateLimitAutoContinuePending = true;
  console.log("[sdk-bridge] Rate limited with usage credits available, continuing immediately for session " +
    session.localId);
  if (typeof input.opts.continueWithUsageCredits === "function") {
    input.opts.continueWithUsageCredits(session, "continue", null, "↻ Continuing with usage credits");
  }
  return true;
}

function scheduleRateLimit(input, enabled) {
  var session = input.session;
  if (!session.rateLimitResetsAt || session.rateLimitResetsAt <= Date.now() || !enabled ||
      session.destroying) return null;
  var resetsAt = session.rateLimitResetsAt;
  session.rateLimitResetsAt = null;
  session.rateLimitAutoContinuePending = true;
  console.log("[sdk-bridge] Rate limited, scheduling auto-continue via scheduleMessage for session " +
    session.localId);
  if (typeof input.opts.scheduleMessage === "function") {
    input.opts.scheduleMessage(session, "continue", resetsAt, null, input.rateLimitResumeLabel);
  }
  return true;
}

function scheduleContinuation(input) {
  var session = input.session;
  var opts = input.opts;
  var acEnabled = session.onQueryComplete ||
    (typeof opts.getAutoContinueSetting === "function" && opts.getAutoContinueSetting(session));
  var pendingFailure = session.providerFailoverPending || null;
  session.providerFailoverPending = null;
  var scheduled = scheduleProviderFailure(input, acEnabled, pendingFailure);
  if (scheduled === null) scheduled = scheduleUsageCredits(input, acEnabled);
  if (scheduled === null) scheduled = scheduleRateLimit(input, acEnabled);
  if (scheduled === null && acEnabled && !session.destroying && !session._providerFailoverClosing) {
    console.log("[sdk-bridge] Query done, auto-continue enabled but not scheduled: rateLimitResetsAt=" +
      session.rateLimitResetsAt + " (will rely on late rate_limit_event handler)");
  }
  return { pendingFailure: pendingFailure, scheduled: scheduled === true };
}

function finishCallbacks(input, continuation) {
  var session = input.session;
  if (session.onQueryComplete && !continuation.scheduled && !continuation.pendingFailure &&
      !session._providerFailoverClosing) {
    console.log("[sdk-bridge] Calling onQueryComplete for session " + session.localId +
      " (title: " + (session.title || "?") + ")");
    try { session.onQueryComplete(session); }
    catch (error) { console.error("[sdk-bridge] onQueryComplete error:", error.message || error); }
  }
  if (!session.destroying && typeof input.opts.reconcileQueuedUserMessages === "function") {
    try { input.opts.reconcileQueuedUserMessages(session); } catch (error) {}
  }
}

function finalizeStream(input) {
  var session = input.session;
  var fencedOut = input.fencedOut ||
    (input.controlledFence && !input.controlledFence.isCurrent("callback"));
  if (fencedOut) {
    closeOwnedQuery(session, input.query);
    if (session.abortController === input.abortController) session.abortController = null;
    return;
  }
  var ownsTurn = closeOwnedQuery(session, input.query);
  if (session.abortController === input.abortController) session.abortController = null;
  clearPendingState(session, input.clearInteractiveToolWaits, ownsTurn);
  resetCopilotAfterHandoff(session, input.sm);
  restoreFailedHandoff(session, input.sm, ownsTurn);
  session.isProcessing = false;
  if (ownsTurn && !session._turnDoneSent && !session.destroying) {
    console.warn("[sdk-bridge] Turn for session " + session.localId +
      " ended without a terminal event; emitting safety-net done.");
    input.sendAndRecord(session, { type: "done", code: 0 });
    if (typeof input.sm.broadcastSessionList === "function") input.sm.broadcastSessionList();
  }
  finishCallbacks(input, scheduleContinuation(input));
}

module.exports = { finalizeStream: finalizeStream };
