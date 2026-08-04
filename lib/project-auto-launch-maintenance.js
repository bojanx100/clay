// project-auto-launch-maintenance.js - Prevent background PR responders from
// racing a workspace-wide maintenance command that already owns PR updates.

function commandName(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  var firstLine = text.split(/\r?\n/, 1)[0].trim();
  return (firstLine.split(/\s+/, 1)[0] || "").toLowerCase();
}

function latestUserCommand(session) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (!item || item.type !== "user_message") continue;
    return commandName(item.text);
  }
  return "";
}

function isActiveCleanupSession(session) {
  if (!session || (!session.isProcessing && !session.queryInstance)) return false;
  return commandName(session.title) === "/cleanup" || latestUserCommand(session) === "/cleanup";
}

function activeMaintenanceCommand(sm) {
  var command = "";
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return command;
  sm.sessions.forEach(function (session) {
    if (!command && isActiveCleanupSession(session)) command = "/cleanup";
  });
  return command;
}

function blockingMaintenanceCommand(sm, autoKind) {
  if (autoKind !== "pr-review") return "";
  return activeMaintenanceCommand(sm);
}

function deferralFor(sm, autoKind) {
  var command = blockingMaintenanceCommand(sm, autoKind);
  if (!command) return null;
  return {
    ok: true,
    started: [],
    skipped: [],
    deferred: 0,
    vendorDeferred: 0,
    maintenanceDeferred: true,
    maintenanceCommand: command,
  };
}

module.exports = {
  activeMaintenanceCommand: activeMaintenanceCommand,
  blockingMaintenanceCommand: blockingMaintenanceCommand,
  deferralFor: deferralFor,
  isActiveCleanupSession: isActiveCleanupSession,
};
