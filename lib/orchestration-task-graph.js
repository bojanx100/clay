var crypto = require("crypto");
var coopWorkActivity = require("./coop-work-activity");

var TERMINAL_STATUSES = {
  completed: true,
  dismissed: true,
  failed: true,
  cancelled: true,
  waiting_user: true,
};
var WORKER_COLORS = [
  "#55A7FF",
  "#A78BFA",
  "#36C6A7",
  "#F0B35A",
  "#FF7A72",
  "#E879F9",
];
var PROJECT_COMPLETION_STATUSES = { pending: true, completed: true };

function projectCompletionState(session) {
  var state = session && session.orchestrationProjectCompletion;
  if (state && PROJECT_COMPLETION_STATUSES[state.status] &&
      Number.isInteger(state.completionRevision) && state.completionRevision >= 0) {
    return state;
  }
  state = projectCompletionStateFromEvents(session);
  if (state) {
    session.orchestrationProjectCompletion = state;
    return state;
  }
  state = {
    status: "pending",
    completionRevision: 0,
    graphDigest: "",
    summary: "",
    verification: "",
    integrationVerification: "",
    escalationRequired: "",
    portfolioTaskId: "",
    bindingRevision: null,
    completedAt: null,
    revokedAt: null,
    revocationReason: "",
  };
  if (session) session.orchestrationProjectCompletion = state;
  return state;
}

function projectCompletionStateFromEvents(session) {
  var events = session && Array.isArray(session.orchestrationEvents) ?
    session.orchestrationEvents : [];
  for (var i = events.length - 1; i >= 0; i--) {
    var event = events[i] || {};
    if (event.type !== "project_completed" && event.type !== "project_completion_revoked") {
      continue;
    }
    var data = event.data || {};
    var revision = Number(data.completionRevision);
    if (!Number.isInteger(revision) || revision < 1) continue;
    if (event.type === "project_completed") {
      return {
        status: "completed",
        completionRevision: revision,
        graphDigest: completionText(data.graphDigest),
        summary: completionText(data.summary),
        verification: completionText(data.verification),
        integrationVerification: completionText(data.integrationVerification),
        escalationRequired: completionText(data.escalationRequired),
        portfolioTaskId: completionText(data.portfolioTaskId),
        bindingRevision: Number.isInteger(data.bindingRevision) ? data.bindingRevision : null,
        completedAt: event.at || null,
        revokedAt: null,
        revocationReason: "",
      };
    }
    return {
      status: "pending",
      completionRevision: revision,
      graphDigest: "",
      summary: "",
      verification: "",
      integrationVerification: "",
      escalationRequired: "",
      portfolioTaskId: completionText(data.portfolioTaskId),
      bindingRevision: Number.isInteger(data.bindingRevision) ? data.bindingRevision : null,
      completedAt: null,
      revokedAt: event.at || null,
      revocationReason: completionText(data.reason),
    };
  }
  return null;
}

function completionText(value) {
  return String(value || "").trim();
}

function completionReport(input) {
  var value = input || {};
  return {
    summary: completionText(value.summary),
    verification: completionText(value.verification),
    integrationVerification: completionText(value.integrationVerification),
    integrationVerified: value.integrationVerified === true,
    escalationRequired: completionText(value.escalationRequired),
    escalationVerified: /^no\b/i.test(completionText(value.escalationRequired)),
  };
}

function validProjectCompletion(report) {
  return !!(report.summary && report.verification && report.integrationVerification &&
    report.integrationVerified && report.escalationVerified);
}

function isProjectCoordinator(session) {
  return !!(session && session.coordinationMode &&
    (!session.orchestrationParent || session.coordinationRole === "task_coordinator"));
}

function workerColorForId(value) {
  var text = String(value || "");
  var hash = 0;
  for (var i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return WORKER_COLORS[Math.abs(hash) % WORKER_COLORS.length];
}

function ensureGraph(session) {
  if (!Array.isArray(session.orchestrationTasks)) session.orchestrationTasks = [];
  if (!Array.isArray(session.orchestrationEvents)) session.orchestrationEvents = [];
  if (!session.orchestrationGraphId) session.orchestrationGraphId = "graph-" + crypto.randomUUID();
  return session.orchestrationTasks;
}

function appendEvent(session, type, task, data) {
  ensureGraph(session);
  var event = {
    eventId: "event-" + crypto.randomUUID(),
    graphId: session.orchestrationGraphId,
    taskId: task && task.taskId || null,
    type: type,
    at: Date.now(),
    data: data || {},
  };
  session.orchestrationEvents.push(event);
  return event;
}

function findTask(session, taskId) {
  var tasks = ensureGraph(session);
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].taskId === taskId) return tasks[i];
  }
  return null;
}

function normalizeDependencies(value) {
  if (!Array.isArray(value)) return [];
  var result = [];
  for (var i = 0; i < value.length; i++) {
    var id = String(value[i] || "").trim();
    if (id && result.indexOf(id) === -1) result.push(id);
  }
  return result;
}

// Reference-only, like every other canonical ref: an id and nothing else, so a
// task record can never carry topic content. Defined in the leaf coop-topic-ref
// module so the durable binding store can share it without depending on this
// graph -- see that module's header for why the direction matters.
var normalizeTopicRefInput = require("./coop-topic-ref").normalizeTopicRefInput;

// The topic this task is attributed to when the caller did not explicitly name
// one. Only applies on the canonical Coop session itself (session.coopHome):
// that is the one durable record of "which topic the owner most recently
// addressed", and it is real evidence -- the owner's own last routed
// user_message -- not a guess. A worker or project-coordinator session has no
// such history to read, so it stays unlinked rather than inventing one.
function inferredCoopTopicRef(session) {
  if (!session || !session.coopHome) return null;
  var route = coopWorkActivity.latestCoopRoute(session);
  return normalizeTopicRefInput(route && route.topicRef);
}

function createTask(session, input) {
  ensureGraph(session);
  revokeProjectCompletion(session, "new_task");
  var now = Date.now();
  var taskId = input.taskId || "task-" + crypto.randomUUID();
  var explicitTopicRef = normalizeTopicRefInput(input.coopTopicRef);
  var task = {
    taskId: taskId,
    clientRef: input.clientRef || null,
    parentTaskId: input.parentTaskId || null,
    title: input.title,
    objective: input.objective,
    context: input.context || "",
    acceptanceCriteria: input.acceptanceCriteria || "",
    ownedPaths: input.ownedPaths || "",
    imageRefs: Array.isArray(input.imageRefs) ? input.imageRefs.slice(0, 4) : null,
    workerColor: input.workerColor || workerColorForId(taskId),
    dependencies: normalizeDependencies(input.dependencies),
    status: "queued",
    currentActivity: "Waiting for scheduler",
    provider: input.provider || null,
    model: input.model || null,
    providerRouteId: input.providerRouteId || null,
    providerPinned: !!input.providerPinned,
    modelPinned: !!input.modelPinned,
    difficulty: input.difficulty || null,
    // The canonical Coop topic this work was started from, captured once at
    // creation and never recomputed. Attribution has to be durable: background
    // work outlives the turn that began it, so resolving "which topic owns this"
    // later from the most recently addressed lens would credit Topic A's work to
    // Topic B, and the link would not survive a reconnect or restart at all.
    // An explicit ref from the caller always wins; absent that, the canonical
    // Coop session's own last-addressed topic is real evidence, not a guess.
    coopTopicRef: explicitTopicRef || inferredCoopTopicRef(session),
    coopProjectRef: input.coopProjectRef || null,
    // Owner acceptance is tracked separately from worker completion: a worker
    // returning "completed" is a terminal implementation state, not the owner
    // agreeing the work is done. See coop-topic-state.
    ownerAcceptance: null,
    attempt: 0,
    maxAttempts: Math.max(1, Number(input.maxAttempts) || 1),
    createdAt: now,
    updatedAt: now,
  };
  if (input.controlRole) task.controlRole = input.controlRole;
  if (input.reviewOnly === true) task.reviewOnly = true;
  session.orchestrationTasks.push(task);
  appendEvent(session, "task_created", task, {
    dependencies: task.dependencies,
    parentTaskId: task.parentTaskId,
  });
  return task;
}

function dependencyState(session, task) {
  var waiting = [];
  var failed = [];
  for (var i = 0; i < task.dependencies.length; i++) {
    var dependency = findTask(session, task.dependencies[i]);
    if (!dependency || dependency.status === "failed" || dependency.status === "cancelled" ||
        dependency.status === "dismissed") {
      failed.push(task.dependencies[i]);
    } else if (dependency.status !== "completed") {
      waiting.push(task.dependencies[i]);
    }
  }
  return { waiting: waiting, failed: failed };
}

function refreshReadiness(session) {
  var tasks = ensureGraph(session);
  var changed = [];
  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i];
    if (TERMINAL_STATUSES[task.status] || task.status === "running" ||
        task.status === "needs_input" || task.status === "reviewing") continue;
    var state = dependencyState(session, task);
    var next = state.failed.length ? "blocked" : (state.waiting.length ? "queued" : "ready");
    var activity = state.failed.length
      ? "Blocked by failed dependency"
      : (state.waiting.length ? "Waiting for " + state.waiting.length + " task(s)" : "Ready to start");
    if (task.status !== next || task.currentActivity !== activity) {
      task.status = next;
      task.currentActivity = activity;
      task.updatedAt = Date.now();
      appendEvent(session, "task_readiness_changed", task, {
        status: next,
        waiting: state.waiting,
        failed: state.failed,
      });
      changed.push(task);
    }
  }
  return changed;
}

function runningCount(session) {
  var tasks = ensureGraph(session);
  var count = 0;
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].status === "running") count++;
  }
  return count;
}

function readyTasks(session, maxParallel) {
  refreshReadiness(session);
  var slots = Math.max(0, (Number(maxParallel) || 3) - runningCount(session));
  var result = [];
  var tasks = ensureGraph(session);
  var occupied = {};
  for (var j = 0; j < tasks.length; j++) {
    if (tasks[j].status === "running") occupied[ownershipKey(tasks[j])] = true;
  }
  for (var i = 0; i < tasks.length && result.length < slots; i++) {
    // These rows describe work owned by another session or project. A queued
    // external assignment is not a local worker launch, including after restart.
    if (tasks[i].externalTaskCoordinator) continue;
    var key = ownershipKey(tasks[i]);
    if (tasks[i].status === "ready" && (!key || !occupied[key])) {
      result.push(tasks[i]);
      if (key) occupied[key] = true;
    }
  }
  return result;
}

function ownershipKey(task) {
  var value = String(task && task.ownedPaths || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!value || value.indexOf("read-only") !== -1) return "";
  return value;
}

function transition(session, task, status, data) {
  var previous = task.status;
  if (status !== "completed" && status !== "dismissed" && status !== "cancelled") {
    revokeProjectCompletion(session, "task_" + status);
  }
  task.status = status;
  task.updatedAt = Date.now();
  if (data) Object.assign(task, data);
  appendEvent(session, "task_status_changed", task, {
    from: previous,
    to: status,
    activity: task.currentActivity || "",
  });
  return task;
}

function retryTask(session, task) {
  revokeProjectCompletion(session, "task_retry_requested");
  task.workerSessionId = null;
  task.workerStorageId = null;
  task.resultSummary = "";
  task.verification = "";
  task.resolutionReason = "";
  task.resolutionSummary = "";
  task.resolvedAt = null;
  task.userQuestion = "";
  task.waitingReason = "";
  task.userAnsweredAt = null;
  transition(session, task, "queued", { currentActivity: "Queued for retry" });
  appendEvent(session, "task_retry_requested", task, { nextAttempt: task.attempt + 1 });
  return task;
}

function graphResolutionDigest(session) {
  var tasks = session && Array.isArray(session.orchestrationTasks)
    ? session.orchestrationTasks : [];
  var taskDigest = tasks.map(taskDigestLine).join("|");
  var events = session && Array.isArray(session.orchestrationEvents)
    ? session.orchestrationEvents : [];
  var lastEvent = events.length > 0 ? events[events.length - 1] || {} : {};
  return taskDigest + "#events:" + events.length + ":" +
    (lastEvent.eventId || "") + ":" + (lastEvent.type || "");
}

function taskDigestLine(task) {
  var value = task || {};
  return [
    value.taskId || "",
    value.status || "queued",
    value.updatedAt || 0,
    value.resolutionReason || "",
    value.resolutionSummary || "",
    value.resolvedAt || 0,
    value.userQuestion || "",
    value.userAnsweredAt || 0,
  ].join(":");
}

function countTaskStatus(metrics, task) {
  var status = task && task.status || "queued";
  if (status === "completed") {
    metrics.completed++;
    metrics.resolved++;
  } else if (status === "dismissed" || status === "cancelled") {
    metrics.dismissed++;
    metrics.resolved++;
  } else if (status === "waiting_user" && String(task.userQuestion || "").trim()) {
    metrics.waitingUser++;
    metrics.unresolved++;
  } else if (status === "queued" || status === "ready" || status === "running") {
    metrics.active++;
    metrics.unresolved++;
  } else {
    metrics.attention++;
    metrics.unresolved++;
  }
}

function graphPhase(metrics, reconciliation, digest) {
  if (metrics.attention > 0 && reconciliation.stalled && reconciliation.stalledDigest === digest) {
    return "stalled";
  }
  if (metrics.attention > 0) return "reconciling";
  if (metrics.active > 0) return "executing";
  if (metrics.waitingUser > 0) return "waiting_user";
  return "complete";
}

function graphResolutionState(session) {
  var tasks = session && Array.isArray(session.orchestrationTasks)
    ? session.orchestrationTasks : [];
  var metrics = {
    total: tasks.length,
    active: 0,
    attention: 0,
    waitingUser: 0,
    completed: 0,
    dismissed: 0,
    resolved: 0,
    unresolved: 0,
  };
  for (var i = 0; i < tasks.length; i++) {
    countTaskStatus(metrics, tasks[i] || {});
  }
  var digest = graphResolutionDigest(session);
  var reconciliation = session && session.orchestrationReconciliation || {};
  return {
    phase: graphPhase(metrics, reconciliation, digest),
    metrics: metrics,
    digest: digest,
  };
}

function completeProject(session, input) {
  var graph = graphResolutionState(session);
  var report = completionReport(input);
  var state = projectCompletionState(session);
  if (!isProjectCoordinator(session)) return { ok: false, reason: "project_owner_required", state: state };
  if (graph.phase !== "complete") return { ok: false, reason: "graph_unresolved", state: state };
  if (!report.escalationVerified) {
    return { ok: false, reason: "escalation_required", state: state };
  }
  if (!validProjectCompletion(report)) {
    return { ok: false, reason: "integration_unverified", state: state };
  }
  if (state.status === "completed") return { ok: true, created: false, state: state };
  state.status = "completed";
  state.completionRevision = Math.max(1, state.completionRevision);
  state.graphDigest = graph.digest;
  state.summary = report.summary;
  state.verification = report.verification;
  state.integrationVerification = report.integrationVerification;
  state.escalationRequired = report.escalationRequired;
  state.portfolioTaskId = completionText(input && input.portfolioTaskId);
  state.bindingRevision = Number.isInteger(input && input.bindingRevision) ?
    input.bindingRevision : null;
  state.completedAt = Date.now();
  state.revokedAt = null;
  state.revocationReason = "";
  appendEvent(session, "project_completed", null, {
    completionRevision: state.completionRevision,
    graphDigest: state.graphDigest,
    summary: state.summary,
    verification: state.verification,
    integrationVerification: state.integrationVerification,
    escalationRequired: state.escalationRequired,
    portfolioTaskId: state.portfolioTaskId,
    bindingRevision: state.bindingRevision,
  });
  return { ok: true, created: true, state: state };
}

function revokeProjectCompletion(session, reason) {
  var state = projectCompletionState(session);
  if (state.status !== "completed") return false;
  var previousRevision = state.completionRevision;
  state.status = "pending";
  state.completionRevision = previousRevision + 1;
  state.revokedAt = Date.now();
  state.revocationReason = completionText(reason) || "unresolved_work";
  appendEvent(session, "project_completion_revoked", null, {
    completionRevision: state.completionRevision,
    previousCompletionRevision: previousRevision,
    reason: state.revocationReason,
    portfolioTaskId: state.portfolioTaskId,
    bindingRevision: state.bindingRevision,
  });
  return true;
}

function reconcileProjectCompletion(session) {
  var state = projectCompletionState(session);
  var graph = graphResolutionState(session);
  if (state.status !== "completed" || graph.phase === "complete") return false;
  return revokeProjectCompletion(session, "graph_unresolved");
}

module.exports = {
  dependencyState: dependencyState,
  appendEvent: appendEvent,
  completeProject: completeProject,
  createTask: createTask,
  ensureGraph: ensureGraph,
  findTask: findTask,
  graphResolutionDigest: graphResolutionDigest,
  graphResolutionState: graphResolutionState,
  // Exported so the tool handlers and the durable binding store share one
  // topic-ref normalizer instead of each re-implementing the reference-only
  // shape and drifting apart.
  normalizeTopicRefInput: normalizeTopicRefInput,
  projectCompletionState: projectCompletionState,
  readyTasks: readyTasks,
  reconcileProjectCompletion: reconcileProjectCompletion,
  refreshReadiness: refreshReadiness,
  retryTask: retryTask,
  revokeProjectCompletion: revokeProjectCompletion,
  transition: transition,
  workerColorForId: workerColorForId,
};
