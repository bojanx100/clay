// Thrown stream-error handling kept separate from normal event consumption.

var usersModule = require("./users");
var recordRecoveryEvent = require("./recovery-log").recordRecoveryEvent;
var recordProviderFailure = require("./sdk-provider-failover-signals").recordProviderFailure;
var policy = require("./sdk-bridge-stream-policy");
var watchdog = require("./sdk-bridge-stream-watchdog");
var maybeTurnDone = require("./sdk-bridge-stream-events").maybeTurnDone;

function isInterrupted(state, error) {
  var signal = state.abortController && state.abortController.signal;
  return error.name === "AbortError" || signal && signal.aborted ||
    state.session.taskStopRequested;
}

function canRetryWatchdog(ctx, session) {
  return session._watchdogAbort && !session.taskStopRequested && !session.destroying &&
    !session._transientRetryUsed && ctx.autoResumeAllowed(session) &&
    typeof ctx.opts.scheduleMessage === "function";
}

function retryWatchdog(ctx, session) {
  console.warn("[sdk-bridge] Watchdog abort for session " + session.localId +
    "; auto-resuming once.");
  session._watchdogAbort = false;
  session._transientRetryUsed = true;
  ctx.sendAndRecord(session, { type: "thinking_stop" });
  ctx.sendAndRecord(session, { type: "info", text: "Response stalled. Resuming…",
    variant: "recovery" });
  ctx.sendAndRecord(session, { type: "done", code: 0 });
  ctx.scheduleInterruptResume(session);
  ctx.sm.broadcastSessionList();
}

function finishInterrupt(ctx, session) {
  session._watchdogAbort = false;
  if (session.destroying) return;
  ctx.sendAndRecord(session, { type: "thinking_stop" });
  if (!session.steerInterruptRequested) {
    var text = session.vendor === "codex" ?
      "■ Conversation interrupted - tell the model what to do differently." :
      "Interrupted · What should Claude do instead?";
    ctx.sendAndRecord(session, { type: "info", text: text });
  }
  ctx.sendAndRecord(session, { type: "done", code: 0 });
}

function handleInterrupted(ctx, state) {
  if (canRetryWatchdog(ctx, state.session)) {
    retryWatchdog(ctx, state.session);
    return true;
  }
  finishInterrupt(ctx, state.session);
  return false;
}

function errorDetails(error) {
  var detail = error.message || String(error);
  if (error.stderr) detail += "\nstderr: " + error.stderr;
  if (error.exitCode != null) detail += " (exitCode: " + error.exitCode + ")";
  return detail;
}

function isExitCodeOne(error) {
  return error.exitCode === 1 || !!(error.message &&
    error.message.indexOf("exited with code 1") !== -1);
}

function handleConflict(ctx, session, error) {
  var conflicts = isExitCodeOne(error) ? ctx.findConflictingClaude() : [];
  if (conflicts.length === 0) return false;
  console.error("[sdk-bridge] Found " + conflicts.length +
    " conflicting Claude process(es):", conflicts.map(function (item) {
      return "PID " + item.pid;
    }).join(", "));
  ctx.sendAndRecord(session, { type: "process_conflict",
    text: "Another Claude Code process is already running in this project.",
    processes: conflicts });
  ctx.notifyResumeGaveUp(session,
    "Another Claude Code process is conflicting with this project.");
  return true;
}

function canRetryTransient(ctx, session, detail) {
  return ctx.isTransientStreamError(detail) && !session._transientRetryUsed &&
    !session.taskStopRequested && ctx.autoResumeAllowed(session) &&
    typeof ctx.opts.scheduleMessage === "function";
}

function retryTransient(ctx, session, detail) {
  var vendor = watchdog.vendorFor(ctx, session);
  console.warn("[sdk-bridge] Transient stream error for session " + session.localId +
    "; auto-retrying once: " + detail);
  recordRecoveryEvent({ kind: "transient", sessionId: session.localId, vendor: vendor,
    error: String(detail).slice(0, 300) });
  recordProviderFailure(session, vendor, "transient:" + String(detail).slice(0, 80));
  session._transientRetryUsed = true;
  ctx.sendAndRecord(session, { type: "thinking_stop" });
  ctx.sendAndRecord(session, { type: "info",
    text: "Connection dropped mid-response. Retrying…", variant: "recovery" });
  ctx.sendAndRecord(session, { type: "done", code: 0 });
  ctx.scheduleInterruptResume(session);
  ctx.sm.broadcastSessionList();
}

function authUserDetails(session) {
  var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
  var linuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
  return { linuxUser: linuxUser, canAutoLogin: !usersModule.isMultiUser() ||
    !!linuxUser || !!(authUser && authUser.role === "admin") };
}

function reportAuthRequired(ctx, session) {
  var vendor = watchdog.vendorFor(ctx, session);
  var details = authUserDetails(session);
  var title = ctx.getVendorDisplayName(vendor) + " is not logged in.";
  var command = ctx.getLoginCommand(vendor);
  ctx.sendAndRecord(session, { type: "auth_required", text: title, vendor: vendor,
    loginCommand: command, linuxUser: details.linuxUser,
    canAutoLogin: details.canAutoLogin });
  ctx.notifyAuthRequired(session, title,
    "Open a terminal, then click the URL and follow the instructions.",
    details.linuxUser, details.canAutoLogin, command);
}

function handleAuthError(ctx, session, detail) {
  var fresh = ctx.getFreshAuthState(true, ctx.getLinuxUserForSession(session)) || {};
  ctx.logAuthDecision("catch-auth-error", session, detail, fresh);
  if (!fresh[session.vendor]) {
    reportAuthRequired(ctx, session);
    return false;
  }
  ctx.sendAndRecord(session, { type: "error", text: "Authentication looked fine, but " +
    (session.vendor || "the vendor") + " returned an auth-like error." });
  ctx.sendAndRecord(session, { type: "done", code: 1 });
  ctx.sm.broadcastSessionList();
  return true;
}

function reportContextOverflow(ctx, session) {
  require("./sdk-context-recovery").mark(ctx, session);
}

function reportProviderError(ctx, session, error) {
  ctx.sendAndRecord(session, { type: "error", text: "Claude process error: " + error.message });
  recordProviderFailure(session, watchdog.vendorFor(ctx, session),
    "provider-error:" + String(error.message || "").slice(0, 80), { strong: true });
  ctx.notifyResumeGaveUp(session, "The provider errored and auto-resume did not apply.");
}

function classifyTerminal(ctx, session, error, detail) {
  if (policy.isContextOverflowError(detail)) {
    reportContextOverflow(ctx, session);
    return false;
  }
  if (ctx.isAuthErrorMessage(detail)) return handleAuthError(ctx, session, detail);
  reportProviderError(ctx, session, error);
  return false;
}

function handleFailure(ctx, state, error) {
  var session = state.session;
  var detail = errorDetails(error);
  console.error("[sdk-bridge] Query stream error for session " + session.localId + ":", detail);
  console.error("[sdk-bridge] Stack:", error.stack || "(no stack)");
  if (handleConflict(ctx, session, error)) return false;
  if (canRetryTransient(ctx, session, detail)) {
    retryTransient(ctx, session, detail);
    return true;
  }
  if (classifyTerminal(ctx, session, error, detail)) return true;
  ctx.sendAndRecord(session, { type: "done", code: 1 });
  return false;
}

function finishCaughtTurn(ctx, state) {
  ctx.sm.broadcastSessionList();
  if (state.session.steerInterruptRequested) maybeTurnDone(ctx, state);
}

function handleStreamError(ctx, state, error) {
  if (!watchdog.isCurrent(state, "callback")) {
    watchdog.rejectFence(state);
    return;
  }
  var session = state.session;
  if (!session.isProcessing) return;
  session.isProcessing = false;
  ctx.onProcessingChanged();
  if (isInterrupted(state, error)) {
    if (handleInterrupted(ctx, state)) return;
  } else if (session.destroying) {
    console.log("[sdk-bridge] Suppressing stream error during shutdown for session " +
      session.localId);
  } else if (handleFailure(ctx, state, error)) {
    return;
  }
  finishCaughtTurn(ctx, state);
}

module.exports = { handleStreamError: handleStreamError };
