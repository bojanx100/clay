// Renew a terminal project coordinator's durable control incarnation while
// preserving its task, ProjectRef, SessionRef, and original Lead authority.

var bindings = require("./portfolio-execution-bindings");
var projectIdentity = require("./project-identity");

function sameSessionRef(left, right) {
  var a = projectIdentity.normalizeSessionRef(left);
  var b = projectIdentity.normalizeSessionRef(right);
  return !!(a && b && a.projectId === b.projectId &&
    a.sessionStorageId === b.sessionStorageId);
}

function hasEffect(history, effectId) {
  if (!effectId) return false;
  for (var i = 0; i < history.length; i++) {
    if (history[i] && history[i].controlEffectId === effectId) return true;
  }
  return false;
}

function appendCommand(opts, session, metadata, input) {
  var item = {
    type: "user_message",
    text: input.text,
    synthetic: true,
    origin: { kind: "portfolio_execution" },
    _ts: Date.now(),
  };
  if (input.effectId) item.controlEffectId = input.effectId;
  session.history.push(item);
  if (!input.effectId && input.eventId) {
    var applied = Array.isArray(metadata.appliedCommandIds) ?
      metadata.appliedCommandIds.slice() : [];
    applied.push(input.eventId);
    if (applied.length > 64) applied.splice(0, applied.length - 64);
    metadata.appliedCommandIds = applied;
  }
  opts.sm.appendToSessionFile(session, item);
}

function createTaskCoordinatorRecovery(options) {
  var opts = options || {};

  function prepareNeedsInputResume(session, envelope) {
    var metadata = opts.executionMetadata(session);
    if (!opts.executionControl.enabled || !metadata ||
        metadata.mode !== "project_coordinator" || metadata.status !== "needs_input") return null;
    if (session.coordinationRole !== "task_coordinator") {
      return { ok: false, reason: "invalid_execution_binding" };
    }
    if (session.isProcessing) return { ok: false, reason: "coordinator_busy" };
    var source = projectIdentity.normalizeSessionRef(envelope && envelope.source);
    var authority = projectIdentity.normalizeSessionRef(metadata.source);
    if (!source || !authority || !sameSessionRef(source, authority)) {
      return { ok: false, reason: "execution_authority_mismatch" };
    }
    var request = bindings.normalizeRequest(metadata, { persisted: true });
    var payload = envelope && envelope.payload || {};
    if (!request || request.portfolioTaskId !== String(payload.portfolioTaskId || "") ||
        request.bindingRevision !== Number(payload.bindingRevision)) {
      return { ok: false, reason: "invalid_execution_binding" };
    }
    return { ok: true, request: request, source: authority };
  }

  function restart(input) {
    var session = input.session;
    var metadata = opts.executionMetadata(session);
    var applied = Array.isArray(metadata && metadata.appliedCommandIds) ?
      metadata.appliedCommandIds : [];
    var existingEffect = hasEffect(session.history, input.effectId);
    if (!input.effectId && input.eventId && applied.indexOf(input.eventId) !== -1) {
      return opts.sessionResult(session, false);
    }
    var start = opts.executionControl.reserve(input.request, input.source);
    var snapshot = {
      policy: session.orchestrationPolicy,
      fence: session._coopExecutionFence,
      historyLength: session.history.length,
    };
    try {
      var controlMetadata = opts.executionControl.bind(session, start);
      session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
        portfolioExecution: opts.activeExecutionMetadata(metadata, input.request, input.source),
      });
      metadata = session.orchestrationPolicy.portfolioExecution;
      if (controlMetadata) metadata.control = controlMetadata;
      if (typeof input.prepareSession === "function") input.prepareSession(session);
      if (!existingEffect) appendCommand(opts, session, metadata, input);
      if (typeof opts.onRunning === "function") opts.onRunning(session);
      opts.sm.saveSessionFile(session, { durable: true });
      opts.sm.broadcastSessionList();
      opts.executionControl.open(start);
      opts.continueExecution(session, input.text);
      return opts.sessionResult(session, false);
    } catch (error) {
      try { opts.executionControl.abandonStart(start, "pre_start_failed"); }
      catch (abandonError) {}
      session.orchestrationPolicy = snapshot.policy;
      session.history.splice(snapshot.historyLength);
      if (snapshot.fence) session._coopExecutionFence = snapshot.fence;
      else delete session._coopExecutionFence;
      try { opts.sm.saveSessionFile(session, { durable: true }); }
      catch (saveError) {}
      throw error;
    }
  }

  return {
    prepareNeedsInputResume: prepareNeedsInputResume,
    restart: restart,
  };
}

module.exports = { createTaskCoordinatorRecovery: createTaskCoordinatorRecovery };
