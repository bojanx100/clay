// Format a user's answer to an ask_user_questions card as a plain user
// message so the MCP path can feed it back to the agent on the next turn.
// The agent sees its own question text alongside the selected answer(s),
// which keeps the connection explicit: a bare "Phase 0" with no context
// reads as a non-sequitur to the model and triggers "I don't see an
// answer" responses, especially when a turn break sits between the tool
// call and this message.
function formatAskUserAnswerAsMessage(input, answers) {
  var questions = (input && Array.isArray(input.questions)) ? input.questions : [];
  if (questions.length === 0) {
    // Shouldn't happen, but be defensive.
    try { return "(answered with: " + JSON.stringify(answers || {}) + ")"; }
    catch (e) { return "(answered)"; }
  }
  var lines = [];
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    var qText = (q && q.question) ? q.question : ("Question " + (i + 1));
    var ans = (answers && answers[i] != null) ? String(answers[i]) : "";
    if (!ans) continue;
    lines.push("- " + qText + " → " + ans);
  }
  if (lines.length === 0) return "(no answer provided)";
  // Prefix tells the model "this is a structured answer to your previous
  // AskUserQuestion call", which the bare "Q → A" alone doesn't make
  // unambiguous when read out of context.
  return "[Answer to your AskUserQuestion]\n" + lines.join("\n");
}

function attachProjectSessionsPermissions(ctx) {
  var osUsers = ctx.osUsers;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var usersModule = ctx.usersModule;
  var getSessionForWs = ctx.getSessionForWs;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var onProcessingChanged = ctx.onProcessingChanged;

  function sendUserMessageToAgent(session, text) {
    var userMsg = { type: "user_message", text: text };
    session.history.push(userMsg);
    sm.appendToSessionFile(session, userMsg);
    sendToSession(session.localId, userMsg);

    if (!session.isProcessing) {
      session.isProcessing = true;
      onProcessingChanged();
      session.sentToolResults = {};
      sendToSession(session.localId, { type: "status", status: "processing" });
      if (!session.queryInstance && !session.worker) {
        sdk.startQuery(session, text, undefined, ensureProjectAccessForSession(session));
      } else {
        sdk.pushMessage(session, text);
      }
    } else {
      sdk.pushMessage(session, text);
    }
  }

  function sendConfigState() {
    send({
      type: "config_state",
      model: sm.currentModel || "",
      mode: sm.currentPermissionMode,
      effort: sm.currentEffort || "medium",
      betas: sm.currentBetas || [],
      thinking: sm.currentThinking || "adaptive",
      thinkingBudget: sm.currentThinkingBudget || 10000,
    });
  }

  function handlePermissionsMessage(ws, msg) {
    if (msg.type === "ask_user_response") {
      var session = getSessionForWs(ws);
      if (!session) return true;
      var toolId = msg.toolId;
      var answers = msg.answers || {};
      var pending = session.pendingAskUser[toolId];
      if (pending) delete session.pendingAskUser[toolId];
      sm.sendAndRecord(session, { type: "ask_user_answered", toolId: toolId, answers: answers });

      if (!pending) {
        var fallbackAnswerText = formatAskUserAnswerAsMessage({ questions: msg.questions || [] }, answers);
        sendUserMessageToAgent(session, fallbackAnswerText);
      } else if (pending.mode === "mcp") {
        // Stateless MCP path: the tool already returned. Inject the user's
        // answer as a new user message so the conversation continues
        // naturally on the next turn. This matches how the mate would see
        // any other user input.
        var answerText = formatAskUserAnswerAsMessage(pending.input, answers);
        sendUserMessageToAgent(session, answerText);
      } else {
        // Claude native AskUserQuestion path (built-in tool, intercepted via
        // canUseTool). In headless SDK mode the built-in can't render its own
        // answer UI: resolving "allow" lets it return an EMPTY result, so the
        // model continues the same turn with no answer ("I don't see an
        // answer"). Injected next-turn user messages also lose the race against
        // that empty result. Instead, deliver the answer as the tool_result by
        // denying with the formatted answer text - the SDK surfaces a deny
        // `message` to the model as the tool result, so the model receives the
        // user's choice in the same turn. (updatedInput.answers is not read by
        // the 0.3.x built-in, which is what caused answers to be dropped.)
        // We still record the answer in the session history so it renders as a
        // user message in the UI, but delivery to the model is via the deny
        // message only (no pushMessage) to avoid double-delivering the answer.
        var nativeAnswerText = formatAskUserAnswerAsMessage(pending.input, answers);
        var nativeUserMsg = { type: "user_message", text: nativeAnswerText };
        session.history.push(nativeUserMsg);
        sm.appendToSessionFile(session, nativeUserMsg);
        sendToSession(session.localId, nativeUserMsg);

        pending.resolve({ behavior: "deny", message: nativeAnswerText });
      }
      return true;
    }

    if (msg.type === "permission_response") {
      var requestId = msg.requestId;
      var decision = msg.decision;
      // Look up session by requestId index (O(1)), fall back to active session
      var sessionId = sm.permissionRequestIndex[requestId];
      var session = sessionId ? sm.sessions.get(sessionId) : getSessionForWs(ws);
      if (!session) return true;
      var pending = session.pendingPermissions[requestId];
      if (!pending) return true;
      delete sm.permissionRequestIndex[requestId];
      delete session.pendingPermissions[requestId];
      onProcessingChanged(); // update cross-project permission badge

      // --- Plan approval: "allow_accept_edits" -- approve + switch to acceptEdits mode ---
      if (decision === "allow_accept_edits") {
        sdk.setPermissionMode(session, "acceptEdits");
        sm.currentPermissionMode = "acceptEdits";
        sendConfigState();
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });
        return true;
      }

      // --- Plan approval: "allow_clear_context" -- new session + plan as first message + acceptEdits ---
      if (decision === "allow_clear_context") {
        // Deny current plan to end the turn
        pending.resolve({ behavior: "deny", message: "User chose to clear context and restart" });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });

        // Abort the old session's query -- but defer to next tick so the SDK's
        // deny write (scheduled as microtask by pending.resolve) completes first.
        // Aborting synchronously would kill the subprocess before the write,
        // causing an "Operation aborted" crash in the SDK.
        session.isProcessing = false;
        onProcessingChanged();
        session.pendingPermissions = {};
        session.pendingAskUser = {};
        sm.broadcastSessionList();
        setImmediate(function () {
          if (session.abortController) {
            session.abortController.abort();
          }
        });

        // Update permission mode for the new session
        sm.currentPermissionMode = "acceptEdits";
        sendConfigState();

        // Build prompt from plan content (sent from client) or plan file path
        var clientPlanContent = msg.planContent || "";
        var planPrompt;
        if (clientPlanContent) {
          planPrompt = "Execute the following plan. Do NOT re-enter plan mode -- just implement it step by step.\n\n" + clientPlanContent;
        } else {
          var planFilePath = (pending.toolInput && pending.toolInput.planFilePath) || "";
          planPrompt = "Execute the plan in " + planFilePath + ". Do NOT re-enter plan mode -- read the plan file and implement it step by step.";
        }

        // Wait for old query stream to fully terminate, then create new session + send plan
        var oldStreamPromise = session.streamPromise || Promise.resolve();
        Promise.race([
          oldStreamPromise,
          new Promise(function (resolve) { setTimeout(resolve, 3000); }),
        ]).then(function () {
          try {
            var newSession = sm.createSession(null, ws);
            // Send the plan as the first user message (with planContent for UI rendering)
            var userMsg = { type: "user_message", text: planPrompt, planContent: clientPlanContent || null };
            newSession.history.push(userMsg);
            sm.appendToSessionFile(newSession, userMsg);
            newSession.title = "Plan execution (cleared context)";
            sm.saveSessionFile(newSession);
            sm.broadcastSessionList();
            sendToSession(newSession.localId, userMsg);

            newSession.isProcessing = true;
            onProcessingChanged();
            newSession.sentToolResults = {};
            sendToSession(newSession.localId, { type: "status", status: "processing" });
            newSession.acceptEditsAfterStart = true;
            sdk.startQuery(newSession, planPrompt, undefined, ensureProjectAccessForSession(newSession));
          } catch (e) {
            console.error("[project] Error starting plan execution:", e);
            sendTo(ws, { type: "error", text: "Failed to start plan execution: " + (e.message || e) });
          }
        }).catch(function (e) {
          console.error("[project] Plan execution stream wait failed:", e.message || e);
        });
        return true;
      }

      // --- Plan approval: "deny_with_feedback" -- deny + send feedback as follow-up message ---
      if (decision === "deny_with_feedback") {
        var feedback = msg.feedback || "";
        pending.resolve({ behavior: "deny", message: feedback || "User provided feedback" });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });

        // Send feedback as next user message if there's text
        if (feedback) {
          setTimeout(function () {
            sendUserMessageToAgent(session, feedback);
          }, 200);
        }
        return true;
      }

      if (decision === "allow" || decision === "allow_always") {
        if (decision === "allow_always") {
          if (!session.allowedTools) session.allowedTools = {};
          session.allowedTools[pending.toolName] = true;
        }
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
      } else {
        pending.resolve({ behavior: "deny", message: "User denied permission" });
      }

      sm.sendAndRecord(session, {
        type: "permission_resolved",
        requestId: requestId,
        decision: decision,
      });
      return true;
    }

    // --- MCP elicitation response ---
    if (msg.type === "elicitation_response") {
      var elSession = getSessionForWs(ws);
      if (!elSession) return true;
      var elPending = elSession.pendingElicitations && elSession.pendingElicitations[msg.requestId];
      if (!elPending) return true;
      delete elSession.pendingElicitations[msg.requestId];
      if (msg.action === "accept") {
        elPending.resolve({ action: "accept", content: msg.content || {} });
      } else {
        elPending.resolve({ action: "reject" });
      }
      sm.sendAndRecord(elSession, {
        type: "elicitation_resolved",
        requestId: msg.requestId,
        action: msg.action,
      });
      return true;
    }

    // --- Host user dialog response (SDK request_user_dialog) ---
    if (msg.type === "user_dialog_response") {
      var udSession = getSessionForWs(ws);
      if (!udSession) return true;
      var udPending = udSession.pendingUserDialogs && udSession.pendingUserDialogs[msg.requestId];
      if (!udPending) return true;
      delete udSession.pendingUserDialogs[msg.requestId];
      if (msg.behavior === "completed") {
        udPending.resolve({ behavior: "completed", result: msg.result });
      } else {
        udPending.resolve({ behavior: "cancelled" });
      }
      sm.sendAndRecord(udSession, {
        type: "user_dialog_resolved",
        requestId: msg.requestId,
        behavior: msg.behavior === "completed" ? "completed" : "cancelled",
      });
      return true;
    }

    if (msg.type === "get_claude_allow_list") {
      var galUid = ws._clayUser ? ws._clayUser.id : null;
      var galManaged = [];
      var galUser = [];
      try {
        var galInstaller = require("./claude-hook-installer");
        galManaged = galInstaller.CLAY_MANAGED_ALLOW || [];
      } catch (e) {}
      if (galUid) {
        try { galUser = usersModule.getClaudeUserAllowList(galUid) || []; } catch (e) {}
      }
      sendTo(ws, { type: "claude_allow_list", managed: galManaged, user: galUser });
      return true;
    }

    if (msg.type === "set_claude_user_allow_list") {
      var salUid = ws._clayUser ? ws._clayUser.id : null;
      if (!salUid) {
        sendTo(ws, { type: "set_claude_user_allow_list_result", ok: false, error: "no_user" });
        return true;
      }
      var salResult = usersModule.setClaudeUserAllowList(salUid, msg.patterns || []);
      if (!salResult || !salResult.ok) {
        sendTo(ws, { type: "set_claude_user_allow_list_result", ok: false, error: (salResult && salResult.error) || "unknown" });
        return true;
      }
      // Re-install settings.json with the updated list so the new patterns
      // take effect on the next `claude` invocation. Resolve this user's
      // home (OS-mode: getent passwd; single-user: os.homedir()).
      try {
        var salInstaller = require("./claude-hook-installer");
        var salHome = null;
        if (osUsers && ws._clayUser && ws._clayUser.linuxUser) {
          try {
            var salInfo = require("./os-users").resolveOsUserInfo(ws._clayUser.linuxUser);
            if (salInfo && salInfo.home) salHome = salInfo.home;
          } catch (e) {}
        }
        if (!salHome) salHome = require("os").homedir();
        var salMerged = (salInstaller.CLAY_MANAGED_ALLOW || []).concat(salResult.claudeUserAllowList);
        salInstaller.installAllowList({ homeDirs: [salHome], patterns: salMerged });
      } catch (e) {}
      sendTo(ws, { type: "set_claude_user_allow_list_result", ok: true, patterns: salResult.claudeUserAllowList });
      return true;
    }

    return false;
  }

  return {
    handlePermissionsMessage: handlePermissionsMessage,
  };
}

module.exports = { attachProjectSessionsPermissions: attachProjectSessionsPermissions };
