var buildHandoffContextFromHistory = require("./handoff-context").buildHandoffContextFromHistory;
var taskGraph = require("./orchestration-task-graph");

function taskTitle(text) {
  var compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "Coordinated task";
  if (compact.length <= 72) return compact;
  return compact.substring(0, 69).trim() + "...";
}

function createQueuedCoordinator(ctx) {
  return function coordinateQueuedMessage(parentSession, queueItem) {
    if (!parentSession || !queueItem || !String(queueItem.text || "").trim()) return null;
    parentSession.coordinationMode = true;
    var context = buildHandoffContextFromHistory(parentSession.history, {
      cwd: ctx.cwd || process.cwd(),
      fromVendor: parentSession.vendor || "current provider",
      toVendor: parentSession.vendor || "worker",
      sourceLabel: "the owning coordinator conversation",
      maxChars: 120000,
    });
    var task = taskGraph.createTask(parentSession, {
      title: taskTitle(queueItem.displayText || queueItem.text),
      objective: String(queueItem.text).trim(),
      context: context || "No earlier transcript was available. Follow the objective exactly.",
      acceptanceCriteria: [
        "Complete the requested work without interrupting the owning coordinator.",
        "Verify the result in proportion to its risk.",
        "Return the required structured worker report with concrete changes, commits, and evidence.",
      ].join(" "),
      ownedPaths: [
        "Infer the smallest necessary subsystem from the request and transcript.",
        "Inspect current git status before editing. Do not overwrite unrelated or concurrent changes;",
        "report a conflict when safe ownership cannot be established.",
      ].join(" "),
    });
    task.images = queueItem.images || null;
    ctx.schedule(parentSession);
    ctx.sm.saveSessionFile(parentSession);
    return task;
  };
}

module.exports = { createQueuedCoordinator: createQueuedCoordinator };
