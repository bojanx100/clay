var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");

function stopCoopSelfCleanup(timers) {
  if (!timers) return;
  if (timers.coopSelfCleanupRuntime && typeof timers.coopSelfCleanupRuntime.stop === "function") {
    try { timers.coopSelfCleanupRuntime.stop(); } catch (e) {}
    timers.coopSelfCleanupRuntime = null;
    return;
  }
  if (timers.coopSelfCleanupTimer) {
    clearInterval(timers.coopSelfCleanupTimer);
    timers.coopSelfCleanupTimer = null;
  }
}

function stopTaskOrchestrator(getTaskOrchestrator) {
  if (typeof getTaskOrchestrator !== "function") return;
  var taskOrchestrator = getTaskOrchestrator();
  if (taskOrchestrator && typeof taskOrchestrator.stopCoopWatchdog === "function") {
    try { taskOrchestrator.stopCoopWatchdog(); } catch (e) {}
  }
}

function stopLiveUi(liveUi) {
  if (!liveUi || typeof liveUi.dispose !== "function") return;
  try { liveUi.dispose(); } catch (e) {}
}

function closeSessionResources(session) {
  if (session.abortController) {
    try { session.abortController.abort(); } catch (e) {}
  }
  if (session.queryInstance && typeof session.queryInstance.close === "function") {
    try { session.queryInstance.close(); } catch (e) {}
  }
  session.queryInstance = null;
  if (session.messageQueue) {
    try { session.messageQueue.end(); } catch (e) {}
  }
  if (session.worker) {
    try { session.worker.kill(); } catch (e) {}
    session.worker = null;
  }
}

function closeMentionSessions(session) {
  if (!session._mentionSessions) return;
  var mateIds = Object.keys(session._mentionSessions);
  for (var mi = 0; mi < mateIds.length; mi++) {
    try { session._mentionSessions[mateIds[mi]].close(); } catch (e) {}
  }
  session._mentionSessions = {};
}

function destroySessionRuntime(session) {
  session.destroying = true;
  if (session.autoContinueTimer) {
    clearTimeout(session.autoContinueTimer);
    session.autoContinueTimer = null;
  }
  if (session.scheduledMessage && session.scheduledMessage.timer) {
    clearTimeout(session.scheduledMessage.timer);
    session.scheduledMessage = null;
  }
  if (session._providerFailoverTimer) {
    clearTimeout(session._providerFailoverTimer);
    session._providerFailoverTimer = null;
  }
  closeSessionResources(session);
  closeMentionSessions(session);
}

function createProjectDestroy(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var timers = ctx.timers;
  var loop = ctx.loop;
  var email = ctx.email;
  var mateDatastore = ctx.mateDatastore;
  var stopFileWatch = ctx.stopFileWatch;
  var stopAllDirWatches = ctx.stopAllDirWatches;
  var sm = ctx.sm;
  var tm = ctx.tm;
  var clients = ctx.clients;
  var adapters = ctx.adapters;
  var sdk = ctx.sdk;
  var getTaskOrchestrator = ctx.getTaskOrchestrator;

  function destroy(liveUi) {
    stopCoopSelfCleanup(timers);
    stopLiveUi(liveUi);
    sdk.stopIdleReaper();
    stopTaskOrchestrator(getTaskOrchestrator);
    if (timers.restoredScheduledTimer) {
      clearTimeout(timers.restoredScheduledTimer);
      timers.restoredScheduledTimer = null;
    }
    if (timers.externalCodexSyncTimer) {
      clearInterval(timers.externalCodexSyncTimer);
      timers.externalCodexSyncTimer = null;
    }
    loop.stopTimer();
    email.destroy();
    if (mateDatastore && typeof mateDatastore.closeAllDatastores === "function") {
      try { mateDatastore.closeAllDatastores(); } catch (e) {}
    }
    stopFileWatch();
    stopAllDirWatches();
    sm.sessions.forEach(destroySessionRuntime);
    tm.destroyAll();
    for (var ws of clients) {
      try { ws.close(); } catch (e) {}
    }
    clients.clear();
    try {
      var cwdHash = crypto.createHash("sha256").update(cwd).digest("hex").substring(0, 12);
      var tmpDir = path.join(os.tmpdir(), "clay-" + cwdHash);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}

    var codexShutdown = Promise.resolve(true);
    if (adapters && adapters.codex && typeof adapters.codex.shutdown === "function") {
      codexShutdown = adapters.codex.shutdown().catch(function (err) {
        console.error("[project] Codex shutdown failed for " + slug + ":", err && err.message ? err.message : err);
        return false;
      });
    }
    return codexShutdown;
  }

  return destroy;
}

module.exports = {
  createProjectDestroy: createProjectDestroy,
};
