function attachProjectSessionsLive(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var sendToSessionOthers = ctx.sendToSessionOthers;
  var usersModule = ctx.usersModule;
  var pushModule = ctx.pushModule;
  var getSessionForWs = ctx.getSessionForWs;
  var clearPendingQueuedMessages = ctx.clearPendingQueuedMessages;

  function handleLiveMessage(ws, msg) {
    if (msg.type === "push_subscribe") {
      var _pushUserId = ws._clayUser ? ws._clayUser.id : null;
      if (pushModule && msg.subscription) pushModule.addSubscription(msg.subscription, msg.replaceEndpoint, _pushUserId);
      return true;
    }

    if (msg.type === "stop") {
      var session = getSessionForWs(ws);
      if (session && session.isProcessing) {
        clearPendingQueuedMessages(session);
        sendToSession(session.localId, { type: "queued_user_messages_cleared" });
        session.taskStopRequested = true;
        if (session.abortController) session.abortController.abort();
      }
      return true;
    }

    if (msg.type === "stop_task") {
      if (msg.taskId) {
        sdk.stopTask(msg.taskId);
      }
      return true;
    }

    if (msg.type === "kill_process") {
      var pid = msg.pid;
      if (!pid || typeof pid !== "number") return true;
      // Verify target is actually a claude process before killing
      if (!sdk.isClaudeProcess(pid)) {
        console.error("[project] Refused to kill PID " + pid + ": not a claude process");
        sendTo(ws, { type: "error", text: "Process " + pid + " is not a Claude process." });
        return true;
      }
      try {
        process.kill(pid, "SIGTERM");
        console.log("[project] Sent SIGTERM to conflicting Claude process PID " + pid);
        sendTo(ws, { type: "process_killed", pid: pid });
      } catch (e) {
        console.error("[project] Failed to kill PID " + pid + ":", e.message);
        sendTo(ws, { type: "error", text: "Failed to kill process " + pid + ": " + (e.message || e) });
      }
      return true;
    }

    if (msg.type === "input_sync") {
      var syncSessionId = msg.sessionId;
      if (typeof syncSessionId === "string" && syncSessionId.trim()) syncSessionId = Number(syncSessionId);
      if (typeof syncSessionId !== "number" || !isFinite(syncSessionId) || !sm.sessions.has(syncSessionId)) {
        syncSessionId = ws._clayActiveSession;
      }
      if (!syncSessionId) return true;
      sendToSessionOthers(ws, syncSessionId, Object.assign({}, msg, { sessionId: syncSessionId }));
      return true;
    }

    if (msg.type === "cursor_move" || msg.type === "cursor_leave" || msg.type === "text_select") {
      if (!usersModule.isMultiUser() || !ws._clayUser) return true;
      var u = ws._clayUser;
      var p = u.profile || {};
      var cursorMsg = {
        type: msg.type,
        userId: u.id,
        displayName: p.name || u.displayName || u.username,
        avatarStyle: p.avatarStyle || "thumbs",
        avatarSeed: p.avatarSeed || u.username,
        avatarCustom: p.avatarCustom || "",
      };
      if (msg.type === "cursor_move") {
        cursorMsg.turn = msg.turn;
        if (msg.rx != null) cursorMsg.rx = msg.rx;
        if (msg.ry != null) cursorMsg.ry = msg.ry;
      }
      if (msg.type === "text_select") {
        cursorMsg.ranges = msg.ranges || [];
      }
      sendToSessionOthers(ws, ws._clayActiveSession, cursorMsg);
      return true;
    }

    return false;
  }

  return {
    handleLiveMessage: handleLiveMessage,
  };
}

module.exports = { attachProjectSessionsLive: attachProjectSessionsLive };
