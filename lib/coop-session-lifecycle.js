// The single projection from raw session / binding / task records to the
// lifecycle and work state the owner's surfaces read. Split out of
// coop-session-ledger so there is exactly one place that can decide whether
// something counts as live work.
var ACTIVE = { pending: true, active: true, queued: true, ready: true,
  running: true, reviewing: true };
var ATTENTION = { needs_input: true, waiting_user: true, blocked: true,
  failed: true, unavailable: true, unrouted: true };
var TERMINAL = { completed: true, failed: true, cancelled: true, dismissed: true,
  superseded: true, deleted: true };

function cleanText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, limit || 500);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function attentionTaskStatus(tasks) {
  var active = "";
  var list = Array.isArray(tasks) ? tasks : [];
  for (var i = 0; i < list.length; i++) {
    var status = cleanText(list[i] && list[i].status, 40);
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
function lifecycleState(session, binding, task, role) {
  var bindingState = terminalBindingStatus(binding, role);
  if (bindingState) return bindingState;
  var state = liveLifecycleState(session, binding, task, role);
  if (!ACTIVE[state]) return state;
  if (session && session.hidden) return "dismissed";
  if (binding && finite(binding.attentionAt)) return "needs_input";
  return state;
}

function liveLifecycleState(session, binding, task, role) {
  if (task && task.status) return cleanText(task.status, 40);
  var execution = session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution || {};
  if (role === "project_coordinator") {
    var completion = session && session.orchestrationProjectCompletion;
    if (completion && completion.status === "completed") return "completed";
    if (cleanText(execution.status, 40) === "needs_input") return "needs_input";
    // The completion gate refused this coordinator's envelope. The graph is
    // resolved and nothing is executing; it needs attention, not a "running"
    // badge that survives until someone notices days later.
    if (execution.completionRefusalReason) return "needs_input";
    var taskStatus = attentionTaskStatus(session && session.orchestrationTasks);
    if (taskStatus) return taskStatus;
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

function terminalOutcome(status, role, sources) {
  var terminal = TERMINAL[status] || role === "direct_leaf" && ATTENTION[status];
  if (!terminal) return null;
  var bindingState = terminalBindingStatus(sources.binding, role);
  var bindingWins = bindingState && bindingState === status;
  var summary = bindingWins ? sources.binding.statusReason ||
    sources.completion && sources.completion.summary ||
    sources.task && (sources.task.resultSummary || sources.task.resolutionSummary) || "" :
    sources.completion && sources.completion.summary ||
    sources.task && (sources.task.resultSummary || sources.task.resolutionSummary ||
      sources.task.currentActivity) || sources.execution.statusReason ||
    sources.binding && sources.binding.statusReason || "";
  var at = bindingWins && finite(sources.binding &&
    (sources.binding.completedAt || sources.binding.updatedAt)) ||
    finite(sources.completion && sources.completion.completedAt) ||
    finite(sources.task && (sources.task.resolvedAt || sources.task.updatedAt)) ||
    finite(sources.execution.completedAt || sources.execution.updatedAt) ||
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
  lifecycleState: lifecycleState,
  terminalOutcome: terminalOutcome,
  workState: workState,
};
