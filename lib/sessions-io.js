function attachSessionIo(ctx) {
  var send = ctx.send;
  var sendEach = ctx.sendEach;
  var appendToSessionFile = ctx.appendToSessionFile;
  var saveSessionFile = ctx.saveSessionFile;
  var isMeaninglessUnknownError = ctx.isMeaninglessUnknownError;
  var getActiveSessionId = ctx.getActiveSessionId;
  var getSingleUserUnread = ctx.getSingleUserUnread;
  var onSessionDone = ctx.onSessionDone;

  function sendToSession(session, obj) {
    var msg = obj;
    if (msg && !Object.prototype.hasOwnProperty.call(msg, "sessionId")) {
      msg = Object.assign({}, msg, { sessionId: session.localId });
    }
    if (sendEach) {
      var data = JSON.stringify(msg);
      sendEach(function (ws) {
        if (ws._clayActiveSession === session.localId && ws.readyState === 1) {
          ws.send(data);
        }
      });
    } else if (session.localId === getActiveSessionId()) {
      send(msg);
    }
  }

  function persistRecordedItem(session, obj) {
    var appended = appendToSessionFile(session, obj) !== false;
    if (appended && !session._historyNeedsRewrite) return true;
    session._historyNeedsRewrite = true;
    if (typeof saveSessionFile !== "function") return false;
    try {
      if (saveSessionFile(session, { durable: true }) !== true) return false;
      delete session._historyNeedsRewrite;
      return true;
    } catch (error) {
      console.error("[session] Failed to repair assistant transcript:", error.message || error);
      return false;
    }
  }

  function notifyPersistenceFailure(session) {
    if (session._historyPersistenceFailureNotified) return;
    session._historyPersistenceFailureNotified = true;
    sendToSession(session, {
      type: "error",
      text: "Clay could not save the latest response event. Unsaved output was not displayed. Check disk access and retry.",
    });
  }

  function sendAndRecord(session, obj) {
    if (isMeaninglessUnknownError(obj)) return false;
    var terminal = obj && obj.type === "done";
    if (terminal) {
      // `done` is the authoritative terminal event. Clear processing before
      // broadcasting it so a concurrent reconnect/session switch cannot replay
      // the completed turn and then receive a stale `status: processing`.
      session.isProcessing = false;
    }
    if (!obj._ts) obj._ts = Date.now();
    session.history.push(obj);
    if (!persistRecordedItem(session, obj)) {
      if (terminal) delete session._turnDoneSent;
      notifyPersistenceFailure(session);
      return false;
    }
    delete session._historyPersistenceFailureNotified;
    if (terminal) session._turnDoneSent = true;
    if (terminal) require("./turn-performance").finish(session, obj.code ? "failed" : null, obj._ts);
    var msg = obj;
    if (msg && !Object.prototype.hasOwnProperty.call(msg, "sessionId")) {
      msg = Object.assign({}, msg, { sessionId: session.localId });
    }
    if (session._subscribers && session._subscribers.size > 0) {
      for (var sub of session._subscribers) {
        try { sub(obj); } catch (e) {}
      }
    }
    if (sendEach) {
      var data = JSON.stringify(msg);
      var ioData = null;
      sendEach(function (ws) {
        if (ws._clayActiveSession === session.localId) {
          if (ws.readyState === 1) ws.send(data);
        } else if (session.isProcessing && !session._ioThrottle) {
          if (!ioData) ioData = JSON.stringify({ type: "session_io", id: session.localId });
          if (ws.readyState === 1) ws.send(ioData);
        }
        if (obj.type === "done" && ws._clayActiveSession !== session.localId) {
          var _isMySession = !session.ownerId || (ws._clayUser && ws._clayUser.id === session.ownerId);
          if (_isMySession) {
            if (!ws._clayUnread) ws._clayUnread = {};
            ws._clayUnread[session.localId] = (ws._clayUnread[session.localId] || 0) + 1;
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "session_unread", id: session.localId, count: ws._clayUnread[session.localId] }));
            }
          }
        }
      });
      if (session.isProcessing && !session._ioThrottle && ioData) {
        session._ioThrottle = true;
        setTimeout(function () { session._ioThrottle = false; }, 80);
      }
    } else if (session.localId === getActiveSessionId()) {
      send(msg);
    } else {
      if (obj.type === "done") {
        var singleUserUnread = getSingleUserUnread();
        singleUserUnread[session.localId] = (singleUserUnread[session.localId] || 0) + 1;
        send({ type: "session_unread", id: session.localId, count: singleUserUnread[session.localId] });
      }
      if (session.isProcessing && !session._ioThrottle) {
        session._ioThrottle = true;
        send({ type: "session_io", id: session.localId });
        setTimeout(function () { session._ioThrottle = false; }, 80);
      }
    }
    if (obj.type === "done") onSessionDone(session, obj);
    return true;
  }

  return {
    sendToSession: sendToSession,
    sendAndRecord: sendAndRecord,
  };
}

module.exports = {
  attachSessionIo: attachSessionIo,
};
