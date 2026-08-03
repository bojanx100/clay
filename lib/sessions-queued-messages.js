var fs = require("fs");
var path = require("path");
var config = require("./config");

function hasStaleProcessingState(session) {
  if (!session || !session.isProcessing || !Array.isArray(session.history)) return false;
  var doneIndex = -1;
  var doneAt = 0;
  for (var i = session.history.length - 1; i >= 0; i--) {
    var item = session.history[i];
    if (item && item.type === "done" && Number.isFinite(item._ts)) {
      doneIndex = i;
      doneAt = item._ts;
      break;
    }
  }
  if (doneIndex < 0) return false;

  // A dispatched user message after the terminal event proves that another
  // turn owns the processing flag. Pending queue entries do not.
  for (var j = doneIndex + 1; j < session.history.length; j++) {
    var laterItem = session.history[j];
    if (laterItem && laterItem.type === "user_message" && !laterItem.queuedPending) return false;
  }

  // Every direct user dispatch records its start time before setting the busy
  // flag. If that start predates the latest authoritative `done`, the flag was
  // reasserted without a new turn and would otherwise trap the next message.
  if (Number.isFinite(session._queryStartTs)) {
    return session._queryStartTs <= doneAt;
  }

  // Legacy dispatch paths may not have a query timestamp. Preserve a turn
  // that has emitted provider activity since the last completion.
  if (Number.isFinite(session._lastStreamEventAt) && session._lastStreamEventAt > doneAt) return false;
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
        var data = fs.readFileSync(path.join(imagesDir, ref.file)).toString("base64");
        out.push({ mediaType: ref.mediaType || "image/png", data: data });
      } catch (e) {}
    }
    return out;
  }

  function rebuildPendingUserMessageQueueFromHistory(session) {
    if (!session || !Array.isArray(session.history)) return;
    var existingById = {};
    var existingQueue = Array.isArray(session.pendingUserMessageQueue) ? session.pendingUserMessageQueue : [];
    for (var qi = 0; qi < existingQueue.length; qi++) {
      var existing = existingQueue[qi];
      if (existing && existing.queueId) existingById[existing.queueId] = existing;
    }
    var nextQueue = [];
    for (var hi = 0; hi < session.history.length; hi++) {
      var item = session.history[hi];
      if (!item || item.type !== "user_message" || !item.queueId || (!item.queuedPending && !item.steerPending)) continue;
      var live = existingById[item.queueId] || {};
      var images = live.images || item.images || null;
      if ((!images || images.length === 0) && item.imageRefs) {
        images = imagesFromRefs(item.imageRefs);
      }
      nextQueue.push({
        queueId: item.queueId,
        text: live.text || item.text || "",
        images: images,
        pastes: live.pastes || item.pastes || null,
        displayText: item.text || "",
        imageCount: item.imageCount || 0,
        clientMessageId: item.clientMessageId || null,
        hidden: !!item.steerPending,
      });
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
};
