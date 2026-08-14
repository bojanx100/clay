// Canonical project coordinator hierarchy for the global Coop sidebar.
//
// The projection is deliberately exact: every descendant must be the current
// worker bound by its direct parent's durable TaskRef. Parent metadata alone
// is not enough because historical attempts can retain the same task id.

var projectIdentity = require("./project-identity");
var coopControlProvenance = require("./coop-control-provenance");
var isCoopControlled = coopControlProvenance.isCoopControlled;
var normalizeControlledBy = coopControlProvenance.normalizeControlledBy;

var ACTIVE_STATUSES = { queued: true, ready: true, running: true, reviewing: true };
var ATTENTION_STATUSES = { blocked: true, failed: true, needs_input: true, waiting_user: true };
var MAX_DEPTH = 2;
var MAX_WORKERS_PER_TASK = 24;

function attachGlobalCoopCoordinatorTree(ctx) {
  var canAccessSession = ctx.canAccessSession;
  var cleanText = ctx.cleanText;
  var sessionList = ctx.sessionList;

  function sessionStorageId(session) {
    return session && (session.storageId || session.cliSessionId) || null;
  }

  function directParent(session) {
    return session && session.orchestrationParent || null;
  }

  function directParentStorageId(session) {
    var parent = directParent(session);
    return parent && parent.sessionStorageId || null;
  }

  function hasAnyParent(session) {
    return !!(session && (session.orchestrationGroupParent || session.orchestrationParent));
  }

  function taskForChild(session, parents, tasksByParent, projectId) {
    var parentId = directParentStorageId(session);
    var parent = parents.get(parentId);
    var ownership = directParent(session);
    if (!parent || !ownership || !ownership.taskId) return null;
    var tasks = tasksByParent.get(parentId);
    var task = tasks && tasks.get(ownership.taskId);
    if (!task) return null;

    var storageId = sessionStorageId(session);
    var hasWorkerStorageId = Object.prototype.hasOwnProperty.call(task, "workerStorageId");
    var hasLegacyStorageId = Object.prototype.hasOwnProperty.call(task, "workerSessionStorageId");
    var boundStorageId = typeof task.workerStorageId === "string" && task.workerStorageId
      ? task.workerStorageId
      : (typeof task.workerSessionStorageId === "string" && task.workerSessionStorageId
        ? task.workerSessionStorageId : null);
    var exactWorker = hasWorkerStorageId || hasLegacyStorageId
      ? !!boundStorageId && boundStorageId === storageId
      : Number.isInteger(task.workerSessionId) && Number.isInteger(session.localId) &&
        task.workerSessionId === session.localId;
    if (!exactWorker) return null;
    var taskRef = projectIdentity.taskRef({ projectId: projectId }, parent, task);
    if (!taskRef) return null;
    return { parent: parent, task: task, taskRef: taskRef };
  }

  function visibleDescendant(session, binding, depth) {
    if (!binding || !isCoopControlled(session) || depth < 1 || depth > MAX_DEPTH) return false;
    var parentControl = normalizeControlledBy(binding.parent && binding.parent.coopControlledBy);
    var childControl = normalizeControlledBy(session.coopControlledBy);
    if (!parentControl || !childControl ||
        parentControl.coopSessionStorageId !== childControl.coopSessionStorageId) return false;
    var status = cleanText(binding.task.status, "queued");
    if (!ACTIVE_STATUSES[status] && !ATTENTION_STATUSES[status]) return false;
    if (depth === 1) return session.coordinationRole === "task_coordinator";
    return !session.coordinationRole || session.coordinationRole === "worker";
  }

  function build(options, project, projectId) {
    var sessions = sessionList(project).filter(function (session) {
      return canAccessSession(options, project, session);
    });
    var byStorageId = new Map();
    var ambiguousStorageIds = new Set();
    var children = new Map();
    for (var i = 0; i < sessions.length; i++) {
      var storageId = sessionStorageId(sessions[i]);
      if (!storageId || ambiguousStorageIds.has(storageId)) continue;
      if (byStorageId.has(storageId)) {
        byStorageId.delete(storageId);
        ambiguousStorageIds.add(storageId);
      } else {
        byStorageId.set(storageId, sessions[i]);
      }
    }
    for (var j = 0; j < sessions.length; j++) {
      var parentId = directParentStorageId(sessions[j]);
      if (!parentId || !byStorageId.has(parentId)) continue;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(sessions[j]);
    }
    var tasksByParent = new Map();
    byStorageId.forEach(function (session, storageId) {
      var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
      var byTaskId = new Map();
      for (var ti = 0; ti < tasks.length; ti++) {
        var taskId = tasks[ti] && tasks[ti].taskId;
        if (!taskId) continue;
        byTaskId.set(taskId, byTaskId.has(taskId) ? null : tasks[ti]);
      }
      tasksByParent.set(storageId, byTaskId);
    });

    function matchesCanonicalCoop(session) {
      if (!options.expectedCoopStorageId) return false;
      var controlledBy = normalizeControlledBy(session && session.coopControlledBy);
      return !!(controlledBy &&
        controlledBy.coopSessionStorageId === options.expectedCoopStorageId);
    }

    var projected = new Set();
    function nodeFor(session, depth, visited) {
      var storageId = sessionStorageId(session);
      if (!storageId || ambiguousStorageIds.has(storageId) || projected.has(storageId) ||
          visited.has(storageId) || depth > MAX_DEPTH) return null;
      var binding = depth === 0 ? null :
        taskForChild(session, byStorageId, tasksByParent, projectId);
      if (depth > 0 && !visibleDescendant(session, binding, depth)) return null;
      var sessionRef = projectIdentity.sessionRef({ projectId: projectId }, session);
      if (!sessionRef) return null;

      var nextVisited = new Set(visited);
      nextVisited.add(storageId);
      var childNodes = [];
      var childSessions = depth < MAX_DEPTH ? children.get(storageId) || [] : [];
      for (var ci = 0; ci < childSessions.length; ci++) {
        var child = nodeFor(childSessions[ci], depth + 1, nextVisited);
        if (child) childNodes.push(child);
      }
      childNodes.sort(function (a, b) {
        var aRank = ACTIVE_STATUSES[a.status] ? 0 : 1;
        var bRank = ACTIVE_STATUSES[b.status] ? 0 : 1;
        return aRank - bRank || (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      if (depth === 1 && childNodes.length > MAX_WORKERS_PER_TASK) {
        childNodes = childNodes.slice(0, MAX_WORKERS_PER_TASK);
      }
      projected.add(storageId);
      return {
        sessionRef: sessionRef,
        taskRef: binding ? binding.taskRef : null,
        title: cleanText(session.title, depth === 0 ? "Project coordinator" :
          (depth === 1 ? "Task coordinator" : "Worker session")),
        role: depth === 0 ? "project_coordinator" :
          (depth === 1 ? "task_coordinator" : "worker"),
        status: binding ? cleanText(binding.task.status, "queued") : "queued",
        activity: cleanText(session.currentActivity || binding && binding.task.currentActivity || "", ""),
        updatedAt: session.lastActivity || session.lastViewedAt ||
          binding && binding.task.updatedAt || null,
        children: childNodes,
      };
    }

    var eligibleRoots = [];
    for (var si = 0; si < sessions.length; si++) {
      if (hasAnyParent(sessions[si]) ||
          sessions[si].coordinationRole !== "project_coordinator" ||
          !isCoopControlled(sessions[si]) || !matchesCanonicalCoop(sessions[si])) continue;
      eligibleRoots.push(sessions[si]);
    }
    var roots = [];
    if (eligibleRoots.length === 1) {
      var node = nodeFor(eligibleRoots[0], 0, new Set());
      if (node) roots.push(node);
    }
    roots.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

    var taskCoordinatorCount = 0;
    var workerCount = 0;
    function countDescendants(node) {
      var nodes = node && Array.isArray(node.children) ? node.children : [];
      for (var ni = 0; ni < nodes.length; ni++) {
        if (nodes[ni].role === "task_coordinator") taskCoordinatorCount++;
        if (nodes[ni].role === "worker") workerCount++;
        countDescendants(nodes[ni]);
      }
    }
    for (var ri = 0; ri < roots.length; ri++) countDescendants(roots[ri]);
    return {
      coordinators: roots,
      taskCoordinatorCount: taskCoordinatorCount,
      workerCount: workerCount,
    };
  }

  return { build: build };
}

module.exports = {
  attachGlobalCoopCoordinatorTree: attachGlobalCoopCoordinatorTree,
};
