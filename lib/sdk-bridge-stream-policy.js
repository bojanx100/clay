// Pure timeout and event classifiers shared by the provider stream.

var STREAM_MIDSTREAM_TIMEOUT_MS = 120 * 1000;
var STREAM_MIDSTREAM_TIMEOUT_CODEX_MS = 120 * 1000;
var STREAM_MIDSTREAM_TIMEOUT_CODEX_SOL_MS = 240 * 1000;
var STREAM_TOOL_TIMEOUT_MS = 10 * 60 * 1000;
var STREAM_FIRST_EVENT_TIMEOUT_MS = 45 * 1000;

function isCodexSolModel(model) {
  return String(model || "").toLowerCase() === "gpt-5.6-sol";
}

function midstreamTimeoutFor(vendor, consecutiveAutoResumes, model) {
  var base = vendor === "codex" ? STREAM_MIDSTREAM_TIMEOUT_CODEX_MS : STREAM_MIDSTREAM_TIMEOUT_MS;
  if (vendor === "codex" && isCodexSolModel(model)) {
    base = STREAM_MIDSTREAM_TIMEOUT_CODEX_SOL_MS;
  }
  var n = Math.min(consecutiveAutoResumes || 0, 3);
  return Math.min(base * Math.pow(2, n), STREAM_TOOL_TIMEOUT_MS);
}

function hasInteractiveToolWaits(session) {
  return !!(session && session.interactiveToolWaits &&
    Object.keys(session.interactiveToolWaits).length > 0);
}

function clearInteractiveToolWaits(session) {
  if (session) session.interactiveToolWaits = {};
}

function watchdogTimeoutFor(session, activeToolCount, sawAnyEvent, vendor) {
  return activeToolCount > 0 || hasInteractiveToolWaits(session)
    ? STREAM_TOOL_TIMEOUT_MS
    : (sawAnyEvent
      ? midstreamTimeoutFor(vendor, session && session._consecutiveAutoResumes,
        session && (session.verifiedModel || session.model))
      : STREAM_FIRST_EVENT_TIMEOUT_MS);
}

function isContextOverflowError(text) {
  if (!text) return false;
  var value = String(text).toLowerCase();
  return value.indexOf("prompt is too long") !== -1 || value.indexOf("context_length") !== -1 ||
    value.indexOf("maximum context length") !== -1;
}

function isTransientProviderErrorText(text) {
  if (!text) return false;
  var value = String(text).toLowerCase();
  return value.indexOf("reconnecting") !== -1 || value.indexOf("reconnect…") !== -1 ||
    value.indexOf("stream disconnected, reconnecting") !== -1;
}

function isWatchdogProgressEvent(message) {
  if (!message || message.yokeType !== "system") return true;
  return !!(message.error || message.message || message.text || message.content);
}

module.exports = {
  clearInteractiveToolWaits: clearInteractiveToolWaits,
  hasInteractiveToolWaits: hasInteractiveToolWaits,
  isContextOverflowError: isContextOverflowError,
  isTransientProviderErrorText: isTransientProviderErrorText,
  isWatchdogProgressEvent: isWatchdogProgressEvent,
  midstreamTimeoutFor: midstreamTimeoutFor,
  watchdogTimeoutFor: watchdogTimeoutFor,
};
