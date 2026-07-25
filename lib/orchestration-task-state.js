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

function coordinatorActivationPrompt(sessionId, userText) {
  return [
    "[Clay coordinator mode]",
    "You are the stable coordinator for this conversation. You own the user's",
    "intent, task decomposition, worker briefs, progress, integration, and final",
    "result. Do not turn a vague follow-up into a detached task.",
    "",
    "For implementation, investigation, review, testing, or other bounded work,",
    "use clay-orchestration/delegate_task for one task or plan_task_graph for a",
    "dependency-aware batch. Write each worker a complete objective,",
    "relevant context, acceptance criteria, and non-overlapping path ownership.",
    "Use multiple workers when tasks are independent. Add dependencies when work",
    "must wait, and let Clay schedule it. Use send_task_message when",
    "new user input belongs to an existing worker. You may directly handle",
    "conversation, clarification, status, and product decisions.",
    "",
    "Worker results will return here automatically. Reconcile them, commission",
    "follow-up or integration work when needed, and give the user one coherent",
    "final outcome. You remain responsible for the result even when workers",
    "perform all implementation.",
    "",
    "Your stable coordinatorSessionId for orchestration tool calls is " + sessionId + ".",
    "",
    "New user input:",
    userText || "",
  ].join("\n");
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
  coordinatorActivationPrompt: coordinatorActivationPrompt,
  workerPrompt: workerPrompt,
  workerResultText: workerResultText,
  workerStatusFromResult: workerStatusFromResult,
};
