var path = require("path");

function attachProjectMessageRouter(ctx) {
  var slug = ctx.slug;
  var opts = ctx.opts;
  var cwd = ctx.cwd;
  var isMate = !!ctx.isMate;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var getSessionForWs = ctx.getSessionForWs;
  var pendingDebateProposals = ctx.pendingDebateProposals;
  var handleMention = ctx.handleMention;
  var handleUserMention = ctx.handleUserMention;
  var vendorModels = ctx.vendorModels;
  var debate = ctx.debate;
  var modules = ctx.modules;

  function isServerLevelMessage(type) {
    return type === "dm_open" || type === "dm_send" || type === "dm_list" || type === "dm_typing"
      || type === "dm_add_favorite" || type === "dm_remove_favorite" || type === "mate_create"
      || type === "mate_list" || type === "mate_delete" || type === "mate_update"
      || type === "mate_readd_builtin" || type === "mate_list_available_builtins"
      || type === "email_accounts_list" || type === "email_account_add" || type === "email_account_remove"
      || type === "email_account_test" || type === "home_clay_open" || type === "home_clay_send"
      || type === "home_clay_new_session" || type === "home_clay_close";
  }

  function handleMessage(ws, msg) {
    if (msg && msg.type === "ping") {
      sendTo(ws, { type: "pong" });
      return;
    }

    if (msg.targetSlug && msg.targetSlug !== slug && opts.getProject) {
      var targetCtx = opts.getProject(msg.targetSlug);
      if (targetCtx) {
        targetCtx.handleMessage(ws, msg);
        return;
      }
    }

    if (isServerLevelMessage(msg.type)) {
      if (typeof opts.onDmMessage === "function") {
        opts.onDmMessage(ws, msg);
      }
      return;
    }

    if (msg.type === "mention") {
      handleMention(ws, msg);
      return;
    }

    if (msg.type === "user_mention") {
      handleUserMention(ws, msg);
      return;
    }

    if (msg.type === "mention_stop") {
      var session = getSessionForWs(ws);
      if (session && session._mentionInProgress) {
        var mateId = msg.mateId;
        if (mateId && session._mentionSessions && session._mentionSessions[mateId]) {
          session._mentionSessions[mateId].abort();
          session._mentionSessions[mateId].close();
          delete session._mentionSessions[mateId];
        }
        session._mentionInProgress = false;
        session._mentionActiveMateId = null;
        sendToSession(session.localId, { type: "mention_done", mateId: mateId, stopped: true });
        send({ type: "mention_processing", mateId: mateId, active: false });
      }
      return;
    }

    if (vendorModels.handleMessage(ws, msg)) return;

    if (msg.type === "debate_start") { debate.handleDebateStart(ws, msg); return; }
    if (msg.type === "debate_hand_raise") { debate.handleDebateHandRaise(ws); return; }
    if (msg.type === "debate_comment") { debate.handleDebateComment(ws, msg); return; }
    if (msg.type === "debate_stop") { debate.handleDebateStop(ws); return; }
    if (msg.type === "debate_conclude_response") { debate.handleDebateConcludeResponse(ws, msg); return; }
    if (msg.type === "debate_confirm_brief") { debate.handleDebateConfirmBrief(ws); return; }
    if (msg.type === "debate_proposal_response") {
      var dpKeys = Object.keys(pendingDebateProposals);
      var dpKey = msg.proposalId || dpKeys[dpKeys.length - 1];
      var pending = dpKey ? pendingDebateProposals[dpKey] : null;
      if (!pending) {
        // In-memory proposals do not survive a daemon restart; a click on a
        // stale card must tell the user instead of silently doing nothing.
        sendTo(ws, { type: "debate_error", error: "This debate proposal has expired (Clay restarted since it was made). Ask the session to propose the debate again." });
        return;
      }
      delete pendingDebateProposals[dpKey];
      if (msg.action === "start") {
        var dpMateId = isMate ? path.basename(cwd) : null;
        // The handler owns all validation (null session included) and user
        // feedback; resolve the MCP proposal with the REAL outcome so the
        // proposing model is never told "started" when nothing started (F-6).
        var dpResult = debate.handleMcpDebateApproval(getSessionForWs(ws), pending.briefData, dpMateId, ws);
        if (dpResult && dpResult.ok) {
          pending.resolve({ action: "start" });
        } else {
          pending.resolve({ action: "error", reason: (dpResult && dpResult.reason) || "debate could not start" });
        }
      } else {
        pending.resolve({ action: "cancel" });
      }
      return;
    }
    if (msg.type === "debate_user_floor_response") { debate.handleDebateUserFloorResponse(ws, msg); return; }

    if (modules.email.handleEmailMessage(ws, msg)) return;
    if (modules.mcp.handleMcpMessage(ws, msg)) return;
    if (modules.mateDatastore.handleMateDatastoreMessage(ws, msg)) return;
    if (modules.knowledge.handleKnowledgeMessage(ws, msg)) return;
    if (modules.notifications.handleNotificationMessage(ws, msg)) return;
    if (modules.taskLauncher && modules.taskLauncher.handleLaunchMessage(ws, msg)) return;
    if (modules.autoLaunch && modules.autoLaunch.handleMessage(ws, msg)) return;
    if (modules.taskSetup && modules.taskSetup.handleMessage(ws, msg)) return;
    if (modules.taskDashboard && modules.taskDashboard.handleDashboardMessage(ws, msg)) return;

    if (msg.type === "memory_list") { modules.memory.handleMemoryList(ws); return; }
    if (msg.type === "memory_search") { modules.memory.handleMemorySearch(ws, msg); return; }
    if (msg.type === "memory_delete") { modules.memory.handleMemoryDelete(ws, msg); return; }

    if (modules.sessions.handleSessionsMessage(ws, msg)) return;
    if (modules.filesystem.handleFilesystemMessage(ws, msg)) return;
    if (modules.liveUi && modules.liveUi.handleLiveUiMessage(ws, msg)) return;
    if (modules.workspace.handleWorkspaceMessage(ws, msg)) return;
    if (modules.userMessage.handleUserMessage(ws, msg)) return;
  }

  return {
    handleMessage: handleMessage,
  };
}

module.exports = {
  attachProjectMessageRouter: attachProjectMessageRouter,
};
