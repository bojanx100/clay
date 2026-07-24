var usersModule = require("./users");
var { automationForClaudePermission } = require("./automation-modes");
var { recordRecoveryEvent } = require("./recovery-log");
var { recordProviderFailure, queuePendingProviderFailover } = require("./sdk-provider-failover-signals");

// Reasoning models can stay silent for 30-60s+, so every vendor gets a 120s
// mid-generation watchdog. First-event and active-tool waits use separate budgets.
//
// Silent-reasoning stretches keep outgrowing any fixed budget (30s killed
// healthy claude/codex turns in 2026-07-03/07; 120s killed five healthy codex
// turns in a row on 2026-07-24, session 298 — silentMs 122-125s each cycle,
// the documented resume-loop signature in DIAGNOSTICS.md). So instead of
// raising the constant again, the budget DOUBLES with each consecutive
// watchdog auto-resume in the same stall episode, capped at the tool budget.
// First detection stays fast; a resume loop self-extinguishes. A genuine user
// message or real turn activity resets _consecutiveAutoResumes and with it
// the budget.
var STREAM_MIDSTREAM_TIMEOUT_MS = 120 * 1000;
var STREAM_MIDSTREAM_TIMEOUT_CODEX_MS = 120 * 1000;
var STREAM_TOOL_TIMEOUT_MS = 10 * 60 * 1000;
var STREAM_FIRST_EVENT_TIMEOUT_MS = 45 * 1000;

function midstreamTimeoutFor(vendor, consecutiveAutoResumes) {
  var base = vendor === "codex" ? STREAM_MIDSTREAM_TIMEOUT_CODEX_MS : STREAM_MIDSTREAM_TIMEOUT_MS;
  var n = Math.min(consecutiveAutoResumes || 0, 3);
  var scaled = base * Math.pow(2, n);
  return Math.min(scaled, STREAM_TOOL_TIMEOUT_MS);
}

function hasInteractiveToolWaits(session) {
  return !!(session && session.interactiveToolWaits
    && Object.keys(session.interactiveToolWaits).length > 0);
}

function clearInteractiveToolWaits(session) {
  if (session) session.interactiveToolWaits = {};
}

function watchdogTimeoutFor(session, activeToolCount, sawAnyEvent, vendor) {
  return activeToolCount > 0 || hasInteractiveToolWaits(session)
    ? STREAM_TOOL_TIMEOUT_MS
    : (sawAnyEvent
      ? midstreamTimeoutFor(vendor, session && session._consecutiveAutoResumes)
      : STREAM_FIRST_EVENT_TIMEOUT_MS);
}

// Context overflow can be thrown or streamed; both paths share this classifier.
function isContextOverflowError(text) {
  if (!text) return false;
  var t = String(text).toLowerCase();
  return t.indexOf("prompt is too long") !== -1
    || t.indexOf("context_length") !== -1
    || t.indexOf("maximum context length") !== -1;
}

// Transient adapter progress text (e.g. Codex's "Reconnecting... 4/5") reports
// a self-recovering reconnect, not a terminal provider failure. It surfaces as
// an error event but must NOT count as a provider-health failure or trip a
// failover — the adapter is still trying and usually recovers on its own.
function isTransientProviderErrorText(text) {
  if (!text) return false;
  var t = String(text).toLowerCase();
  return t.indexOf("reconnecting") !== -1
    || t.indexOf("reconnect…") !== -1
    || t.indexOf("stream disconnected, reconnecting") !== -1;
}

// Payload-free system metadata is not progress and must not reset the watchdog.
function isWatchdogProgressEvent(msg) {
  if (!msg) return true;
  if (msg.yokeType !== "system") return true;
  return !!(msg.error || msg.message || msg.text || msg.content);
}

function attachBridgeStream(ctx) {
  var adapter = ctx.adapter;
  var sm = ctx.sm;
  var send = ctx.send;
  var sendAndRecord = ctx.sendAndRecord;
  var sendToSession = ctx.sendToSession;
  var processSDKMessage = ctx.processSDKMessage;
  var onProcessingChanged = ctx.onProcessingChanged;
  var onTurnDone = ctx.onTurnDone;
  var opts = ctx.opts;
  var getVendorDisplayName = ctx.getVendorDisplayName;
  var isAuthErrorMessage = ctx.isAuthErrorMessage;
  var getFreshAuthState = ctx.getFreshAuthState;
  var logAuthDecision = ctx.logAuthDecision;
  var getLoginCommand = ctx.getLoginCommand;
  var notifyAuthRequired = ctx.notifyAuthRequired;
  var findConflictingClaude = ctx.findConflictingClaude;
  var isTransientStreamError = ctx.isTransientStreamError;
  var autoResumeAllowed = ctx.autoResumeAllowed;
  var scheduleInterruptResume = ctx.scheduleInterruptResume;
  var sendModelInfoForVendor = ctx.sendModelInfoForVendor;
  var rateLimitResumeLabel = ctx.rateLimitResumeLabel;
  var debugEvents = ctx.debugEvents;
  var pushModule = ctx.pushModule || null;
  var getNotificationsModule = ctx.getNotificationsModule || function () { return null; };
  var slug = ctx.slug || "";
  // Work must never HOLD silently. When auto-resume gives up (budget spent,
  // retry already used), the session sits with an error until a human acts —
  // so tell the human: alarm-center notification + push. Once per stall
  // episode; a genuine user message clears the latch via the budget reset.
  function notifyResumeGaveUp(session, reason) {
    if (session._resumeGaveUpNotified) return;
    session._resumeGaveUpNotified = true;
    var title = (session.title || "Session") + " paused — needs attention";
    var body = reason + " Open the session and send a message to continue.";
    var nm = getNotificationsModule();
    if (nm) {
      try {
        nm.notify("needs_input", {
          title: title,
          preview: body,
          slug: slug,
          sessionId: session.localId,
          ownerId: session.ownerId || null,
        });
      } catch (e) {}
    }
    if (pushModule) {
      try {
        pushModule.sendPush({
          type: "needs_input",
          slug: slug,
          title: title,
          body: body,
          tag: "clay-stalled-" + session.localId,
        });
      } catch (e) {}
    }
  }

  async function processQueryStream(session) {
    var myQueryInstance = session.queryInstance;
    var myAbortController = session.abortController;
    console.log("[sdk-bridge] processQueryStream: starting for-await loop, vendor=" + (session.vendor || adapter.vendor));

    var lastEventAt = Date.now();
    var turnStartedAt = Date.now();
    var sawAnyEvent = false;
    var activeTools = {};
    var activeToolCount = 0;
    var watchdogTimer = setInterval(function () {
      if (!session.isProcessing || session.taskStopRequested || session.destroying) {
        clearInterval(watchdogTimer);
        return;
      }
      var interactiveToolActive = hasInteractiveToolWaits(session);
      var timeoutMs = watchdogTimeoutFor(
        session,
        activeToolCount,
        sawAnyEvent,
        session.vendor || (adapter && adapter.vendor)
      );
      var since = sawAnyEvent ? (Date.now() - lastEventAt) : (Date.now() - turnStartedAt);
      if (since >= timeoutMs) {
        clearInterval(watchdogTimer);
        var watchdogCase = activeToolCount > 0 || interactiveToolActive ? "tool-active" : (sawAnyEvent ? "mid-generation" : "first-event");
        console.warn("[sdk-bridge] Stream watchdog fired for session " + session.localId +
          " — case=" + watchdogCase + " silentFor=" + Math.round(since / 1000) + "s timeout=" + Math.round(timeoutMs / 1000) + "s" +
          " sawAnyEvent=" + sawAnyEvent + " activeTools=" + activeToolCount + ", aborting to auto-resume.");
        recordRecoveryEvent({
          kind: "watchdog",
          sessionId: session.localId,
          vendor: session.vendor || (adapter && adapter.vendor) || "claude",
          case: watchdogCase,
          silentMs: since,
          timeoutMs: timeoutMs,
        });
        // Per-provider health: a watchdog-aborted stall is a qualifying failure.
        var watchdogVendor = session.vendor || (adapter && adapter.vendor) || "claude";
        recordProviderFailure(session, watchdogVendor, "watchdog:" + watchdogCase);
        session._watchdogAbort = true;
        if (myAbortController && !myAbortController.signal.aborted) {
          try { myAbortController.abort(); } catch (e) {}
        } else if (myQueryInstance && typeof myQueryInstance.close === "function") {
          try { myQueryInstance.close(); } catch (e) {}
        } else if (session.messageQueue && typeof session.messageQueue.end === "function") {
          try { session.messageQueue.end(); } catch (e) {}
        }
      }
    }, 5 * 1000);
    if (watchdogTimer.unref) watchdogTimer.unref();

    try {
      for await (var msg of myQueryInstance) {
        // Only count REAL progress toward watchdog liveness. The catch-all
        // "system" yokeType is unrecognized SDK meta — the processor silently
        // drops content-free ones — and a flood of them (observed: 570 in one
        // turn) otherwise resets lastEventAt on every tick, so a wedged turn
        // that emits nothing-but-system keepalive defeats the mid-generation
        // watchdog forever and the client spins on thinking dots. A content-
        // free system event is not progress; leave the timers where they were.
        if (isWatchdogProgressEvent(msg)) {
          lastEventAt = Date.now();
          sawAnyEvent = true;
          clearInteractiveToolWaits(session);
        }
        if (msg && (msg.yokeType === "tool_start" || msg.yokeType === "tool_executing")) {
          var wdTid = msg.toolId || msg.blockId;
          if (wdTid && !activeTools[wdTid]) { activeTools[wdTid] = true; activeToolCount++; }
        } else if (msg && msg.yokeType === "tool_result") {
          var wdRtid = msg.toolId || msg.blockId;
          if (wdRtid && activeTools[wdRtid]) { delete activeTools[wdRtid]; activeToolCount--; }
        }
        if (debugEvents && msg && msg.yokeType !== "text_delta" && msg.yokeType !== "thinking_delta" && msg.yokeType !== "tool_input_delta") {
          console.log("[sdk-bridge] processQueryStream: received event yokeType=" + msg.yokeType);
        }
        if (msg && msg.type === "_worker_meta") {
          var metaData = msg.data || {};
          switch (msg.subtype) {
            case "context_usage":
              session.lastContextUsage = metaData.data;
              sendToSession(session, { type: "context_usage", data: metaData.data });
              break;
            case "model_changed":
              sm.currentModel = metaData.model;
              sendModelInfoForVendor(session.vendor || (adapter && adapter.vendor) || "claude", metaData.model, session);
              send({ type: "config_state", model: sm.currentModel, mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
              break;
            case "effort_changed":
              sm.currentEffort = metaData.effort;
              send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [] });
              break;
            case "permission_mode_changed":
              sm.currentPermissionMode = metaData.mode;
              session.permissionMode = metaData.mode;
              session.automationMode = automationForClaudePermission(metaData.mode);
              send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, automationMode: session.automationMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
              break;
            case "worker_error":
              send({ type: "error", text: metaData.error });
              break;
          }
          continue;
        }
        if (msg && msg.yokeType === "error") {
          var adapterErrText = msg.text || "Unknown error";
          console.error("[sdk-bridge] Adapter error event for session " + session.localId + ": " + adapterErrText);
          session.isProcessing = false;
          onProcessingChanged();
          send({ type: "status", processing: false });
          sendAndRecord(session, { type: "thinking_stop" });
          if (isContextOverflowError(adapterErrText)) {
            // Same overflow the thrown-error catch handles — surface the
            // recoverable card, not a raw "Prompt is too long" bubble.
            sendAndRecord(session, { type: "context_overflow", text: "Conversation too long to continue." });
            sendAndRecord(session, { type: "done", code: 1 });
            notifyResumeGaveUp(session, "The conversation exceeded the model's context window.");
          } else {
            sendAndRecord(session, { type: "error", text: adapterErrText });
            sendAndRecord(session, { type: "done", code: 1 });
            if (!isAuthErrorMessage(adapterErrText) && !isTransientProviderErrorText(adapterErrText)) {
              var adapterErrorVendor = session.vendor || (adapter && adapter.vendor) || "claude";
              var adapterErrorReason = "provider-error:" + String(adapterErrText).slice(0, 80);
              recordProviderFailure(session, adapterErrorVendor, adapterErrorReason, { strong: true });
            }
          }
          queuePendingProviderFailover(session, opts);
          continue;
        }
        processSDKMessage(session, msg);
      }
      console.log("[sdk-bridge] processQueryStream ended: isProcessing=" + session.isProcessing + " taskStopRequested=" + session.taskStopRequested);
      if (session.isProcessing) {
        session.isProcessing = false;
        onProcessingChanged();
        send({ type: "status", processing: false });
        sendAndRecord(session, { type: "thinking_stop" });
        if (!session.destroying) {
          var streamEndedMsg;
          if (session._providerFailoverClosing) {
            console.log("[sdk-bridge] Stream closed at the provider-failover boundary for session " + session.localId);
          } else if (session.taskStopRequested) {
            streamEndedMsg = (session.vendor === "codex")
              ? "\u25a0 Conversation interrupted - tell the model what to do differently."
              : "Interrupted \u00b7 What should Claude do instead?";
            sendAndRecord(session, { type: "info", text: streamEndedMsg });
            sendAndRecord(session, { type: "done", code: 0 });
          } else {
            var canRetryStreamEnd = !session.streamEndedAutoRetryQueued
              && !session._transientRetryUsed
              && !session.rateLimitResetsAt
              && !session.scheduledMessage
              && autoResumeAllowed(session)
              && typeof opts.scheduleMessage === "function";
            if (canRetryStreamEnd) {
              session.streamEndedAutoRetryQueued = true;
              session._transientRetryUsed = true;
              sendAndRecord(session, { type: "info", text: "Connection dropped before the response finished. Resuming…" });
              sendAndRecord(session, { type: "done", code: 0 });
              scheduleInterruptResume(session);
            } else {
              streamEndedMsg = getVendorDisplayName(session.vendor || (adapter && adapter.vendor) || "claude") + " stopped before returning a final response.";
              sendAndRecord(session, { type: "error", text: streamEndedMsg });
              sendAndRecord(session, { type: "done", code: 1 });
              // Per-provider health: auto-resume gave up — an immediately-strong
              // signal that extends the streak regardless of the rolling window.
              var endedVendor = session.vendor || (adapter && adapter.vendor) || "claude";
              recordProviderFailure(session, endedVendor, "resume-gave-up:stream-ended", { strong: true });
              notifyResumeGaveUp(session, streamEndedMsg + " Auto-resume is out of retries.");
            }
          }
        }
        sm.broadcastSessionList();
        if ((!session.taskStopRequested || session.steerInterruptRequested) && onTurnDone
            && !session.providerFailoverPending && !session._providerFailoverClosing) {
          try { onTurnDone(session, session._taskWorkflowResponseText || ""); } catch (e) {}
        }
      }
    } catch (err) {
      if (session.isProcessing) {
        session.isProcessing = false;
        onProcessingChanged();
        if (err.name === "AbortError" || (myAbortController && myAbortController.signal.aborted) || session.taskStopRequested) {
          if (session._watchdogAbort && !session.taskStopRequested && !session.destroying
              && !session._transientRetryUsed && autoResumeAllowed(session)
              && typeof opts.scheduleMessage === "function") {
            console.warn("[sdk-bridge] Watchdog abort for session " + session.localId + "; auto-resuming once.");
            session._watchdogAbort = false;
            session._transientRetryUsed = true;
            sendAndRecord(session, { type: "thinking_stop" });
            sendAndRecord(session, { type: "info", text: "Response stalled. Resuming\u2026", variant: "recovery" });
            sendAndRecord(session, { type: "done", code: 0 });
            scheduleInterruptResume(session);
            sm.broadcastSessionList();
            return;
          }
          session._watchdogAbort = false;
          if (!session.destroying && session.steerInterruptRequested) {
            sendAndRecord(session, { type: "thinking_stop" });
            sendAndRecord(session, { type: "done", code: 0 });
          } else if (!session.destroying) {
            sendAndRecord(session, { type: "thinking_stop" });
            var interruptMsg2 = (session.vendor === "codex")
              ? "\u25a0 Conversation interrupted - tell the model what to do differently."
              : "Interrupted \u00b7 What should Claude do instead?";
            sendAndRecord(session, { type: "info", text: interruptMsg2 });
            sendAndRecord(session, { type: "done", code: 0 });
          }
        } else if (session.destroying) {
          console.log("[sdk-bridge] Suppressing stream error during shutdown for session " + session.localId);
        } else {
          var errDetail = err.message || String(err);
          if (err.stderr) errDetail += "\nstderr: " + err.stderr;
          if (err.exitCode != null) errDetail += " (exitCode: " + err.exitCode + ")";
          console.error("[sdk-bridge] Query stream error for session " + session.localId + ":", errDetail);
          console.error("[sdk-bridge] Stack:", err.stack || "(no stack)");

          var isExitCode1 = err.exitCode === 1 || (err.message && err.message.indexOf("exited with code 1") !== -1);
          var conflicts = isExitCode1 ? findConflictingClaude() : [];
          if (conflicts.length > 0) {
            console.error("[sdk-bridge] Found " + conflicts.length + " conflicting Claude process(es):", conflicts.map(function(c) { return "PID " + c.pid; }).join(", "));
            sendAndRecord(session, {
              type: "process_conflict",
              text: "Another Claude Code process is already running in this project.",
              processes: conflicts,
            });
            notifyResumeGaveUp(session, "Another Claude Code process is conflicting with this project.");
          } else if (isTransientStreamError(errDetail) && !session._transientRetryUsed
              && !session.taskStopRequested && autoResumeAllowed(session)
              && typeof opts.scheduleMessage === "function") {
            console.warn("[sdk-bridge] Transient stream error for session " + session.localId + "; auto-retrying once: " + errDetail);
            recordRecoveryEvent({
              kind: "transient",
              sessionId: session.localId,
              vendor: session.vendor || (adapter && adapter.vendor) || "claude",
              error: String(errDetail).slice(0, 300),
            });
            // Per-provider health: a classified transient stream error counts.
            var transientVendor = session.vendor || (adapter && adapter.vendor) || "claude";
            var transientReason = "transient:" + String(errDetail).slice(0, 80);
            recordProviderFailure(session, transientVendor, transientReason);
            session._transientRetryUsed = true;
            sendAndRecord(session, { type: "thinking_stop" });
            sendAndRecord(session, { type: "info", text: "Connection dropped mid-response. Retrying…", variant: "recovery" });
            sendAndRecord(session, { type: "done", code: 0 });
            scheduleInterruptResume(session);
            sm.broadcastSessionList();
            return;
          } else {
            var isContextOverflow = isContextOverflowError(errDetail);
            var isAuthError = isAuthErrorMessage(errDetail);
            if (isContextOverflow) {
              sendAndRecord(session, {
                type: "context_overflow",
                text: "Conversation too long to continue.",
              });
              notifyResumeGaveUp(session, "The conversation exceeded the model's context window.");
            } else if (isAuthError) {
              var freshAuth = getFreshAuthState();
              logAuthDecision("catch-auth-error", session, errDetail, freshAuth);
              if (freshAuth[session.vendor]) {
                sendAndRecord(session, {
                  type: "error",
                  text: "Authentication looked fine, but " + (session.vendor || "the vendor") + " returned an auth-like error.",
                });
                sendAndRecord(session, { type: "done", code: 1 });
                sm.broadcastSessionList();
                return;
              }
              var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
              var authLinuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
              var canAutoLogin = !usersModule.isMultiUser()
                || !!authLinuxUser
                || (authUser && authUser.role === "admin");
              var authTitle = getVendorDisplayName(session.vendor || (adapter && adapter.vendor) || "claude") + " is not logged in.";
              var authMsg = {
                type: "auth_required",
                text: authTitle,
                vendor: session.vendor || (adapter && adapter.vendor) || "claude",
                loginCommand: getLoginCommand(session.vendor || (adapter && adapter.vendor) || "claude"),
                linuxUser: authLinuxUser,
                canAutoLogin: canAutoLogin,
              };
              sendAndRecord(session, authMsg);
              if (!notifyAuthRequired(
                session,
                authTitle,
                "Open a terminal, then click the URL and follow the instructions.",
                authLinuxUser,
                canAutoLogin,
                getLoginCommand(session.vendor || (adapter && adapter.vendor) || "claude")
              )) {
              }
            } else {
              sendAndRecord(session, { type: "error", text: "Claude process error: " + err.message });
              // Per-provider health: a non-transient, non-auth, non-overflow
              // provider error with no auto-resume — immediately-strong signal.
              var errorVendor = session.vendor || (adapter && adapter.vendor) || "claude";
              var errorReason = "provider-error:" + String(err.message || "").slice(0, 80);
              recordProviderFailure(session, errorVendor, errorReason, { strong: true });
              notifyResumeGaveUp(session, "The provider errored and auto-resume did not apply.");
            }
          }
          sendAndRecord(session, { type: "done", code: 1 });
        }
        sm.broadcastSessionList();
        if (session.steerInterruptRequested && onTurnDone && !session.providerFailoverPending) {
          try { onTurnDone(session, session._taskWorkflowResponseText || ""); } catch (e) {}
        }
      }
    } finally {
      clearInterval(watchdogTimer);
      var ownsTurn = session.queryInstance === myQueryInstance;
      if (session.queryInstance === myQueryInstance) {
        try {
          if (typeof session.queryInstance.close === "function") {
            session.queryInstance.close();
          }
        } catch (e) {}
        session.queryInstance = null;
      }
      session.messageQueue = null;
      if (session.abortController === myAbortController) session.abortController = null;
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
      if (session.vendor === "github-copilot" && session.copilotResetAfterCurrentHandoffTurn && !session.copilotHandoffNativeReset) {
        console.warn("[sdk-bridge] Dropping GitHub Copilot native session that received handoff transcript: " + (session.cliSessionId || "unknown"));
        session.cliSessionId = null;
        session.copilotHandoffNativeReset = true;
        session.copilotResetAfterCurrentHandoffTurn = false;
        try { sm.saveSessionFile(session); } catch (e) {}
        if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
      } else if (session.copilotResetAfterCurrentHandoffTurn) {
        session.copilotResetAfterCurrentHandoffTurn = false;
      }

      // Failed handoff turn (no real output): the consuming send burned the
      // context on an error. Restore it so the next send retries with full
      // context — the only retry headroom github-copilot's 1-turn budget has.
      if (ownsTurn && !session._turnSawActivity && session._handoffContextStash) {
        if (handoffContextModule.restoreHandoffAfterFailedTurn(session)) {
          console.warn("[sdk-bridge] Restoring handoff context after failed post-switch turn for session " + session.localId);
          try { sm.saveSessionFile(session); } catch (e) {}
        }
      }

      session.isProcessing = false;
      if (ownsTurn && !session._turnDoneSent && !session.destroying) {
        console.warn("[sdk-bridge] Turn for session " + session.localId + " ended without a terminal event; emitting safety-net done.");
        sendAndRecord(session, { type: "done", code: 0 });
        if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
      }

      var didScheduleAutoContinue = false;
      var acEnabled = session.onQueryComplete || (typeof opts.getAutoContinueSetting === "function" && opts.getAutoContinueSetting(session));
      var pendingProviderFailure = session.providerFailoverPending || null;
      session.providerFailoverPending = null;
      if (pendingProviderFailure && acEnabled && !session.destroying && typeof opts.failoverAndContinue === "function") {
        didScheduleAutoContinue = !!opts.failoverAndContinue(session, pendingProviderFailure);
      } else if (session.rateLimitUseCreditsPending && acEnabled && !session.destroying) {
        session.rateLimitUseCreditsPending = false;
        session.rateLimitAutoContinuePending = true;
        didScheduleAutoContinue = true;
        console.log("[sdk-bridge] Rate limited with usage credits available, continuing immediately for session " + session.localId);
        if (typeof opts.continueWithUsageCredits === "function") {
          opts.continueWithUsageCredits(session, "continue", null, "↻ Continuing with usage credits");
        }
      } else if (session.rateLimitResetsAt && session.rateLimitResetsAt > Date.now()
          && acEnabled && !session.destroying) {
        var acResetsAt = session.rateLimitResetsAt;
        session.rateLimitResetsAt = null;
        session.rateLimitAutoContinuePending = true;
        didScheduleAutoContinue = true;
        console.log("[sdk-bridge] Rate limited, scheduling auto-continue via scheduleMessage for session " + session.localId);
        if (typeof opts.scheduleMessage === "function") {
          opts.scheduleMessage(session, "continue", acResetsAt, null, rateLimitResumeLabel);
        }
      } else if (acEnabled && !session.destroying && !session._providerFailoverClosing) {
        console.log("[sdk-bridge] Query done, auto-continue enabled but not scheduled: rateLimitResetsAt=" +
          session.rateLimitResetsAt + " (will rely on late rate_limit_event handler)");
      }

      if (session.onQueryComplete && !didScheduleAutoContinue && !pendingProviderFailure && !session._providerFailoverClosing) {
        console.log("[sdk-bridge] Calling onQueryComplete for session " + session.localId + " (title: " + (session.title || "?") + ")");
        try {
          session.onQueryComplete(session);
        } catch (err) {
          console.error("[sdk-bridge] onQueryComplete error:", err.message || err);
        }
      }
    }
  }

  return {
    processQueryStream: processQueryStream,
  };
}

module.exports = {
  attachBridgeStream: attachBridgeStream,
  midstreamTimeoutFor: midstreamTimeoutFor,
  watchdogTimeoutFor: watchdogTimeoutFor,
  clearInteractiveToolWaits: clearInteractiveToolWaits,
  isWatchdogProgressEvent: isWatchdogProgressEvent,
  isContextOverflowError: isContextOverflowError,
  isTransientProviderErrorText: isTransientProviderErrorText,
};
