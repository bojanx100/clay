function orchestrationTasksForClient(session) {
  var tasks = session && session.orchestrationTasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map(function (task) {
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      workerSessionId: task.workerSessionId,
      parentTaskId: task.parentTaskId || null,
      dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
      provider: task.provider || null,
      model: task.model || null,
      objective: task.objective || "",
      acceptanceCriteria: task.acceptanceCriteria || "",
      ownedPaths: task.ownedPaths || "",
      resultSummary: task.resultSummary || "",
      currentActivity: task.currentActivity || "",
      verification: task.verification || "",
      progress: typeof task.progress === "number" ? task.progress : null,
      attempt: task.attempt || 0,
      maxAttempts: task.maxAttempts || 1,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  });
}

function workerPrompt(parentSession, brief, taskId) {
  return [
    "You are a bounded worker owned by a Clay coordinator.",
    "Do not broaden product scope or delegate further. Work only inside the",
    "declared ownership boundary. If the task conflicts with in-flight work,",
    "stop and report the conflict instead of overwriting it.",
    "",
    "Coordinator session: " + parentSession.localId,
    "Worker session: {{WORKER_SESSION_ID}}",
    "Task ID: " + taskId,
    "Title: " + brief.title,
    "",
    "Objective:",
    brief.objective,
    "",
    "Relevant context:",
    brief.context,
    "",
    "Acceptance criteria:",
    brief.acceptanceCriteria,
    "",
    "Owned paths/subsystem:",
    brief.ownedPaths,
    "",
    "Use clay-orchestration/report_task_progress for meaningful milestones.",
    "Complete the task, verify it, and end with this structured report:",
    "WORKER_STATUS: completed | needs_input | blocked | failed",
    "SUMMARY: concise outcome",
    "CHANGES: files and behavior changed, or none",
    "COMMITS: hashes and messages, or none",
    "VERIFICATION: commands/evidence",
    "ESCALATION_REQUIRED: yes | no",
  ].join("\n");
}

function workerResultUpdateText(task, worker, resultText, status) {
  return [
    "[Clay worker update]",
    "Task ID: " + task.taskId,
    "Title: " + task.title,
    "Status: " + status,
    "Worker session: " + worker.localId,
    "Provider: " + (worker.vendor || "unknown"),
    "",
    "Worker result:",
    resultText || "(The worker returned no written result.)",
    "",
    "You own this result. Reconcile it with the other active tasks and the",
    "user's intent. Delegate follow-up or integration work if needed. Report",
    "a unified outcome only when the relevant task graph is complete.",
  ].join("\n");
}

function workerResultText(worker) {
  var history = worker && worker.history;
  if (!Array.isArray(history)) return "";
  var parts = [];
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i] || {};
    if (item.type === "user_message") break;
    if (item.type === "delta" && item.text) parts.unshift(item.text);
  }
  return parts.join("").trim();
}

function workerStatusFromResult(text) {
  var match = String(text || "").match(/WORKER_STATUS:\s*(completed|blocked|needs_input|failed)/i);
  if (!match) return "completed";
  var status = match[1].toLowerCase();
  return status === "blocked" ? "needs_input" : status;
}

module.exports = {
  orchestrationTasksForClient: orchestrationTasksForClient,
  workerPrompt: workerPrompt,
  workerResultUpdateText: workerResultUpdateText,
  workerResultText: workerResultText,
  workerStatusFromResult: workerStatusFromResult,
};
