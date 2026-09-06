var taskGraph = require("./orchestration-task-graph");
var approvalStaging = require("./coop-approval-question-staging");
var projectIdentity = require("./project-identity");
var historyStore = require("./sessions-history-store");

var CLIENT_EXECUTION_STATUSES = {
  active: true, queued: true, ready: true, running: true, reviewing: true,
  blocked: true, failed: true, needs_input: true, waiting_user: true,
  completed: true, dismissed: true, cancelled: true, superseded: true,
};

function valueOr(value, fallback) {
  return value || fallback;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function approvalSetForClient(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var scopes = approvalStaging.normalizeScopes(value.scopes);
  var setId = typeof value.setId === "string" ? value.setId : "";
  var stagedAt = Number(value.stagedAt);
  if (!scopes || setId !== approvalStaging.setIdFor(scopes) ||
      !Number.isFinite(stagedAt) || stagedAt <= 0) return null;
  return {
    setId: setId,
    stagedAt: stagedAt,
    scopes: scopes,
  };
}

function orchestrationTasksForClient(session) {
  var tasks = session && session.orchestrationTasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map(function (task) {
    var representedWorkerRef = task.workerSessionRef !== undefined && task.workerSessionRef !== null;
    var workerSessionRef = projectIdentity.normalizeSessionRef(task.workerSessionRef);
    var workerSessionId = Number.isInteger(task.workerSessionId) && task.workerSessionId > 0
      ? task.workerSessionId : null;
    if (representedWorkerRef && !workerSessionRef) workerSessionId = null;
    return {
      taskId: task.taskId,
      clientRef: valueOr(task.clientRef, null),
      approvalSet: approvalSetForClient(task.approvalSet),
      title: task.title,
      status: task.status,
      workerSessionId: workerSessionId,
      workerSessionRef: workerSessionRef,
      workerColor: valueOr(task.workerColor, null),
      parentTaskId: valueOr(task.parentTaskId, null),
      dependencies: arrayOrEmpty(task.dependencies),
      provider: valueOr(task.provider, null),
      model: valueOr(task.model, null),
      providerRouteId: valueOr(task.providerRouteId, null),
      routingTier: valueOr(task.routingTier, null),
      routingProfile: valueOr(task.routingProfile, null),
      routingRationale: valueOr(task.routingRationale, ""),
      objective: valueOr(task.objective, ""),
      acceptanceCriteria: valueOr(task.acceptanceCriteria, ""),
      ownedPaths: valueOr(task.ownedPaths, ""),
      resultSummary: valueOr(task.resultSummary, ""),
      currentActivity: valueOr(task.currentActivity, ""),
      verification: valueOr(task.verification, ""),
      resolutionReason: valueOr(task.resolutionReason, ""),
      resolutionSummary: valueOr(task.resolutionSummary, ""),
      resolvedAt: valueOr(task.resolvedAt, null),
      userQuestion: valueOr(task.userQuestion, ""),
      waitingReason: valueOr(task.waitingReason, ""),
      userAnsweredAt: valueOr(task.userAnsweredAt, null),
      progress: typeof task.progress === "number" ? task.progress : null,
      attempt: valueOr(task.attempt, 0),
      maxAttempts: valueOr(task.maxAttempts, 1),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  });
}

function orchestrationStateForClient(session) {
  var state = taskGraph.graphResolutionState(session);
  var completion = taskGraph.projectCompletionState(session);
  return {
    coordinatorUpdates: require("./project-coordinator-update-state").coordinatorUpdateState(session),
    phase: state.phase,
    metrics: state.metrics,
    projectCompletion: {
      status: completion.status,
      completionRevision: completion.completionRevision,
      graphDigest: completion.graphDigest,
      summary: completion.summary,
      verification: completion.verification,
      integrationVerification: completion.integrationVerification,
      escalationRequired: completion.escalationRequired || "",
      portfolioTaskId: completion.portfolioTaskId || "",
      bindingRevision: completion.bindingRevision || null,
      completedAt: completion.completedAt,
      revokedAt: completion.revokedAt,
      revocationReason: completion.revocationReason,
    },
  };
}

function coopExecutionStatusForClient(session) {
  var policy = session && session.orchestrationPolicy;
  var execution = policy && policy.portfolioExecution;
  var status = execution && String(execution.status || "");
  return status && CLIENT_EXECUTION_STATUSES[status] ? status : null;
}

// Decided by the first GROUPING_SCAN_LIMIT records, so this is derived from the
// immutable head of a transcript — but reading it went through `session.history`,
// which pages the WHOLE .jsonl back in and re-parses every line. That is on the
// debounced session-list broadcast path (broadcastSessionListNow ->
// buildOrchestrationSessionGroups), so every session change re-read and re-parsed
// every released worker transcript just to look at 25 records. On an otherwise
// idle daemon that was the single largest source of allocation, and the
// synchronous readFileSync + JSON.parse of a large transcript stalls the event
// loop for seconds. Memoize per history generation instead.
var GROUPING_TASK_ID = Symbol("clayGroupingTaskId");
var GROUPING_SCAN_LIMIT = 25;

function scanGroupingTaskId(history) {
  var list = Array.isArray(history) ? history : [];
  var limit = Math.min(list.length, GROUPING_SCAN_LIMIT);
  for (var i = 0; i < limit; i++) {
    var item = list[i];
    if (item && item.type === "user_message" && item.orchestrationTaskId &&
        item.origin && item.origin.kind === "coordinator") {
      return String(item.orchestrationTaskId);
    }
  }
  return "";
}

function groupingTaskId(session) {
  if (!session) return "";
  if (session.orchestrationParent && session.orchestrationParent.taskId) {
    return String(session.orchestrationParent.taskId);
  }
  if (session.orchestrationAdoption && session.orchestrationAdoption.taskId) {
    return String(session.orchestrationAdoption.taskId);
  }
  var gen = historyStore.generation(session);
  var memo = session[GROUPING_TASK_ID];
  if (memo && memo.gen === gen) return memo.taskId;
  var taskId = historyStore.readTransient(session, scanGroupingTaskId);
  // Only settle once the scan window is full. Below that a later append can
  // still introduce the coordinator message, and those transcripts are short
  // enough that recomputing them is cheap. historyLength() answers this from
  // the persisted record count without paging the transcript back in.
  if (taskId || historyStore.historyLength(session) >= GROUPING_SCAN_LIMIT) {
    session[GROUPING_TASK_ID] = { gen: gen, taskId: taskId };
  }
  return taskId;
}

function ownerForTask(session, task) {
  if (!task || !task.taskId) return null;
  return {
    taskId: String(task.taskId),
    sessionId: session.localId,
    workerColor: valueOr(task.workerColor, null),
    taskStatus: valueOr(task.status, null),
  };
}

function ownerForWorker(session, owners) {
  var taskId = groupingTaskId(session);
  var owner = taskId && owners[taskId];
  if (!owner || owner.sessionId === session.localId) return null;
  return { taskId: taskId, owner: owner };
}

function buildOrchestrationSessionGroups(sessions) {
  var list = Array.isArray(sessions) ? sessions : [];
  var owners = {};
  var workers = {};
  var bySessionId = {};
  for (var i = 0; i < list.length; i++) {
    var tasks = list[i] && list[i].orchestrationTasks;
    if (!Array.isArray(tasks)) continue;
    for (var ti = 0; ti < tasks.length; ti++) {
      var owner = ownerForTask(list[i], tasks[ti]);
      if (owner) owners[owner.taskId] = owner;
    }
  }
  for (var si = 0; si < list.length; si++) {
    var session = list[si];
    var workerOwner = ownerForWorker(session, owners);
    if (!workerOwner) continue;
    if (!workers[workerOwner.taskId]) workers[workerOwner.taskId] = [];
    workers[workerOwner.taskId].push(session);
  }
  var taskIds = Object.keys(workers);
  for (var wi = 0; wi < taskIds.length; wi++) {
    var workerTaskId = taskIds[wi];
    var attempts = workers[workerTaskId];
    attempts.sort(function (a, b) {
      var createdDiff = (a.createdAt || 0) - (b.createdAt || 0);
      return createdDiff || (a.localId || 0) - (b.localId || 0);
    });
    for (var ai = 0; ai < attempts.length; ai++) {
      var workerSession = attempts[ai];
      bySessionId[workerSession.localId] = Object.assign({}, owners[workerTaskId], {
        attempt: ai + 1,
        attemptCount: attempts.length,
        historical: !workerSession.orchestrationParent,
      });
    }
  }
  return bySessionId;
}

function orchestrationParentForClient(session) {
  if (!session || !session.orchestrationParent) return null;
  return {
    taskId: session.orchestrationParent.taskId,
    sessionId: session.orchestrationParent.sessionId,
    workerColor: session.orchestrationParent.workerColor || null,
  };
}

function orchestrationGroupParentForClient(session, groups) {
  return session && groups && groups[session.localId] || null;
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

function portfolioExecutionPrompt(brief, binding, role, localInstructions) {
  var coordinated = role === "project_coordinator";
  var lines = [
    coordinated
      ? "You are the canonical project coordinator for a Coop-owned portfolio effort."
      : "You are a canonical direct-leaf worker for a Coop-owned portfolio task.",
    "This conversation lives in the target project and is the only execution",
    "copy for binding revision " + binding.bindingRevision + ".",
    coordinated
      ? "You alone own project-local decomposition, workers, retries, integration, and verification."
      : "Do not delegate, create sibling workers, or broaden the ownership boundary.",
    "Report scope expansion explicitly as WORKER_STATUS: needs_input and REASON: scope_expansion.",
    "Use clay-orchestration/report_task_progress for meaningful milestones when available.",
    "",
    "Portfolio task / Task ID: " + binding.portfolioTaskId,
    "Title: " + brief.title,
    "",
    "Objective:",
    brief.objective,
    "",
    "Relevant context:",
    brief.context || "(No additional context.)",
    "",
    "Acceptance criteria:",
    brief.acceptanceCriteria || "Verify the requested outcome.",
    "",
    "Owned paths/subsystem:",
    brief.ownedPaths || "Infer the smallest safe project-local boundary.",
    "",
    coordinated
      ? "Create local tasks only when needed, reconcile their evidence, and report one integrated outcome."
      : "Complete and verify this bounded task, then return the structured worker report.",
    "WORKER_STATUS: completed | needs_input | blocked | failed",
    "SUMMARY: concise outcome",
    "CHANGES: files and behavior changed, or none",
    "COMMITS: hashes and messages, or none",
    "VERIFICATION: commands/evidence",
    "ESCALATION_REQUIRED: yes | no",
    coordinated ? "" : null,
    coordinated ? "A completed worker task is evidence only; it does not complete this project or Coop's portfolio." : null,
    coordinated ? "After every local task is resolved and project integration has passed, only you may emit:" : null,
    coordinated ? "PROJECT_COMPLETED: yes" : null,
    coordinated ? "SUMMARY: integrated outcome" : null,
    coordinated ? "VERIFICATION: project acceptance evidence" : null,
    coordinated ? "INTEGRATION_VERIFIED: yes" : null,
    coordinated ? "ESCALATION_REQUIRED: no" : null,
  ].filter(function (line) { return line !== null; });
  var workflow = localInstructions && localInstructions.configured === true ?
    localInstructions : null;
  if (workflow && workflow.ownerAcceptanceRequired === true) {
    lines.push(
      "",
      "Project-local workflow authority was loaded before this execution was staffed.",
      "Implementation and verification are not owner acceptance. Until the owner explicitly says",
      "\"mark it done\", \"done\", \"ship it\", or an equivalent configured phrase, do not",
      "run a Done/Dev Complete/cleanup workflow or emit PROJECT_COMPLETED: yes.",
      "Report verified implementation as WORKER_STATUS: needs_input while awaiting that decision."
    );
    for (var i = 0; i < workflow.files.length; i++) {
      lines.push(
        "",
        "--- BEGIN " + workflow.files[i].path + " ---",
        workflow.files[i].body,
        "--- END " + workflow.files[i].path + " ---"
      );
    }
  }
  return lines.join("\n");
}

function scopeExpansionReason(text) {
  var result = String(text || "");
  if (/(?:^|\n)REASON:\s*scope_expansion\b/i.test(result)) return "scope_expansion";
  if (/(?:^|\n)SCOPE_EXPANSION:\s*yes\b/i.test(result)) return "scope_expansion";
  return "";
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
    "user's intent. Delegate follow-up or integration work if needed. You cannot",
    "report overall completion while any task still needs attention. If you",
    "independently finish and verify this task, call clay-orchestration/resolve_task",
    "with your concrete summary and verification evidence. Use dismiss_task with a",
    "durable reason for obsolete or duplicate work. Use request_task_input with one",
    "precise question only when human judgment is genuinely unavoidable. Report a",
    "unified outcome only when the relevant task graph is complete.",
  ].join("\n");
}

function workerResultText(worker) {
  return historyStore.readTransient(worker, function (history) {
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
  });
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

function workerReasonFromResult(text) {
  var reason = structuredReportField(String(text || ""), "REASON");
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(reason)) return "";
  return reason.toLowerCase();
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

function projectCompletionFromResult(text) {
  var result = String(text || "");
  return {
    requested: /(?:^|\n)PROJECT_COMPLETED:\s*yes\b/i.test(result),
    summary: structuredReportField(result, "SUMMARY"),
    verification: structuredReportField(result, "VERIFICATION"),
    integrationVerification: structuredReportField(result, "INTEGRATION_VERIFIED"),
    integrationVerified: /(?:^|\n)INTEGRATION_VERIFIED:\s*yes\b/i.test(result),
    escalationRequired: structuredReportField(result, "ESCALATION_REQUIRED"),
    escalationVerified: /(?:^|\n)ESCALATION_REQUIRED:\s*no\b/i.test(result),
  };
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
  if (task && worker && (worker.pendingCoordinatorMessages || []).length && typeof updateTask === "function") {
    if (task.status === "completed") updateTask(parentSession, task.taskId, {
      status: "reviewing", currentActivity: "Worker turn finished; queued follow-up remains",
      resolutionReason: "", resolutionSummary: "", resolvedAt: null,
    });
    return false;
  }
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
    resolutionReason: "Verified worker completion",
    resolutionSummary: structuredReportField(result, "SUMMARY"),
    resolvedAt: Date.now(),
  });
  return true;
}

module.exports = {
  buildOrchestrationSessionGroups: buildOrchestrationSessionGroups,
  coopExecutionStatusForClient: coopExecutionStatusForClient,
  groupingTaskId: groupingTaskId,
  orchestrationGroupParentForClient: orchestrationGroupParentForClient,
  orchestrationStateForClient: orchestrationStateForClient,
  orchestrationTasksForClient: orchestrationTasksForClient,
  orchestrationParentForClient: orchestrationParentForClient,
  projectCompletionFromResult: projectCompletionFromResult,
  restoreVerifiedWorkerCompletion: restoreVerifiedWorkerCompletion,
  portfolioExecutionPrompt: portfolioExecutionPrompt,
  scopeExpansionReason: scopeExpansionReason,
  workerPrompt: workerPrompt,
  workerReasonFromResult: workerReasonFromResult,
  workerResultUpdateText: workerResultUpdateText,
  workerResultText: workerResultText,
  workerStatusFromResult: workerStatusFromResult,
  workerTaskStatusFromResult: workerTaskStatusFromResult,
  isVerifiedCompletion: isVerifiedCompletion,
};
