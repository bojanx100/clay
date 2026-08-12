// Shared fail-closed cleanup for provider construction and initial dispatch.

var executionFence = require("./coop-control-fence");

function capturedTurnIsCurrent(input) {
  return !input.controlledFence || executionFence.isIncarnationCurrent(
    input.session, input.controlledFence);
}

function failQueryStart(input) {
  var session = input.session;
  var error = input.error;
  var handle = input.handle;
  if (handle && typeof handle.close === "function") {
    try { handle.close(); } catch (closeError) {}
  }
  var current = capturedTurnIsCurrent(input);
  if (current && input.controlledFence) {
    try { input.controlledFence.abandon("provider_start_failed"); } catch (fenceError) {}
  }
  console.error("[sdk-bridge] Failed to create or start query for session " + session.localId + ":",
    error.message || error);
  console.error("[sdk-bridge] cliSessionId:", session.cliSessionId, "resume:", !!session.cliSessionId);
  console.error("[sdk-bridge] Stack:", error.stack || "(no stack)");
  if (!current) return false;
  session.isProcessing = false;
  input.onProcessingChanged();
  if (session.queryInstance === handle) session.queryInstance = null;
  session.messageQueue = null;
  session.abortController = null;
  input.sendAndRecord(session, { type: "error", text: "Failed to start query: " + (error.message || error) });
  input.sendAndRecord(session, { type: "done", code: 1 });
  input.sm.broadcastSessionList();
  return true;
}

module.exports = { failQueryStart: failQueryStart };
