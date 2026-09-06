var config = require("./config");

// Instance-local pause: two daemons may read the same repository recipes.
// Never disable those shared recipes merely to pause a comparison instance.
function isPaused() {
  var current = config.loadConfig();
  return !!(current && current.scheduledExecutionPaused === true);
}

function pausedResult() {
  return { ok: true, paused: true, reason: "instance_schedules_paused", started: [], skipped: [] };
}

function restoresWork() {
  var current = config.loadConfig();
  return !current || current.restoreWorkOnStartup !== false;
}

module.exports = { isPaused: isPaused, pausedResult: pausedResult, restoresWork: restoresWork };
