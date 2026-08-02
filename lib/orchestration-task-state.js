function orchestrationTasksForClient(session) {
  var tasks = session && session.orchestrationTasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map(function (task) {
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      workerSessionId: task.workerSessionId,
      workerColor: task.workerColor || null,
      parentTaskId: task.parentTaskId || null,
      dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
      provider: task.provider || null,
      model: task.model || null,
      providerRouteId: task.providerRouteId || null,
      routingTier: task.routingTier || null,
      routingRationale: task.routingRationale || "",
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
    "If the ownership boundary begins with \"read-only:\", do not modify files or external state.",
    "Use clay-orchestration/report_task_progress for meaningful milestones.",
    "Complete the task, verify the acceptance criteria, and end with this structured report:",
    "WORKER_STATUS: completed | needs_input | blocked | failed",
    "SUMMARY: concise outcome",
    "CHANGES: files and behavior changed, or none",
    "COMMITS: hashes and messages, or none",
    "VERIFICATION: commands/evidence",
    "ESCALATION_REQUIRED: yes | no",
    "",
    "Use completed only when the requested result is finished and the",
    "VERIFICATION field contains concrete evidence that it is ready for the",
    "coordinator or user to test. A turn ending, a plan, partial progress, or",
    "a request for input is not completion. Use needs_input, blocked, or failed",
    "instead. An unstructured or unverifiable report will be treated as",
    "needs_input.",
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
    "user's intent. Delegate follow-up or integration work if needed. If you",
    "independently finish and verify this task, call clay-orchestration/resolve_task",
    "with your concrete summary and verification evidence before reporting it",
    "complete. Report a unified outcome only when the relevant task graph is complete.",
  ].join("\n");
}

function workerResultText(worker) {
  var history = worker && worker.history;
  if (!Array.isArray(history)) return "";
  var segments = [];
  var current = "";
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i] || {};
    if (item.type === "user_message") break;
    if (item.type === "delta" && item.text) {
      current = item.text + current;
    } else if (current) {
      segments.unshift(current);
      current = "";
    }
  }
  if (current) segments.unshift(current);
  return segments.join("\n").trim();
}

function workerStatusFromResult(text) {
  var result = String(text || "");
  var match = result.match(/(?:^|\n)WORKER_STATUS:\s*(completed|blocked|needs_input|failed)/i);
  if (!match) return "needs_input";
  var status = match[1].toLowerCase();
  if (status === "blocked") return "needs_input";
  if (status !== "completed") return status;

  var summary = structuredReportField(result, "SUMMARY");
  var verification = structuredReportField(result, "VERIFICATION");
  var escalation = structuredReportField(result, "ESCALATION_REQUIRED");
  if (!isVerifiedCompletion(summary, verification, escalation)) return "needs_input";
  return "completed";
}

function workerTaskStatusFromResult(text) {
  var result = String(text || "");
  var status = workerStatusFromResult(result);
  if (status !== "needs_input") return status;
  var match = result.match(/(?:^|\n)WORKER_STATUS:\s*completed/i);
  if (!match) return status;
  var summary = structuredReportField(result, "SUMMARY");
  var verification = structuredReportField(result, "VERIFICATION");
  var escalation = structuredReportField(result, "ESCALATION_REQUIRED");
  if (summary && hasCompletionEvidence(verification) && /^yes\b/i.test(escalation)) {
    return "reviewing";
  }
  return status;
}

function isVerifiedCompletion(summary, verification, escalation) {
  if (!String(summary || "").trim()) return false;
  if (!hasCompletionEvidence(verification)) return false;
  return /^no\b/i.test(String(escalation || "").trim());
}

function structuredReportField(text, name) {
  var match = String(text || "").match(new RegExp("(?:^|\\n)" + name + ":\\s*([^\\n]+)", "i"));
  return match ? match[1].trim() : "";
}

function hasCompletionEvidence(verification) {
  var value = String(verification || "").trim();
  if (!value) return false;
  return !/^(?:none|n\/a|not applicable|not run|not tested|not verified|pending|skipped|unavailable)[.!]?$/i.test(value);
}

function restoreVerifiedWorkerCompletion(parentSession, task, worker, updateTask) {
  if (!task || task.status !== "needs_input" || typeof updateTask !== "function") return false;
  var history = worker && worker.history;
  if (!Array.isArray(history)) return false;
  var finished = false;
  for (var i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].type === "done") {
      finished = true;
      break;
    }
    if (history[i] && history[i].type === "user_message") break;
  }
  if (!finished) return false;
  var result = workerResultText(worker);
  if (workerStatusFromResult(result) !== "completed") return false;
  updateTask(parentSession, task.taskId, {
    status: "completed",
    resultSummary: result,
    currentActivity: "Completed; awaiting coordinator integration",
    verification: structuredReportField(result, "VERIFICATION"),
  });
  return true;
}

module.exports = {
  orchestrationTasksForClient: orchestrationTasksForClient,
  restoreVerifiedWorkerCompletion: restoreVerifiedWorkerCompletion,
  workerPrompt: workerPrompt,
  workerResultUpdateText: workerResultUpdateText,
  workerResultText: workerResultText,
  workerStatusFromResult: workerStatusFromResult,
  workerTaskStatusFromResult: workerTaskStatusFromResult,
  isVerifiedCompletion: isVerifiedCompletion,
};
