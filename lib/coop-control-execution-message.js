// Crash-safe visible application of a durable external execution message.

function hasEffect(history, effectId) {
  for (var i = 0; i < history.length; i++) {
    if (history[i] && history[i].controlEffectId === effectId) return true;
  }
  return false;
}

function appendMessage(opts, session, metadata, envelope, text, effectId, applied) {
  var item = { type: "user_message", text: text, synthetic: true,
    origin: { kind: "portfolio_execution" }, _ts: Date.now() };
  if (effectId) item.controlEffectId = effectId;
  session.history.push(item);
  if (!effectId) {
    applied.push(envelope.eventId);
    if (applied.length > 64) applied.splice(0, applied.length - 64);
    metadata.appliedCommandIds = applied;
  }
  opts.sm.appendToSessionFile(session, item);
}

function recoveryResult(started, result) {
  function accepted(value) {
    return value === false || value && value.ok === false ? false : result;
  }
  return started && typeof started.then === "function" ? started.then(accepted) : accepted(started);
}

function createExecutionMessageApplier(options) {
  var opts = options || {};
  return function applyExecutionMessage(session, payload, envelope, text, effectId, recoveryStart) {
    var metadata = opts.executionMetadata(session);
    var applied = Array.isArray(metadata.appliedCommandIds) ? metadata.appliedCommandIds : [];
    var alreadyApplied = effectId ? hasEffect(session.history, effectId) : false;
    if (effectId) {
      if (alreadyApplied && !recoveryStart) return opts.sessionResult(session, false);
      opts.executionControl.assert(session, recoveryStart ? "provider_start" : "tool");
    } else if (applied.indexOf(envelope.eventId) !== -1) {
      return opts.sessionResult(session, false);
    }
    if (!alreadyApplied) appendMessage(opts, session, metadata, envelope, text, effectId, applied);
    metadata.status = "running";
    metadata.updatedAt = Date.now();
    delete metadata.reason;
    delete metadata.resultEventId;
    if (effectId) opts.sm.saveSessionFile(session, { durable: true });
    if (metadata.mode === "direct_leaf") opts.watchDirectLeaf(session);
    var started = opts.continueExecution(session, text, recoveryStart ? "recovery" : null);
    if (!effectId) opts.sm.saveSessionFile(session);
    var result = opts.sessionResult(session, false);
    return recoveryStart ? recoveryResult(started, result) : result;
  };
}

module.exports = { createExecutionMessageApplier: createExecutionMessageApplier };
