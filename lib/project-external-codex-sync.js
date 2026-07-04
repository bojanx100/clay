function startExternalCodexSync(ctx) {
  var timers = ctx.timers;
  var clients = ctx.clients;
  var sessions = ctx.sessions;
  var sm = ctx.sm;
  var hydrateImageRefs = ctx.hydrateImageRefs;

  timers.externalCodexSyncTimer = setInterval(function () {
    if (!clients || clients.size === 0 || !sessions || typeof sessions.resolveSessionForView !== "function") return;
    var synced = {};
    for (var ws of clients) {
      if (!ws || ws.readyState !== 1 || !ws._clayActiveSession) continue;
      if (synced[ws._clayActiveSession]) continue;
      var session = sm.sessions.get(ws._clayActiveSession);
      if (!session || session.vendor !== "codex") continue;
      if (session.isProcessing || session.queryInstance) continue;
      var beforeMtime = session._historyMtime || 0;
      sessions.resolveSessionForView(session, ws);
      var afterMtime = session._historyMtime || 0;
      if (afterMtime && afterMtime !== beforeMtime) {
        sm.switchSession(session.localId, ws, hydrateImageRefs);
        synced[session.localId] = true;
      }
    }
  }, 5000);
  if (timers.externalCodexSyncTimer && typeof timers.externalCodexSyncTimer.unref === "function") {
    timers.externalCodexSyncTimer.unref();
  }
}

module.exports = {
  startExternalCodexSync: startExternalCodexSync,
};
