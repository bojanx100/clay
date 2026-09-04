var projectIdentity = require("./project-identity");
var coopControlPlane = require("./coop-control-plane");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;
var coopControlRole = require("./coop-control-role");
var sessionExecutionBinding = require("./portfolio-execution-bindings").sessionExecutionBinding;
var normalizeTopicRef = require("./coop-topic-ref").normalizeTopicRefInput;
var workIdentity = require("./coop-owner-work-identity");

var ACTIVE_STATUSES = { queued: true, ready: true, running: true, reviewing: true };
var ATTENTION_STATUSES = { blocked: true, failed: true, needs_input: true, waiting_user: true };
var RETAINED_TERMINAL_STATUSES = { completed: true, dismissed: true, cancelled: true, failed: true };
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
  var manager = sessionManager(project);
  var sessions = manager && manager.sessions;
  var list = [];
  if (sessions && typeof sessions.forEach === "function") {
    sessions.forEach(function (session) { list.push(session); });
  }
  return list;
}

function sessionManager(project) {
  return project && typeof project.getSessionManager === "function" ?
    project.getSessionManager() : project && project.sm;
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

function sameSessionRef(left, right) {
  var a = projectIdentity.normalizeSessionRef(left);
  var b = projectIdentity.normalizeSessionRef(right);
  return !!(a && b && a.projectId === b.projectId &&
    a.sessionStorageId === b.sessionStorageId);
}

function controlTaskIndex(leadProject) {
  var result = {};
  var manager = sessionManager(leadProject);
  var canonicalCoop = coopControlPlane.canonicalCoop(manager);
  var canonicalCoopStorageId = projectIdentity.sessionStorageId(canonicalCoop);
  if (!canonicalCoopStorageId) return result;
  var sessions = sessionList(leadProject);
  for (var i = 0; i < sessions.length; i++) {
    var root = sessions[i];
    var rootRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root);
    var policy = coopControlPlane.projectCoordinatorPolicy(root);
    var projectRef = projectIdentity.normalizeProjectRef(policy && policy.projectRef);
    var rootControl = normalizeControlledBy(root && root.coopControlledBy);
    if (!rootRef || root && root._deleted || !policy ||
        policy.version !== coopControlPlane.CONTROL_PLANE_VERSION || !projectRef ||
        !rootControl || rootControl.coopSessionStorageId !== canonicalCoopStorageId) continue;
    var tasks = Array.isArray(root && root.orchestrationTasks) ? root.orchestrationTasks : [];
    for (var ti = 0; ti < tasks.length; ti++) {
      var task = tasks[ti] || {};
      if (!task.externalTaskCoordinator) continue;
      var ref = projectIdentity.normalizeSessionRef(task.workerSessionRef);
      if (!ref || ref.projectId !== projectRef.projectId) continue;
      var key = sessionRefKey(ref);
      if (key && !result[key]) result[key] = { task: task, rootRef: rootRef };
    }
  }
  return result;
}

function archivedActiveStatus(session, status) {
  // A persisted role session can remain marked running after it was archived
  // or closed.  Its terminal container is stronger evidence than that stale
  // activity bit, but absent a durable outcome we say dismissed rather than
  // inventing a successful review.
  if (!session || !ACTIVE_STATUSES[status]) return "";
  return session.hidden || session.closedAt || session._deleted ? "dismissed" : "";
}

function executionStatus(session, task, execution) {
  var completion = session && session.orchestrationProjectCompletion;
  if (completion && completion.status === "completed") return "completed";
  var status = cleanText(execution && execution.status || task && task.status, "");
  if (status === "active") status = "running";
  var archived = archivedActiveStatus(session, status);
  if (archived) return archived;
  if (status) return status;
  return session && session.isProcessing ? "running" : "idle";
}

function resultSummary(session, task, execution) {
  var completion = session && session.orchestrationProjectCompletion;
  return cleanText(completion && completion.summary || task &&
    (task.resultSummary || task.resolutionSummary) || execution &&
    (execution.resultSummary || execution.statusReason || execution.reason),
  "No durable review outcome was recorded.");
}

function roleFallback(role) {
  return role === "council" ? "Council review context unavailable" :
    "Triage evidence context unavailable";
}

function meaningfulTitle(value) {
  var result = cleanText(value, "");
  if (!result || /^(council|triage)(?:\s+(?:result|review))?$/i.test(result)) return "";
  return result;
}

function topicIndex(options) {
  var result = {};
  var topics = Array.isArray(options && options.coopThreads) ? options.coopThreads : [];
  for (var i = 0; i < topics.length; i++) {
    var ref = normalizeTopicRef(topics[i] && topics[i].topicRef);
    if (ref && !result[ref.topicId]) result[ref.topicId] = topics[i];
  }
  return result;
}

function projectTitle(project) {
  var status = projectStatus(project);
  return cleanText(status.title || status.project || project && project.project, "Project");
}

function controlTopic(task, execution, topics) {
  var topicRef = normalizeTopicRef(execution.coopTopicRef || task && task.coopTopicRef);
  var topic = topicRef && topics[topicRef.topicId] || {};
  return { topicRef: topicRef, title: meaningfulTitle(topic.title) };
}

function controlTaskRef(task, taskEntry) {
  if (!task || !task.taskId || !taskEntry || !taskEntry.rootRef) return null;
  return {
    projectId: taskEntry.rootRef.projectId,
    coordinatorSessionStorageId: taskEntry.rootRef.sessionStorageId,
    taskId: task.taskId,
  };
}

function controlIdentity(projectRef, task, execution, topicRef) {
  var portfolioTaskId = cleanText(execution.portfolioTaskId || task &&
    task.portfolioTaskId || task && task.taskId, "");
  return workIdentity.canonicalKey({ projectRef: projectRef,
    portfolioTaskId: portfolioTaskId, topicRef: topicRef });
}

function controlContext(role, project, session, task, execution, taskEntry, topics) {
  var topic = controlTopic(task, execution, topics);
  var taskTitle = meaningfulTitle(task && task.title);
  var question = meaningfulTitle(task && (task.userQuestion || task.objective));
  var sessionTitle = meaningfulTitle(session && session.title);
  var projectRef = { projectId: projectIdFor(project, projectStatus(project)) };
  return {
    canonicalKey: controlIdentity(projectRef, task, execution, topic.topicRef),
    projectRef: projectRef,
    projectTitle: projectTitle(project),
    topicRef: topic.topicRef,
    topicTitle: topic.title,
    question: question || topic.title || "",
    title: taskTitle || topic.title || sessionTitle || roleFallback(role),
    taskRef: controlTaskRef(task, taskEntry),
    containerSessionRef: taskEntry && taskEntry.rootRef || null,
  };
}

function itemRank(item) {
  var rank = { failed: 7, blocked: 6, needs_input: 5, waiting_user: 5,
    running: 4, reviewing: 3, queued: 2, ready: 2, completed: 1, dismissed: 0 };
  return rank[item && item.status] || -1;
}

function addReference(list, ref) {
  if (!ref || !ref.projectId || !ref.sessionStorageId) return;
  var key = sessionRefKey(ref);
  for (var i = 0; i < list.length; i++) if (sessionRefKey(list[i]) === key) return;
  list.push(ref);
}

function controlMergeKey(item) {
  return item.role + ":" + (item.canonicalKey ||
    sessionRefKey(item.executionRef || item.sessionRef));
}

function controlItemTime(item) {
  return item.updatedAt || item.completedAt || 0;
}

function mergedControlItem(current, item) {
  var winner = controlItemTime(item) > controlItemTime(current) ||
    controlItemTime(item) === controlItemTime(current) && itemRank(item) > itemRank(current) ?
    item : current;
  var loser = winner === item ? current : item;
  var refs = (winner.sessionRefs || []).slice();
  addReference(refs, winner.executionRef || winner.sessionRef);
  addReference(refs, loser.executionRef || loser.sessionRef);
  winner.sessionRefs = refs;
  return winner;
}

function mergeControlItems(items) {
  var byKey = {};
  var order = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var key = controlMergeKey(item);
    if (!key || key === item.role + ":") continue;
    var current = byKey[key];
    if (!current) {
      byKey[key] = item;
      order.push(key);
      continue;
    }
    byKey[key] = mergedControlItem(current, item);
  }
  return order.map(function (key) { return byKey[key]; });
}

function projectControlPlane(options, contexts, leadProject) {
  var sessions = [];
  var results = [];
  var seenSessions = {};
  var seenResults = {};
  var tasks = controlTaskIndex(leadProject);
  var topics = topicIndex(options);
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
      var controlledBy = normalizeControlledBy(session && session.coopControlledBy);
      if (!taskEntry || session.coordinationRole !== "task_coordinator" || !controlledBy ||
          controlledBy.coopSessionStorageId !== taskEntry.rootRef.sessionStorageId ||
          !sameSessionRef(session.projectCoordinatorRef, taskEntry.rootRef)) continue;
      var role = coopControlRole.forSession(session, task, execution);
      if (!coopControlRole.isPeer(role) || !ref) continue;
      var lifecycleStatus = executionStatus(session, task, execution);
      var context = controlContext(role, project, session, task, execution, taskEntry, topics);
      var topicRef = context.topicRef;
      var updatedAt = session.lastActivity || execution.updatedAt || task && task.updatedAt || null;
      if (!session.hidden && (ACTIVE_STATUSES[lifecycleStatus] ||
          ATTENTION_STATUSES[lifecycleStatus]) && canAccessSession(options, project, session, false) &&
          !seenSessions[key]) {
        seenSessions[key] = true;
        sessions.push({
          role: role,
          title: context.title,
          sessionRef: ref,
          status: lifecycleStatus,
          activity: cleanText(execution.currentActivity || session.currentActivity ||
            task && task.currentActivity, lifecycleStatus === "needs_input" ?
            "Needs owner input" : ""),
          processing: lifecycleStatus === "running" && session.isProcessing === true,
          topicRef: topicRef,
          projectRef: context.projectRef,
          projectTitle: context.projectTitle,
          topicTitle: context.topicTitle,
          question: context.question,
          taskRef: context.taskRef,
          containerSessionRef: context.containerSessionRef,
          canonicalKey: context.canonicalKey,
          updatedAt: updatedAt,
        });
      }
      var completion = session.orchestrationProjectCompletion;
      var terminalResult = RETAINED_TERMINAL_STATUSES[lifecycleStatus] ||
        (session.hidden && lifecycleStatus === "failed");
      if (!terminalResult || !canAccessSession(options, project, session, true) ||
          seenResults[key]) continue;
      seenResults[key] = true;
      results.push({
        role: role,
        title: context.title,
        status: lifecycleStatus,
        summary: resultSummary(session, task, execution),
        verification: cleanText(completion && completion.verification, ""),
        completedAt: completion && completion.completedAt || execution.completedAt || updatedAt,
        topicRef: topicRef,
        projectRef: context.projectRef,
        projectTitle: context.projectTitle,
        topicTitle: context.topicTitle,
        question: context.question,
        taskRef: context.taskRef,
        canonicalKey: context.canonicalKey,
        executionRef: ref,
        containerSessionRef: taskEntry.rootRef,
      });
    }
  }
  function sortControlItems(a, b) {
    var rank = { council: 0, triage: 1 };
    return rank[a.role] - rank[b.role] || (b.updatedAt || b.completedAt || 0) -
      (a.updatedAt || a.completedAt || 0);
  }
  sessions = mergeControlItems(sessions);
  results = mergeControlItems(results);
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
