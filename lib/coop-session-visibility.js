// Durable visibility reconciliation for proven Coop task dispositions.
// This module hides only a task-coordinator session whose exact canonical
// parent task is dismissed. It never changes task or execution history and it
// never applies to owner-direct, active, blocked, or needs-input sessions.

var coopControlProvenance = require("./coop-control-provenance");

function hideDismissedSession(project, session, task) {
  if (!project || !session || !task || task.status !== "dismissed") return false;
  if (!coopControlProvenance.isCoopControlled(session) ||
      session.coordinationRole !== "task_coordinator" || session.hidden) return false;
  var manager = typeof project.getSessionManager === "function"
    ? project.getSessionManager() : project.sm;
  if (!manager || typeof manager.hideSession !== "function") return false;
  manager.hideSession(session.localId, null, { projectionOnly: true });
  return true;
}

module.exports = {
  hideDismissedSession: hideDismissedSession,
};
