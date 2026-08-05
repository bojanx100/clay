// Read-only global conversation model for the Coop/Lead scope.
//
// The server is the authority for this projection.  This module deliberately
// stores only stable refs and bounded display data; it never turns a missing
// ref into a local session.

var projection = null;
var navigationFailures = {};
var expandedTaskAttempts = {};
var pendingNavigationRef = null;

var ACTIVE_STATUSES = {
  queued: true,
  ready: true,
  running: true,
  reviewing: true,
};

var ATTENTION_STATUSES = {
  blocked: true,
  failed: true,
  needs_input: true,
  waiting_user: true,
};

var TERMINAL_STATUSES = {
  completed: true,
  dismissed: true,
  cancelled: true,
  archived: true,
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback) {
  var text = typeof value === "string" ? value.trim() : "";
  return text || fallback || "";
}

function stableProjectId(group) {
  return group && group.projectRef && typeof group.projectRef.projectId === "string"
    ? group.projectRef.projectId : "";
}

function sessionRefKey(ref) {
  if (!ref || !ref.projectId || !ref.sessionStorageId) return "";
  return ref.projectId + ":" + ref.sessionStorageId;
}

function taskRefKey(ref) {
  if (!ref || !ref.projectId || !ref.coordinatorSessionStorageId || !ref.taskId) return "";
  return ref.projectId + ":" + ref.coordinatorSessionStorageId + ":" + ref.taskId;
}

function isSessionRef(ref) {
  return !!sessionRefKey(ref);
}

function isCoopGroup(group) {
  return stableProjectId(group) === "system-lead" || group && group.isCoop === true;
}

function cloneProjection(message) {
  if (!message || message.type !== "global_coop_projection") return null;
  return { type: message.type, projects: safeArray(message.projects) };
}

function projectTitle(group) {
  return safeText(group && (group.title || group.slug), "Project");
}

function taskStatus(task) {
  return safeText(task && task.status, "unknown");
}

function taskIsVisible(task) {
  var status = taskStatus(task);
  return !!(ACTIVE_STATUSES[status] || ATTENTION_STATUSES[status] || task && task.attention);
}

function attemptIsHistorical(attempt) {
  return !!(attempt && attempt.historical);
}

function attemptAvailability(attempt) {
  var key = sessionRefKey(attempt && attempt.sessionRef);
  return navigationFailures[key] || safeText(attempt && attempt.availability, "available");
}

function taskDisplay(task) {
  var attempts = safeArray(task && task.attempts);
  var currentAttempts = [];
  var historicalAttempts = [];
  for (var i = 0; i < attempts.length; i++) {
    if (attemptIsHistorical(attempts[i])) historicalAttempts.push(attempts[i]);
    else currentAttempts.push(attempts[i]);
  }
  return {
    taskRef: task && task.taskRef || null,
    status: taskStatus(task),
    attention: !!(task && task.attention),
    activity: safeText(task && task.activity, ""),
    currentAttempts: currentAttempts,
    historicalAttempts: historicalAttempts,
    terminal: !!TERMINAL_STATUSES[taskStatus(task)],
  };
}

function coordinatorDisplay(coordinator) {
  var allTasks = safeArray(coordinator && coordinator.tasks);
  var visibleTasks = [];
  var terminalTasks = [];
  for (var i = 0; i < allTasks.length; i++) {
    var display = taskDisplay(allTasks[i]);
    if (taskIsVisible(allTasks[i])) visibleTasks.push(display);
    else if (display.currentAttempts.length || display.historicalAttempts.length) terminalTasks.push(display);
  }
  return Object.assign({}, coordinator || {}, {
    title: safeText(coordinator && coordinator.title, "Coordinator"),
    role: "coordinator",
    visibleTasks: visibleTasks,
    terminalTasks: terminalTasks,
  });
}

function projectDisplay(group, depth) {
  var coordinators = safeArray(group && group.coordinators).map(coordinatorDisplay);
  return {
    projectRef: group && group.projectRef || null,
    title: projectTitle(group),
    slug: safeText(group && group.slug, ""),
    icon: safeText(group && group.icon, ""),
    depth: depth || 0,
    worktree: !!(group && group.parentProjectId),
    coordinators: coordinators,
    directLeaves: safeArray(group && group.directLeaves),
    worktrees: safeArray(group && group.worktrees).map(function (child) {
      return projectDisplay(child, (depth || 0) + 1);
    }),
  };
}

function filterSessionRow(row, query) {
  if (!query) return true;
  var haystack = [row && row.title, row && row.role, row && row.activity, row && row.status]
    .join(" ").toLowerCase();
  return haystack.indexOf(query) !== -1;
}

function filterTask(task, query) {
  if (!query) return true;
  if (filterSessionRow(task, query)) return true;
  return task.currentAttempts.concat(task.historicalAttempts).some(function (attempt) {
    return filterSessionRow(attempt, query);
  });
}

function filterCoordinator(coordinator, query) {
  if (!query || filterSessionRow(coordinator, query)) return coordinator;
  var visibleTasks = coordinator.visibleTasks.filter(function (task) { return filterTask(task, query); });
  var terminalTasks = coordinator.terminalTasks.filter(function (task) { return filterTask(task, query); });
  if (visibleTasks.length === 0 && terminalTasks.length === 0) return null;
  return Object.assign({}, coordinator, { visibleTasks: visibleTasks, terminalTasks: terminalTasks });
}

function filterProject(group, query) {
  var coordinators = group.coordinators.map(function (row) { return filterCoordinator(row, query); })
    .filter(function (row) { return !!row; });
  var directLeaves = group.directLeaves.filter(function (row) { return filterSessionRow(row, query); });
  var worktrees = group.worktrees.map(function (child) { return filterProject(child, query); })
    .filter(function (child) { return !!child; });
  if (!query || projectTitle(group).toLowerCase().indexOf(query) !== -1 ||
      coordinators.length || directLeaves.length || worktrees.length) {
    return Object.assign({}, group, {
      coordinators: coordinators,
      directLeaves: directLeaves,
      worktrees: worktrees,
    });
  }
  return null;
}

export function setGlobalCoopProjection(message) {
  projection = cloneProjection(message);
  navigationFailures = {};
  return projection;
}

export function getGlobalCoopProjection() {
  return projection;
}

export function globalCoopProjectionSignature() {
  return (projection ? JSON.stringify(projection) : "") + "|" + JSON.stringify(navigationFailures);
}

export function globalSessionRefKey(ref) {
  return sessionRefKey(ref);
}

export function globalTaskRefKey(ref) {
  return taskRefKey(ref);
}

export function globalAttemptAvailability(attempt) {
  return attemptAvailability(attempt);
}

export function globalAvailabilityLabel(availability) {
  var labels = {
    access_denied: "Access denied",
    project_not_found: "Project deleted",
    session_not_found: "Session deleted",
    session_archived: "Session archived",
    unavailable: "Unavailable",
  };
  return labels[availability] || (availability === "available" ? "" : "Unavailable");
}

export function buildGlobalCoopDisplayModel(searchQuery) {
  var groups = projection ? projection.projects : [];
  var projects = [];
  for (var i = 0; i < groups.length; i++) {
    if (!isCoopGroup(groups[i])) projects.push(projectDisplay(groups[i], 0));
  }
  var query = safeText(searchQuery, "").toLowerCase();
  return {
    projects: projects.map(function (group) { return filterProject(group, query); })
      .filter(function (group) { return !!group; }),
    hasProjection: !!projection,
  };
}

export function isGlobalTaskExpanded(taskRef) {
  return !!expandedTaskAttempts[taskRefKey(taskRef)];
}

export function toggleGlobalTaskExpanded(taskRef) {
  var key = taskRefKey(taskRef);
  if (!key) return false;
  expandedTaskAttempts[key] = !expandedTaskAttempts[key];
  return expandedTaskAttempts[key];
}

export function requestGlobalSessionRef(ref, send) {
  if (pendingNavigationRef || !isSessionRef(ref) || typeof send !== "function") return false;
  var sent = send({ type: "resolve_session_ref", sessionRef: ref }) !== false;
  if (sent) pendingNavigationRef = ref;
  return sent;
}

export function consumeGlobalSessionRefResolution(message) {
  if (!message || message.type !== "session_ref_resolved") return null;
  var resolvedRef = message.sessionRef || pendingNavigationRef;
  pendingNavigationRef = null;
  if (!message.ok || !isSessionRef(resolvedRef)) {
    var failedRef = resolvedRef;
    if (isSessionRef(failedRef)) navigationFailures[sessionRefKey(failedRef)] = message.code || "unavailable";
    return { ok: false, ref: failedRef || null, code: message.code || "unavailable" };
  }
  delete navigationFailures[sessionRefKey(resolvedRef)];
  if (!safeText(message.slug, "") || typeof message.localId !== "number") {
    navigationFailures[sessionRefKey(resolvedRef)] = "unavailable";
    return { ok: false, ref: resolvedRef, code: "unavailable" };
  }
  return {
    ok: true,
    ref: resolvedRef,
    slug: message.slug,
    localId: message.localId,
  };
}
