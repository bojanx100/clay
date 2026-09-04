// Project-runtime bridge for infrastructure portfolio recovery.

var recovery = require("./recovery-portfolio-execution");
var bindings = require("./portfolio-execution-bindings");

function attachInfrastructureRecovery(ctx) {
  var options = ctx || {};
  var sm = options.sm;
  var setExecutionStatus = options.setExecutionStatus;
  var scheduleTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  var scheduleMicrotask = typeof options.queueMicrotask === "function" ?
    options.queueMicrotask : queueMicrotask;
  var retryBaseMs = Number.isFinite(options.retryBaseMs) && options.retryBaseMs >= 0 ?
    options.retryBaseMs : 1000;
  var retryMaxMs = Number.isFinite(options.retryMaxMs) && options.retryMaxMs >= retryBaseMs ?
    options.retryMaxMs : 60000;
  var scheduled = Object.create(null);

  function save(session) {
    if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session, { durable: true });
  }

  function dependencies() {
    var crossProject = options.crossProject;
    return {
      reconcileStrandedCompletions: crossProject && crossProject.reconcileStrandedCompletions,
      getBinding: crossProject && (crossProject.getExecutionBinding || crossProject.getBinding),
      createProjectExecution: crossProject &&
        (crossProject.createProjectExecution || crossProject.createExecution),
      saveSession: save,
      // Optional by design: a runtime that cannot observe the live board must
      // not silently gain a gate that always fails closed and stalls recovery.
      revalidateRestaff: typeof options.revalidateRestaff === "function" ?
        options.revalidateRestaff : null,
      onDisqualified: typeof options.onDisqualified === "function" ?
        options.onDisqualified : null,
    };
  }

  function capture(session, payload, request, opts) {
    var captureOptions = opts || {};
    var captured = recovery.capture(session, payload, request);
    if (captured && captureOptions.save !== false) save(session);
    return captured;
  }

  function recover(session) {
    return recovery.recover(session, dependencies());
  }

  function recoveryKey(session) {
    var metadata = bindings.sessionExecutionBinding(session);
    return metadata ? metadata.portfolioTaskId + ":" + metadata.bindingRevision : "";
  }

  function recoveryDelay(session) {
    var metadata = bindings.sessionExecutionBinding(session);
    var attempt = Number(metadata && metadata.infrastructureRecovery &&
      metadata.infrastructureRecovery.attempt || 0);
    if (!Number.isSafeInteger(attempt) || attempt <= 0) return 0;
    return Math.min(retryMaxMs, retryBaseMs * Math.pow(2, Math.min(attempt - 1, 16)));
  }

  function discard(session) {
    if (typeof options.discardSession === "function") options.discardSession(session);
  }

  function retryableResult(result) {
    return !!result && result.ok !== true &&
      result.reason !== "infrastructure_recovery_not_eligible" &&
      result.reason !== "failed_binding_not_persisted";
  }

  function recoverAfterFailure(session) {
    var key = recoveryKey(session);
    if (!key || !recovery.eligible(session)) {
      return { ok: false, reason: "infrastructure_recovery_not_eligible" };
    }
    if (scheduled[key]) return { ok: true, pending: true, duplicate: true };
    var delayMs = recoveryDelay(session);
    var pending = {};
    scheduled[key] = pending;
    function run() {
      delete scheduled[key];
      var result = recover(session);
      if (result && result.ok === true) {
        discard(session);
      } else if (retryableResult(result) && recovery.eligible(session)) {
        recoverAfterFailure(session);
      } else {
        discard(session);
      }
    }
    if (delayMs === 0) {
      pending.timer = true;
      scheduleMicrotask(run);
    } else {
      pending.timer = scheduleTimer(run, delayMs);
      if (pending.timer && typeof pending.timer.unref === "function") pending.timer.unref();
    }
    return { ok: true, pending: true, retryAt: Date.now() + delayMs };
  }

  function recoverAll(sessions) {
    if (!sessions || typeof sessions.forEach !== "function") return;
    sessions.forEach(recoverAfterFailure);
  }

  function recoverReaped(session, binding) {
    var metadata = bindings.sessionExecutionBinding(session);
    if (!metadata || !binding || binding.status !== "failed" ||
        metadata.portfolioTaskId !== binding.portfolioTaskId ||
        metadata.bindingRevision !== binding.bindingRevision ||
        !recovery.infrastructureFailure(binding)) {
      return { ok: false, reason: "reaped_execution_recovery_not_eligible" };
    }
    if (typeof setExecutionStatus === "function") setExecutionStatus(session, "failed", binding.statusReason || binding.failureCode, {
      code: binding.failureCode,
      details: binding.reapEvidence ? { reapEvidence: binding.reapEvidence } : null,
    });
    return recover(session);
  }

  return { capture: capture, recover: recover, recoverAfterFailure: recoverAfterFailure,
    recoverAll: recoverAll,
    recoverReaped: recoverReaped };
}

module.exports = { attachInfrastructureRecovery: attachInfrastructureRecovery };
