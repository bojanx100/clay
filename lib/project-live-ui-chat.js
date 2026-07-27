var crypto = require("crypto");

function attachLiveUiChat(ctx) {
  var registry = ctx.registry;
  var sm = ctx.sm;
  var userMessage = ctx.userMessage;
  var pairSessions = new Map();
  var activeOperations = new Map();

  function clearOperation(pairingId) {
    var operation = activeOperations.get(pairingId);
    if (operation && operation.unsubscribe) operation.unsubscribe();
    activeOperations.delete(pairingId);
  }

  function registerPair(pairingId, sessionId) {
    pairSessions.set(pairingId, sessionId);
  }

  function clearPair(pairingId) {
    clearOperation(pairingId);
    pairSessions.delete(pairingId);
  }

  function selectionContext(selection) {
    if (!selection) return "";
    return [
      "Live UI target context:",
      "- Route: " + (selection.route || "/"),
      "- Element: " + (selection.tag || "unknown"),
      "- Accessible name: " + (selection.accessibleName || "none"),
      "- Visible text: " + (selection.text || "none"),
      "- Selector candidates: " + (selection.selectors || []).join(", "),
      "Treat selectors as candidates. Inspect the source before editing and verify the result.",
    ].join("\n");
  }

  function publicStreamEvent(event) {
    if (!event || !event.type) return null;
    if (event.type === "delta" || event.type === "thinking_delta") {
      return { type: event.type, text: String(event.text || "").slice(0, 12000) };
    }
    if (event.type === "tool_start" || event.type === "tool_executing" ||
        event.type === "tool_done") {
      return {
        type: event.type,
        tool: event.tool || event.name || "Working",
      };
    }
    if (event.type === "permission_request" || event.type === "ask_user" ||
        event.type === "elicitation_request") {
      return { type: "needs_input", text: "Input or approval is required in Clay." };
    }
    if (event.type === "error") {
      return {
        type: "error",
        text: String(event.text || event.error || "The turn failed").slice(0, 2000),
      };
    }
    if (event.type === "done") return { type: "done", code: event.code || 0 };
    return null;
  }

  function handleMessage(ws, msg, pairing, selection) {
    ctx.assertExtensionSender(ws, pairing);
    var text = msg.payload && typeof msg.payload.text === "string"
      ? msg.payload.text.trim().slice(0, 12000)
      : "";
    if (!text) {
      var emptyError = new Error("Write a message before sending");
      emptyError.code = "LIVE_UI_CHAT_EMPTY";
      throw emptyError;
    }
    if (activeOperations.has(pairing.pairingId)) {
      var busyError = new Error("This Live UI turn is still running");
      busyError.code = "LIVE_UI_CHAT_BUSY";
      throw busyError;
    }
    var sessionId = pairSessions.get(pairing.pairingId);
    var session = sm && sm.sessions ? sm.sessions.get(sessionId) : null;
    if (!session) {
      var sessionError = new Error("The pinned Clay session is no longer available");
      sessionError.code = "LIVE_UI_SESSION_GONE";
      throw sessionError;
    }
    if (session.isProcessing) {
      var sessionBusyError = new Error(
        "The pinned Clay session is already working. Wait for it to finish or continue in Clay."
      );
      sessionBusyError.code = "LIVE_UI_SESSION_BUSY";
      throw sessionBusyError;
    }
    var operationId = crypto.randomUUID();
    var accepted = registry.acceptMessage(pairing.pairingId, msg.clientMessageId, function () {
      return { accepted: true, operationId: operationId };
    });
    if (accepted.duplicate) {
      ctx.sendTarget(pairing, "chat.accepted", accepted.acknowledgment);
      return;
    }
    var unsubscribe = sm.subscribeSession(session.localId, function (event) {
      var publicEvent = publicStreamEvent(event);
      if (!publicEvent) return;
      ctx.sendTarget(pairing, "chat.stream", Object.assign({
        operationId: operationId,
      }, publicEvent));
      if (event.type === "done") clearOperation(pairing.pairingId);
    });
    activeOperations.set(pairing.pairingId, {
      operationId: operationId,
      unsubscribe: unsubscribe,
    });
    ctx.sendTarget(pairing, "chat.accepted", {
      operationId: operationId,
      text: text,
    });
    var context = selectionContext(selection);
    var handled = false;
    try {
      handled = userMessage.handleUserMessage(ctx.pairControlWs(pairing), {
        type: "message",
        sessionId: session.localId,
        preserveActiveSession: true,
        clientMessageId: "live-ui-" + operationId,
        text: text,
        pastes: context ? [context] : null,
      });
    } catch (error) {
      clearOperation(pairing.pairingId);
      throw error;
    }
    if (!handled) {
      clearOperation(pairing.pairingId);
      var dispatchError = new Error("Clay could not dispatch the Live UI message");
      dispatchError.code = "LIVE_UI_CHAT_DISPATCH_FAILED";
      throw dispatchError;
    }
  }

  return {
    registerPair: registerPair,
    clearPair: clearPair,
    handleMessage: handleMessage,
  };
}

module.exports = {
  attachLiveUiChat: attachLiveUiChat,
};
