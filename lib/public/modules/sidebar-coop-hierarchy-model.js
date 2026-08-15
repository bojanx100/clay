// Pure, bounded normalization for the canonical project hierarchy carried by
// the global Coop projection.

var ATTENTION_STATUSES = {
  blocked: true, failed: true, needs_input: true, waiting_user: true,
};
var ACTIVE_STATUSES = {
  queued: true, ready: true, running: true, reviewing: true,
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback) {
  var text = typeof value === "string" ? value.trim() : "";
  return text || fallback || "";
}

export function visibleCoopTaskCoordinator(node) {
  var status = safeText(node && node.status, "queued");
  return !!(node && node.role === "task_coordinator" &&
    (ACTIVE_STATUSES[status] || ATTENTION_STATUSES[status]));
}

export function visibleCoopThread(node) {
  var status = safeText(node && node.status, "handed_off");
  return !!(node && node.role === "thread" && node.topicRef &&
    (status === "handed_off" || status === "completed" ||
      ACTIVE_STATUSES[status] || ATTENTION_STATUSES[status]));
}

export function visibleCoopWorker(node) {
  var status = safeText(node && node.status, "queued");
  return !!(node && node.role === "worker" &&
    (ACTIVE_STATUSES[status] || ATTENTION_STATUSES[status]));
}

function cloneTaskRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.projectId !== "string" ||
      typeof value.coordinatorSessionStorageId !== "string" ||
      typeof value.taskId !== "string") return null;
  return {
    projectId: value.projectId,
    coordinatorSessionStorageId: value.coordinatorSessionStorageId,
    taskId: value.taskId,
  };
}

function cloneTopicRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.topicId !== "string" || !value.topicId) return null;
  return { topicId: value.topicId };
}

function cloneProjectRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.projectId !== "string" || !value.projectId) return null;
  return { projectId: value.projectId };
}

function visibleNode(value, depth, parentRole) {
  if (depth === 0) return value.role === "project_coordinator" && !!value.sessionRef;
  if (value.role === "thread") return depth === 1 && visibleCoopThread(value);
  if (value.role === "task_coordinator") {
    return (depth === 1 && parentRole === "project_coordinator" ||
      depth === 2 && parentRole === "thread") && visibleCoopTaskCoordinator(value);
  }
  return value.role === "worker" &&
    (depth === 2 && parentRole === "task_coordinator" ||
      depth === 3 && parentRole === "task_coordinator") && visibleCoopWorker(value);
}

function cloneCoordinatorNode(node, depth, parentRole) {
  var value = node || {};
  if (depth > 3 || !visibleNode(value, depth, parentRole)) return null;
  return {
    sessionRef: value.sessionRef || null,
    taskRef: cloneTaskRef(value.taskRef),
    topicRef: cloneTopicRef(value.topicRef),
    threadRef: value.threadRef && typeof value.threadRef.threadId === "string"
      ? { threadId: value.threadRef.threadId } : null,
    projectRef: cloneProjectRef(value.projectRef),
    title: safeText(value.title, "Project work"),
    role: safeText(value.role, "worker"),
    status: safeText(value.status, "queued"),
    threadState: safeText(value.threadState, ""),
    workState: safeText(value.workState, ""),
    activity: safeText(value.activity, ""),
    dependencyState: safeText(value.dependencyState, ""),
    dependencies: safeArray(value.dependencies).map(cloneTaskRef).filter(Boolean),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
    children: (depth < 3 ? safeArray(value.children) : []).map(function (child) {
      return cloneCoordinatorNode(child, depth + 1, value.role);
    }).filter(Boolean),
  };
}

export function cloneCoopProjectHierarchy(value) {
  return safeArray(value).map(function (node) {
    return cloneCoordinatorNode(node, 0, "");
  }).filter(function (node) {
    return !!(node && node.role === "project_coordinator" && node.sessionRef);
  }).slice(0, 1);
}
