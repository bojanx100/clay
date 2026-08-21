// Canonical project coordinator hierarchy for the global Coop sidebar.
//
// The projection is deliberately exact: every descendant must be the current
// worker bound by its direct parent's durable TaskRef. Parent metadata alone
// is not enough because historical attempts can retain the same task id.

var projectIdentity = require("./project-identity");
var coopControlProvenance = require("./coop-control-provenance");
var isCoopControlled = coopControlProvenance.isCoopControlled;
var normalizeControlledBy = coopControlProvenance.normalizeControlledBy;
var controlPlane = require("./coop-control-plane");
var controlRole = require("./coop-control-role");

var ACTIVE_STATUSES = { queued: true, ready: true, running: true, reviewing: true };
var ATTENTION_STATUSES = { blocked: true, failed: true, needs_input: true, waiting_user: true };
var RESOLVED_TASK_STATUSES = { completed: true, dismissed: true, cancelled: true };
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
    if (!ACTIVE_STATUSES[status] && !ATTENTION_STATUSES[status] &&
        !RESOLVED_TASK_STATUSES[status]) return false;
    if (depth === 1) return session.coordinationRole === "task_coordinator";
    return !session.coordinationRole || session.coordinationRole === "worker";
  }

  function sameSessionRef(left, right) {
    var a = projectIdentity.normalizeSessionRef(left);
    var b = projectIdentity.normalizeSessionRef(right);
    return !!(a && b && a.projectId === b.projectId &&
      a.sessionStorageId === b.sessionStorageId);
  }

  function dependencyRefs(parent, task, projectId) {
    var dependencies = Array.isArray(task && task.dependencies) ? task.dependencies : [];
    var refs = [];
    for (var i = 0; i < dependencies.length; i++) {
      var dependency = taskGraphTask(parent, dependencies[i]);
      var ref = dependency && projectIdentity.taskRef({ projectId: projectId }, parent, dependency);
      if (ref) refs.push(ref);
    }
    return refs;
  }

  function taskGraphTask(parent, taskId) {
    var tasks = Array.isArray(parent && parent.orchestrationTasks) ? parent.orchestrationTasks : [];
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i] && tasks[i].taskId === taskId) return tasks[i];
    }
    return null;
  }

  function dependencyState(task) {
    var dependencies = Array.isArray(task && task.dependencies) ? task.dependencies : [];
    if (!dependencies.length) return "independent";
    return task.status === "queued" ? "waiting" : "ready";
  }

  function isLiveStatus(status) {
    return !!(ACTIVE_STATUSES[status] || ATTENTION_STATUSES[status]);
  }

  function isVisibleStatus(status) {
    return isLiveStatus(status) || !!RESOLVED_TASK_STATUSES[status];
  }

  function typedExecution(session) {
    var execution = session && session.orchestrationPolicy &&
      session.orchestrationPolicy.portfolioExecution;
    if (!execution || execution.mode !== "project_coordinator" || !projectIdentity.isTaskId(execution.portfolioTaskId) ||
        !Number.isInteger(execution.bindingRevision) || execution.bindingRevision < 1 ||
        !projectIdentity.isTaskId(execution.idempotencyKey)) return null;
    return execution;
  }

  function bindingBuckets(bindings) {
    var buckets = {};
    var list = Array.isArray(bindings) ? bindings : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || !projectIdentity.isTaskId(item.portfolioTaskId)) continue;
      if (!buckets[item.portfolioTaskId]) buckets[item.portfolioTaskId] = [];
      buckets[item.portfolioTaskId].push(item);
    }
    return buckets;
  }

  function hasNewerCommittedTypedBinding(child, projectId, buckets) {
    var execution = typedExecution(child);
    if (!execution || execution.status !== "failed") return false;
    var childRef = projectIdentity.sessionRef({ projectId: projectId }, child);
    var candidates = buckets[execution.portfolioTaskId] || [];
    var exactFailed = false;
    var newerCommitted = false;
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var target = projectIdentity.normalizeProjectRef(candidate.targetProject);
      var coordinator = projectIdentity.normalizeSessionRef(candidate.coordinator);
      if (!target || target.projectId !== projectId || candidate.mode !== execution.mode || !Number.isInteger(candidate.bindingRevision) || !projectIdentity.isTaskId(candidate.idempotencyKey)) {
        continue;
      }
      if (candidate.bindingRevision === execution.bindingRevision &&
          candidate.idempotencyKey === execution.idempotencyKey &&
          candidate.status === "failed" && sameSessionRef(coordinator, childRef)) exactFailed = true;
      if (candidate.bindingRevision > execution.bindingRevision && coordinator &&
          candidate.status !== "pending" && candidate.status !== "unrouted") {
        newerCommitted = true;
      }
    }
    return exactFailed && newerCommitted;
  }

  function effectiveTaskStatus(task, child, projectId, buckets) {
    var taskStatus = cleanText(task && task.status, "queued");
    // The parent task is the authoritative disposition. A failed child binding
    // remains immutable audit evidence after the coordinator dismisses or
    // completes that task, but it must not reopen a closed sidebar row.
    if (RESOLVED_TASK_STATUSES[taskStatus]) return taskStatus;
    var execution = child && child.orchestrationPolicy && child.orchestrationPolicy.portfolioExecution;
    var childStatus = cleanText(execution && execution.status, "");
    if (childStatus === "failed" && hasNewerCommittedTypedBinding(child, projectId, buckets)) {
      return "superseded";
    }
    if (ATTENTION_STATUSES[childStatus] || childStatus === "completed") return childStatus;
    return taskStatus;
  }

  function sessionMaps(sessions) {
    var byStorageId = new Map();
    var tasksByParent = new Map();
    for (var i = 0; i < sessions.length; i++) {
      var id = sessionStorageId(sessions[i]);
      if (id && !byStorageId.has(id)) byStorageId.set(id, sessions[i]);
    }
    byStorageId.forEach(function (session, storageId) {
      var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
      var byTaskId = new Map();
      for (var ti = 0; ti < tasks.length; ti++) {
        if (tasks[ti] && tasks[ti].taskId) byTaskId.set(tasks[ti].taskId, tasks[ti]);
      }
      tasksByParent.set(storageId, byTaskId);
    });
    return { byStorageId: byStorageId, tasksByParent: tasksByParent };
  }

  function workerNodes(options, project, projectId, sessions, child, maps) {
    var nodes = [];
    for (var i = 0; i < sessions.length; i++) {
      var candidate = sessions[i];
      if (candidate.hidden) continue;
      if (directParentStorageId(candidate) !== sessionStorageId(child)) continue;
      var binding = taskForChild(candidate, maps.byStorageId, maps.tasksByParent, projectId);
      if (!binding || !isCoopControlled(candidate)) continue;
      var status = cleanText(binding.task.status, "queued");
      if (!isVisibleStatus(status)) continue;
      var ref = projectIdentity.sessionRef({ projectId: projectId }, candidate);
      if (!ref || !canAccessSession(options, project, candidate)) continue;
      nodes.push({
        sessionRef: ref,
        taskRef: binding.taskRef,
        title: cleanText(candidate.title, "Worker session"),
        role: "worker",
        status: status,
        activity: cleanText(candidate.currentActivity || binding.task.currentActivity || "", ""),
        updatedAt: candidate.lastActivity || candidate.lastViewedAt || binding.task.updatedAt || null,
        dependencies: dependencyRefs(binding.parent, binding.task, projectId),
        dependencyState: dependencyState(binding.task),
        children: [],
      });
    }
    nodes.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return nodes.slice(0, MAX_WORKERS_PER_TASK);
  }

  function handedOffThreads(options, projectId) {
    var threads = Array.isArray(options && options.coopThreads) ? options.coopThreads : [];
    return threads.filter(function (thread) {
      if (!thread || thread.threadState !== "handed_off" || !thread.topicRef) return false;
      var refs = Array.isArray(thread.executionProjectRefs) ? thread.executionProjectRefs : [];
      for (var i = 0; i < refs.length; i++) {
        if (refs[i] && refs[i].projectId === projectId) return true;
      }
      return thread.projectRef && thread.projectRef.projectId === projectId;
    });
  }

  function threadStatus(thread, children) {
    var attention = null;
    var active = false;
    for (var i = 0; i < children.length; i++) {
      var status = children[i] && children[i].status;
      if (!attention && ATTENTION_STATUSES[status]) attention = status;
      if (ACTIVE_STATUSES[status]) active = true;
    }
    if (attention) return attention;
    if (active) return "running";
    if (thread && thread.workState === "done") return "completed";
    return "handed_off";
  }

  function threadNode(thread, children) {
    var updatedAt = thread.updatedAt || null;
    for (var i = 0; i < children.length; i++) {
      updatedAt = Math.max(updatedAt || 0, children[i].updatedAt || 0) || null;
    }
    return {
      sessionRef: null,
      taskRef: null,
      topicRef: thread.topicRef,
      threadRef: thread.threadRef || { threadId: thread.topicRef.topicId },
      projectRef: thread.projectRef,
      title: cleanText(thread.title, "Handed-off Thread"),
      role: "thread",
      status: threadStatus(thread, children),
      threadState: "handed_off",
      workState: cleanText(thread.workState, ""),
      activity: cleanText(thread.currentActivity, ""),
      controlResults: Array.isArray(thread.controlResults) ? thread.controlResults : [],
      updatedAt: updatedAt,
      dependencies: [],
      dependencyState: "container",
      children: children,
    };
  }

  function buildControlPlane(options, leadProject, project, projectId) {
    if (!leadProject) return null;
    var leadSessions = sessionList(leadProject);
    var targetSessions = sessionList(project).filter(function (session) {
      return canAccessSession(options, project, session);
    });
    var root = null;
    for (var i = 0; i < leadSessions.length; i++) {
      var policy = controlPlane.projectCoordinatorPolicy(leadSessions[i]);
      var control = normalizeControlledBy(leadSessions[i] && leadSessions[i].coopControlledBy);
      if (!policy || !policy.projectRef || policy.projectRef.projectId !== projectId ||
          !control || control.coopSessionStorageId !== options.expectedCoopStorageId ||
          !canAccessSession(options, leadProject, leadSessions[i])) continue;
      if (root) return {
        coordinators: [],
        activeCoordinatorCount: 0,
        taskCoordinatorCount: 0,
        workerCount: 0,
      };
      root = leadSessions[i];
    }
    if (!root) return null;
    var rootRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root);
    var maps = sessionMaps(targetSessions);
    var durableBindings = bindingBuckets(options && options.portfolioBindings);
    var tasks = Array.isArray(root.orchestrationTasks) ? root.orchestrationTasks : [];
    var taskEntries = [];
    var taskCoordinatorCount = 0;
    var workerCount = 0;
    for (var ti = 0; ti < tasks.length; ti++) {
      var task = tasks[ti] || {};
      if (!task.externalTaskCoordinator) continue;
      var childRef = projectIdentity.normalizeSessionRef(task.workerSessionRef || {
        projectId: projectId,
        sessionStorageId: task.workerStorageId,
      });
      var child = childRef && childRef.projectId === projectId &&
        maps.byStorageId.get(childRef.sessionStorageId);
      if (!child || child.coordinationRole !== "task_coordinator" ||
          child.hidden || !sameSessionRef(child.projectCoordinatorRef, rootRef)) continue;
      if (controlRole.isPeer(controlRole.forSession(child, task, null))) continue;
      var status = effectiveTaskStatus(task, child, projectId, durableBindings);
      if (status === "dismissed" && task.archivedAt &&
          typeof options.reconcileDismissedSession === "function") {
        options.reconcileDismissedSession(project, child, task);
      }
      if (child.hidden) continue;
      if (!isVisibleStatus(status)) continue;
      var workers = workerNodes(options, project, projectId, targetSessions, child, maps);
      if (isLiveStatus(status)) taskCoordinatorCount += 1;
      for (var wi = 0; wi < workers.length; wi++) {
        if (isLiveStatus(workers[wi].status)) workerCount += 1;
      }
      taskEntries.push({ task: task, node: {
        sessionRef: childRef,
        taskRef: projectIdentity.taskRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root, task),
        title: cleanText(child.title || task.title, "Task coordinator"),
        role: "task_coordinator",
        status: status,
        activity: cleanText(child.currentActivity || task.currentActivity || "", ""),
        updatedAt: child.lastActivity || child.lastViewedAt || task.updatedAt || null,
        dependencies: dependencyRefs(root, task, projectIdentity.LEAD_PROJECT_ID),
        dependencyState: dependencyState(task),
        children: workers,
      } });
    }
    var grouped = {};
    var unlinked = [];
    for (var ei = 0; ei < taskEntries.length; ei++) {
      var topicId = taskEntries[ei].task.coopTopicRef && taskEntries[ei].task.coopTopicRef.topicId;
      if (!topicId) unlinked.push(taskEntries[ei].node);
      else {
        if (!grouped[topicId]) grouped[topicId] = [];
        grouped[topicId].push(taskEntries[ei].node);
      }
    }
    var children = [];
    var threads = handedOffThreads(options, projectId);
    var projectedThreads = {};
    for (var hi = 0; hi < threads.length; hi++) {
      var id = threads[hi].topicRef.topicId;
      var threadChildren = grouped[id] || [];
      threadChildren.sort(function (a, b) {
        var aRank = ACTIVE_STATUSES[a.status] ? 0 : 1;
        var bRank = ACTIVE_STATUSES[b.status] ? 0 : 1;
        return aRank - bRank || (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      children.push(threadNode(threads[hi], threadChildren));
      projectedThreads[id] = true;
    }
    var groupedIds = Object.keys(grouped);
    for (var gi = 0; gi < groupedIds.length; gi++) {
      if (!projectedThreads[groupedIds[gi]]) unlinked = unlinked.concat(grouped[groupedIds[gi]]);
    }
    children = children.concat(unlinked);
    children.sort(function (a, b) {
      var aRank = ACTIVE_STATUSES[a.status] ? 0 : 1;
      var bRank = ACTIVE_STATUSES[b.status] ? 0 : 1;
      return aRank - bRank || (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return {
      coordinators: [{
        sessionRef: rootRef,
        taskRef: null,
        title: cleanText(root.title, "Project coordinator"),
        role: "project_coordinator",
        status: "persistent",
        activity: "",
        updatedAt: root.lastActivity || root.lastViewedAt || null,
        children: children,
      }],
      activeCoordinatorCount: taskCoordinatorCount > 0 ? 1 : 0,
      taskCoordinatorCount: taskCoordinatorCount,
      workerCount: workerCount,
    };
  }

  function build(options, project, projectId) {
    var controlPlaneTree = buildControlPlane(options, options.leadProject, project, projectId);
    if (controlPlaneTree) return controlPlaneTree;
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
      if (!storageId || session.hidden || ambiguousStorageIds.has(storageId) || projected.has(storageId) ||
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

    var activeCoordinatorCount = 0;
    var taskCoordinatorCount = 0;
    var workerCount = 0;
    function countDescendants(node) {
      var nodes = node && Array.isArray(node.children) ? node.children : [];
      for (var ni = 0; ni < nodes.length; ni++) {
        if (nodes[ni].role === "task_coordinator" && isLiveStatus(nodes[ni].status)) {
          taskCoordinatorCount++;
          activeCoordinatorCount = 1;
        }
        if (nodes[ni].role === "worker" && isLiveStatus(nodes[ni].status)) workerCount++;
        countDescendants(nodes[ni]);
      }
    }
    for (var ri = 0; ri < roots.length; ri++) countDescendants(roots[ri]);
    return {
      coordinators: roots,
      activeCoordinatorCount: activeCoordinatorCount,
      taskCoordinatorCount: taskCoordinatorCount,
      workerCount: workerCount,
    };
  }

  return { build: build };
}

module.exports = {
  attachGlobalCoopCoordinatorTree: attachGlobalCoopCoordinatorTree,
};
