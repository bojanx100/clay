// Stream deltas are persisted as individual events, so 100 raw entries can
// represent only a fragment of one assistant reply. A wider bounded window
// keeps several complete recent turns available to scroll in normal sessions.
var HISTORY_PAGE_SIZE = 300;
var coopSessionHistory = require("./coop-session-history");

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

function normalizedEventIndexes(history, values) {
  var source = Array.isArray(values) ? values : [];
  var seen = {};
  var indexes = [];
  for (var i = 0; i < source.length; i++) {
    var index = source[i];
    if (!Number.isInteger(index) || index < 0 || index >= history.length || seen[index]) continue;
    seen[index] = true;
    indexes.push(index);
  }
  indexes.sort(function (a, b) { return a - b; });
  return indexes;
}

function indexedTurnBoundary(history, indexes, targetOffset) {
  var floorOffset = Math.max(0, targetOffset - HISTORY_PAGE_SIZE);
  for (var i = targetOffset; i >= floorOffset; i--) {
    var item = history[indexes[i]];
    if (item && item.type === "user_message") return i;
  }
  return targetOffset;
}

function indexedHistoryPage(history, values, beforeOffset, targetOffset, transform, options) {
  var canonical = Array.isArray(history) ? history : [];
  var indexes = normalizedEventIndexes(canonical, values);
  if (!Number.isInteger(beforeOffset)) return null;
  var to = Math.max(0, Math.min(indexes.length, beforeOffset));
  var requested = Number.isInteger(targetOffset) ? targetOffset : to - HISTORY_PAGE_SIZE;
  var target = Math.max(0, Math.min(to, requested));
  var from = target < to ? indexedTurnBoundary(canonical, indexes, target) : target;
  var opts = options || {};
  var items = [];
  for (var i = from; i < to; i++) {
    var canonicalIndex = indexes[i];
    var item = canonical[canonicalIndex];
    if (!item || item.internalOnly || item.type === "digest_checkpoint" ||
        item.type === "user_message" && item.queuedPending) continue;
    var prepared = transform ? transform(item, canonicalIndex) : item;
    if (prepared == null) continue;
    if (opts.annotateHistoryIndex) prepared = Object.assign({}, prepared, { _historyIndex: canonicalIndex });
    items.push(prepared);
  }
  return {
    items: items,
    meta: {
      from: from,
      to: to,
      hasMore: from > 0,
      scope: opts.scope || "topic",
      topicRef: opts.topicRef || null,
      projectRef: opts.projectRef || null,
      canonicalTotal: canonical.length,
    },
  };
}

function attachSessionHistory(ctx) {
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var isMeaninglessUnknownError = ctx.isMeaninglessUnknownError;
  var sessions = ctx.sessions;

  function getHistoryView(session) {
    return coopSessionHistory.forSession(session, sessions);
  }

  function replayHistory(session, fromIndex, targetWs, transform, replayOptions) {
    var _send = (targetWs && sendTo) ? function (obj) { sendTo(targetWs, obj); } : send;
    var options = replayOptions || {};
    var historyView = options.historyView || getHistoryView(session);
    var history = historyView.history;
    var canonicalTotal = history.length;
    var indexed = Array.isArray(options.eventIndexes);
    var eventIndexes = indexed ? normalizedEventIndexes(history, options.eventIndexes) : null;
    var total = indexed ? eventIndexes.length : canonicalTotal;
    var replayFrom;
    var replayTo;

    if (indexed) {
      replayFrom = Number.isInteger(options.fromOffset) ? options.fromOffset : Math.max(0, total - HISTORY_PAGE_SIZE);
      replayFrom = Math.max(0, Math.min(total, replayFrom));
      if (!Number.isInteger(options.fromOffset) && replayFrom < total) {
        replayFrom = indexedTurnBoundary(history, eventIndexes, replayFrom);
      }
      replayTo = Number.isInteger(options.toOffset) ? options.toOffset : total;
      replayTo = Math.max(replayFrom, Math.min(total, replayTo));
    } else if (Number.isInteger(options.focusEventIndex) && canonicalTotal > 0) {
      var focus = Math.max(0, Math.min(canonicalTotal - 1, options.focusEventIndex));
      replayFrom = findTurnBoundary(history, Math.max(0, focus - Math.floor(HISTORY_PAGE_SIZE / 2)));
      replayTo = Math.min(canonicalTotal, replayFrom + HISTORY_PAGE_SIZE);
      if (focus >= replayTo) {
        replayFrom = Math.max(0, focus - HISTORY_PAGE_SIZE + 1);
        replayTo = Math.min(canonicalTotal, replayFrom + HISTORY_PAGE_SIZE);
      }
    } else {
      replayFrom = fromIndex;
      if (typeof replayFrom !== "number") {
        replayFrom = total <= HISTORY_PAGE_SIZE
          ? 0
          : findTurnBoundary(history, Math.max(0, total - HISTORY_PAGE_SIZE));
      }
      replayTo = total;
    }

    var meta = { type: "history_meta", total: total, from: replayFrom };
    if (indexed) {
      meta.scope = options.scope || "topic";
      meta.topicRef = options.topicRef || null;
      meta.projectRef = options.projectRef || null;
      meta.canonicalTotal = canonicalTotal;
    }
    if (Number.isInteger(options.focusEventIndex)) meta.focusEventIndex = options.focusEventIndex;
    _send(meta);

    function replayEntryAt(offset) {
      var canonicalIndex = indexed ? eventIndexes[offset] : offset;
      return { item: history[canonicalIndex], canonicalIndex: canonicalIndex };
    }

    var assistantTurnOpen = false;
    var queuedUserMessages = [];
    function sendReplayEntry(entry) {
      var prepared = transform ? transform(entry.item, entry.canonicalIndex) : entry.item;
      if (prepared == null) return;
      if (options.annotateHistoryIndex) {
        prepared = Object.assign({}, prepared, { _historyIndex: entry.canonicalIndex });
      }
      _send(prepared);
    }
    function flushQueuedUserMessages() {
      for (var qi = 0; qi < queuedUserMessages.length; qi++) {
        sendReplayEntry(queuedUserMessages[qi]);
      }
      queuedUserMessages = [];
    }
    var scheduledMessageClosed = false;
    for (var si = replayTo - 1; si >= replayFrom; si--) {
      var scheduledItem = replayEntryAt(si).item;
      if (!scheduledItem) continue;
      if (scheduledItem.type === "scheduled_message_sent" || scheduledItem.type === "scheduled_message_cancelled" || scheduledItem.type === "vendor_switched") {
        scheduledMessageClosed = true;
        break;
      }
      if (scheduledItem.type === "scheduled_message_queued") break;
    }

    for (var i = replayFrom; i < replayTo; i++) {
      var entry = replayEntryAt(i);
      var _item = entry.item;
      if (_item && _item.internalOnly) continue;
      if (_item && _item.type === "digest_checkpoint") continue;
      if (isMeaninglessUnknownError(_item)) continue;
      if (_item && _item.type === "user_message" && _item.queuedPending) continue;
      if (_item && _item.type === "scheduled_message_queued" && scheduledMessageClosed) continue;
      if (_item && (_item.type === "mention_user" || _item.type === "mention_response")) {
        console.log("[DEBUG replayHistory] sending mention at index=" + entry.canonicalIndex + " from=" + replayFrom + " total=" + total + " type=" + _item.type + " mate=" + (_item.mateName || ""));
      }
      if (_item && _item.type === "user_message") {
        if (_item.queuedDuringProcessing && assistantTurnOpen) {
          queuedUserMessages.push(entry);
          continue;
        }
        sendReplayEntry(entry);
        continue;
      }
      if (_item && _item.type === "done") {
        sendReplayEntry(entry);
        assistantTurnOpen = false;
        flushQueuedUserMessages();
        continue;
      }
      if (_item && _item.type === "vendor_switched") {
        assistantTurnOpen = false;
        flushQueuedUserMessages();
        sendReplayEntry(entry);
        continue;
      }
      if (isAssistantReplayEvent(_item)) assistantTurnOpen = true;
      sendReplayEntry(entry);
    }
    flushQueuedUserMessages();

    var lastUsage = null;
    var lastModelUsage = null;
    var lastCost = null;
    var lastStreamInputTokens = null;
    for (var j = canonicalTotal - 1; j >= 0; j--) {
      if (history[j] && history[j].type === "result") {
        var r = history[j];
        lastUsage = r.usage || null;
        lastModelUsage = r.modelUsage || null;
        lastCost = r.cost != null ? r.cost : null;
        lastStreamInputTokens = r.lastStreamInputTokens || null;
        break;
      }
    }

    _send({
      type: "history_done",
      lastUsage: lastUsage,
      lastModelUsage: lastModelUsage,
      lastCost: lastCost,
      lastStreamInputTokens: lastStreamInputTokens,
      contextUsage: session.lastContextUsage || null,
      scope: indexed ? options.scope || "topic" : "all",
      focusEventIndex: Number.isInteger(options.focusEventIndex) ? options.focusEventIndex : null,
    });
    if (targetWs) targetWs._clayDeliveredLen = canonicalTotal;
  }

  return {
    HISTORY_PAGE_SIZE: HISTORY_PAGE_SIZE,
    findTurnBoundary: findTurnBoundary,
    getHistoryView: getHistoryView,
    replayHistory: replayHistory,
  };
}

module.exports = {
  HISTORY_PAGE_SIZE: HISTORY_PAGE_SIZE,
  findTurnBoundary: findTurnBoundary,
  indexedHistoryPage: indexedHistoryPage,
  isAssistantReplayEvent: isAssistantReplayEvent,
  attachSessionHistory: attachSessionHistory,
};
