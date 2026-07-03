function attachProjectSessionsRewind(ctx) {
  var cwd = ctx.cwd;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendTo = ctx.sendTo;
  var getSessionForWs = ctx.getSessionForWs;
  var onProcessingChanged = ctx.onProcessingChanged;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var resolveSessionHome = ctx.resolveSessionHome;

  function handleRewindMessage(ws, msg) {
    if (msg.type === "rewind_preview") {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId || !msg.uuid) return true;
      if (session._rewindInProgress) return true;

      (async function () {
        try {
          var r = await sdk.rewindPreview(session, msg.uuid);
          sendTo(ws, { type: "rewind_preview_result", preview: r.preview, diffs: r.diffs, uuid: msg.uuid, chatOnly: r.chatOnly || false });
        } catch (err) {
          sendTo(ws, { type: "rewind_error", text: "Failed to preview rewind: " + err.message });
        }
      })();
      return true;
    }

    if (msg.type === "rewind_execute") {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId || !msg.uuid) return true;
      if (session._rewindInProgress) {
        sendTo(ws, { type: "rewind_error", text: "Rewind already in progress." });
        return true;
      }
      session._rewindInProgress = true;
      var mode = msg.mode || "both";

      (async function () {
        try {
          if (mode !== "chat") {
            await sdk.rewindExecuteFiles(session, msg.uuid);
          }

          if (mode !== "files") {
            var targetIdx = -1;
            for (var i = 0; i < session.messageUUIDs.length; i++) {
              if (session.messageUUIDs[i].uuid === msg.uuid) {
                targetIdx = i;
                break;
              }
            }

            var turnsToRollBack = 0;
            if (targetIdx >= 0) {
              for (var ri = targetIdx; ri < session.messageUUIDs.length; ri++) {
                if (session.messageUUIDs[ri].type === "user") turnsToRollBack++;
              }
            }

            if (targetIdx >= 0) {
              var trimTo = session.messageUUIDs[targetIdx].historyIndex;
              for (var k = trimTo - 1; k >= 0; k--) {
                if (session.history[k].type === "user_message") {
                  trimTo = k;
                  break;
                }
              }
              session.history = session.history.slice(0, trimTo);
              session.messageUUIDs = session.messageUUIDs.slice(0, targetIdx);
              if (typeof session._dmLastDigestedIndex === "number" && session._dmLastDigestedIndex > trimTo) {
                session._dmLastDigestedIndex = trimTo;
              }
            }

            if (turnsToRollBack > 0) {
              try {
                await sdk.rollbackConversation(session, turnsToRollBack);
              } catch (rbErr) {
                console.error("[project-sessions] conversation rollback failed:", rbErr.message || rbErr);
              }
            }

            var kept = session.messageUUIDs;
            session.lastRewindUuid = kept.length > 0 ? kept[kept.length - 1].uuid : null;
          }

          if (session.abortController) {
            try { session.abortController.abort(); } catch (e) {}
          }
          if (session.messageQueue) {
            try { session.messageQueue.end(); } catch (e) {}
          }
          session.queryInstance = null;
          session.messageQueue = null;
          session.abortController = null;
          session.blocks = {};
          session.sentToolResults = {};
          session.pendingPermissions = {};
          session.pendingAskUser = {};
          session.isProcessing = false;
          onProcessingChanged();

          sm.saveSessionFile(session);
          sm.switchSession(session.localId, ws, hydrateImageRefs);
          sm.sendAndRecord(session, { type: "rewind_complete", mode: mode });
          sm.broadcastSessionList();
        } catch (err) {
          sendTo(ws, { type: "rewind_error", text: "Rewind failed: " + err.message });
        } finally {
          session._rewindInProgress = false;
        }
      })();
      return true;
    }

    if (msg.type === "fork_session" && msg.uuid) {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId) {
        sendTo(ws, { type: "error", text: "Cannot fork: no CLI session" });
        return true;
      }
      var forkTitle = (session.title || "New Session") + " (fork)";

      sdk.forkSession(session, msg.uuid).then(function(result) {
        if (result.useLocalHistory) {
          var targetIdx = -1;
          for (var fi = 0; fi < session.messageUUIDs.length; fi++) {
            if (session.messageUUIDs[fi].uuid === msg.uuid) { targetIdx = fi; break; }
          }
          var forkHistory = [];
          if (targetIdx >= 0) {
            var trimTo = session.messageUUIDs[targetIdx].historyIndex;
            forkHistory = session.history.slice(0, trimTo);
          } else {
            forkHistory = session.history.slice();
          }
          var forked = sm.createSession({ vendor: session.vendor, ownerId: session.ownerId || null }, ws);
          forked.cliSessionId = result.sessionId;
          forked.title = forkTitle;
          forked.history = forkHistory;
          forked.messageUUIDs = [];
          for (var hi = 0; hi < forkHistory.length; hi++) {
            if (forkHistory[hi].type === "message_uuid") {
              forked.messageUUIDs.push({ uuid: forkHistory[hi].uuid, type: forkHistory[hi].messageType, historyIndex: hi });
            }
          }
          sm.saveSessionFile(forked);
          sm.switchSession(forked.localId, ws, hydrateImageRefs);
          sendTo(ws, { type: "fork_complete", sessionId: forked.localId });
          sm.broadcastSessionList();
        } else {
          var cliSess = require("./cli-sessions");
          return cliSess.readCliSessionHistory(resolveSessionHome(session), cwd, result.sessionId).then(function(history) {
            var forked = sm.resumeSession(result.sessionId, { history: history, title: forkTitle }, ws);
            if (forked) {
              ws._clayActiveSession = forked.localId;
              sendTo(ws, { type: "fork_complete", sessionId: forked.localId });
            }
          });
        }
      }).catch(function(e) {
        sendTo(ws, { type: "error", text: "Fork failed: " + (e.message || e) });
      });
      return true;
    }

    return false;
  }

  return {
    handleRewindMessage: handleRewindMessage,
  };
}

module.exports = { attachProjectSessionsRewind: attachProjectSessionsRewind };
