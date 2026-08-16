var hasOwn = Object.prototype.hasOwnProperty;
var coopIngressQueue = require("./coop-ingress-queue");
function makeQueueId() {
  return "q-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function findQueuedHistoryMessage(session, queueId) {
  if (!session || !queueId || !session.history) return null;
  for (var i = session.history.length - 1; i >= 0; i--) {
    var item = session.history[i];
    if (item && item.type === "user_message" && item.queueId === queueId) return item;
  }
  return null;
}

function markQueuedHistoryAsSteered(session, queueId, sm) {
  var item = findQueuedHistoryMessage(session, queueId);
  if (!item) return null;
  delete item.queuedDuringProcessing;
  delete item.queuedPending;
  item.steerDuringProcessing = true;
  item.steerPending = true;
  item._ts = Date.now();
  sm.saveSessionFile(session);
  return item;
}

function markQueuedHistoryAsCoordinated(session, queueId, sm) {
  var item = markQueuedHistoryAsSteered(session, queueId, sm);
  if (!item) return null;
  item.coordinationRequest = true;
  sm.saveSessionFile(session);
  return item;
}

function markQueuedHistoryAsDispatched(session, queueId, sm) {
  var item = findQueuedHistoryMessage(session, queueId);
  if (!item) return null;
  delete item.queuedDuringProcessing;
  delete item.queuedPending;
  delete item.steerPending;
  item._ts = Date.now();
  sm.saveSessionFile(session);
  return item;
}

function removeQueuedHistoryMessage(session, queueId, sm) {
  if (!session || !queueId || !session.history) return false;
  var removed = false;
  var nextHistory = [];
  for (var i = 0; i < session.history.length; i++) {
    var item = session.history[i];
    if (item && item.type === "user_message" && item.queueId === queueId) {
      removed = true;
      continue;
    }
    nextHistory.push(item);
  }
  if (removed) {
    session.history = nextHistory;
    sm.saveSessionFile(session);
  }
  return removed;
}

function hasActiveTaskState(session) {
  if (!session) return false;
  return !!(session.compacting ||
    (session.blocks && Object.keys(session.blocks).length > 0) ||
    (session.activeTaskToolIds && Object.keys(session.activeTaskToolIds).length > 0) ||
    (session.taskIdMap && Object.keys(session.taskIdMap).length > 0));
}

function hasQueuedUserMessageDispatchBlocker(session) {
  if (!session) return true;
  return !!(session.destroying ||
    session.isProcessing ||
    session.taskStopRequested ||
    session.providerFailoverPending ||
    session._providerFailoverQueued ||
    session._providerFailoverClosing ||
    (session.scheduledMessage && session.scheduledMessage.autoAction) ||
    session.restartAutoContinueQueued ||
    session.rateLimitAutoContinuePending ||
    session.rateLimitUseCreditsPending ||
    (session.rateLimitResetsAt && session.rateLimitResetsAt > Date.now()) ||
    hasActiveTaskState(session));
}

function buildQueuedItem(finalText, images, queueId, displayText, imageCount, clientMessageId, pastes, options) {
  return {
    queueId: queueId,
    text: finalText || "",
    images: images || null,
    pastes: pastes || null,
    displayText: displayText || "",
    imageCount: imageCount || 0,
    clientMessageId: clientMessageId || null,
    hidden: !!options.hidden,
    // Carried so a turn that is queued now and dispatched later still knows
    // WHO sent it. The Done-workflow gate authorizes on the real sender, and a
    // replayed turn that lost its actor would silently fail that check.
    actorUserId: options.actorUserId || null,
  };
}

function sendQueueNotification(session, item, options, deps) {
  if (!options.silent) {
    deps.sendToSession(session.localId, {
      type: "queued_user_message",
      queueId: item.queueId,
      text: item.displayText,
      imageCount: item.imageCount,
      images: item.images,
      pastes: item.pastes,
      clientMessageId: item.clientMessageId,
    });
  }
  deps.sendQueuedUserMessagesState(session);
  deps.sm.broadcastSessionList();
}

function queuePreparedMessage(session, finalText, images, queueId, displayText, imageCount, clientMessageId, pastes, options, deps) {
  options = options || {};
  if (!session.pendingUserMessageQueue) session.pendingUserMessageQueue = [];
  var resolvedQueueId = queueId || makeQueueId();
  var item = buildQueuedItem(
    finalText, images, resolvedQueueId, displayText, imageCount, clientMessageId, pastes, options);
  if (options.front) session.pendingUserMessageQueue.unshift(item);
  else session.pendingUserMessageQueue.push(item);
  sendQueueNotification(session, item, options, deps);
}

function recentTurnHadApiError(session) {
  if (!session || !Array.isArray(session.history)) return false;
  var sawApiError = false;
  var skippedCurrentUserMessage = false;
  for (var i = session.history.length - 1; i >= 0; i--) {
    var item = session.history[i] || {};
    if (item.type === "user_message") {
      if (!skippedCurrentUserMessage) {
        skippedCurrentUserMessage = true;
        continue;
      }
      return sawApiError;
    }
    var text = item.text || item.content || "";
    if ((item.type === "delta" || item.type === "error") && /^API Error:/i.test(String(text).trim())) {
      sawApiError = true;
    } else if (item.type === "error" && / API error: API Error:/i.test(String(text))) {
      sawApiError = true;
    }
  }
  return sawApiError;
}

function shouldRetryAfterApiError(session, userText) {
  var text = String(userText || "").trim().toLowerCase();
  if (!text || !["continue", "continue.", "keep going", "go on"].includes(text)) return false;
  return recentTurnHadApiError(session);
}

function queueTaskMessage(session, finalText, images, displayText, pastes, deps) {
  deps.coordinateQueuedMessage(session, {
    text: finalText,
    displayText: displayText || finalText,
    images: images || null,
    pastes: pastes || null,
  });
  deps.sm.saveSessionFile(session);
  return true;
}

function queueNormalMessage(session, args, deps) {
  queuePreparedMessage(session, args.finalText, args.images, args.queueId,
    args.displayText, args.imageCount, args.clientMessageId, args.pastes,
    { actorUserId: args.actorUserId || null }, deps);
  return true;
}

function interruptWithSteer(session, args, deps) {
  var queueId = args.queueId || makeQueueId();
  queuePreparedMessage(session, args.finalText, args.images, queueId,
    args.displayText, args.imageCount, args.clientMessageId, args.pastes,
    { front: true, actorUserId: args.actorUserId || null }, deps);
  session.steerInterruptRequested = true;
  session.taskStopRequested = true;
  deps.sm.saveSessionFile(session);
  if (session.abortController) session.abortController.abort();
  return true;
}

function dispatchTaskOrQueue(session, args, deps) {
  if (args.intent === "task" && deps.coordinateQueuedMessage) {
    return queueTaskMessage(session, args.finalText, args.images, args.displayText, args.pastes, deps);
  }
  if (!args.steer && !args.fromQueue &&
      (args.intent === "queue" || deps.shouldQueueDuringProcessing(session))) {
    return queueNormalMessage(session, args, deps);
  }
  return false;
}

function sendPreparedToSdk(session, args, deps) {
  var taskDirective = deps.onUserMessageDispatched(
    session, args.displayText || args.finalText || "", args.actorUserId || null);
  var finalText = taskDirective ? (args.finalText || "") + "\n\n" + taskDirective : args.finalText;
  session._consecutiveAutoResumes = 0;
  session._resumeGaveUpNotified = false;
  session._suppressActivityBump = false;
  if (!session.isProcessing) {
    session._queryStartTs = Date.now();
    session.isProcessing = true;
    deps.onProcessingChanged();
    session.sentToolResults = {};
    deps.sendToSession(session.localId, { type: "status", status: "processing" });
    if (!session.queryInstance && (!session.worker || session.messageQueue !== "worker")) {
      console.log("[PERF] project.js: startQuery called, localId=" + session.localId + " t=0ms");
      deps.sdk.startQuery(session, finalText, args.images, deps.ensureProjectAccessForSession(session));
    } else {
      deps.sdk.pushMessage(session, finalText, args.images);
    }
  } else {
    deps.sdk.pushMessage(session, finalText, args.images);
  }
  deps.sm.broadcastSessionList();
}

function dispatchPreparedToSdk(session, args, deps) {
  try {
    console.log("[clay-paste] dispatchPreparedToSdk: session=" + session.localId +
      " steer=" + (args.steer === true) + " isProcessing=" + !!session.isProcessing +
      " finalTextLen=" + ((args.finalText || "").length) +
      " pastes=" + ((args.pastes && args.pastes.length) || 0));
  } catch (e) {}
  if (args.coopIngress && !args.coopDispatching) {
    coopIngressQueue.enqueue(session, args, deps, sendPreparedToSdk);
    return;
  }
  if (dispatchTaskOrQueue(session, args, deps)) return;
  if (args.steer && session.isProcessing) {
    interruptWithSteer(session, args, deps);
    return;
  }
  sendPreparedToSdk(session, args, deps);
}

function attachProjectUserMessageQueue(ctx) {
  var sm = ctx.sm;
  var deps = {
    sm: sm,
    sdk: ctx.sdk,
    sendToSession: ctx.sendToSession,
    hydrateImageRefs: ctx.hydrateImageRefs || function (item) { return item; },
    onProcessingChanged: ctx.onProcessingChanged,
    onUserMessageDispatched: ctx.onUserMessageDispatched || function () { return ""; },
    coordinateQueuedMessage: ctx.coordinateQueuedMessage || null,
    ensureProjectAccessForSession: ctx.ensureProjectAccessForSession,
    coopControl: ctx.coopControl || null,
    cancelScheduledMessage: ctx.cancelScheduledMessage || null,
  };

  function sendQueuedUserMessagesState(session) {
    if (!session) return;
    deps.sendToSession(session.localId, {
      type: "queued_user_messages_state",
      queueingDisabled: !!session.queueingDisabled,
      queuedUserMessages: sm.queuedUserMessagesForClient ? sm.queuedUserMessagesForClient(session) : [],
    });
  }

  deps.sendQueuedUserMessagesState = sendQueuedUserMessagesState;

  function shouldQueueDuringProcessing(session) {
    return !!(session && (session.isProcessing ||
      (Array.isArray(session.pendingUserMessageQueue) && session.pendingUserMessageQueue.length > 0)));
  }

  deps.shouldQueueDuringProcessing = shouldQueueDuringProcessing;

  function clearQueuedFlushTimer(session) {
    if (!session || !session._queuedFlushTimer) return;
    clearTimeout(session._queuedFlushTimer);
    session._queuedFlushTimer = null;
  }

  function queuedFlushQuietFor(session) {
    var lastEventAt = session && session._lastStreamEventAt ? session._lastStreamEventAt : 0;
    return lastEventAt ? Date.now() - lastEventAt : 300;
  }

  function flushQueuedUserMessage(session) {
    clearQueuedFlushTimer(session);
    if (!session || session.destroying) return false;
    if (hasQueuedUserMessageDispatchBlocker(session)) {
      scheduleQueuedUserMessageFlush(session);
      return false;
    }
    if (!session.pendingUserMessageQueue || session.pendingUserMessageQueue.length === 0) {
      sendQueuedUserMessagesState(session);
      return false;
    }
    var next = session.pendingUserMessageQueue.shift();
    try {
      console.log("[clay-paste] flushQueuedUserMessage: session=" + session.localId +
        " queueId=" + next.queueId + " textLen=" + ((next.text || "").length) +
        " pastes=" + ((next.pastes && next.pastes.length) || 0) + " hidden=" + !!next.hidden);
    } catch (e) {}
    deps.sendToSession(session.localId, { type: "queued_user_message_removed", queueId: next.queueId });
    var queuedHistoryItem = markQueuedHistoryAsDispatched(session, next.queueId, sm);
    sendQueuedUserMessagesState(session);
    if (queuedHistoryItem && !queuedHistoryItem.steerDuringProcessing && !next.hidden) {
      deps.sendToSession(session.localId, deps.hydrateImageRefs(queuedHistoryItem));
    }
    dispatchPreparedToSdk(session, {
      finalText: next.text,
      images: next.images,
      steer: false,
      queueId: next.queueId,
      displayText: next.displayText,
      imageCount: next.imageCount,
      clientMessageId: next.clientMessageId,
      pastes: next.pastes,
      actorUserId: next.actorUserId || null,
      fromQueue: true,
      intent: null,
    }, deps);
    return true;
  }

  function scheduleQueuedUserMessageFlush(session) {
    if (!session || session.destroying || session._queuedFlushTimer) return false;
    session._queuedFlushTimer = setTimeout(function () {
      session._queuedFlushTimer = null;
      if (session.destroying) return;
      if (!session.pendingUserMessageQueue || session.pendingUserMessageQueue.length === 0) {
        sendQueuedUserMessagesState(session);
        return;
      }
      if (hasQueuedUserMessageDispatchBlocker(session)) {
        scheduleQueuedUserMessageFlush(session);
        return;
      }
      if (queuedFlushQuietFor(session) < 300) {
        scheduleQueuedUserMessageFlush(session);
        return;
      }
      flushQueuedUserMessage(session);
    }, 100);
    if (session._queuedFlushTimer.unref) session._queuedFlushTimer.unref();
    return true;
  }

  return {
    makeQueueId: makeQueueId,
    findQueuedHistoryMessage: findQueuedHistoryMessage,
    markQueuedHistoryAsSteered: function (session, id) { return markQueuedHistoryAsSteered(session, id, sm); },
    markQueuedHistoryAsCoordinated: function (session, id) { return markQueuedHistoryAsCoordinated(session, id, sm); },
    markQueuedHistoryAsDispatched: function (session, id) { return markQueuedHistoryAsDispatched(session, id, sm); },
    removeQueuedHistoryMessage: function (session, id) { return removeQueuedHistoryMessage(session, id, sm); },
    sendQueuedUserMessagesState: sendQueuedUserMessagesState,
    shouldQueueDuringProcessing: shouldQueueDuringProcessing,
    queuePreparedMessage: function (session, finalText, images, queueId, displayText, imageCount, clientMessageId, pastes, options) {
      return queuePreparedMessage(session, finalText, images, queueId, displayText, imageCount, clientMessageId, pastes, options, deps);
    },
    dispatchPreparedToSdk: function (session, args) { return dispatchPreparedToSdk(session, args, deps); },
    shouldRetryAfterApiError: shouldRetryAfterApiError,
    flushQueuedUserMessage: flushQueuedUserMessage,
    flushCoopIngress: function (session) {
      return coopIngressQueue.flush(session, deps, sendPreparedToSdk);
    },
    rebuildCoopIngressFromHistory: function (session) {
      return coopIngressQueue.rebuildFromHistory(session, deps);
    },
    scheduleQueuedUserMessageFlush: scheduleQueuedUserMessageFlush,
  };
}

module.exports = {
  attachProjectUserMessageQueue: attachProjectUserMessageQueue,
  makeQueueId: makeQueueId,
  queuePreparedMessage: queuePreparedMessage,
  dispatchPreparedToSdk: dispatchPreparedToSdk,
  shouldRetryAfterApiError: shouldRetryAfterApiError,
  hasActiveTaskState: hasActiveTaskState,
  hasQueuedUserMessageDispatchBlocker: hasQueuedUserMessageDispatchBlocker,
  rebuildCoopIngressFromHistory: coopIngressQueue.rebuildFromHistory, hasOwn: hasOwn,
};
