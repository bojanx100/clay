// Project-runtime bridge for infrastructure portfolio recovery.

var recovery = require("./recovery-portfolio-execution");
var bindings = require("./portfolio-execution-bindings");

function attachInfrastructureRecovery(ctx) {
  var options = ctx || {};
  var sm = options.sm;
  var setExecutionStatus = options.setExecutionStatus;

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

  function recoverAll(sessions) {
    if (!sessions || typeof sessions.forEach !== "function") return;
    sessions.forEach(recover);
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

  return { capture: capture, recover: recover, recoverAll: recoverAll,
    recoverReaped: recoverReaped };
}

module.exports = { attachInfrastructureRecovery: attachInfrastructureRecovery };
