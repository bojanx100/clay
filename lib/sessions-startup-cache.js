var fs = require("fs");
var path = require("path");

var CACHE_VERSION = 2;
var FILE_NAME = ".startup-cache.json";

function createSessionsStartupCache(sessionsDir) {
  var filePath = path.join(sessionsDir, FILE_NAME);
  var entries = Object.create(null);
  var dirty = false;
  try {
    var parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && parsed.version === CACHE_VERSION && parsed.sessions) {
      entries = Object.assign(Object.create(null), parsed.sessions);
    }
  } catch (e) {}

  function lookup(storageId, stat) {
    var entry = storageId && entries[storageId];
    if (!entry || !stat || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) return null;
    return entry.summary || null;
  }

  function canCapture(session, metadata) {
    return !!(session && !session.isProcessing &&
      !session.restartResumeEligible &&
      !session.handoffContext && !(metadata && metadata.handoffContext) &&
      (!Array.isArray(session.pendingUserMessageQueue) ||
        session.pendingUserMessageQueue.length === 0));
  }

  function capture(session, stat, historyLength, metadata) {
    var storageId = session && (session.storageId || session.cliSessionId);
    if (!storageId || !stat || !canCapture(session, metadata)) return false;
    entries[storageId] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      summary: {
        historyLength: historyLength,
        lastActivity: session.lastActivity,
        lastActivityDerived: !!session._lastActivityDerived,
        cliSessionId: session.cliSessionId || null,
        vendor: session.vendor || null,
        providerRouteId: session.providerRouteId || null,
        model: session.model || null,
        messageUUIDs: session.messageUUIDs || [],
        historicalProviderIds: session._historicalProviderIds || [],
        interruptedByRestart: !!session.interruptedByRestart,
        handoffContextRecovered: !!session.handoffContextRecovered,
        handoffContextConsumed: !!session.handoffContextConsumed,
        copilotHandoffNativeReset: !!session.copilotHandoffNativeReset,
      },
    };
    dirty = true;
    return true;
  }

  function flush() {
    if (!dirty) return true;
    var tmpPath = filePath + ".tmp." + process.pid;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify({
        version: CACHE_VERSION,
        sessions: entries,
      }) + "\n", { mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
      dirty = false;
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (unlinkErr) {}
      return false;
    }
  }

  return {
    lookup: lookup,
    capture: capture,
    flush: flush,
  };
}

module.exports = {
  createSessionsStartupCache: createSessionsStartupCache,
};
