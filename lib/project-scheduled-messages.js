var { applyHandoffToOutgoingText } = require("./handoff-context");
var handoffPackageModule = require("./handoff-package");
var executionFence = require("./coop-control-fence");
var coopWake = require("./coop-scheduled-wake");
var recordScheduled = require("./project-scheduled-message-persistence").recordScheduledMessage;

var TERMINAL_EXECUTION = {
  completed: true,
  failed: true,
  needs_input: true,
  superseded: true,
  cancelled: true,
};

function scheduledTargetEnded(session) {
  if (!session || session.closedAt || session.compactedIntoLocalId) return true;
  var policy = session.orchestrationPolicy;
  var execution = policy && policy.portfolioExecution;
  return !!(execution && TERMINAL_EXECUTION[execution.status]);
}

function attachProjectScheduledMessages(ctx) {
  var imagesDir = ctx.imagesDir || null;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendToSession = ctx.sendToSession;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var loadImagesForSdk = ctx.loadImagesForSdk;
  var onProcessingChanged = ctx.onProcessingChanged;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var resumeCoopIngress = ctx.resumeCoopIngress || function () { return false; };
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
    if (coopWake.prompt(entry)) return coopWake.prompt(entry);
    var displayText = entry && entry.text ? String(entry.text) : "";
    if (displayText === "↻ Auto-continued" || displayText === "↻ Resuming after restart") return "continue";
    return displayText;
  }

  function activeCoopIngressId(session) {
    var state = session && session.coopConversationIngress;
    return state && typeof state.activeIngressId === "string" ? state.activeIngressId : "";
  }

  function autoContinuationIngressId(session, opts2) {
    if (!opts2 || !opts2.autoAction) return "";
    return opts2.coopIngressId || activeCoopIngressId(session);
  }

  function attachContinuationIngress(entry, ingressId) {
    if (ingressId) entry.coopContinuationIngressId = ingressId;
    return entry;
  }

  function entryContinuationIngressId(entry) {
    return entry && typeof entry.coopContinuationIngressId === "string"
      ? entry.coopContinuationIngressId : "";
  }

  function recordedScheduledMessage(session) {
    var queued = session && session.scheduledMessage;
    if (!queued) return null;
    if (queued.timer) clearTimeout(queued.timer);
    session.scheduledMessage = null;
    return coopWake.copy({
      text: queued.text,
      displayText: queued.displayText || queued.text,
      imageRefs: queued.imageRefs || null,
      coopRouting: cloneScheduledCoopRouting(queued.coopRouting),
      ingressId: queued.coopIngressId || "",
      autoAction: !!queued.autoAction,
    }, queued);
  }

  function recoveredScheduledMessage(session) {
    var entry = openScheduledMessageEntry(session);
    if (!entry) return null;
    return coopWake.copy({
      text: scheduledPromptTextFromEntry(entry),
      displayText: entry.text || "",
      imageRefs: entry.imageRefs || null,
      coopRouting: cloneScheduledCoopRouting(entry.coopRouting),
      ingressId: entryContinuationIngressId(entry),
      autoAction: !!entry.autoAction,
    }, entry);
  }

  function scheduleDispatchOptions(options, scheduled) {
    var dispatch = Object.assign({}, options || {});
    if (scheduled.autoAction) dispatch.autoAction = true;
    if (scheduled.ingressId) dispatch.coopIngressId = scheduled.ingressId;
    if (scheduled.coopRouting) dispatch.coopRouting = cloneScheduledCoopRouting(scheduled.coopRouting);
    return coopWake.copy(dispatch, scheduled);
  }

  function clearRestartResume(session) {
    session.interruptedByRestart = false;
    session.restartAutoContinueQueued = false;
    session.restartResumeEligible = false;
    sm.saveSessionFile(session);
  }

  function clearRestartResumeState(session, text, displayText) {
    if (text === "continue" && displayText === "↻ Resuming after restart" && session.interruptedByRestart) {
      clearRestartResume(session);
    }
  }

  function clearRestartResumeForContinuation(session, text) {
    if (text === "continue" && session.interruptedByRestart) clearRestartResume(session);
  }

  function scheduledImageRefs(options) {
    var source = options || {};
    return Array.isArray(source.imageRefs) && source.imageRefs.length > 0 ? source.imageRefs : null;
  }

  function scheduledAutoAction(options) {
    return !!(options && options.autoAction);
  }

  function isQueuedRestartResume(session) {
    var queued = session && session.scheduledMessage;
    if (queued && queued.autoAction && queued.displayText === "↻ Resuming after restart") return true;
    var entry = openScheduledMessageEntry(session);
    return !!(entry && entry.autoAction && entry.text === "↻ Resuming after restart");
  }

  function cloneScheduledCoopRouting(routing) {
    if (!routing || typeof routing.scope !== "string") return null;
    if (routing.scope === "main" || routing.scope === "canonical") {
      return { scope: routing.scope, topicRef: null, projectRef: null };
    }
    if (routing.scope !== "topic" && routing.scope !== "project") return null;
    if (routing.scope === "topic" && !routing.topicRef) return null;
    if (routing.scope === "project" && (!routing.projectRef || routing.topicRef)) return null;
    try {
      return JSON.parse(JSON.stringify({
        scope: routing.scope,
        topicRef: routing.topicRef || null,
        projectRef: routing.projectRef || null,
      }));
    } catch (e) {
      return null;
    }
  }

  function scheduledCoopRouting(options) {
    return cloneScheduledCoopRouting(options && options.coopRouting);
  }

  function scheduledMessageTimer(session, text, delay) {
    return setTimeout(function () {
      if (session.destroying) return;
      console.log("[project] Scheduled message firing for session " + session.localId);
      clearRestartResumeForContinuation(session, text);
      sendScheduledMessageNow(session);
    }, delay);
  }

  function validScheduledTime(entry) {
    return typeof entry.resetsAt === "number" && isFinite(entry.resetsAt);
  }

  function restoredScheduledMessage(entry) {
    var displayText = entry.text || "";
    var sendText = scheduledPromptTextFromEntry(entry);
    if (!sendText && !displayText) return null;
    if (!sendText) sendText = displayText;
    var sendsAt = validScheduledTime(entry) ? entry.resetsAt : Date.now();
    return coopWake.copy({
      text: sendText,
      displayText: displayText || sendText,
      resetsAt: sendsAt,
      delay: sendsAt <= Date.now() ? 5000 : sendsAt - Date.now(),
      imageRefs: scheduledImageRefs(entry),
      coopRouting: cloneScheduledCoopRouting(entry.coopRouting),
      autoAction: scheduledAutoAction(entry) || /^↻ /.test(displayText),
      coopIngressId: entryContinuationIngressId(entry),
    }, entry);
  }

  function restoredScheduledMessageTimer(session, delay) {
    return setTimeout(function () {
      if (session.destroying) return;
      console.log("[project] Restored scheduled message firing for session " + session.localId);
      sendScheduledMessageNow(session);
    }, delay);
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
    var continuationIngressId = autoContinuationIngressId(session, opts2);
    if (continuationIngressId) resumeCoopIngress(session, continuationIngressId);
    var userMsg = { type: "user_message", text: schedDisplayText, _ts: Date.now() };
    coopWake.copy(userMsg, opts2);
    var coopRouting = opts2 && cloneScheduledCoopRouting(opts2.coopRouting);
    if (coopRouting) {
      userMsg.coopComposerScope = coopRouting.scope;
      if (coopRouting.topicRef) userMsg.coopTopicRef = coopRouting.topicRef;
      if (coopRouting.projectRef) userMsg.coopProjectRef = coopRouting.projectRef;
    }
    if (opts2 && opts2.autoAction) {
      userMsg.autoAction = true;
      userMsg.synthetic = true;
    }
    if (continuationIngressId) {
      // This is provenance for the retry, not a second owner ingress. Keeping
      // it on the synthetic turn makes restart recovery and transcript audits
      // exact without making historical ingress extraction see a duplicate.
      userMsg.coopContinuationIngressId = continuationIngressId;
    }
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
    // Codex keeps a resident query between turns. That query is the transport
    // for the next turn, not proof that a turn is still active. Ordinary owner
    // messages already reuse it through pushMessage; scheduled Lead ticks,
    // restart resumes and rate-limit resumes must follow the same rule or they
    // defer forever while Coop appears idle.
    if (!session.queryInstance && !session._queryStarting &&
        (!session.worker || session.messageQueue !== "worker")) {
      sdk.startQuery(session, schedText, sdkImages, ensureProjectAccessForSession(session));
    } else if (typeof sdk.pushMessage !== "function" ||
        sdk.pushMessage(session, schedText, sdkImages) === false) {
      sdk.startQuery(session, schedText, sdkImages, ensureProjectAccessForSession(session));
    }
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

  function deferScheduledMessage(session, opts2, reason) {
    if (!session || session.destroying) return false;
    var retryTimer = setTimeout(function () { sendScheduledMessageNow(session, opts2); }, 30000);
    if (retryTimer.unref) retryTimer.unref();
    if (session.scheduledMessage) {
      if (session.scheduledMessage.timer) clearTimeout(session.scheduledMessage.timer);
      session.scheduledMessage.timer = retryTimer;
    }
    console.log("[project] Scheduled message deferred (" + reason + ") for session " + session.localId);
    return false;
  }

  function sendScheduledMessageNow(session, opts2) {
    if (!session) return false;
    if (scheduledTargetEnded(session)) {
      cancelScheduledMessage(session);
      console.log("[project] Scheduled message cancelled for ended session " + session.localId);
      return false;
    }
    var queuedAuto = session.scheduledMessage || openScheduledMessageEntry(session);
    if (queuedAuto && queuedAuto.coopLeadWake &&
        coopWake.shouldCancel(session, queuedAuto, require("./lead-mode").getLeadMode(), sm)) {
      cancelScheduledMessage(session); return false;
    }
    if (queuedAuto && queuedAuto.autoAction &&
        require("./project-coordinator-update-state").hasPendingCoordinatorReports(session)) {
      clearRestartResume(session);
      cancelScheduledMessage(session);
      return false;
    }
    // Restored control metadata is only a reference. Until startup recovery
    // reattaches the matching in-memory capability, consuming the durable queue
    // would append a synthetic turn and then reject provider startup. Keep the
    // queue intact and retry after the recovery barrier has had time to open.
    if (!executionFence.isCurrent(session, "provider_start")) {
      return deferScheduledMessage(session, opts2, "control recovery pending");
    }
    // A turn may be mid-flight when the timer fires (e.g. the user typed while
    // a rate-limit resume was queued). Defer on the real activity bit. An idle
    // resident query is reusable and dispatchSyntheticMessage handles it via
    // pushMessage, matching the ordinary owner-message path.
    if (session.isProcessing) {
      // A provider stream can reattach before the restart fallback timer fires.
      // In that case the interrupted turn is already continuing, so retrying
      // the fallback forever leaves a stale "Sending... / Send now" bubble and
      // can inject a duplicate continuation after the recovered turn finishes.
      if (isQueuedRestartResume(session)) {
        clearRestartResume(session);
        cancelScheduledMessage(session);
        console.log("[project] Scheduled restart resume cancelled (turn already resumed) for session " + session.localId);
        return false;
      }
      return deferScheduledMessage(session, opts2, "turn in flight");
    }
    var scheduled = recordedScheduledMessage(session) || recoveredScheduledMessage(session);
    if (!scheduled || (!scheduled.text && !scheduled.displayText)) return false;
    if (!scheduled.text) scheduled.text = scheduled.displayText;
    if (!scheduled.displayText) scheduled.displayText = scheduled.text;
    clearRestartResumeState(session, scheduled.text, scheduled.displayText);
    session.rateLimitAutoContinuePending = false;
    console.log("[project] Scheduled message sent for session " + session.localId);
    dispatchScheduledMessage(session, scheduled.text, scheduled.displayText,
      scheduleDispatchOptions(opts2, scheduled), scheduled.imageRefs);
    return true;
  }

  function continueWithUsageCredits(session, text, promptText, displayLabel) {
    if (!session || !text || session.destroying || session.isProcessing ||
        scheduledTargetEnded(session) || !executionFence.isCurrent(session, "provider_start")) return false;
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
    if (!session || session.destroying || session.isProcessing ||
        scheduledTargetEnded(session) || !executionFence.isCurrent(session, "provider_start")) return false;
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
    if (!session || !text || !resetsAt || scheduledTargetEnded(session)) return false;
    if (opts2 && opts2.autoAction) session._suppressActivityBump = true;
    var sendText = promptText || text;
    var displayText = displayLabel || text;
    var isPastReset = resetsAt <= Date.now();
    var schedDelay = isPastReset ? 5000 : Math.max(0, resetsAt - Date.now()) + 60000;
    var sendsAt = Date.now() + schedDelay;
    var schedImageRefs = scheduledImageRefs(opts2);
    var schedCoopRouting = scheduledCoopRouting(opts2);
    var continuationIngressId = autoContinuationIngressId(session, opts2);
    var schedEntry = {
      type: "scheduled_message_queued",
      text: displayText,
      resetsAt: sendsAt,
      scheduledAt: Date.now(),
      autoAction: scheduledAutoAction(opts2),
    };
    attachContinuationIngress(schedEntry, continuationIngressId);
    coopWake.copy(schedEntry, opts2);
    if (schedImageRefs) schedEntry.imageRefs = schedImageRefs;
    if (schedCoopRouting) schedEntry.coopRouting = schedCoopRouting;
    if (!recordScheduled(sm, session, schedEntry)) return false;
    if (session.scheduledMessage && session.scheduledMessage.timer) {
      clearTimeout(session.scheduledMessage.timer);
    }
    session.scheduledMessage = {
      text: sendText,
      displayText: displayText,
      resetsAt: resetsAt,
      imageRefs: schedImageRefs,
      coopRouting: schedCoopRouting,
      autoAction: scheduledAutoAction(opts2),
      coopIngressId: continuationIngressId,
      timer: scheduledMessageTimer(session, text, schedDelay),
    };
    coopWake.copy(session.scheduledMessage, opts2);
    return true;
  }

  function restoreScheduledMessageTimer(session) {
    if (!session || session.destroying || session.scheduledMessage || scheduledTargetEnded(session)) return false;
    var openEntry = openScheduledMessageEntry(session);
    if (!openEntry) return false;
    var restored = restoredScheduledMessage(openEntry);
    if (!restored) return false;
    restored.timer = restoredScheduledMessageTimer(session, restored.delay);
    delete restored.delay;
    session.scheduledMessage = restored;
    console.log("[project] Restored scheduled message timer for session " + session.localId);
    return true;
  }

  function restoreScheduledMessageTimers() {
    sm.sessions.forEach(function (session) {
      restoreScheduledMessageTimer(session);
    });
  }

  function autoResumeRestartSession(session, options) {
    if (!session || scheduledTargetEnded(session) || !session.restartResumeEligible ||
        session.restartAutoContinueQueued) return;
    session.restartResumeEligible = false;
    var userInitiated = !!(options && options.userInitiated);
    var recent = userInitiated || (session.restartInterruptedAt
      && (Date.now() - session.restartInterruptedAt) < RESTART_RESUME_WINDOW_MS);
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
