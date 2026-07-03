function attachSessionSearch(ctx) {
  var sessions = ctx.sessions;
  var getActiveSessionId = ctx.getActiveSessionId;

  function searchSessions(query) {
    if (!query) return [];
    var q = query.toLowerCase();
    var results = [];
    var activeSessionId = getActiveSessionId();
    sessions.forEach(function (session) {
      var titleMatch = (session.title || "New Session").toLowerCase().indexOf(q) !== -1;
      var contentMatch = false;
      for (var i = 0; i < session.history.length; i++) {
        var entry = session.history[i];
        if ((entry.type === "delta" || entry.type === "user_message" || entry.type === "mention_user" || entry.type === "mention_response" || entry.type === "debate_turn_done" || entry.type === "debate_comment_injected") && entry.text) {
          if (entry.text.toLowerCase().indexOf(q) !== -1) {
            contentMatch = true;
            break;
          }
        }
      }
      if (titleMatch || contentMatch) {
        results.push({
          id: session.localId,
          cliSessionId: session.cliSessionId || null,
          title: session.title || "New Session",
          active: session.localId === activeSessionId,
          isProcessing: session.isProcessing,
          lastActivity: session.lastActivity || session.createdAt || 0,
          matchType: titleMatch && contentMatch ? "both" : titleMatch ? "title" : "content",
        });
      }
    });
    return results;
  }

  function searchSessionContent(localId, query) {
    if (!query) return { hits: [], total: 0 };
    var session = sessions.get(localId);
    if (!session) return { hits: [], total: 0 };
    var q = query.toLowerCase();
    var qLen = query.length;
    var history = session.history;
    var hits = [];
    var turnBuffer = "";
    var turnSegments = [];

    function pushScalarHits(text, historyIndex, role, ts) {
      if (!text) return;
      var lower = text.toLowerCase();
      var from = 0;
      while (true) {
        var idx = lower.indexOf(q, from);
        if (idx === -1) break;
        var s = Math.max(0, idx - 15);
        var e = Math.min(text.length, idx + qLen + 15);
        var snippet = (s > 0 ? "\u2026" : "") + text.substring(s, e) + (e < text.length ? "\u2026" : "");
        hits.push({ historyIndex: historyIndex, snippet: snippet, role: role, ts: ts });
        from = idx + qLen;
      }
    }

    function flushTurn() {
      if (!turnBuffer || turnSegments.length === 0) {
        turnBuffer = "";
        turnSegments = [];
        return;
      }
      var lowerBuf = turnBuffer.toLowerCase();
      var from = 0;
      var segCursor = 0;
      while (true) {
        var idx = lowerBuf.indexOf(q, from);
        if (idx === -1) break;
        while (segCursor < turnSegments.length - 1 && turnSegments[segCursor].end <= idx) {
          segCursor++;
        }
        var seg = turnSegments[segCursor];
        var s = Math.max(0, idx - 15);
        var e = Math.min(turnBuffer.length, idx + qLen + 15);
        var snippet = (s > 0 ? "\u2026" : "") + turnBuffer.substring(s, e) + (e < turnBuffer.length ? "\u2026" : "");
        hits.push({ historyIndex: seg.historyIndex, snippet: snippet, role: "assistant", ts: seg.ts });
        from = idx + qLen;
      }
      turnBuffer = "";
      turnSegments = [];
    }

    for (var i = 0; i < history.length; i++) {
      var entry = history[i];
      var t = entry.type;
      if (t === "user_message" || t === "mention_user") {
        flushTurn();
        pushScalarHits(entry.text, i, t === "user_message" ? "user" : "assistant", entry._ts || null);
      } else if (t === "delta" && entry.text) {
        turnSegments.push({
          start: turnBuffer.length,
          end: turnBuffer.length + entry.text.length,
          historyIndex: i,
          ts: entry._ts || null,
        });
        turnBuffer += entry.text;
      } else if ((t === "mention_response" || t === "debate_turn_done" || t === "debate_comment_injected") && entry.text) {
        flushTurn();
        pushScalarHits(entry.text, i, "assistant", entry._ts || null);
      }
    }
    flushTurn();
    return { hits: hits, total: history.length };
  }

  return {
    searchSessions: searchSessions,
    searchSessionContent: searchSessionContent,
  };
}

module.exports = {
  attachSessionSearch: attachSessionSearch,
};
