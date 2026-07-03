function attachProjectSessionsSearch(ctx) {
  var sm = ctx.sm;
  var sendTo = ctx.sendTo;
  var getSessionForWs = ctx.getSessionForWs;

  function handleSearchMessage(ws, msg) {
    // CLI session import: list and import handlers. Auto-adopt in sessions.js
    // runs at startup, but a user who deletes a session can re-surface it via
    // these handlers.
    if (msg.type === "list_cli_sessions") {
      var importVendor = msg.vendor === "claude" || msg.vendor === "codex" ? msg.vendor : "";
      var adoptable = sm.listAdoptableCliSessions(importVendor);
      sendTo(ws, { type: "cli_session_list", sessions: adoptable, vendor: importVendor });
      return true;
    }

    if (msg.type === "import_cli_session") {
      if (msg.cliSessionId) {
        var importedId = sm.importCliSession(msg.cliSessionId, msg.vendor);
        if (importedId) {
          sm.broadcastSessionList();
          sendTo(ws, { type: "cli_session_imported", cliSessionId: msg.cliSessionId, localId: importedId });
        } else {
          sendTo(ws, { type: "cli_session_import_failed", cliSessionId: msg.cliSessionId });
        }
      }
      return true;
    }

    if (msg.type === "search_sessions") {
      var results = sm.searchSessions(msg.query || "");
      sendTo(ws, { type: "search_results", query: msg.query || "", results: results });
      return true;
    }

    if (msg.type === "search_session_content") {
      var targetSession = msg.id ? sm.sessions.get(msg.id) : getSessionForWs(ws);
      if (!targetSession) return true;
      var contentResults = sm.searchSessionContent(targetSession.localId, msg.query || "");
      var searchResp = { type: "search_content_results", query: msg.query || "", sessionId: targetSession.localId, hits: contentResults.hits, total: contentResults.total };
      if (msg.source) searchResp.source = msg.source;
      sendTo(ws, searchResp);
      return true;
    }

    return false;
  }

  return {
    handleSearchMessage: handleSearchMessage,
  };
}

module.exports = { attachProjectSessionsSearch: attachProjectSessionsSearch };
