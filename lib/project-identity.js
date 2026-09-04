var crypto = require("crypto");

var LEAD_PROJECT_ID = "system-lead";
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var SYSTEM_ID_RE = /^system-[a-z0-9_-]+$/;
var STORAGE_ID_RE = /^[A-Za-z0-9_-]+$/;
var TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isProjectId(value) {
  return typeof value === "string" && (UUID_RE.test(value) || SYSTEM_ID_RE.test(value));
}

function isSessionStorageId(value) {
  return typeof value === "string" && STORAGE_ID_RE.test(value);
}

function isTaskId(value) {
  return typeof value === "string" && TASK_ID_RE.test(value);
}

function projectRef(value) {
  var projectId = typeof value === "string" ? value : value && value.projectId;
  return isProjectId(projectId) ? { projectId: projectId } : null;
}

function sessionStorageId(session) {
  if (!session) return null;
  var value = session.sessionStorageId || session.storageId || session.cliSessionId;
  return isSessionStorageId(value) ? value : null;
}

function sessionRef(project, session) {
  var ref = projectRef(project);
  var storageId = sessionStorageId(session);
  if (!ref || !storageId) return null;
  return { projectId: ref.projectId, sessionStorageId: storageId };
}

function taskRef(project, coordinator, task) {
  var ref = projectRef(project);
  var coordinatorSessionStorageId = sessionStorageId(coordinator);
  var taskId = typeof task === "string" ? task : task && task.taskId;
  if (!ref || !coordinatorSessionStorageId || !isTaskId(taskId)) return null;
  return {
    projectId: ref.projectId,
    coordinatorSessionStorageId: coordinatorSessionStorageId,
    taskId: taskId,
  };
}

function normalizeProjectRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  return projectRef(ref.projectId);
}

function normalizeSessionRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  var project = projectRef(ref.projectId);
  if (!project || !isSessionStorageId(ref.sessionStorageId)) return null;
  return { projectId: project.projectId, sessionStorageId: ref.sessionStorageId };
}

function normalizeTaskRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  var project = projectRef(ref.projectId);
  if (!project || !isSessionStorageId(ref.coordinatorSessionStorageId) || !isTaskId(ref.taskId)) return null;
  return {
    projectId: project.projectId,
    coordinatorSessionStorageId: ref.coordinatorSessionStorageId,
    taskId: ref.taskId,
  };
}

function uuidFromSeed(seed) {
  var hex = crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = "89ab"[parseInt(hex[16], 16) % 4];
  return hex.slice(0, 8).join("") + "-" + hex.slice(8, 12).join("") + "-" +
    hex.slice(12, 16).join("") + "-" + hex.slice(16, 20).join("") + "-" + hex.slice(20).join("");
}

function identitySeed(project, suffix) {
  var locator = project && (project.path || project.cwd || project.slug);
  return "clay-project-identity:" + String(locator || "unknown") + ":" + String(suffix || 0);
}

function deterministicProjectId(project, suffix) {
  if (project && project.isLead) return LEAD_PROJECT_ID;
  return uuidFromSeed(identitySeed(project, suffix));
}

function retainedProjectId(removedProjects, projectPath) {
  var records = Array.isArray(removedProjects) ? removedProjects : [];
  for (var i = records.length - 1; i >= 0; i--) {
    if (records[i].path === projectPath && isProjectId(records[i].projectId)) {
      return records[i].projectId;
    }
  }
  return null;
}

function uniqueProjectId(project, usedIds, suffix) {
  var candidate = deterministicProjectId(project, suffix);
  var attempt = suffix || 0;
  while (usedIds[candidate]) {
    attempt++;
    candidate = deterministicProjectId(project, attempt);
  }
  return candidate;
}

function assignProjectId(project, usedIds, removedProjects) {
  if (!project || typeof project !== "object") return false;
  var current = project.projectId;
  if (isProjectId(current) && !usedIds[current]) {
    usedIds[current] = true;
    return false;
  }
  var retained = retainedProjectId(removedProjects, project.path);
  var next = retained && !usedIds[retained] ? retained : uniqueProjectId(project, usedIds, 0);
  project.projectId = next;
  usedIds[next] = true;
  return current !== next;
}

// Mutates only the provided config object. Callers persist it once with the
// normal temp-file rename before advertising any project contexts.
function migrateProjectIdentities(config) {
  var changed = false;
  var usedIds = {};
  var projects = config && Array.isArray(config.projects) ? config.projects : [];
  var removedProjects = config && Array.isArray(config.removedProjects) ? config.removedProjects : [];
  for (var i = 0; i < projects.length; i++) {
    if (assignProjectId(projects[i], usedIds, removedProjects)) changed = true;
  }
  for (var j = 0; j < removedProjects.length; j++) {
    if (assignProjectId(removedProjects[j], usedIds, null)) changed = true;
  }
  return { changed: changed, projects: projects, removedProjects: removedProjects };
}

function createProjectEntry(fields, removedProjects) {
  var entry = Object.assign({}, fields || {});
  var retained = retainedProjectId(removedProjects, entry.path);
  entry.projectId = retained || deterministicProjectId(entry, 0);
  return entry;
}

function projectIdForRuntime(extra, cwd, slug, worktreeMeta) {
  if (worktreeMeta && isProjectId(worktreeMeta.parentProjectId)) {
    return worktreeMeta.parentProjectId;
  }
  if (extra && isProjectId(extra.projectId)) return extra.projectId;
  if (extra && extra.isLead) return LEAD_PROJECT_ID;
  return deterministicProjectId({ path: cwd, slug: slug }, 0);
}

function createReferenceResolver(ctx) {
  var getProjectById = ctx.getProjectById;
  var getProjectsById = ctx.getProjectsById || function (projectId) {
    var project = getProjectById(projectId);
    return project ? [project] : [];
  };
  var getSessionManager = ctx.getSessionManager || function (project) {
    return project && project.getSessionManager ? project.getSessionManager() : null;
  };
  var canAccessProject = ctx.canAccessProject || function () { return true; };
  var canAccessSession = ctx.canAccessSession || function () { return true; };

  function candidateProjects(projectId) {
    var candidates = getProjectsById(projectId);
    if (!Array.isArray(candidates)) candidates = candidates ? [candidates] : [];
    candidates = candidates.filter(function (project) { return !!project; });
    candidates.sort(function (left, right) {
      var leftStatus = left && typeof left.getStatus === "function" ? left.getStatus() : left || {};
      var rightStatus = right && typeof right.getStatus === "function" ? right.getStatus() : right || {};
      return Number(!!leftStatus.isWorktree) - Number(!!rightStatus.isWorktree);
    });
    return candidates;
  }

  function resolveProjectRef(ref, actor) {
    var normalized = normalizeProjectRef(ref);
    if (!normalized) return { ok: false, code: "invalid_project_ref" };
    var candidates = candidateProjects(normalized.projectId);
    if (!candidates.length) return { ok: false, code: "project_not_found" };
    for (var i = 0; i < candidates.length; i++) {
      if (canAccessProject(actor, candidates[i])) {
        return { ok: true, ref: normalized, project: candidates[i] };
      }
    }
    return { ok: false, code: "access_denied" };
  }

  function resolveSessionRef(ref, actor) {
    var normalized = normalizeSessionRef(ref);
    if (!normalized) return { ok: false, code: "invalid_session_ref" };
    var candidates = candidateProjects(normalized.projectId);
    if (!candidates.length) return { ok: false, code: "project_not_found" };
    var accessibleProject = false;
    var deniedSession = false;
    for (var i = 0; i < candidates.length; i++) {
      var project = candidates[i];
      if (!canAccessProject(actor, project)) continue;
      accessibleProject = true;
      var manager = getSessionManager(project);
      var session = manager && typeof manager.resolveSessionRef === "function"
        ? manager.resolveSessionRef(normalized) : null;
      if (!session) continue;
      if (!canAccessSession(actor, project, session)) {
        deniedSession = true;
        continue;
      }
      return { ok: true, ref: normalized, project: project, session: session };
    }
    if (!accessibleProject || deniedSession) return { ok: false, code: "access_denied" };
    return { ok: false, code: "session_not_found" };
  }

  function resolveTaskRef(ref, actor) {
    var normalized = normalizeTaskRef(ref);
    if (!normalized) return { ok: false, code: "invalid_task_ref" };
    var sessionResult = resolveSessionRef({
      projectId: normalized.projectId,
      sessionStorageId: normalized.coordinatorSessionStorageId,
    }, actor);
    if (!sessionResult.ok) return sessionResult;
    var tasks = Array.isArray(sessionResult.session.orchestrationTasks) ?
      sessionResult.session.orchestrationTasks : [];
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i] && tasks[i].taskId === normalized.taskId) {
        return {
          ok: true,
          ref: normalized,
          project: sessionResult.project,
          coordinator: sessionResult.session,
          task: tasks[i],
        };
      }
    }
    return { ok: false, code: "task_not_found" };
  }

  return {
    resolveProjectRef: resolveProjectRef,
    resolveSessionRef: resolveSessionRef,
    resolveTaskRef: resolveTaskRef,
  };
}

module.exports = {
  LEAD_PROJECT_ID: LEAD_PROJECT_ID,
  isProjectId: isProjectId,
  isSessionStorageId: isSessionStorageId,
  isTaskId: isTaskId,
  projectRef: projectRef,
  sessionRef: sessionRef,
  taskRef: taskRef,
  sessionStorageId: sessionStorageId,
  normalizeProjectRef: normalizeProjectRef,
  normalizeSessionRef: normalizeSessionRef,
  normalizeTaskRef: normalizeTaskRef,
  deterministicProjectId: deterministicProjectId,
  retainedProjectId: retainedProjectId,
  migrateProjectIdentities: migrateProjectIdentities,
  createProjectEntry: createProjectEntry,
  projectIdForRuntime: projectIdForRuntime,
  createReferenceResolver: createReferenceResolver,
};
