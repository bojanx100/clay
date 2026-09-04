// Normal provider event consumption and clean stream-end behavior.

var automationForClaudePermission = require("./automation-modes").automationForClaudePermission;
var recordRecoveryEvent = require("./recovery-log").recordRecoveryEvent;
var failures = require("./sdk-provider-failover-signals");
var recordProviderFailure = failures.recordProviderFailure;
var queuePendingProviderFailover = failures.queuePendingProviderFailover;
var policy = require("./sdk-bridge-stream-policy");
var watchdog = require("./sdk-bridge-stream-watchdog");
var isProviderQuotaError = require("./provider-quota-errors").isProviderQuotaError;

function requestUsage(ctx, state) {
  var query = state.query;
  if (state.rateLimitUsageRequested || typeof query.getRateLimitUsageEvents !== "function") return;
  state.rateLimitUsageRequested = true;
  query.getRateLimitUsageEvents().then(function (events) {
    if (!watchdog.isCurrent(state, "callback")) return;
    if (!Array.isArray(events) || state.session.destroying) return;
    for (var i = 0; i < events.length; i++) ctx.processSDKMessage(state.session, events[i]);
  }).catch(function (error) {
    console.error("[sdk-bridge] current Claude usage fetch failed (non-fatal):", error.message || error);
  });
}

function contextUsage(ctx, session, data) {
  session.lastContextUsage = data.data;
  ctx.sendToSession(session, { type: "context_usage", data: data.data });
}

function modelChanged(ctx, session, data) {
  ctx.sm.currentModel = data.model;
  ctx.sendModelInfoForVendor(watchdog.vendorFor(ctx, session), data.model, session);
  ctx.send({ type: "config_state", model: ctx.sm.currentModel,
    mode: ctx.sm.currentPermissionMode || "default", effort: ctx.sm.currentEffort || "medium",
    betas: ctx.sm.currentBetas || [] });
}

function effortChanged(ctx, data) {
  ctx.sm.currentEffort = data.effort;
  ctx.send({ type: "config_state", model: ctx.sm.currentModel || "",
    mode: ctx.sm.currentPermissionMode || "default", effort: ctx.sm.currentEffort,
    betas: ctx.sm.currentBetas || [] });
}

function permissionChanged(ctx, session, data) {
  ctx.sm.currentPermissionMode = data.mode;
  session.permissionMode = data.mode;
  session.automationMode = automationForClaudePermission(data.mode);
  ctx.send({ type: "config_state", model: ctx.sm.currentModel || "", mode: data.mode,
    automationMode: session.automationMode, effort: ctx.sm.currentEffort || "medium",
    betas: ctx.sm.currentBetas || [] });
}

var META_HANDLERS = {
  context_usage: contextUsage,
  model_changed: modelChanged,
  effort_changed: function (ctx, session, data) { effortChanged(ctx, data); },
  permission_mode_changed: permissionChanged,
  worker_error: function (ctx, session, data) { ctx.send({ type: "error", text: data.error }); },
};

function handleWorkerMeta(ctx, state, message) {
  var handler = META_HANDLERS[message.subtype];
  if (handler) handler(ctx, state.session, message.data || {});
}

function beginAdapterError(ctx, session, text) {
  console.error("[sdk-bridge] Adapter error event for session " + session.localId + ": " + text);
  session.isProcessing = false;
  ctx.onProcessingChanged();
  ctx.send({ type: "status", processing: false });
  ctx.sendAndRecord(session, { type: "thinking_stop" });
}

function canRetryAdapterError(ctx, session, text) {
  return ctx.isTransientStreamError(text) && !session._transientRetryUsed &&
    !session.taskStopRequested && ctx.autoResumeAllowed(session) &&
    typeof ctx.opts.scheduleMessage === "function";
}

function retryAdapterError(ctx, session, text) {
  console.warn("[sdk-bridge] Transient adapter stream error for session " + session.localId +
    "; auto-retrying once: " + text);
  recordRecoveryEvent({ kind: "transient", sessionId: session.localId,
    vendor: watchdog.vendorFor(ctx, session), source: "adapter-error",
    error: String(text).slice(0, 300) });
  session._transientRetryUsed = true;
  ctx.sendAndRecord(session, { type: "info",
    text: "Connection dropped mid-response. Retrying…", variant: "recovery" });
  ctx.sendAndRecord(session, { type: "done", code: 0 });
  ctx.scheduleInterruptResume(session);
  ctx.sm.broadcastSessionList();
}

function terminalAdapterError(ctx, session, text) {
  if (isProviderQuotaError(text)) {
    var vendor = watchdog.vendorFor(ctx, session);
    ctx.sendAndRecord(session, { type: "info", variant: "warning",
      text: ctx.getVendorDisplayName(vendor) +
        " quota or allowance is exhausted. Clay will try another healthy provider." });
    ctx.sendAndRecord(session, { type: "done", code: 1 });
    recordProviderFailure(session, vendor, "provider-quota-exhausted", {
      immediate: true,
    });
    return;
  }
  ctx.sendAndRecord(session, { type: "error", text: text });
  ctx.sendAndRecord(session, { type: "done", code: 1 });
  if (!ctx.isAuthErrorMessage(text) && !policy.isTransientProviderErrorText(text)) {
    recordProviderFailure(session, watchdog.vendorFor(ctx, session),
      "provider-error:" + String(text).slice(0, 80), { strong: true });
  }
}

function handleAdapterError(ctx, state, message) {
  var session = state.session;
  var text = message.text || "Unknown error";
  beginAdapterError(ctx, session, text);
  if (policy.isContextOverflowError(text)) {
    ctx.sendAndRecord(session, { type: "context_overflow", text: "Conversation too long to continue." });
    ctx.sendAndRecord(session, { type: "done", code: 1 });
    ctx.notifyResumeGaveUp(session, "The conversation exceeded the model's context window.");
  } else if (canRetryAdapterError(ctx, session, text)) {
    retryAdapterError(ctx, session, text);
  } else {
    terminalAdapterError(ctx, session, text);
  }
  queuePendingProviderFailover(session, ctx.opts);
}

function debugMessage(ctx, message) {
  if (!ctx.debugEvents || !message) return;
  var quiet = message.yokeType === "text_delta" || message.yokeType === "thinking_delta" ||
    message.yokeType === "tool_input_delta";
  if (!quiet) console.log("[sdk-bridge] processQueryStream: received event yokeType=" + message.yokeType);
}

function processMessage(ctx, state, message) {
  requestUsage(ctx, state);
  watchdog.observeProgress(state, message);
  watchdog.observeTool(state, message);
  debugMessage(ctx, message);
  if (message && message.type === "_worker_meta") {
    handleWorkerMeta(ctx, state, message);
    return;
  }
  if (message && message.yokeType === "error") {
    handleAdapterError(ctx, state, message);
    return;
  }
  if (watchdog.isCurrent(state, "callback")) ctx.processSDKMessage(state.session, message);
}

function canRetryStreamEnd(ctx, session) {
  return !session.streamEndedAutoRetryQueued && !session._transientRetryUsed &&
    !session.rateLimitResetsAt && !session.scheduledMessage && ctx.autoResumeAllowed(session) &&
    typeof ctx.opts.scheduleMessage === "function";
}

function retryStreamEnd(ctx, session) {
  session.streamEndedAutoRetryQueued = true;
  session._transientRetryUsed = true;
  ctx.sendAndRecord(session, { type: "info",
    text: "Connection dropped before the response finished. Resuming…" });
  ctx.sendAndRecord(session, { type: "done", code: 0 });
  ctx.scheduleInterruptResume(session);
}

function failedStreamEnd(ctx, session) {
  var message = ctx.getVendorDisplayName(watchdog.vendorFor(ctx, session)) +
    " stopped before returning a final response.";
  ctx.sendAndRecord(session, { type: "error", text: message });
  ctx.sendAndRecord(session, { type: "done", code: 1 });
  recordProviderFailure(session, watchdog.vendorFor(ctx, session),
    "resume-gave-up:stream-ended", { strong: true });
  ctx.notifyResumeGaveUp(session, message + " Auto-resume is out of retries.");
}

function interruptedStreamEnd(ctx, session) {
  var message = session.vendor === "codex" ?
    "■ Conversation interrupted - tell the model what to do differently." :
    "Interrupted · What should Claude do instead?";
  ctx.sendAndRecord(session, { type: "info", text: message });
  ctx.sendAndRecord(session, { type: "done", code: 0 });
}

function explainStreamEnd(ctx, session) {
  if (session._providerFailoverClosing) {
    console.log("[sdk-bridge] Stream closed at the provider-failover boundary for session " + session.localId);
    return;
  }
  if (session.taskStopRequested) { interruptedStreamEnd(ctx, session); return; }
  if (canRetryStreamEnd(ctx, session)) { retryStreamEnd(ctx, session); return; }
  failedStreamEnd(ctx, session);
}

function maybeTurnDone(ctx, state) {
  var session = state.session;
  if (!watchdog.isCurrent(state, "completion")) return;
  if (session.taskStopRequested && !session.steerInterruptRequested) return;
  if (!ctx.onTurnDone || session.providerFailoverPending || session._providerFailoverClosing) return;
  try { ctx.onTurnDone(session, session._taskWorkflowResponseText || ""); } catch (error) {}
}

function handleStreamEnd(ctx, state) {
  var session = state.session;
  console.log("[sdk-bridge] processQueryStream ended: isProcessing=" + session.isProcessing +
    " taskStopRequested=" + session.taskStopRequested);
  if (!session.isProcessing) return;
  session.isProcessing = false;
  ctx.onProcessingChanged();
  ctx.send({ type: "status", processing: false });
  ctx.sendAndRecord(session, { type: "thinking_stop" });
  if (!session.destroying) explainStreamEnd(ctx, session);
  ctx.sm.broadcastSessionList();
  maybeTurnDone(ctx, state);
}

async function consumeStream(ctx, state) {
  if (state.fencedOut || !watchdog.isCurrent(state, "callback")) {
    watchdog.rejectFence(state);
    return;
  }
  for await (var message of state.query) {
    if (!watchdog.isCurrent(state, "callback")) { watchdog.rejectFence(state); break; }
    processMessage(ctx, state, message);
  }
  if (!watchdog.isCurrent(state, "completion")) { watchdog.rejectFence(state); return; }
  handleStreamEnd(ctx, state);
}

module.exports = { consumeStream: consumeStream, maybeTurnDone: maybeTurnDone };
