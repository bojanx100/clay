var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");

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

  function destroy() {
    sdk.stopIdleReaper();
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
    sm.sessions.forEach(function (session) {
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
      if (session._mentionSessions) {
        var mateIds = Object.keys(session._mentionSessions);
        for (var mi = 0; mi < mateIds.length; mi++) {
          try { session._mentionSessions[mateIds[mi]].close(); } catch (e) {}
        }
        session._mentionSessions = {};
      }
    });
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
