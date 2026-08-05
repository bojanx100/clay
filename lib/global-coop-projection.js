var projectIdentity = require("./project-identity");
var coopChannels = require("./project-coop-channels");

var MAX_ITEMS = 4;
var MAX_TEXT = 240;
var ACTIVE_STATUSES = { queued: true, ready: true, running: true, reviewing: true };
var ATTENTION_STATUSES = { blocked: true, failed: true, needs_input: true, waiting_user: true };

function cleanText(value, fallback) {
  var text = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return text || fallback || "";
}

function projectContexts(projects) {
  if (Array.isArray(projects)) return projects.slice();
  var list = [];
  if (projects && typeof projects.forEach === "function") {
    projects.forEach(function (project) { list.push(project); });
  }
  return list;
}

function projectStatus(project) {
  return project && typeof project.getStatus === "function" ? project.getStatus() : project || {};
}

function projectIdFor(project, status) {
  var projectId = project && project.projectId || status && status.projectId;
  return projectIdentity.isProjectId(projectId) ? projectId : null;
}

function sessionManager(project) {
  if (project && typeof project.getSessionManager === "function") return project.getSessionManager();
  return project && project.sm || null;
}

function sessionList(project) {
  var manager = sessionManager(project);
  var sessions = manager && manager.sessions;
  var list = [];
  if (sessions && typeof sessions.forEach === "function") {
    sessions.forEach(function (session) { list.push(session); });
  }
  return list;
}

function canAccessProject(options, project) {
  return !options.canAccessProject || options.canAccessProject(options.actor, project);
}

function canAccessSession(options, project, session) {
  if (!session || session.hidden) return false;
  return !options.canAccessSession || options.canAccessSession(options.actor, project, session);
}

function isConfiguredProject(status, projectId) {
  return !!(projectId && projectId !== projectIdentity.LEAD_PROJECT_ID && status &&
    !status.isMate && !status.isWorktree);
}

function taskTitle(task) {
  return cleanText(task && (task.title || task.objective), "Delegated work");
}

function taskActivity(task) {
  return cleanText(task && (task.currentActivity || task.userQuestion || task.waitingReason), "");
}

function taskSummary(task) {
  return {
    title: taskTitle(task),
    status: cleanText(task && task.status, "unknown"),
    activity: taskActivity(task),
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : null,
  };
}

function pushBounded(list, value) {
  if (value && list.length < MAX_ITEMS) list.push(value);
}

function summaryForProject(options, project) {
  var goals = [];
  var decisions = [];
  var activeWork = [];
  var attention = [];
  var outcomes = [];
  var freshestAt = 0;
  var sessions = sessionList(project);
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    if (!canAccessSession(options, project, session) || !session.coordinationMode ||
        session.orchestrationParent) continue;
    freshestAt = Math.max(freshestAt, session.lastActivity || 0, session.lastViewedAt || 0);
    var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
    for (var ti = 0; ti < tasks.length; ti++) {
      var task = tasks[ti] || {};
      var status = cleanText(task.status, "unknown");
      freshestAt = Math.max(freshestAt, task.updatedAt || task.createdAt || 0);
      if (ACTIVE_STATUSES[status]) {
        pushBounded(activeWork, taskSummary(task));
        pushBounded(goals, cleanText(task.objective || task.title, "Current project goal"));
      }
      if (ATTENTION_STATUSES[status] || task.userQuestion || task.waitingReason) {
        pushBounded(attention, taskSummary(task));
      }
    }
    var completion = session.orchestrationProjectCompletion;
    if (completion && completion.status === "completed" && completion.summary) {
      pushBounded(outcomes, {
        summary: cleanText(completion.summary, "Verified project outcome"),
        verifiedAt: typeof completion.completedAt === "number" ? completion.completedAt : null,
      });
      freshestAt = Math.max(freshestAt, completion.completedAt || 0);
    }
  }
  var nextAction = attention.length > 0
    ? "Open this project channel to resolve attention."
    : (activeWork.length > 0
      ? "Open this project channel to review active delegated work."
      : "Open this project channel to set the next action.");
  return {
    goals: goals,
    decisions: decisions,
    activeWork: activeWork,
    attention: attention,
    outcomes: outcomes,
    freshness: { updatedAt: freshestAt || null, stale: !freshestAt },
    nextAction: nextAction,
  };
}

function ownerContext(options) {
  var user = options.actor && options.actor._clayUser;
  return { ownerId: user && user.id || null, multiUser: !!user };
}

function coopHome(options, leadProject, leadProjectId) {
  var sessions = sessionList(leadProject);
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].coopHome && canAccessSession(options, leadProject, sessions[i])) {
      return {
        sessionRef: projectIdentity.sessionRef({ projectId: leadProjectId }, sessions[i]),
        localId: sessions[i].localId,
        title: "Coop",
      };
    }
  }
  return null;
}

function channelForProject(options, leadProject, targetStatus, owner) {
  var manager = sessionManager(leadProject);
  if (!manager) return null;
  var channel = coopChannels.ensureProjectChannel(manager, targetStatus, owner.ownerId, owner.multiUser);
  if (!channel || !canAccessSession(options, leadProject, channel)) return null;
  return {
    sessionRef: projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, channel),
    localId: channel.localId,
  };
}

function projectChannelProjection(options, leadProject, project, status, projectId, owner) {
  var channel = channelForProject(options, leadProject, status, owner);
  if (!channel || !channel.sessionRef) return null;
  return {
    projectRef: { projectId: projectId },
    slug: cleanText(status.slug || project.slug, ""),
    title: cleanText(status.title || status.project || project.project, "Project"),
    icon: cleanText(status.icon, ""),
    channel: channel,
    summary: summaryForProject(options, project),
  };
}

function buildGlobalCoopProjection(options) {
  var opts = options || {};
  var contexts = projectContexts(opts.projects);
  var leadProject = null;
  var configured = [];
  for (var i = 0; i < contexts.length; i++) {
    var status = projectStatus(contexts[i]);
    var projectId = projectIdFor(contexts[i], status);
    if (projectId === projectIdentity.LEAD_PROJECT_ID) leadProject = contexts[i];
    if (isConfiguredProject(status, projectId) && canAccessProject(opts, contexts[i])) {
      configured.push({ project: contexts[i], status: status, projectId: projectId });
    }
  }
  if (!leadProject || !canAccessProject(opts, leadProject)) {
    return { type: "global_coop_projection", coop: null, projects: [] };
  }
  var owner = ownerContext(opts);
  var projects = [];
  for (var pi = 0; pi < configured.length; pi++) {
    var item = configured[pi];
    var projection = projectChannelProjection(opts, leadProject, item.project, item.status, item.projectId, owner);
    if (projection) projects.push(projection);
  }
  return {
    type: "global_coop_projection",
    coop: coopHome(opts, leadProject, projectIdentity.LEAD_PROJECT_ID),
    projects: projects,
  };
}

module.exports = {
  buildGlobalCoopProjection: buildGlobalCoopProjection,
  summaryForProject: summaryForProject,
};
