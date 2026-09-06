// Rebuilt from durable records on every turn. Conversation summaries are not
// the source of assignment scope, ownership, dependencies, or pending reports.
var identity = require("./project-identity");
var assignment = require("./coop-project-assignment");

var CLOSED = { completed: true, cancelled: true, dismissed: true, superseded: true };
var MAX_WORK_BYTES = 256 * 1024;

function copy(value) { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }

function taskState(root, task) {
  var record = task.projectAssignment;
  return {
    taskRef: assignment.taskRef(root, task), title: task.title || "Untitled assignment",
    status: task.status || "queued", activity: task.currentActivity || "",
    objective: task.objective || "", acceptanceCriteria: copy(task.acceptanceCriteria),
    ownedPaths: copy(task.ownedPaths), dependencies: copy(task.dependencies || []),
    question: task.userQuestion || task.waitingReason || "", result: copy(task.result),
    updatedAt: task.updatedAt || task.createdAt || null,
    threadRef: copy(task.coopTopicRef),
    workerRef: identity.normalizeSessionRef(task.workerSessionRef || record && record.sessionRef),
    assignment: record ? { valid: assignment.valid(root, task), phase: record.phase,
      reason: record.reason || null, scope: copy(record.payload) } : null,
  };
}

function workerState(ref, projectContexts, rootRef) {
  if (!ref) return null;
  var matches = [];
  projectContexts.forEach(function (context) {
    if (typeof context.getSessionManager !== "function") return;
    var manager = context.getSessionManager();
    if (!manager || !manager.sessions) return;
    manager.sessions.forEach(function (session) {
      if (session._deleted || identity.sessionStorageId(session) !== ref.sessionStorageId) return;
      if (matches.indexOf(session) === -1) matches.push(session);
    });
  });
  var worker = matches.length === 1 && matches[0];
  var parent = worker && identity.normalizeSessionRef(worker.projectCoordinatorRef);
  if (!worker || !parent || parent.projectId !== rootRef.projectId ||
      parent.sessionStorageId !== rootRef.sessionStorageId) return { sessionRef: ref, available: false };
  return { sessionRef: ref, available: true, processing: !!worker.isProcessing,
    activity: worker.currentActivity || "", vendor: worker.vendor || null,
    model: worker.verifiedModel || worker.model || null,
    tasks: (worker.orchestrationTasks || []).map(function (task) {
      return { taskId: task.taskId, status: task.status, title: task.title,
        activity: task.currentActivity || "", question: task.userQuestion || "",
        workerStorageId: task.workerStorageId || null, result: copy(task.result) };
    }) };
}

function buildWorkContext(root, contexts, projectRef) {
  var tasks = root.orchestrationTasks || [];
  var active = tasks.filter(function (task) { return !CLOSED[task.status] && !task.archivedAt; });
  var dependencyIds = new Set();
  function visit(task) {
    (task.dependencies || []).forEach(function (id) {
      if (dependencyIds.has(id)) return;
      dependencyIds.add(id);
      var dependency = tasks.find(function (candidate) { return candidate.taskId === id; });
      if (dependency) visit(dependency);
    });
  }
  active.forEach(visit);
  var selected = tasks.filter(function (task) { return active.indexOf(task) !== -1 || dependencyIds.has(task.taskId); });
  var rootRef = identity.sessionRef({ projectId: identity.LEAD_PROJECT_ID }, root);
  var invalid = [];
  var states = selected.map(function (task) {
    var state = taskState(root, task);
    if (state.assignment && !state.assignment.valid) invalid.push(task.taskId);
    state.worker = state.workerRef && state.workerRef.projectId === projectRef.projectId ?
      workerState(state.workerRef, contexts, rootRef) : null;
    return state;
  });
  var recent = tasks.filter(function (task) { return CLOSED[task.status]; }).slice().sort(function (a, b) {
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  var result = { ok: true, assignments: states,
    pendingReports: copy(root.pendingCoordinatorUpdates || []),
    recentOutcomes: recent.slice(0, 10).map(function (task) { return taskState(root, task); }),
    omittedOlderOutcomes: Math.max(0, recent.length - 10),
    recentEvents: copy((root.orchestrationEvents || []).slice(-20)),
    omittedOlderEvents: Math.max(0, (root.orchestrationEvents || []).length - 20) };
  if (invalid.length) return { ok: false, reason: "assignment_integrity_failed", invalidTaskIds: invalid };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_WORK_BYTES) {
    return { ok: false, reason: "coordinator_work_context_too_large", assignmentCount: selected.length };
  }
  return result;
}

module.exports = { buildWorkContext: buildWorkContext };
