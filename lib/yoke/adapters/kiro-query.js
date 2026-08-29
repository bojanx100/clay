var events = require("./kiro-events");
var runtime = require("./kiro-runtime");
var createEventState = events.createEventState;
var flattenUpdate = events.flattenUpdate;
var generateUuid = runtime.generateUuid;
var injectSharedSkillContent = runtime.injectSharedSkillContent;
var isKiroAuthError = runtime.isKiroAuthError;
var toolNameForKind = runtime.toolNameForKind;

function createKiroQueryHandle(acp, queryOpts) {
  var abortController = queryOpts.abortController;
  var promptParts = [queryOpts.systemPrompt, queryOpts.appendSystemPrompt].filter(function (part) { return !!part; });
  var systemPrompt = promptParts.join("\n\n");
  var canUseTool = queryOpts.canUseTool || null;
  var onFinished = queryOpts.onFinished || null;

  function isCancelled() {
    return state.aborted || (abortController && abortController.signal && abortController.signal.aborted);
  }

  var state = createEventState(queryOpts);

  // Async iterator plumbing
  var eventBuffer = [];
  var eventWaiting = null;
  var iteratorDone = false;
  var finishedNotified = false;

  function notifyFinished() {
    if (finishedNotified) return;
    finishedNotified = true;
    if (typeof onFinished === "function") {
      try { onFinished(); } catch (e) { console.error("[yoke/kiro] onFinished error:", e.message || e); }
    }
  }

  function pushEvent(evt) {
    if (iteratorDone) return;
    if (eventWaiting) {
      var resolve = eventWaiting;
      eventWaiting = null;
      resolve({ value: evt, done: false });
    } else {
      eventBuffer.push(evt);
    }
  }

  function endIterator() {
    iteratorDone = true;
    if (eventWaiting) {
      var resolve = eventWaiting;
      eventWaiting = null;
      resolve({ value: undefined, done: true });
    }
    notifyFinished();
  }

  // Multi-turn message queue
  var messageQueue = [];
  var messageWaiting = null;
  var messageQueueEnded = false;

  function pushMessageToQueue(msg) {
    if (messageQueueEnded) return false;
    if (messageWaiting) {
      var resolve = messageWaiting;
      messageWaiting = null;
      resolve(msg);
    } else {
      messageQueue.push(msg);
    }
    return true;
  }
  function waitForMessage() {
    if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift());
    if (messageQueueEnded) return Promise.resolve(null);
    return new Promise(function(resolve) { messageWaiting = resolve; });
  }

  // --- ACP event handler ---
  function isApproved(decision) {
    if (!decision) return false;
    if (decision === true) return true;
    if (decision.behavior === "allow") return true;
    return false;
  }

  function handleServerEvent(msg) {
    var method = msg.method;
    var params = msg.params || {};

    // The shared ACP manager routes by sessionId and guarantees unroutable
    // requests get an error response. Do not add a silent sessionId filter here:
    // dropping a request without calling acp.respond() blocks kiro-cli until the
    // session/prompt timeout.

    // Tool permission request (server -> client, has an id we must answer)
    if (method === "session/request_permission") {
      var tc = params.toolCall || {};
      var options = params.options || [];
      function pickOption(kinds) {
        for (var i = 0; i < options.length; i++) {
          if (kinds.indexOf(options[i].kind) !== -1) return options[i].optionId;
        }
        return null;
      }
      var allowId = pickOption(["allow_once", "allow_always"]) || (options[0] && options[0].optionId);
      var rejectId = pickOption(["reject_once", "reject_always"]) || (options[options.length - 1] && options[options.length - 1].optionId);

      if (isCancelled()) {
        acp.respond(msg.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      if (canUseTool) {
        // The permission request payload carries only { toolCallId, title }.
        // Recover kind + rawInput from the tool_call notification we cached.
        var meta = (tc.toolCallId && state.toolMeta[tc.toolCallId]) || {};
        var toolName = toolNameForKind(tc.kind || meta.kind, tc.title || meta.title);
        var toolInput = tc.rawInput || meta.rawInput || { title: tc.title || meta.title };
        canUseTool(toolName, toolInput, {}).then(function(decision) {
          acp.respond(msg.id, { outcome: { outcome: "selected", optionId: isApproved(decision) ? allowId : rejectId } });
        }).catch(function(err) {
          console.error("[yoke/kiro] canUseTool error:", err.message);
          acp.respond(msg.id, { outcome: { outcome: "selected", optionId: rejectId } });
        });
      } else {
        // No approver wired up. Deny: Clay is the only thing standing between
        // the agent and the user's filesystem, so absence of an approver must
        // never mean approval.
        console.warn("[yoke/kiro] permission request with no canUseTool callback, denying");
        acp.respond(msg.id, { outcome: { outcome: "selected", optionId: rejectId } });
      }
      return;
    }

    // Session updates (streaming)
    if (method === "session/update") {
      if (isCancelled()) return;
      // session/load replays persisted history before resolving. Clay already
      // renders that history from its local session file, so forwarding replay
      // chunks would duplicate old assistant text as part of the new turn.
      if (state.loadingSession) return;
      var yokeEvents = flattenUpdate(params.update, state);
      for (var i = 0; i < yokeEvents.length; i++) pushEvent(yokeEvents[i]);
      return;
    }

    // Synthetic auth error from the transport layer
    if (method === "_kiro/error") {
      if (isKiroAuthError(params.error && params.error.message, params.error)) {
        pushEvent({ yokeType: "auth_required", vendor: "kiro" });
      } else {
        pushEvent({ yokeType: "error", text: (params.error && params.error.message) || "Kiro error" });
      }
      return;
    }

    // _kiro.dev/* notifications (commands, metadata, subagents, mcp status) are
    // informational; ignore them quietly to avoid noise.
  }

  // Close the currently open streaming blocks at turn end.
  function closeOpenBlocks() {
    if (state.thinkBlockOpen) {
      pushEvent({ yokeType: "thinking_stop", blockId: state.thinkBlockId });
      state.thinkBlockOpen = false;
    }
  }

  function resetTurnState() {
    state.textBlockOpen = false;
    state.textBlockId = null;
    state.thinkBlockOpen = false;
    state.thinkBlockId = null;
    state.toolBlocks = {};
    state.toolMeta = {};
    state.toolContent = {};
  }

  function emitResult() {
    var inputTokens = state.lastInputTokens || 0;
    var hasTokenData = inputTokens > 0;
    var resultModelUsage = {};
    resultModelUsage[state.model] = { contextWindow: state.contextWindow || null };
    pushEvent({
      yokeType: "result",
      uuid: generateUuid(),
      messageType: "assistant",
      cost: null,
      duration: null,
      usage: hasTokenData ? {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      } : null,
      modelUsage: resultModelUsage,
      sessionId: state.sessionId || null,
      lastStreamInputTokens: state.lastInputTokens || null,
    });
  }

  function setSessionModel(model) {
    if (!state.sessionId || !acp.started) return Promise.resolve();
    if (state.engine === "v3") {
      return acp.send("session/set_config_option", {
        sessionId: state.sessionId,
        configId: "model",
        value: model,
      }, 15000);
    }
    return acp.send("session/set_model", { sessionId: state.sessionId, modelId: model }, 15000);
  }

  // --- Main query loop ---
  async function runQueryLoop(initialMessage) {
    // Prepend the YOKE-merged system prompt to the first message's text.
    var currentMessage;
    if (!systemPrompt) {
      currentMessage = initialMessage;
    } else if (typeof initialMessage === "string") {
      currentMessage = systemPrompt + "\n\n" + initialMessage;
    } else if (Array.isArray(initialMessage)) {
      var cloned = initialMessage.slice();
      var injected = false;
      for (var i = 0; i < cloned.length; i++) {
        if (cloned[i] && cloned[i].type === "text") {
          cloned[i] = { type: "text", text: systemPrompt + "\n\n" + (cloned[i].text || "") };
          injected = true;
          break;
        }
      }
      if (!injected) cloned.unshift({ type: "text", text: systemPrompt });
      currentMessage = cloned;
    } else {
      currentMessage = initialMessage;
    }

    // Registered on the shared ACP process for the lifetime of this query, and
    // removed in the finally below. Events are routed to it by sessionId.
    var handlerEntry = null;

    try {
      handlerEntry = acp.addHandler(handleServerEvent);

      // Create or resume the session.
      if (state.sessionId) {
        // Bind before sending so replayed events from session/load route here.
        handlerEntry.sessionId = state.sessionId;
        state.loadingSession = true;
        try {
          await acp.send("session/load", {
            sessionId: state.sessionId,
            cwd: queryOpts.cwd,
            mcpServers: queryOpts.mcpServers || [],
          }, 60000);
        } catch (e) {
          // If load fails (unknown session), fall back to a fresh session.
          console.warn("[yoke/kiro] session/load failed, starting fresh:", e.message);
          state.sessionId = null;
          handlerEntry.sessionId = null;
        } finally {
          state.loadingSession = false;
        }
      }
      if (!state.sessionId) {
        var newResult = await acp.send("session/new", {
          cwd: queryOpts.cwd,
          mcpServers: queryOpts.mcpServers || [],
        }, 60000);
        state.sessionId = newResult && newResult.sessionId;
      }
      handlerEntry.sessionId = state.sessionId || null;

      // Kiro v3 defaults to autopilot, which bypasses permission requests.
      // Supervised mode is mandatory so every tool call reaches canUseTool.
      if (state.engine === "v3") {
        await acp.send("session/set_config_option", {
          sessionId: state.sessionId,
          configId: "autopilot",
          value: "off",
        }, 15000);
      }

      // Select model + mode for the session (best-effort; failures are non-fatal).
      if (queryOpts.model) {
        await setSessionModel(queryOpts.model).catch(function() {});
      }
      if (queryOpts.mode) {
        await acp.send("session/set_mode", { sessionId: state.sessionId, modeId: queryOpts.mode }, 15000).catch(function() {});
      }

      while (!isCancelled()) {
        resetTurnState();

        var messageWithSkills = injectSharedSkillContent(currentMessage, queryOpts.skills || []);
        var input = typeof messageWithSkills === "string"
          ? [{ type: "text", text: messageWithSkills }]
          : messageWithSkills;

        // Emit turn_start so the UI records a user turn boundary.
        pushEvent({ yokeType: "turn_start", uuid: generateUuid(), messageType: "user" });

        var promptResult = await acp.send("session/prompt", {
          sessionId: state.sessionId,
          prompt: input,
        }, 30 * 60 * 1000);

        closeOpenBlocks();

        var stopReason = promptResult && promptResult.stopReason;
        if (isCancelled() || stopReason === "cancelled") {
          pushEvent({ yokeType: "interrupted" });
          emitResult();
          break;
        }
        emitResult();

        var nextMsg = await waitForMessage();
        if (nextMsg === null) break;
        currentMessage = nextMsg;
      }
    } catch (e) {
      if (!isCancelled() && e.name !== "AbortError") {
        var loopErrMsg = e.message || String(e);
        console.error("[yoke/kiro] runQueryLoop error:", loopErrMsg);
        pushEvent(isKiroAuthError(loopErrMsg, e.rpcError)
          ? { yokeType: "auth_required", vendor: "kiro" }
          : { yokeType: "error", text: loopErrMsg });
      }
    } finally {
      // Leaving this registered would keep routing events (and permission
      // requests) to a dead query.
      if (handlerEntry) acp.removeHandler(handlerEntry);
    }

    state.done = true;
    endIterator();
  }

  var handle = {
    [Symbol.asyncIterator]: function() {
      return {
        next: function() {
          if (eventBuffer.length > 0) return Promise.resolve({ value: eventBuffer.shift(), done: false });
          if (iteratorDone) return Promise.resolve({ value: undefined, done: true });
          return new Promise(function(resolve) { eventWaiting = resolve; });
        },
      };
    },

    pushMessage: function(text, images) {
      if (iteratorDone || state.done || messageQueueEnded) return false;
      var input = [];
      if (images && images.length > 0) {
        for (var i = 0; i < images.length; i++) {
          var img = images[i];
          if (img && img.base64 && img.mimeType) {
            input.push({ type: "image", data: img.base64, mimeType: img.mimeType });
          }
        }
      }
      input.push({ type: "text", text: text || "" });
      var payload = input.length === 1 && input[0].type === "text" ? input[0].text : input;

      if (!state.loopStarted) {
        state.loopStarted = true;
        runQueryLoop(payload);
        return true;
      } else {
        return pushMessageToQueue(payload);
      }
    },

    setModel: function(model) {
      state.model = model;
      return setSessionModel(model);
    },

    setEffort: function() { return Promise.resolve(); },
    setToolPolicy: function() { return Promise.resolve(); },
    stopTask: function() { return Promise.resolve(); },

    getContextUsage: function() {
      return Promise.resolve(state.lastInputTokens != null ? {
        input_tokens: state.lastInputTokens,
        contextWindow: state.contextWindow || null,
      } : null);
    },

    abort: function() {
      console.log("[yoke/kiro] handle.abort() sessionId=" + state.sessionId + " already=" + state.aborted);
      state.aborted = true;
      if (state.sessionId && acp.started) {
        // ACP cancellation is a notification; the in-flight session/prompt will
        // resolve with stopReason "cancelled".
        acp.notify("session/cancel", { sessionId: state.sessionId });
      }
      endIterator();
    },

    close: function() {
      messageQueueEnded = true;
      if (messageWaiting) {
        var resolve = messageWaiting;
        messageWaiting = null;
        resolve(null);
      }
      endIterator();
    },

    endInput: function() {
      messageQueueEnded = true;
      if (messageWaiting) {
        var resolve = messageWaiting;
        messageWaiting = null;
        resolve(null);
      }
    },
  };

  if (abortController && abortController.signal) {
    abortController.signal.addEventListener("abort", function() {
      if (!state.aborted) handle.abort();
    }, { once: true });
  }

  return handle;
}


module.exports = { createKiroQueryHandle: createKiroQueryHandle };
