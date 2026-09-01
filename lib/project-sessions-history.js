var historyStore = require("./sessions-history-store");

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
      var persistedTotal = Number.isInteger(session._persistedHistoryLength)
        ? session._persistedHistoryLength : 0;
      var canRangePage = !session.coopHome && !session.coopChannel &&
        !session.compactedFromStorageId && typeof session._readPersistedHistoryRange === "function";
      if (canRangePage) {
        var to = Math.max(0, Math.min(persistedTotal, Math.floor(before)));
        var target = Math.max(0, Math.min(to, Math.floor(targetFrom)));
        var windowFrom = Math.max(0, target - sm.HISTORY_PAGE_SIZE);
        var window = session._readPersistedHistoryRange(windowFrom, to);
        if (Array.isArray(window)) {
          var relativeFrom = sm.findTurnBoundary(window, target - windowFrom);
          var from = windowFrom + relativeFrom;
          sendTo(ws, {
            type: "history_prepend",
            items: window.slice(relativeFrom, to - windowFrom).map(hydrateImageRefs),
            meta: { from: from, to: to, hasMore: from > 0 },
          });
          return true;
        }
      }
      var historyView = typeof sm.getHistoryView === "function" ? sm.getHistoryView(session) : { history: session.history };
      var history = historyView.history;
      var from = sm.findTurnBoundary(history, Math.max(0, targetFrom));
      var to = before;
      var items = history.slice(from, to).map(hydrateImageRefs);
      historyStore.release(session);
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
