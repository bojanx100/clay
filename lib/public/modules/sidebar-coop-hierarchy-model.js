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

function cloneCoordinatorNode(node, depth) {
  var value = node || {};
  if (depth > 0 && !visibleCoopTaskCoordinator(value)) return null;
  return {
    sessionRef: value.sessionRef || null,
    title: safeText(value.title, "Project work"),
    role: safeText(value.role, "worker"),
    status: safeText(value.status, "queued"),
    activity: safeText(value.activity, ""),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
    children: (depth === 0 ? safeArray(value.children) : []).map(function (child) {
      return cloneCoordinatorNode(child, depth + 1);
    }).filter(Boolean),
  };
}

export function cloneCoopProjectHierarchy(value) {
  return safeArray(value).map(function (node) {
    return cloneCoordinatorNode(node, 0);
  }).filter(function (node) {
    return !!(node && node.role === "project_coordinator" && node.sessionRef);
  }).slice(0, 1);
}
