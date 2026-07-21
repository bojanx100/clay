// Stream deltas are persisted as individual events, so 100 raw entries can
// represent only a fragment of one assistant reply. A wider bounded window
// keeps several complete recent turns available to scroll in normal sessions.
var HISTORY_PAGE_SIZE = 300;

function findTurnBoundary(history, targetIndex) {
  // Preserve nearby turn context without letting one huge turn defeat paging.
  var floorIndex = Math.max(0, targetIndex - HISTORY_PAGE_SIZE);
  for (var i = targetIndex; i >= floorIndex; i--) {
    if (history[i] && history[i].type === "user_message") return i;
  }
  return targetIndex;
}

function isAssistantReplayEvent(item) {
  if (!item || !item.type) return false;
  return item.type === "thinking_start" ||
    item.type === "thinking_delta" ||
    item.type === "thinking_stop" ||
    item.type === "delta" ||
    item.type === "delta_replace" ||
    item.type === "tool_start" ||
    item.type === "tool_executing" ||
    item.type === "tool_result" ||
    item.type === "permission_request" ||
    item.type === "permission_request_pending" ||
    item.type === "permission_cancel" ||
    item.type === "permission_resolved" ||
    item.type === "elicitation_request" ||
    item.type === "elicitation_resolved" ||
    item.type === "subagent_activity" ||
    item.type === "subagent_tool";
}

function attachSessionHistory(ctx) {
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var isMeaninglessUnknownError = ctx.isMeaninglessUnknownError;

  function replayHistory(session, fromIndex, targetWs, transform) {
    var _send = (targetWs && sendTo) ? function (obj) { sendTo(targetWs, obj); } : send;
    var total = session.history.length;
    if (typeof fromIndex !== "number") {
      if (total <= HISTORY_PAGE_SIZE) {
        fromIndex = 0;
      } else {
        fromIndex = findTurnBoundary(session.history, Math.max(0, total - HISTORY_PAGE_SIZE));
      }
    }

    _send({ type: "history_meta", total: total, from: fromIndex });

    var assistantTurnOpen = false;
    var queuedUserMessages = [];
    function sendReplayItem(item) {
      _send(transform ? transform(item) : item);
    }
    function flushQueuedUserMessages() {
      for (var qi = 0; qi < queuedUserMessages.length; qi++) {
        sendReplayItem(queuedUserMessages[qi]);
      }
      queuedUserMessages = [];
    }
    var scheduledMessageClosed = false;
    for (var si = total - 1; si >= fromIndex; si--) {
      var scheduledItem = session.history[si];
      if (!scheduledItem) continue;
      if (scheduledItem.type === "scheduled_message_sent" || scheduledItem.type === "scheduled_message_cancelled" || scheduledItem.type === "vendor_switched") {
        scheduledMessageClosed = true;
        break;
      }
      if (scheduledItem.type === "scheduled_message_queued") break;
    }

    for (var i = fromIndex; i < total; i++) {
      var _item = session.history[i];
      if (_item && _item.type === "digest_checkpoint") continue;
      if (isMeaninglessUnknownError(_item)) continue;
      if (_item && _item.type === "user_message" && _item.queuedPending) continue;
      if (_item && _item.type === "scheduled_message_queued" && scheduledMessageClosed) continue;
      if (_item && (_item.type === "mention_user" || _item.type === "mention_response")) {
        console.log("[DEBUG replayHistory] sending mention at index=" + i + " from=" + fromIndex + " total=" + total + " type=" + _item.type + " mate=" + (_item.mateName || ""));
      }
      if (_item && _item.type === "user_message") {
        if (_item.queuedDuringProcessing && assistantTurnOpen) {
          queuedUserMessages.push(_item);
          continue;
        }
        sendReplayItem(_item);
        continue;
      }
      if (_item && _item.type === "done") {
        sendReplayItem(_item);
        assistantTurnOpen = false;
        flushQueuedUserMessages();
        continue;
      }
      if (_item && _item.type === "vendor_switched") {
        assistantTurnOpen = false;
        flushQueuedUserMessages();
        sendReplayItem(_item);
        continue;
      }
      if (isAssistantReplayEvent(_item)) {
        assistantTurnOpen = true;
      }
      sendReplayItem(_item);
    }
    flushQueuedUserMessages();

    var lastUsage = null;
    var lastModelUsage = null;
    var lastCost = null;
    var lastStreamInputTokens = null;
    for (var j = total - 1; j >= 0; j--) {
      if (session.history[j].type === "result") {
        var r = session.history[j];
        lastUsage = r.usage || null;
        lastModelUsage = r.modelUsage || null;
        lastCost = r.cost != null ? r.cost : null;
        lastStreamInputTokens = r.lastStreamInputTokens || null;
        break;
      }
    }

    _send({ type: "history_done", lastUsage: lastUsage, lastModelUsage: lastModelUsage, lastCost: lastCost, lastStreamInputTokens: lastStreamInputTokens, contextUsage: session.lastContextUsage || null });
    if (targetWs) targetWs._clayDeliveredLen = session.history.length;
  }

  return {
    HISTORY_PAGE_SIZE: HISTORY_PAGE_SIZE,
    findTurnBoundary: findTurnBoundary,
    replayHistory: replayHistory,
  };
}

module.exports = {
  HISTORY_PAGE_SIZE: HISTORY_PAGE_SIZE,
  findTurnBoundary: findTurnBoundary,
  isAssistantReplayEvent: isAssistantReplayEvent,
  attachSessionHistory: attachSessionHistory,
};
