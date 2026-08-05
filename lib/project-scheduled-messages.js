var { applyHandoffToOutgoingText } = require("./handoff-context");
var handoffPackageModule = require("./handoff-package");

function attachProjectScheduledMessages(ctx) {
  var imagesDir = ctx.imagesDir || null;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendToSession = ctx.sendToSession;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var loadImagesForSdk = ctx.loadImagesForSdk;
  var onProcessingChanged = ctx.onProcessingChanged;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  // How far back a restart-interrupted session still auto-resumes. The gate
  // anchors to the LAST HISTORY EVENT before the restart (see
  // markRestartInterruptedSession), so a session that was 15 minutes into a
  // silent tool run when the daemon bounced already looks "old" — 10 minutes
  // silently dropped exactly the long-running unattended work that most needs
  // resuming. The consecutive-auto-resume budget (now reset by productive
  // turns) bounds runaway loops, so the window can be generous.
  var RESTART_RESUME_WINDOW_MS = 30 * 60 * 1000;

  function openScheduledMessageEntry(session) {
    if (!session || !Array.isArray(session.history)) return null;
    for (var i = session.history.length - 1; i >= 0; i--) {
      var item = session.history[i];
      if (!item) continue;
      if (item.type === "scheduled_message_sent" || item.type === "scheduled_message_cancelled" || item.type === "vendor_switched") return null;
      if (item.type === "scheduled_message_queued") return item;
    }
    return null;
  }

  function scheduledPromptTextFromEntry(entry) {
    var displayText = entry && entry.text ? String(entry.text) : "";
    if (displayText === "↻ Auto-continued" || displayText === "↻ Resuming after restart") return "continue";
    return displayText;
  }

  function dispatchSyntheticMessage(session, schedText, schedDisplayText, opts2, imageRefs) {
    // Synthetic sends (scheduled messages, auto-continues) must carry a
    // pending vendor-handoff context just like user sends — otherwise a
    // post-switch scheduled message reaches the new vendor with zero prior
    // context. The wrapper is model-facing only; the recorded/displayed
    // message stays schedDisplayText.
    var handoffImages = [];
    if (session.handoffContext) {
      // Handoff images are model-facing only: merged into the SDK payload
      // below but NOT recorded on the visible message (the user already saw
      // them before the switch). Load BEFORE the wrapper application, which
      // may consume handoffContext.
      handoffImages = handoffPackageModule.loadHandoffImages(session, imagesDir, 5);
      schedText = applyHandoffToOutgoingText(session, schedText);
      sm.saveSessionFile(session);
    }
    var userMsg = { type: "user_message", text: schedDisplayText, _ts: Date.now() };
    var sdkImages = null;
    if (Array.isArray(imageRefs) && imageRefs.length > 0) {
      userMsg.imageRefs = imageRefs;
      userMsg.imageCount = imageRefs.length;
      sdkImages = loadImagesForSdk(imageRefs);
    }
    if (handoffImages.length > 0) {
      sdkImages = (sdkImages || []).concat(handoffImages);
    }
    session.history.push(userMsg);
    sm.appendToSessionFile(session, userMsg);
    sendToSession(session.localId, hydrateImageRefs(userMsg));
    session.isProcessing = true;
    onProcessingChanged();
    sendToSession(session.localId, { type: "status", status: "processing" });
    sdk.startQuery(session, schedText, sdkImages, ensureProjectAccessForSession(session));
    sm.broadcastSessionList();
  }

  function dispatchScheduledMessage(session, schedText, schedDisplayText, opts2, imageRefs) {
    if (opts2 && opts2.manual) {
      session._consecutiveAutoResumes = 0;
      session._suppressActivityBump = false;
    }
    sm.sendAndRecord(session, { type: "scheduled_message_sent" });
    dispatchSyntheticMessage(session, schedText, schedDisplayText, opts2, imageRefs);
  }

  function sendScheduledMessageNow(session, opts2) {
    if (!session) return false;
    // A turn may be mid-flight when the timer fires (e.g. the user typed
    // while a rate-limit resume was queued — user messages deliberately keep
    // the scheduled entry alive). startQuery has NO active-query guard, so
    // dispatching now would overwrite session.queryInstance and orphan the
    // live stream. Defer with a short retry instead; the queued entry stays
    // open in history and fires once the current turn finishes.
    if (session.isProcessing || session.queryInstance) {
      if (session.destroying) return false;
      var retryTimer = setTimeout(function () { sendScheduledMessageNow(session, opts2); }, 30000);
      if (retryTimer.unref) retryTimer.unref();
      if (session.scheduledMessage) {
        if (session.scheduledMessage.timer) clearTimeout(session.scheduledMessage.timer);
        session.scheduledMessage.timer = retryTimer;
      }
      console.log("[project] Scheduled message deferred (turn in flight) for session " + session.localId);
      return false;
    }
    var schedText = null;
    var schedDisplayText = null;
    var schedImageRefs = null;
    if (session.scheduledMessage) {
      schedText = session.scheduledMessage.text;
      schedDisplayText = session.scheduledMessage.displayText || schedText;
      schedImageRefs = session.scheduledMessage.imageRefs || null;
      if (session.scheduledMessage.timer) clearTimeout(session.scheduledMessage.timer);
      session.scheduledMessage = null;
    } else {
      var openEntry = openScheduledMessageEntry(session);
      if (!openEntry) return false;
      schedDisplayText = openEntry.text || "";
      schedText = scheduledPromptTextFromEntry(openEntry);
      schedImageRefs = openEntry.imageRefs || null;
    }
    if (!schedText && !schedDisplayText) return false;
    if (!schedText) schedText = schedDisplayText;
    if (!schedDisplayText) schedDisplayText = schedText;
    if (schedText === "continue" && schedDisplayText === "↻ Resuming after restart" && session.interruptedByRestart) {
      session.interruptedByRestart = false;
      session.restartAutoContinueQueued = false;
      session.restartResumeEligible = false;
      sm.saveSessionFile(session);
    }
    session.rateLimitAutoContinuePending = false;
    console.log("[project] Scheduled message sent for session " + session.localId);
    dispatchScheduledMessage(session, schedText, schedDisplayText, opts2, schedImageRefs);
    return true;
  }

  function continueWithUsageCredits(session, text, promptText, displayLabel) {
    if (!session || !text || session.destroying || session.isProcessing) return false;
    if (!sdk.autoResumeAllowed(session)) {
      console.log("[project] Usage-credits continue suppressed (auto-resume budget exhausted) for session " + session.localId);
      session.rateLimitUseCreditsPending = false;
      session.rateLimitAutoContinuePending = false;
      return false;
    }
    session._consecutiveAutoResumes = (session._consecutiveAutoResumes || 0) + 1;
    session.rateLimitUseCreditsPending = false;
    session.rateLimitAutoContinuePending = false;
    session._suppressActivityBump = true;
    var sendText = promptText || text;
    var displayText = displayLabel || text;
    sm.sendAndRecord(session, {
      type: "info",
      text: "Usage credits are available, so Clay is continuing immediately instead of scheduling a resume after the rate-limit reset.",
      variant: "recovery",
    });
    console.log("[project] Continuing with usage credits for session " + session.localId);
    dispatchSyntheticMessage(session, sendText, displayText, { autoAction: true }, null);
    return true;
  }

  function continueAfterProviderSwitch(session, promptText, displayLabel, providerLabel) {
    if (!session || session.destroying || session.isProcessing) return false;
    if (!sdk.autoResumeAllowed(session)) {
      console.log("[project] Provider-failover continue suppressed (auto-resume budget exhausted) for session " + session.localId);
      return false;
    }
    session._consecutiveAutoResumes = (session._consecutiveAutoResumes || 0) + 1;
    session._suppressActivityBump = true;
    sm.sendAndRecord(session, {
      type: "info",
      text: "Clay switched to " + providerLabel + " and is continuing the interrupted work automatically.",
      variant: "recovery",
    });
    console.log("[project] Continuing after provider failover for session " + session.localId);
    dispatchSyntheticMessage(session, promptText, displayLabel, { autoAction: true }, null);
    return true;
  }

  function scheduleMessage(session, text, resetsAt, promptText, displayLabel, opts2) {
    if (!session || !text || !resetsAt) return;
    if (opts2 && opts2.autoAction) session._suppressActivityBump = true;
    var sendText = promptText || text;
    var displayText = displayLabel || text;
    if (session.scheduledMessage && session.scheduledMessage.timer) {
      clearTimeout(session.scheduledMessage.timer);
    }
    var isPastReset = resetsAt <= Date.now();
    var schedDelay = isPastReset ? 5000 : Math.max(0, resetsAt - Date.now()) + 60000;
    var sendsAt = Date.now() + schedDelay;
    var schedImageRefs = (opts2 && Array.isArray(opts2.imageRefs) && opts2.imageRefs.length > 0) ? opts2.imageRefs : null;
    var schedEntry = {
      type: "scheduled_message_queued",
      text: displayText,
      resetsAt: sendsAt,
      scheduledAt: Date.now(),
      autoAction: !!(opts2 && opts2.autoAction),
    };
    if (schedImageRefs) schedEntry.imageRefs = schedImageRefs;
    sm.sendAndRecord(session, schedEntry);
    session.scheduledMessage = {
      text: sendText,
      displayText: displayText,
      resetsAt: resetsAt,
      imageRefs: schedImageRefs,
      autoAction: !!(opts2 && opts2.autoAction),
      timer: setTimeout(function () {
        if (session.destroying) return;
        console.log("[project] Scheduled message firing for session " + session.localId);
        if (text === "continue" && session.interruptedByRestart) {
          session.interruptedByRestart = false;
          session.restartAutoContinueQueued = false;
          session.restartResumeEligible = false;
          sm.saveSessionFile(session);
        }
        sendScheduledMessageNow(session);
      }, schedDelay),
    };
  }

  function restoreScheduledMessageTimer(session) {
    if (!session || session.destroying || session.scheduledMessage) return false;
    var openEntry = openScheduledMessageEntry(session);
    if (!openEntry) return false;
    var displayText = openEntry.text || "";
    var sendText = scheduledPromptTextFromEntry(openEntry);
    if (!sendText && !displayText) return false;
    if (!sendText) sendText = displayText;
    var sendsAt = typeof openEntry.resetsAt === "number" && isFinite(openEntry.resetsAt) ? openEntry.resetsAt : Date.now();
    var delay = sendsAt <= Date.now() ? 5000 : sendsAt - Date.now();
    session.scheduledMessage = {
      text: sendText,
      displayText: displayText || sendText,
      resetsAt: sendsAt,
      imageRefs: (openEntry && Array.isArray(openEntry.imageRefs) && openEntry.imageRefs.length > 0) ? openEntry.imageRefs : null,
      autoAction: !!openEntry.autoAction || /^↻ /.test(displayText),
      timer: setTimeout(function () {
        if (session.destroying) return;
        console.log("[project] Restored scheduled message firing for session " + session.localId);
        sendScheduledMessageNow(session);
      }, delay),
    };
    console.log("[project] Restored scheduled message timer for session " + session.localId);
    return true;
  }

  function restoreScheduledMessageTimers() {
    sm.sessions.forEach(function (session) {
      restoreScheduledMessageTimer(session);
    });
  }

  function autoResumeRestartSession(session) {
    if (!session || !session.restartResumeEligible || session.restartAutoContinueQueued) return;
    session.restartResumeEligible = false;
    var recent = session.restartInterruptedAt
      && (Date.now() - session.restartInterruptedAt) < RESTART_RESUME_WINDOW_MS;
    if (!recent) return;
    if (!sdk.autoResumeAllowed(session)) return;
    session.restartAutoContinueQueued = true;
    session._consecutiveAutoResumes = (session._consecutiveAutoResumes || 0) + 1;
    scheduleMessage(session, "continue", Date.now(), "Resume the work that was interrupted when Clay restarted. Continue from where you left off; do not restart from scratch or re-ask for confirmation.", "↻ Resuming after restart", { autoAction: true });
  }

  function cancelScheduledMessage(session) {
    if (!session) return;
    if (session.scheduledMessage && session.scheduledMessage.timer) {
      clearTimeout(session.scheduledMessage.timer);
      session.scheduledMessage = null;
      session.rateLimitAutoContinuePending = false;
      sm.sendAndRecord(session, { type: "scheduled_message_cancelled" });
      return;
    }
    if (openScheduledMessageEntry(session)) {
      session.rateLimitAutoContinuePending = false;
      sm.sendAndRecord(session, { type: "scheduled_message_cancelled" });
    }
  }

  return {
    scheduleMessage: scheduleMessage,
    cancelScheduledMessage: cancelScheduledMessage,
    continueWithUsageCredits: continueWithUsageCredits,
    continueAfterProviderSwitch: continueAfterProviderSwitch,
    sendScheduledMessageNow: sendScheduledMessageNow,
    restoreScheduledMessageTimers: restoreScheduledMessageTimers,
    autoResumeRestartSession: autoResumeRestartSession,
  };
}

module.exports = {
  attachProjectScheduledMessages: attachProjectScheduledMessages,
};
