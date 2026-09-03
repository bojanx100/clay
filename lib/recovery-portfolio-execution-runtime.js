// Project-runtime bridge for infrastructure portfolio recovery.

var recovery = require("./recovery-portfolio-execution");

function attachInfrastructureRecovery(ctx) {
  var options = ctx || {};
  var sm = options.sm;

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

  function capture(session, payload, request) {
    var captured = recovery.capture(session, payload, request);
    if (captured) save(session);
    return captured;
  }

  function recover(session) {
    return recovery.recover(session, dependencies());
  }

  function recoverAll(sessions) {
    if (!sessions || typeof sessions.forEach !== "function") return;
    sessions.forEach(recover);
  }

  return { capture: capture, recover: recover, recoverAll: recoverAll };
}

module.exports = { attachInfrastructureRecovery: attachInfrastructureRecovery };
