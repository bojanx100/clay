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
  // cascadeWorkers: this coordinator's task is dismissed AND archived, so its
  // workers are finished by construction and must go with it. Without the
  // cascade they never got `hidden`, and since both session_list producers
  // filter on that flag -- sessions.getVisibleSessions and
  // project-connection-state.visibleSessions -- they leaked into the sidebar and
  // the mobile Projects picker under a coordinator the owner had already
  // dismissed.
  //
  // Opt-in rather than the default for projectionOnly, because
  // coop-self-cleanup-runtime judges each session on its own merits and must NOT
  // cascade into workers it never evaluated.
  manager.hideSession(session.localId, null,
    { projectionOnly: true, cascadeWorkers: true });
  return true;
}

module.exports = {
  hideDismissedSession: hideDismissedSession,
};
