var fs = require("fs");
var path = require("path");
var config = require("./config");

function latestDoneFromHistory(history) {
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (item && item.type === "done" && Number.isFinite(item._ts)) {
      return { index: i, timestamp: item._ts };
    }
  }
  return null;
}

function hasDispatchedUserMessageAfter(history, startIndex) {
  for (var j = startIndex + 1; j < history.length; j++) {
    var laterItem = history[j];
    if (laterItem && laterItem.type === "user_message" && !laterItem.queuedPending) return true;
  }
  return false;
}

function hasProviderActivityAfter(session, timestamp) {
  return Number.isFinite(session._lastStreamEventAt) && session._lastStreamEventAt > timestamp;
}

function hasStaleProcessingState(session) {
  if (!session || !session.isProcessing || !Array.isArray(session.history)) return false;
  var latestDone = latestDoneFromHistory(session.history);
  if (!latestDone) return false;

  // A dispatched user message after the terminal event proves that another
  // turn owns the processing flag. Pending queue entries do not.
  if (hasDispatchedUserMessageAfter(session.history, latestDone.index)) return false;

  // Every direct user dispatch records its start time before setting the busy
  // flag. If that start predates the latest authoritative `done`, the flag was
  // reasserted without a new turn and would otherwise trap the next message.
  if (Number.isFinite(session._queryStartTs)) return session._queryStartTs <= latestDone.timestamp;

  // Legacy dispatch paths may not have a query timestamp. Preserve a turn
  // that has emitted provider activity since the last completion.
  if (hasProviderActivityAfter(session, latestDone.timestamp)) return false;
  return true;
}

function clearStaleProcessingState(session) {
  if (!hasStaleProcessingState(session)) return false;
  session.isProcessing = false;
  return true;
}

function attachSessionQueuedMessages(ctx) {
  var encodedCwd = ctx.encodedCwd;

  function imagesFromRefs(imageRefs) {
    var out = [];
    if (!Array.isArray(imageRefs)) return out;
    var imagesDir = path.join(config.CONFIG_DIR, "images", encodedCwd);
    for (var i = 0; i < imageRefs.length; i++) {
      var ref = imageRefs[i];
      if (!ref || !ref.file) continue;
      try {
        var savedPath = path.join(imagesDir, ref.file);
        var data = fs.readFileSync(savedPath).toString("base64");
        out.push({ mediaType: ref.mediaType || "image/png", data: data, savedPath: savedPath });
      } catch (e) {}
    }
    return out;
  }

  function existingQueueById(session) {
    var existingById = {};
    var existingQueue = Array.isArray(session.pendingUserMessageQueue) ? session.pendingUserMessageQueue : [];
    for (var qi = 0; qi < existingQueue.length; qi++) {
      var existing = existingQueue[qi];
      if (existing && existing.queueId) existingById[existing.queueId] = existing;
    }
    return existingById;
  }

  function isPendingHistoryUserMessage(item) {
    if (!item || item.type !== "user_message" || !item.queueId) return false;
    return !!item.queuedPending || !!item.steerPending;
  }

  function imagesForPendingHistoryItem(live, item) {
    var images = live.images || item.images || null;
    if ((!images || images.length === 0) && item.imageRefs) return imagesFromRefs(item.imageRefs);
    return images;
  }

  function queueItemFromHistory(item, existingById) {
    var live = existingById[item.queueId] || {};
    return {
      queueId: item.queueId,
      text: live.text || item.text || "",
      images: imagesForPendingHistoryItem(live, item),
      pastes: live.pastes || item.pastes || null,
      displayText: item.text || "",
      imageCount: item.imageCount || 0,
      clientMessageId: item.clientMessageId || null,
      hidden: !!item.steerPending,
    };
  }

  function rebuildPendingUserMessageQueueFromHistory(session) {
    if (!session || !Array.isArray(session.history)) return;
    var existingById = existingQueueById(session);
    var nextQueue = [];
    for (var hi = 0; hi < session.history.length; hi++) {
      var item = session.history[hi];
      if (isPendingHistoryUserMessage(item)) nextQueue.push(queueItemFromHistory(item, existingById));
    }
    session.pendingUserMessageQueue = nextQueue;
  }

  function queuedUserMessagesForClient(session) {
    if (session && !Array.isArray(session.pendingUserMessageQueue)) {
      rebuildPendingUserMessageQueueFromHistory(session);
    }
    var out = [];
    var queue = session && session.pendingUserMessageQueue;
    if (!Array.isArray(queue)) return out;
    for (var i = 0; i < queue.length; i++) {
      var item = queue[i] || {};
      if (item.hidden) continue;
      out.push({
        queueId: item.queueId || "",
        text: item.displayText || "",
        imageCount: item.imageCount || 0,
        images: item.images || [],
        pastes: item.pastes || [],
        clientMessageId: item.clientMessageId || null,
      });
    }
    return out;
  }

  return {
    rebuildPendingUserMessageQueueFromHistory: rebuildPendingUserMessageQueueFromHistory,
    queuedUserMessagesForClient: queuedUserMessagesForClient,
  };
}

module.exports = {
  attachSessionQueuedMessages: attachSessionQueuedMessages,
  hasStaleProcessingState: hasStaleProcessingState,
  clearStaleProcessingState: clearStaleProcessingState,
};
