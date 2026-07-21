var fs = require("fs");
var path = require("path");
var config = require("./config");

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
    queuedUserMessagesForClient: queuedUserMessagesForClient,
  };
}

module.exports = {
  attachSessionQueuedMessages: attachSessionQueuedMessages,
};
