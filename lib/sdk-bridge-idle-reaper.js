function attachIdleReaper(ctx) {
  var sm = ctx.sm;
  var idleTimeoutMs = 30 * 60 * 1000;
  var idleCheckIntervalMs = 60 * 1000;
  var idleReaperTimer = null;

  function startIdleReaper() {
    if (idleReaperTimer) return;
    idleReaperTimer = setInterval(function () {
      var now = Date.now();
      sm.sessions.forEach(function (session) {
        if (session.isProcessing) return;
        if (!session.queryInstance) return;
        if (session.singleTurn) return;
        if (session.destroying) return;

        var lastActivity = session.lastActivityAt || 0;
        if (now - lastActivity > idleTimeoutMs) {
          console.log("[sdk-bridge] Reaping idle session " + session.localId +
            " (idle " + Math.round((now - lastActivity) / 60000) + "min)" +
            (session.title ? " title=" + JSON.stringify(session.title) : ""));
          if (session.queryInstance && typeof session.queryInstance.close === "function") {
            try { session.queryInstance.close(); } catch (e) {}
          } else if (session.messageQueue && typeof session.messageQueue.end === "function") {
            try { session.messageQueue.end(); } catch (e) {}
          }
        }
      });
    }, idleCheckIntervalMs);
    if (idleReaperTimer.unref) idleReaperTimer.unref();
  }

  function stopIdleReaper() {
    if (idleReaperTimer) {
      clearInterval(idleReaperTimer);
      idleReaperTimer = null;
    }
  }

  return {
    startIdleReaper: startIdleReaper,
    stopIdleReaper: stopIdleReaper,
  };
}

module.exports = { attachIdleReaper: attachIdleReaper };
