function attachProjectSessionsView(ctx) {
  var cwd = ctx.cwd;
  var sm = ctx.sm;
  var tm = ctx.tm;
  var resolveSessionHome = ctx.resolveSessionHome;
  var getClaudeOpenModeForWs = ctx.getClaudeOpenModeForWs;
  var tuiHandlers = ctx.tuiHandlers;

  // For imported Codex sessions, hydrate session.history from the rollout the
  // first time the session is viewed (or whenever the rollout's mtime advances).
  // Live Codex GUI sessions build history through doSendAndRecord; only the
  // import path lands here. Text-only stub: user prompts + agent messages.
  function prepareCodexSessionForView(session) {
    if (!session || (!session.cliSessionId && !session.storageId)) return;
    if (session.isProcessing || session.queryInstance) return;
    var cliSess;
    try { cliSess = require("./cli-sessions"); } catch (e) { return; }
    var home = resolveSessionHome(session);
    var threadId = null;
    var mtime = 0;
    var candidates = [];
    if (session.storageId) candidates.push(session.storageId);
    if (session.cliSessionId && session.cliSessionId !== session.storageId) candidates.push(session.cliSessionId);
    for (var ci = 0; ci < candidates.length; ci++) {
      var candidateMtime = cliSess.codexRolloutMtime(home, candidates[ci], cwd);
      if (candidateMtime) {
        threadId = candidates[ci];
        mtime = candidateMtime;
        break;
      }
    }
    if (!mtime) return;
    var hasHistory = Array.isArray(session.history) && session.history.length > 0;
    var fresh = hasHistory && session._historyMtime === mtime;
    if (fresh) return;
    var usingStorageThread = threadId && session.storageId && threadId === session.storageId;
    if (hasHistory && !session._historyMtime && !usingStorageThread) return;
    var history = null;
    try { history = cliSess.readCodexHistorySync(home, threadId, cwd); } catch (e) { history = null; }
    if (Array.isArray(history) && history.length > 0) {
      session.history = history;
      session._historyMtime = mtime;
      try { sm.saveSessionFile(session); } catch (e) {}
    }
  }

  function isKnownCodexSession(session) {
    if (!session || !session.cliSessionId) return false;
    var cliSess;
    try { cliSess = require("./cli-sessions"); } catch (e) { return false; }
    var home = resolveSessionHome(session);
    var mtime = 0;
    try { mtime = cliSess.codexRolloutMtime(home, session.cliSessionId, cwd); } catch (e) { mtime = 0; }
    return !!mtime;
  }

  function prepareCopilotSessionForView(session) {
    if (!session || !session.cliSessionId) return;
    if (session.isProcessing || session.queryInstance) return;
    var copilotSess;
    try { copilotSess = require("./copilot-sessions"); } catch (e) { return; }
    var home = resolveSessionHome(session);
    var mtime = copilotSess.copilotSessionMtime(home, session.cliSessionId, cwd);
    if (!mtime) return;
    var hasHistory = Array.isArray(session.history) && session.history.length > 0;
    if (hasHistory && session._historyMtime === mtime) return;
    if (hasHistory && !session._historyMtime) {
      var hasVendorSwitch = false;
      for (var hi = 0; hi < session.history.length; hi++) {
        if (session.history[hi] && session.history[hi].type === "vendor_switched") {
          hasVendorSwitch = true;
          break;
        }
      }
      if (hasVendorSwitch || (session.storageId && session.storageId !== session.cliSessionId)) return;
    }
    var history = null;
    try { history = copilotSess.readCopilotHistorySync(home, session.cliSessionId, cwd); } catch (e) { history = null; }
    if (Array.isArray(history) && history.length > 0) {
      session.history = history;
      session._historyMtime = mtime;
      try { sm.saveSessionFile(session); } catch (e2) {}
    }
  }

  // Resolve how a session should be presented to a viewer WITHOUT spawning a
  // PTY or broadcasting: set runtimeMode / runtimeTerminalId / tuiSuspended and
  // hydrate the transcript for the read-only and GUI cases. Single source of
  // truth shared by switch_session (which additionally spawns for born-GUI)
  // and the connect/restore path (project-connection.js) so a refreshed
  // born-TUI session shows the same read-only + Resume view as a fresh click.
  function resolveSessionForView(session, ws) {
    if (!session) return;
    if (session.vendor && session.vendor !== "claude") {
      if (session.vendor === "codex") {
        prepareCodexSessionForView(session);
      } else if (session.vendor === "github-copilot") {
        prepareCopilotSessionForView(session);
      }
      session.tuiSuspended = false;
      return;
    }
    var pref = getClaudeOpenModeForWs(ws);
    // A LIVE runtime always wins over the viewer's claudeOpenMode pref:
    // another user (or this user in another tab) may be in the session right
    // now, so we join it in whatever mode it is actually running and never
    // convert or kill it. "tui stays tui, gui stays gui."
    var liveNativePty = tm && typeof session.terminalId === "number" && tm.has(session.terminalId);
    var liveResumePty = tm && typeof session.runtimeTerminalId === "number" && tm.has(session.runtimeTerminalId);
    var liveSdk = !!session.queryInstance || !!session.isProcessing;
    if (liveNativePty) {
      session.runtimeMode = "tui";
      session.runtimeTerminalId = session.terminalId;
      session.tuiSuspended = false;
      return;
    }
    if (liveResumePty) {
      session.runtimeMode = "tui";
      session.tuiSuspended = false;
      return;
    }
    if (liveSdk) {
      // Actively running as a GUI/SDK session - show GUI for everyone.
      session.runtimeMode = (session.mode === "tui") ? "gui" : null;
      session.runtimeTerminalId = null;
      session.tuiSuspended = false;
      return;
    }
    // Cold session: apply the viewer's pref.
    if (session.mode === "tui") {
      if (pref === "gui") {
        tuiHandlers.prepareTuiSessionForGuiView(session);
        session.runtimeMode = "gui";
        session.runtimeTerminalId = null;
        session.tuiSuspended = false;
      } else {
        tuiHandlers.prepareTuiSessionForGuiView(session);
        session.runtimeMode = null;
        session.runtimeTerminalId = null;
        session.tuiSuspended = true;
      }
    } else {
      // Born-GUI: always GUI. We no longer auto-convert a GUI session to a
      // `claude --resume` terminal on a pref=tui click - that hijacked shared
      // GUI sessions in multi-user. Such sessions render as their SDK chat.
      session.runtimeMode = null;
      session.tuiSuspended = false;
    }
  }

  return {
    resolveSessionForView: resolveSessionForView,
    isKnownCodexSession: isKnownCodexSession,
  };
}

module.exports = { attachProjectSessionsView: attachProjectSessionsView };
