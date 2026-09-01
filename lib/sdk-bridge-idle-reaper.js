function attachIdleReaper(ctx) {
  var sm = ctx.sm;
  var configuredIdleMs = Number(process.env.CLAY_QUERY_IDLE_MS);
  var configuredWarmLimit = Number(process.env.CLAY_CODEX_WARM_QUERY_LIMIT);
  var idleTimeoutMs = Number.isFinite(ctx.idleTimeoutMs) ? ctx.idleTimeoutMs :
    (Number.isFinite(configuredIdleMs) && configuredIdleMs >= 1000
      ? configuredIdleMs : 10 * 60 * 1000);
  var requestedWarmLimit = Number.isFinite(ctx.maxWarmCodexQueries)
    ? ctx.maxWarmCodexQueries
    : (Number.isFinite(configuredWarmLimit) ? configuredWarmLimit : 3);
  var maxWarmCodexQueries = Math.max(0, Math.floor(requestedWarmLimit));
  var idleCheckIntervalMs = Number.isFinite(ctx.idleCheckIntervalMs)
    ? ctx.idleCheckIntervalMs : 60 * 1000;
  var now = typeof ctx.now === "function" ? ctx.now : Date.now;
  var idleReaperTimer = null;

  function canReap(session) {
    return !!(session && !session.isProcessing && session.queryInstance &&
      !session.singleTurn && !session.destroying);
  }

  function closeQuery(session, reason, currentTime) {
    var lastActivity = session.lastActivityAt || 0;
    console.log("[sdk-bridge] Reaping " + reason + " session " + session.localId +
      " (idle " + Math.round((currentTime - lastActivity) / 60000) + "min)" +
      (session.title ? " title=" + JSON.stringify(session.title) : ""));
    if (session.queryInstance && typeof session.queryInstance.close === "function") {
      try { session.queryInstance.close(); } catch (e) {}
    } else if (session.messageQueue && typeof session.messageQueue.end === "function") {
      try { session.messageQueue.end(); } catch (e) {}
    }
  }

  function reapIdleSessions() {
    var currentTime = now();
    var warmCodex = [];
    sm.sessions.forEach(function (session) {
      if (!canReap(session)) return;
      var lastActivity = session.lastActivityAt || 0;
      if (currentTime - lastActivity > idleTimeoutMs) {
        closeQuery(session, "idle", currentTime);
        return;
      }
      if (session.vendor === "codex") warmCodex.push(session);
    });
    warmCodex.sort(function (a, b) {
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });
    for (var i = maxWarmCodexQueries; i < warmCodex.length; i++) {
      closeQuery(warmCodex[i], "excess warm Codex", currentTime);
    }
  }

  function startIdleReaper() {
    if (idleReaperTimer) return;
    idleReaperTimer = setInterval(reapIdleSessions, idleCheckIntervalMs);
    if (idleReaperTimer.unref) idleReaperTimer.unref();
  }

  function stopIdleReaper() {
    if (idleReaperTimer) {
      clearInterval(idleReaperTimer);
      idleReaperTimer = null;
    }
  }

  return {
    reapIdleSessions: reapIdleSessions,
    startIdleReaper: startIdleReaper,
    stopIdleReaper: stopIdleReaper,
  };
}

module.exports = { attachIdleReaper: attachIdleReaper };
