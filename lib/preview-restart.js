// A comparison instance may load history with work restoration deliberately
// disabled. It has no provider incarnation to checkpoint. This exception is
// unavailable after recovery starts/fails, or while any runtime work exists.
function canRestart(options) {
  if (options.restoreWorkOnStartup !== false ||
      !(options.ingress === "bootstrapping" || options.ingress === "draining" && options.alreadyChecked) ||
      !options.recovery || typeof options.recovery.state !== "function" || options.recovery.state() !== "closed") return false;
  var idle = true, managers = 0;
  options.forEachManager(function (manager) {
    managers++;
    if (!manager.sessions || typeof manager.sessions.forEach !== "function") { idle = false; return; }
    manager.sessions.forEach(function (session) {
      if (session.isProcessing || session._queryStarting || session._coopExecutionFence ||
          session._activeProviderToolCount > 0 || Object.keys(session.pendingPermissions || {}).length ||
          Object.keys(session.pendingElicitations || {}).length || Object.keys(session.pendingUserDialogs || {}).length) idle = false;
    });
  });
  return idle && managers > 0;
}
module.exports = { canRestart: canRestart };
