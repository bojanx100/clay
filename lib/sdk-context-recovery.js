// Context exhaustion is a conversation failure, not a provider outage or task
// completion. Renew after the old stream is detached, once until useful work.
var provenance = require("./coop-control-provenance");
var policy = require("./sdk-bridge-stream-policy");
var recordRecoveryEvent = require("./recovery-log").recordRecoveryEvent;

function pending(session) {
  return !!(session && session.contextRecovery && session.contextRecovery.status === "pending");
}

function save(sm, session) {
  if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session, { durable: true });
}

function mark(ctx, session) {
  if (pending(session)) return;
  var previous = session.contextRecovery || {};
  session.contextRecovery = { status: "pending", attempts: previous.attempts || 0,
    sourceCliSessionId: session.cliSessionId || null, detectedAt: Date.now() };
  session.providerFailoverPending = null;
  ctx.sendAndRecord(session, { type: "context_overflow", text: "Conversation too long to continue." });
  save(ctx.sm, session);
}

function blockedReason(input) {
  var session = input.session;
  var execution = session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
  if (session.destroying || session._deleted || session.hidden || session.taskStopRequested) return "session_stopped";
  if (execution && ["completed", "failed", "needs_input", "superseded", "cancelled"].indexOf(execution.status) !== -1) return "execution_ended";
  if (session.contextRecovery.attempts >= 1) return "recovery_exhausted";
  if (session._activeProviderToolCount > 0 || policy.hasInteractiveToolWaits(session) ||
      Object.keys(session.pendingAskUser || {}).length) return "pending_interaction";
  var controlled = execution && execution.control || provenance.isCoopControlled(session) || session.coopHome;
  var getLeadMode = input.opts.getLeadMode || require("./lead-mode").getLeadMode;
  if (controlled && getLeadMode() !== true) return "lead_mode_off";
  if (typeof input.opts.compactAndContinue !== "function") return "renewal_unavailable";
  return "";
}

function finish(input, priorBlocker) {
  var session = input.session;
  if (!pending(session)) return false;
  var state = session.contextRecovery;
  var reason = priorBlocker || blockedReason(input);
  if (!reason) {
    state.status = "renewing";
    state.attempts++;
    save(input.sm, session);
    try {
      var renewed = input.opts.compactAndContinue(session,
        { reason: "context_overflow", automatic: true, inPlace: true });
      if (renewed) return true;
      reason = "renewal_refused";
    } catch (error) { reason = "renewal_failed"; }
  }
  state.status = "blocked";
  state.reason = reason;
  save(input.sm, session);
  recordRecoveryEvent({ kind: "context_recovery", sessionId: session.localId,
    outcome: "blocked", reason: reason });
  input.sendAndRecord(session, { type: "info", variant: "warning",
    text: "Context recovery paused (" + reason + "). The saved task and conversation are preserved." });
  return true;
}

function productive(session, sm) {
  if (!session.contextRecovery) return;
  session.contextRecovery = null;
  save(sm, session);
}

module.exports = { mark: mark, pending: pending, finish: finish,
  blockedReason: blockedReason, productive: productive };
