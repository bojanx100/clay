var contexts = new Set();
var sharedTimer = null;
var sharedClearInterval = clearInterval;

function syncContext(ctx) {
  var clients = ctx.clients;
  var sessions = ctx.sessions;
  var sm = ctx.sm;
  if (!clients || clients.size === 0 || !sessions ||
      typeof sessions.resolveSessionForView !== "function") return;
  var synced = {};
  for (var ws of clients) {
    if (!ws || ws.readyState !== 1 || !ws._clayActiveSession) continue;
    if (synced[ws._clayActiveSession]) continue;
    var session = sm.sessions.get(ws._clayActiveSession);
    if (!session || session.vendor !== "codex") continue;
    if (session.isProcessing || session.queryInstance) continue;
    var beforeMtime = session._historyMtime || 0;
    var beforeFormat = session._historyFormatVersion || 0;
    sessions.resolveSessionForView(session, ws);
    var afterMtime = session._historyMtime || 0;
    if (afterMtime && (afterMtime !== beforeMtime || session._historyFormatVersion !== beforeFormat)) {
      sm.switchSession(session.localId, ws, ctx.hydrateImageRefs);
      synced[session.localId] = true;
    }
  }
}

function tick() {
  for (var ctx of contexts) {
    try { syncContext(ctx); }
    catch (e) {
      console.error("[project] External Codex sync failed:", e.message || e);
    }
  }
}

function startExternalCodexSync(ctx) {
  contexts.add(ctx);
  if (!sharedTimer) {
    var startInterval = ctx.setInterval || setInterval;
    sharedClearInterval = ctx.clearInterval || clearInterval;
    sharedTimer = startInterval(tick, 5000);
    if (sharedTimer && typeof sharedTimer.unref === "function") sharedTimer.unref();
  }

  function stop() {
    if (!contexts.delete(ctx) || contexts.size > 0) return;
    sharedClearInterval(sharedTimer);
    sharedTimer = null;
  }

  if (ctx.timers) ctx.timers.externalCodexSyncStop = stop;
  return stop;
}

function resetForTests() {
  contexts.clear();
  if (sharedTimer) sharedClearInterval(sharedTimer);
  sharedTimer = null;
  sharedClearInterval = clearInterval;
}

module.exports = {
  startExternalCodexSync: startExternalCodexSync,
  _resetForTests: resetForTests,
  _tickForTests: tick,
};
