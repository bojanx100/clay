// The single projection from raw session / binding / task records to the
// lifecycle and work state the owner's surfaces read. Split out of
// coop-session-ledger so there is exactly one place that can decide whether
// something counts as live work.
var hasStaleProcessingState = require("./sessions-queued-messages").hasStaleProcessingState;
var isOwnerAccepted = require("./project-owner-acceptance").isAccepted;
var ACTIVE = { pending: true, active: true, queued: true, ready: true,
  running: true, reviewing: true };
var ATTENTION = { needs_input: true, waiting_user: true, blocked: true,
  failed: true, unavailable: true, unrouted: true };
var TERMINAL = { completed: true, failed: true, cancelled: true,
  dismissed: true, superseded: true, deleted: true };

function cleanText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, limit || 500);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function storageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}

function sessionExecution(session) {
  var policy = session && session.orchestrationPolicy;
  var execution = policy && policy.portfolioExecution;
  return execution && typeof execution === "object" ? execution : null;
}

function sameSessionRef(ref, projectId, sessionStorageId) {
  return !!(ref && ref.projectId === projectId &&
    ref.sessionStorageId === sessionStorageId);
}

function exactBindingForSession(session, projectId, bindings) {
  var execution = sessionExecution(session);
  var sessionStorageId = storageId(session);
  if (!execution || !sessionStorageId || !projectId) return null;
  var list = Array.isArray(bindings) ? bindings : [];
  for (var i = 0; i < list.length; i++) {
    var binding = list[i];
    if (!binding || !binding.targetProject || binding.targetProject.projectId !== projectId ||
        binding.portfolioTaskId !== execution.portfolioTaskId ||
        Number(binding.bindingRevision) !== Number(execution.bindingRevision) ||
        binding.mode !== execution.mode) continue;
    var ref = binding.mode === "project_coordinator" ? binding.coordinator : binding.worker;
    if (sameSessionRef(ref, projectId, sessionStorageId)) return binding;
    // A reserved-but-not-yet-committed binding carries NO session ref: reserve()
    // files the work identity and commit() is what attaches the ref. Requiring a
    // ref therefore made every pending binding unmatchable, and projectActivityState
    // fell through its `!binding` branch to idle -- so widening the status check
    // alone would have fixed nothing. This is the other half of that fix.
    //
    // Identity is still exact. Every field above -- target project, portfolio task,
    // revision and mode -- has already matched, and the store keeps at most one
    // binding per (portfolioTaskId, bindingRevision), so there is exactly one
    // candidate. The ref-less test is deliberately `!ref`: a binding that HAS a ref
    // naming a different session must never be claimed here, which is what keeps
    // this from attributing one project's execution to another's session.
    if (!ref && binding.status === "pending") return binding;
  }
  return null;
}

function taskForWorker(session, sessions) {
  var sessionStorageId = storageId(session);
  var list = Array.isArray(sessions) ? sessions : [];
  for (var si = 0; si < list.length; si++) {
    var tasks = Array.isArray(list[si] && list[si].orchestrationTasks) ?
      list[si].orchestrationTasks : [];
    for (var ti = 0; ti < tasks.length; ti++) {
      var task = tasks[ti];
      if (!task) continue;
      if (sessionStorageId && task.workerStorageId === sessionStorageId) return task;
      if (typeof session.localId === "number" && task.workerSessionId === session.localId) return task;
    }
  }
  return null;
}

function workerSessionForTask(task, sessions) {
  var wantedStorageId = String(task && (task.workerStorageId || task.workerSessionStorageId) || "");
  var wantedLocalId = Number(task && task.workerSessionId);
  var list = Array.isArray(sessions) ? sessions : [];
  for (var i = 0; i < list.length; i++) {
    var candidate = list[i];
    if (!candidate) continue;
    if (wantedStorageId && storageId(candidate) === wantedStorageId) return candidate;
    if (!wantedStorageId && Number.isInteger(wantedLocalId) && candidate.localId === wantedLocalId) {
      return candidate;
    }
  }
  return null;
}

function bindingForTask(task, projectId, bindings) {
  var result = [];
  var workerStorageId = String(task && task.workerStorageId || "");
  var clientRef = String(task && task.clientRef || "");
  var clientMatch = /^portfolio:(.+):(\d+)$/.exec(clientRef);
  var list = Array.isArray(bindings) ? bindings : [];
  for (var i = 0; i < list.length; i++) {
    var binding = list[i];
    if (!binding || !binding.targetProject || binding.targetProject.projectId !== projectId) continue;
    var ref = binding.mode === "project_coordinator" ? binding.coordinator : binding.worker;
    var byWorker = workerStorageId && sameSessionRef(ref, projectId, workerStorageId);
    var byClient = clientMatch && binding.portfolioTaskId === clientMatch[1] &&
      Number(binding.bindingRevision) === Number(clientMatch[2]);
    if (byWorker || byClient) result.push(binding);
  }
  return result;
}

function roleForProjectActivity(session, task, binding) {
  if (session && session.coordinationRole === "project_coordinator") return "project_coordinator";
  if (session && session.coordinationRole === "task_coordinator") return "task_coordinator";
  if (task) return "worker";
  var execution = sessionExecution(session);
  var mode = execution && execution.mode || binding && binding.mode;
  if (mode === "project_coordinator" || session && session.coordinationMode) return "project_coordinator";
  if (mode === "direct_leaf") return "direct_leaf";
  return "top_level_session";
}

function projectActivityState(session, projectId, sessions, bindings) {
  if (!session || session._deleted || session.hidden || session.closedAt ||
      hasStaleProcessingState(session)) return "idle";
  var execution = sessionExecution(session);
  var binding = exactBindingForSession(session, projectId, bindings);
  // A portfolio execution is active only when its exact durable binding says
  // so. Session metadata is historical after a binding becomes terminal,
  // deleted, unavailable, or otherwise ceases to represent live execution.
  //
  // Tested against this module's own ACTIVE set rather than the literal "active",
  // which was narrower than the rule the comment above states and than the rest of
  // this file. `pending` is the reserved-but-not-yet-committed state: reserve()
  // files the binding as pending, the target session then gets its execution
  // metadata and broadcasts, and only the dispatching side's later commit() flips
  // it to active. Between those, a session that was demonstrably starting work
  // read as idle, so the project activity indicator went dark exactly while a
  // dispatch was landing.
  //
  // Only `pending` changes meaning here. Every other binding status is absent
  // from ACTIVE -- unrouted, unavailable and needs_input are ATTENTION, and
  // completed/failed/cancelled/superseded/deleted are TERMINAL -- so all of them
  // still read as idle exactly as before. A reservation that never starts is moved
  // to unrouted rather than left pending, so this cannot pin the indicator on.
  if (execution && (!binding || !ACTIVE[binding.status])) return "idle";
  var task = taskForWorker(session, sessions);
  var bindingsForTask = function (candidate) {
    return bindingForTask(candidate, projectId, bindings);
  };
  if (task && !taskStatusForActivity(task, bindingsForTask, sessions)) return "idle";
  var role = roleForProjectActivity(session, task, binding);
  return lifecycleState(session, binding, task, role, bindingsForTask, sessions);
}

function projectHasActiveWork(sessions, projectId, bindings) {
  var list = Array.isArray(sessions) ? sessions : [];
  for (var i = 0; i < list.length; i++) {
    // The project pulse means a turn is executing now. Durable queued,
    // reviewing or active bindings survive restarts and are not runtime proof.
    if (list[i] && list[i].isProcessing === true &&
        workState(projectActivityState(list[i], projectId, list, bindings)) === "working") return true;
  }
  return false;
}

function boundTaskStatus(task, bindingsForTask) {
  var bindings = typeof bindingsForTask === "function" ? bindingsForTask(task) : [];
  var list = Array.isArray(bindings) ? bindings : [];
  var terminal = list.length > 0;
  for (var bi = 0; bi < list.length; bi++) {
    var bindingStatus = cleanText(list[bi] && list[bi].status, 40);
    if (!TERMINAL[bindingStatus]) terminal = false;
  }
  if (terminal) return "";
  for (var ai = 0; ai < list.length; ai++) {
    var activeBinding = list[ai] || {};
    var activeStatus = cleanText(activeBinding.status, 40);
    if (!TERMINAL[activeStatus] &&
        (ATTENTION[activeStatus] || finite(activeBinding.attentionAt))) return "needs_input";
  }
  return cleanText(task && task.status, 40);
}

function taskStatusForActivity(task, bindingsForTask, sessions) {
  var status = boundTaskStatus(task, bindingsForTask);
  if (!status || !ACTIVE[status]) return status;
  var taskBindings = typeof bindingsForTask === "function" ? bindingsForTask(task) : [];
  if (!Array.isArray(taskBindings)) taskBindings = [];
  for (var bi = 0; bi < taskBindings.length; bi++) {
    if (taskBindings[bi] && !TERMINAL[cleanText(taskBindings[bi].status, 40)]) return status;
  }
  var hasWorkerReference = !!(task && (task.workerStorageId || task.workerSessionStorageId)) ||
    !!(task && task.workerSessionId != null &&
      Number.isInteger(Number(task.workerSessionId)));
  if (!hasWorkerReference) return status;
  var worker = workerSessionForTask(task, sessions);
  // A task with a worker reference but no live worker is an orphaned projection.
  // Do not let the parent's historical `running` value resurrect project work
  // after the worker has disappeared or reached a terminal execution state.
  if (!worker) {
    // A local task can be visible one enumeration ahead of its worker session.
    // Only an explicitly external task-coordinator record is safe to retire
    // when its referenced worker is absent; that is the persisted restart shape
    // this projection is repairing. Ordinary local task status remains live
    // during the load gap.
    return task && task.externalTaskCoordinator ? "" : status;
  }
  if (worker.hidden || worker.closedAt || worker._deleted) return "";
  var execution = sessionExecution(worker);
  var workerStatus = cleanText(execution && execution.status, 40);
  if (TERMINAL[workerStatus]) return "";
  return status;
}

function attentionTaskStatus(tasks, bindingsForTask, sessions) {
  var active = "";
  var list = Array.isArray(tasks) ? tasks : [];
  for (var i = 0; i < list.length; i++) {
    var status = taskStatusForActivity(list[i], bindingsForTask, sessions);
    if (ATTENTION[status]) return "needs_input";
    if (status === "reviewing") active = "reviewing";
    else if (!active && (status === "running" || status === "ready" || status === "queued")) {
      active = status;
    }
  }
  return active;
}

function terminalBindingStatus(binding, role) {
  // Bounded executions have one exact binding whose terminal result is final.
  // Reusable project roots may keep historical bindings while newer work runs.
  if (role !== "task_coordinator" && role !== "direct_leaf") return "";
  var status = cleanText(binding && binding.status, 40);
  if (binding && binding.ownerAcceptanceRequired === true &&
      !isOwnerAccepted(binding.ownerAcceptance) && status === "completed") {
    return "needs_input";
  }
  if (status === "needs_input") {
    return role === "task_coordinator" && binding && binding.reviewOnly === true ? status : "";
  }
  return TERMINAL[status] ? status : "";
}

// A hidden session was dismissed by the owner, and an attention-marked binding
// was flagged as not progressing. Either way the record's own execution status
// is the last thing the target project happened to write and can be
// arbitrarily stale, so neither may keep claiming to be executing: that is
// what made a dismissed coordinator read as "working" for days. Terminal and
// attention evidence (completed, failed, unavailable, needs_input) is
// deliberately preserved untouched - only a claim of being actively executing
// is refused, because nothing hidden or flagged is executing.
function lifecycleState(session, binding, task, role, bindingsForTask, sessions) {
  var bindingState = terminalBindingStatus(binding, role);
  if (bindingState) return bindingState;
  if (session && session.contextRecovery &&
      (session.contextRecovery.status === "pending" || session.contextRecovery.status === "blocked")) return "needs_input";
  var state = liveLifecycleState(session, binding, task, role, bindingsForTask, sessions);
  if (!ACTIVE[state]) return state;
  if (session && session.hidden) return "dismissed";
  if (binding && finite(binding.attentionAt)) return "needs_input";
  return state;
}

function liveLifecycleState(session, binding, task, role, bindingsForTask, sessions) {
  var execution = session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution || {};
  if (task && task.status) {
    var taskState = cleanText(task.status, 40);
    // An unresolved parent can lag behind its exact worker. Preserve explicit
    // task closure, but never let old running metadata mask a recorded failure.
    if (!ACTIVE[taskState]) return taskState;
    var workerState = cleanText(binding && binding.status, 40);
    if (ATTENTION[workerState] || TERMINAL[workerState]) return workerState;
    if (binding && finite(binding.attentionAt)) return "needs_input";
    workerState = cleanText(execution.status, 40);
    if (ATTENTION[workerState] || TERMINAL[workerState]) return workerState;
    if (execution.completionRefusalReason) return "needs_input";
    return taskState;
  }
  if (role === "project_coordinator") {
    var ownerAcceptanceRequired = binding && binding.ownerAcceptanceRequired === true ||
      execution.ownerAcceptanceRequired === true;
    var ownerAcceptance = binding && binding.ownerAcceptance || execution.ownerAcceptance;
    if (ownerAcceptanceRequired && !isOwnerAccepted(ownerAcceptance)) return "needs_input";
    var completion = session && session.orchestrationProjectCompletion;
    if (completion && completion.status === "completed") return "completed";
    if (cleanText(execution.status, 40) === "needs_input") return "needs_input";
    // The completion gate refused this coordinator's envelope. The graph is
    // resolved and nothing is executing; it needs attention, not a "running"
    // badge that survives until someone notices days later.
    if (execution.completionRefusalReason) return "needs_input";
    var taskStatus = attentionTaskStatus(session && session.orchestrationTasks, bindingsForTask, sessions);
    if (taskStatus) return taskStatus;
    // A legacy reusable project root can retain stale `running` execution
    // metadata after its exact canonical binding has completed. The binding
    // is terminal only when it names this same execution and no child work is
    // active; historical root bindings must not retire a reused coordinator.
    var bindingStatus = cleanText(binding && binding.status, 40);
    var exactBinding = binding && execution &&
      cleanText(binding.portfolioTaskId, 256) === cleanText(execution.portfolioTaskId, 256) &&
      Number(binding.bindingRevision) === Number(execution.bindingRevision);
    if (exactBinding && TERMINAL[bindingStatus]) return bindingStatus;
  }
  var status = cleanText(execution.status, 40) || cleanText(binding && binding.status, 40);
  if (status) return status;
  return session && session.isProcessing ? "running" : "idle";
}

function workState(status) {
  if (ACTIVE[status]) return "working";
  if (status === "completed") return "done";
  if (ATTENTION[status]) return "needs_input";
  return "idle";
}

// A superseded execution normally proves only that this incarnation was
// replaced; it must not be shown as Done by inference. One historical Coop
// execution is different: its durable supersession reason records that the
// implementation was already complete, pushed, and independently verified
// before the stale upstream task was dismissed. Preserve the superseded
// lifecycle for audit, but let owner projections use the explicit completion
// evidence. The marker is intentionally strict so ordinary superseded,
// cancelled, or dismissed work remains non-resolution evidence.
function hasVerifiedSupersededCompletion(session, binding, execution) {
  if (!session || !session.hidden) return false;
  var bindingStatus = cleanText(binding && binding.status, 40);
  if (bindingStatus !== "superseded") return false;
  var reason = cleanText(binding && binding.statusReason, 1000);
  if (!reason) reason = cleanText(execution && execution.statusReason, 1000);
  return /implementation is already complete/i.test(reason) &&
    /pushed/i.test(reason) && /verified/i.test(reason);
}

function projectedWorkState(status, session, binding, execution) {
  if (hasVerifiedSupersededCompletion(session, binding, execution)) return "done";
  return workState(status);
}

function terminalOutcome(status, role, sources) {
  var ownerAcceptanceRequired = sources.binding &&
    sources.binding.ownerAcceptanceRequired === true || sources.execution &&
    sources.execution.ownerAcceptanceRequired === true;
  var ownerAcceptance = sources.binding && sources.binding.ownerAcceptance ||
    sources.execution && sources.execution.ownerAcceptance;
  if (ownerAcceptanceRequired && !isOwnerAccepted(ownerAcceptance)) return null;
  var resolution = sources.binding && sources.binding.coordinatorResolution;
  if (status === "completed" && resolution) return { status: status, at: resolution.resolvedAt,
    summary: cleanText(resolution.summary, 1000), verification: cleanText(resolution.verification, 1000),
    resolvedByCoordinator: resolution.coordinator, previousOutcome: resolution.previousOutcome };
  var bindingState = terminalBindingStatus(sources.binding, role);
  var terminal = TERMINAL[status] || bindingState === status ||
    role === "direct_leaf" && ATTENTION[status];
  if (!terminal) return null;
  var bindingWins = bindingState && bindingState === status ||
    role === "project_coordinator" && TERMINAL[status] &&
      cleanText(sources.binding && sources.binding.status, 40) === status;
  var executionReason = sources.execution &&
    (sources.execution.statusReason || sources.execution.reason ||
      sources.execution.restartRecoveryFailureReason) || "";
  var summary = bindingWins ? sources.binding.statusReason ||
    sources.completion && sources.completion.summary ||
    sources.task && (sources.task.resultSummary || sources.task.resolutionSummary) ||
    executionReason || "" :
    sources.completion && sources.completion.summary ||
    sources.task && (sources.task.resultSummary || sources.task.resolutionSummary ||
      sources.task.currentActivity) || executionReason ||
    sources.binding && sources.binding.statusReason || "";
  var at = bindingWins && finite(sources.binding &&
    (sources.binding.completedAt || sources.binding.updatedAt)) ||
    finite(sources.completion && sources.completion.completedAt) ||
    finite(sources.task && (sources.task.resolvedAt || sources.task.updatedAt)) ||
    finite(sources.execution.terminalAt || sources.execution.completedAt ||
      sources.execution.updatedAt) ||
    finite(sources.binding && (sources.binding.completedAt || sources.binding.updatedAt)) || 0;
  return { status: status, at: at || null, summary: cleanText(summary, 1000) };
}

module.exports = {
  ACTIVE: ACTIVE,
  ATTENTION: ATTENTION,
  TERMINAL: TERMINAL,
  attentionTaskStatus: attentionTaskStatus,
  cleanText: cleanText,
  finite: finite,
  hasVerifiedSupersededCompletion: hasVerifiedSupersededCompletion,
  lifecycleState: lifecycleState,
  projectActivityState: projectActivityState,
  projectHasActiveWork: projectHasActiveWork,
  projectedWorkState: projectedWorkState,
  terminalOutcome: terminalOutcome,
  workState: workState,
};
