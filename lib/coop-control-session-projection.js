var projectIdentity = require("./project-identity");
var coopControlRole = require("./coop-control-role");
var sessionExecutionBinding = require("./portfolio-execution-bindings").sessionExecutionBinding;
var normalizeTopicRef = require("./coop-topic-ref").normalizeTopicRefInput;

var ACTIVE_STATUSES = { queued: true, ready: true, running: true, reviewing: true };
var ATTENTION_STATUSES = { blocked: true, failed: true, needs_input: true, waiting_user: true };
var MAX_TEXT = 240;

function cleanText(value, fallback) {
  var text = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return text || fallback || "";
}

function projectStatus(project) {
  return project && typeof project.getStatus === "function" ? project.getStatus() : project || {};
}

function projectIdFor(project, status) {
  var projectId = project && project.projectId || status && status.projectId;
  return projectIdentity.isProjectId(projectId) ? projectId : null;
}

function sessionList(project) {
  var manager = project && typeof project.getSessionManager === "function" ?
    project.getSessionManager() : project && project.sm;
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

function canAccessSession(options, project, session, includeHidden) {
  if (!session || (!includeHidden && session.hidden)) return false;
  if (includeHidden && typeof options.canAccessArchivedSession === "function") {
    return options.canAccessArchivedSession(options.actor, project, session);
  }
  return !options.canAccessSession || options.canAccessSession(options.actor, project, session);
}

function sessionRefKey(ref) {
  var value = projectIdentity.normalizeSessionRef(ref);
  return value ? value.projectId + ":" + value.sessionStorageId : "";
}

function controlTaskIndex(leadProject) {
  var result = {};
  var sessions = sessionList(leadProject);
  for (var i = 0; i < sessions.length; i++) {
    var root = sessions[i];
    var rootRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root);
    var tasks = Array.isArray(root && root.orchestrationTasks) ? root.orchestrationTasks : [];
    for (var ti = 0; ti < tasks.length; ti++) {
      var task = tasks[ti] || {};
      if (!task.externalTaskCoordinator) continue;
      var ref = projectIdentity.normalizeSessionRef(task.workerSessionRef ||
        (task.coopProjectRef && task.workerStorageId ? {
          projectId: task.coopProjectRef.projectId,
          sessionStorageId: task.workerStorageId,
        } : null));
      var key = sessionRefKey(ref);
      if (key && !result[key]) result[key] = { task: task, rootRef: rootRef };
    }
  }
  return result;
}

function executionStatus(session, task, execution) {
  var completion = session && session.orchestrationProjectCompletion;
  if (completion && completion.status === "completed") return "completed";
  var status = cleanText(execution && execution.status || task && task.status, "");
  if (status === "active") return "running";
  return status || (session && session.isProcessing ? "running" : "idle");
}

function resultSummary(session, task, execution) {
  var completion = session && session.orchestrationProjectCompletion;
  return cleanText(completion && completion.summary || task &&
    (task.resultSummary || task.resolutionSummary) || execution &&
    (execution.resultSummary || execution.statusReason || execution.reason),
  "Control review completed.");
}

function projectControlPlane(options, contexts, leadProject) {
  var sessions = [];
  var results = [];
  var seenSessions = {};
  var seenResults = {};
  var tasks = controlTaskIndex(leadProject);
  for (var pi = 0; pi < contexts.length; pi++) {
    var project = contexts[pi];
    var status = projectStatus(project);
    var projectId = projectIdFor(project, status);
    if (!projectId || !canAccessProject(options, project)) continue;
    var list = sessionList(project);
    for (var si = 0; si < list.length; si++) {
      var session = list[si];
      var execution = sessionExecutionBinding(session);
      if (!execution || execution.mode !== "project_coordinator") continue;
      var ref = projectIdentity.sessionRef({ projectId: projectId }, session);
      var key = sessionRefKey(ref);
      var taskEntry = tasks[key] || null;
      var task = taskEntry && taskEntry.task || null;
      var role = coopControlRole.forSession(session, task, execution);
      if (!coopControlRole.isPeer(role) || !ref) continue;
      var lifecycleStatus = executionStatus(session, task, execution);
      var topicRef = normalizeTopicRef(execution.coopTopicRef || task && task.coopTopicRef);
      var updatedAt = session.lastActivity || execution.updatedAt || task && task.updatedAt || null;
      if (!session.hidden && (ACTIVE_STATUSES[lifecycleStatus] ||
          ATTENTION_STATUSES[lifecycleStatus]) && canAccessSession(options, project, session, false) &&
          !seenSessions[key]) {
        seenSessions[key] = true;
        sessions.push({
          role: role,
          title: cleanText(session.title, role === "council" ? "Council" : "Triage"),
          sessionRef: ref,
          status: lifecycleStatus,
          activity: cleanText(execution.currentActivity || session.currentActivity ||
            task && task.currentActivity, lifecycleStatus === "needs_input" ?
            "Needs owner input" : ""),
          processing: lifecycleStatus === "running" && session.isProcessing === true,
          topicRef: topicRef,
          updatedAt: updatedAt,
        });
      }
      var completion = session.orchestrationProjectCompletion;
      var terminalResult = lifecycleStatus === "completed" ||
        (session.hidden && lifecycleStatus === "failed");
      if (!terminalResult || !canAccessSession(options, project, session, true) ||
          seenResults[key]) continue;
      seenResults[key] = true;
      results.push({
        role: role,
        title: cleanText(session.title, role === "council" ? "Council result" : "Triage result"),
        status: lifecycleStatus,
        summary: resultSummary(session, task, execution),
        verification: cleanText(completion && completion.verification, ""),
        completedAt: completion && completion.completedAt || execution.completedAt || updatedAt,
        topicRef: topicRef,
        executionRef: ref,
        containerSessionRef: projectIdentity.normalizeSessionRef(session.projectCoordinatorRef ||
          taskEntry && taskEntry.rootRef),
      });
    }
  }
  function sortControlItems(a, b) {
    var rank = { council: 0, triage: 1 };
    return rank[a.role] - rank[b.role] || (b.updatedAt || b.completedAt || 0) -
      (a.updatedAt || a.completedAt || 0);
  }
  sessions.sort(sortControlItems);
  results.sort(sortControlItems);
  return { sessions: sessions, results: results };
}

function attachResults(topics, results) {
  var byTopic = {};
  for (var i = 0; i < results.length; i++) {
    var ref = normalizeTopicRef(results[i] && results[i].topicRef);
    if (!ref) continue;
    if (!byTopic[ref.topicId]) byTopic[ref.topicId] = [];
    byTopic[ref.topicId].push(results[i]);
  }
  for (var ti = 0; ti < topics.length; ti++) {
    var topicRef = normalizeTopicRef(topics[ti] && topics[ti].topicRef);
    topics[ti].controlResults = topicRef && byTopic[topicRef.topicId] || [];
  }
  return topics;
}

module.exports = {
  attachResults: attachResults,
  projectControlPlane: projectControlPlane,
};
