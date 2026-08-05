var projectIdentity = require("./project-identity");

var MAX_TITLE = 240;
var MAX_ACTIVITY = 240;
var ATTENTION_STATUSES = {
  failed: true,
  blocked: true,
  needs_input: true,
  waiting_user: true,
};

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function projectContexts(projects) {
  if (projects && typeof projects.forEach === "function" && !Array.isArray(projects)) {
    var list = [];
    projects.forEach(function (project) { list.push(project); });
    return list;
  }
  return Array.isArray(projects) ? projects.slice() : [];
}

function projectStatus(project) {
  return project && typeof project.getStatus === "function" ? project.getStatus() : project || {};
}

function projectIdFor(project, status) {
  var id = project && project.projectId || status && status.projectId;
  return projectIdentity.isProjectId(id) ? id : null;
}

function canAccessProject(options, project) {
  return !options.canAccessProject || options.canAccessProject(options.actor, project);
}

function canAccessSession(options, project, session) {
  if (session.hidden) return false;
  return !options.canAccessSession || options.canAccessSession(options.actor, project, session);
}

function sessionList(project) {
  var manager = project && typeof project.getSessionManager === "function" ? project.getSessionManager() : project && project.sm;
  var sessions = manager && manager.sessions;
  if (sessions && typeof sessions.forEach === "function") {
    var list = [];
    sessions.forEach(function (session) { list.push(session); });
    return list;
  }
  return [];
}

function unreadForSession(options, project, session) {
  if (typeof options.unreadForSession !== "function") return 0;
  var unread = options.unreadForSession(options.actor, project, session);
  return typeof unread === "number" && unread > 0 ? unread : 0;
}

function sessionAttention(session) {
  return !!(session && session.pendingPermissions && Object.keys(session.pendingPermissions).length > 0);
}

function sessionProjection(options, project, projectId, session, role, extra) {
  var ref = projectIdentity.sessionRef({ projectId: projectId }, session);
  if (!ref) return null;
  var details = extra || {};
  return {
    sessionRef: ref,
    title: cleanText(session.title, MAX_TITLE) || "New Session",
    role: role,
    provider: cleanText(session.vendor, 80) || null,
    model: cleanText(session.verifiedModel || session.requestedModel || session.model, 160) || null,
    activity: typeof session.lastActivity === "number" ? session.lastActivity :
      (typeof session.createdAt === "number" ? session.createdAt : null),
    unread: unreadForSession(options, project, session),
    attention: !!details.attention || sessionAttention(session),
    availability: "available",
    attempt: typeof details.attempt === "number" ? details.attempt : null,
    current: details.current === true,
    historical: details.historical === true,
  };
}

function coordinatorSession(session) {
  return !!(session && session.coordinationMode && !session.orchestrationParent);
}

function directLeafSession(session) {
  return !!(session && !session.orchestrationParent && !coordinatorSession(session) && session.coopControlledBy);
}

function sameCoordinator(parent, coordinator) {
  if (!parent || !coordinator) return false;
  var storageId = projectIdentity.sessionStorageId(coordinator);
  if (parent.sessionStorageId && storageId) return parent.sessionStorageId === storageId;
  return typeof parent.sessionId === "number" && parent.sessionId === coordinator.localId;
}

function historicalTaskId(session) {
  var adoption = session && session.orchestrationAdoption;
  if (adoption && projectIdentity.isTaskId(adoption.taskId)) return adoption.taskId;
  var history = Array.isArray(session && session.history) ? session.history : [];
  for (var i = 0; i < history.length && i < 25; i++) {
    var item = history[i];
    if (item && item.type === "user_message" && item.orchestrationTaskId &&
        item.origin && item.origin.kind === "coordinator") return String(item.orchestrationTaskId);
  }
  return null;
}

function attemptKind(coordinator, task, session) {
  var parent = session && session.orchestrationParent;
  if (parent && parent.taskId === task.taskId && sameCoordinator(parent, coordinator)) return "current";
  if (task.workerStorageId && task.workerStorageId === projectIdentity.sessionStorageId(session)) return "current";
  return historicalTaskId(session) === task.taskId ? "historical" : null;
}

function attemptSort(left, right) {
  if (left.kind !== right.kind) return left.kind === "historical" ? -1 : 1;
  var created = (left.session.createdAt || 0) - (right.session.createdAt || 0);
  if (created) return created;
  return projectIdentity.sessionStorageId(left.session).localeCompare(projectIdentity.sessionStorageId(right.session));
}

function taskAttention(task) {
  return !!(task && (ATTENTION_STATUSES[task.status] || task.userQuestion || task.waitingReason));
}

function unavailableAttempt(projectId, task) {
  if (!projectIdentity.isSessionStorageId(task && task.workerStorageId)) return null;
  return {
    sessionRef: { projectId: projectId, sessionStorageId: task.workerStorageId },
    role: "worker",
    availability: "unavailable",
    attempt: typeof task.attempt === "number" ? task.attempt : null,
    current: true,
    historical: false,
  };
}

function taskAttemptCandidates(options, project, task, coordinator, sessions) {
  var candidates = [];
  for (var i = 0; i < sessions.length; i++) {
    var kind = attemptKind(coordinator, task, sessions[i]);
    if (kind && projectIdentity.sessionStorageId(sessions[i]) &&
        canAccessSession(options, project, sessions[i])) {
      candidates.push({ session: sessions[i], kind: kind });
    }
  }
  candidates.sort(attemptSort);
  return candidates;
}

function projectedAttempts(options, project, projectId, task, candidates) {
  var attempts = [];
  for (var ci = 0; ci < candidates.length; ci++) {
    var current = candidates[ci].kind === "current";
    var attempt = sessionProjection(options, project, projectId, candidates[ci].session, "worker", {
      attention: taskAttention(task),
      attempt: current ? (typeof task.attempt === "number" ? task.attempt : ci + 1) : ci + 1,
      current: current,
      historical: !current,
    });
    if (attempt) attempts.push(attempt);
  }
  if (attempts.length === 0) {
    var unavailable = unavailableAttempt(projectId, task);
    if (unavailable) attempts.push(unavailable);
  }
  return attempts;
}

function taskProjection(options, project, projectId, coordinator, task, sessions) {
  var ref = projectIdentity.taskRef({ projectId: projectId }, coordinator, task);
  if (!ref) return null;
  var candidates = taskAttemptCandidates(options, project, task, coordinator, sessions);
  return {
    taskRef: ref,
    status: cleanText(task.status, 64) || "unknown",
    progress: typeof task.progress === "number" ? task.progress : null,
    activity: cleanText(task.currentActivity, MAX_ACTIVITY) || null,
    attempt: typeof task.attempt === "number" ? task.attempt : null,
    current: true,
    historical: false,
    attention: taskAttention(task),
    attempts: projectedAttempts(options, project, projectId, task, candidates),
  };
}

function coordinatorProjection(options, project, projectId, session, sessions) {
  var coordinator = sessionProjection(options, project, projectId, session, "coordinator", {});
  if (!coordinator) return null;
  coordinator.tasks = [];
  var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
  for (var ti = 0; ti < tasks.length; ti++) {
    var task = taskProjection(options, project, projectId, session, tasks[ti], sessions);
    if (task) coordinator.tasks.push(task);
  }
  return coordinator;
}

function sessionRole(session) {
  if (coordinatorSession(session)) return "coordinator";
  return directLeafSession(session) ? "direct_leaf" : null;
}

function projectSessionRows(options, project, projectId, sessions) {
  var rows = { coordinators: [], directLeaves: [] };
  for (var i = 0; i < sessions.length; i++) {
    if (!canAccessSession(options, project, sessions[i])) continue;
    var role = sessionRole(sessions[i]);
    if (role === "coordinator") {
      var coordinator = coordinatorProjection(options, project, projectId, sessions[i], sessions);
      if (coordinator) rows.coordinators.push(coordinator);
    } else if (role === "direct_leaf") {
      var leaf = sessionProjection(options, project, projectId, sessions[i], role, {});
      if (leaf) rows.directLeaves.push(leaf);
    }
  }
  return rows;
}

function projectProjection(options, project) {
  var status = projectStatus(project);
  var projectId = projectIdFor(project, status);
  if (!projectId || !canAccessProject(options, project)) return null;
  var sessions = sessionList(project);
  var rows = projectSessionRows(options, project, projectId, sessions);
  return {
    projectRef: { projectId: projectId },
    slug: cleanText(status.slug || project.slug, 160) || null,
    title: cleanText(status.title || status.project || project.project, MAX_TITLE) || null,
    icon: cleanText(status.icon, 240) || null,
    parentProjectId: projectIdentity.isProjectId(status.parentProjectId) ? status.parentProjectId : null,
    coordinators: rows.coordinators,
    directLeaves: rows.directLeaves,
    worktrees: [],
  };
}

function nestWorktrees(groups) {
  var byId = {};
  for (var i = 0; i < groups.length; i++) byId[groups[i].projectRef.projectId] = groups[i];
  var roots = [];
  for (var gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    var parent = group.parentProjectId && byId[group.parentProjectId];
    if (parent) parent.worktrees.push(group);
    else roots.push(group);
  }
  return roots;
}

function buildGlobalCoopProjection(options) {
  var opts = options || {};
  var contexts = projectContexts(opts.projects);
  var groups = [];
  for (var i = 0; i < contexts.length; i++) {
    var group = projectProjection(opts, contexts[i]);
    if (group) groups.push(group);
  }
  return { type: "global_coop_projection", projects: nestWorktrees(groups) };
}

module.exports = {
  buildGlobalCoopProjection: buildGlobalCoopProjection,
  coordinatorSession: coordinatorSession,
  directLeafSession: directLeafSession,
  taskProjection: taskProjection,
};
