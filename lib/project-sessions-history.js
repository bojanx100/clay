function attachProjectSessionsHistory(ctx) {
  var sm = ctx.sm;
  var sendTo = ctx.sendTo;
  var getSessionForWs = ctx.getSessionForWs;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var compactAndContinue = ctx.compactAndContinue;

  function handleHistoryMessage(ws, msg) {
    if (msg.type === "load_more_history") {
      var session = getSessionForWs(ws);
      if (!session || typeof msg.before !== "number") return true;
      var before = msg.before;
      var targetFrom = typeof msg.target === "number" ? msg.target : before - sm.HISTORY_PAGE_SIZE;
      var from = sm.findTurnBoundary(session.history, Math.max(0, targetFrom));
      var to = before;
      var items = session.history.slice(from, to).map(hydrateImageRefs);
      sendTo(ws, {
        type: "history_prepend",
        items: items,
        meta: { from: from, to: to, hasMore: from > 0 },
      });
      return true;
    }

    if (msg.type === "compact_session") {
      var compactSession = getSessionForWs(ws);
      if (!compactSession || !compactAndContinue) return true;
      if (compactSession.isProcessing) {
        sendTo(ws, { type: "error", text: "Cannot compact while the session is processing." });
        return true;
      }
      compactAndContinue(compactSession, {
        reason: "manual",
        currentText: msg.text || "Continue from the compacted context.",
      });
      return true;
    }

    return false;
  }

  return {
    handleHistoryMessage: handleHistoryMessage,
  };
}

module.exports = { attachProjectSessionsHistory: attachProjectSessionsHistory };
