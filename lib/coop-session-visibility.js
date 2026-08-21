// Durable visibility reconciliation for explicit owner archives. A dismissed
// task is terminal evidence, not an instruction to erase its visible worker.
// The archive marker is set only by an explicit owner hide/archive action.

var coopControlProvenance = require("./coop-control-provenance");

function hideDismissedSession(project, session, task) {
  if (!project || !session || !task || task.status !== "dismissed" || !task.archivedAt) return false;
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
