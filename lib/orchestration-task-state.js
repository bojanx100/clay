function orchestrationTasksForClient(session) {
  var tasks = session && session.orchestrationTasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map(function (task) {
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      workerSessionId: task.workerSessionId,
      provider: task.provider || null,
      model: task.model || null,
      objective: task.objective || "",
      acceptanceCriteria: task.acceptanceCriteria || "",
      ownedPaths: task.ownedPaths || "",
      resultSummary: task.resultSummary || "",
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
    "use clay-orchestration/delegate_task. Write each worker a complete objective,",
    "relevant context, acceptance criteria, and non-overlapping path ownership.",
    "Use multiple workers when tasks are independent. Use send_task_message when",
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
  workerResultText: workerResultText,
  workerStatusFromResult: workerStatusFromResult,
};
