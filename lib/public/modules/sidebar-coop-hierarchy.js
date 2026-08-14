// Persistent project coordinator hierarchy shown only inside canonical Coop.
// Exact SessionRefs stay in click closures and child navigation uses the
// server-authorized owner hierarchy scope.

import { requestCanonicalSession } from './global-coop-projection.js';
import {
  visibleCoopTaskCoordinator,
  visibleCoopWorker,
} from './sidebar-coop-hierarchy-model.js';

var ACTIVE_STATUSES = {
  queued: true, ready: true, running: true, reviewing: true,
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback) {
  var result = typeof value === "string" ? value.trim() : "";
  return result || fallback || "";
}

function statusClass(status) {
  return safeText(status, "queued").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

function statusLabel(node, depth) {
  if (depth === 0) return "Persistent";
  var status = safeText(node && node.status, "queued");
  if (status === "blocked") return "Blocked";
  if (status === "failed") return "Failed";
  if (status === "needs_input" || status === "waiting_user") return "Needs input";
  if (status === "reviewing") return "Reviewing";
  if (ACTIVE_STATUSES[status]) return "Working";
  return status.replace(/_/g, " ");
}

function depthClass(depth) {
  if (depth === 0) return "root";
  if (depth === 1) return "child";
  return "grandchild";
}

function visibleHierarchyNode(node, depth) {
  if (depth === 1) return visibleCoopTaskCoordinator(node);
  if (depth === 2) return visibleCoopWorker(node);
  return false;
}

function createHierarchyRow(node, depth, prefix, options) {
  var row = document.createElement("button");
  var label = statusLabel(node, depth);
  row.type = "button";
  row.className = prefix + "coop-project-coordinator-row " + prefix +
    "coop-project-coordinator-status-" + statusClass(node.status) +
    " " + depthClass(depth);
  row.setAttribute("aria-label", "Open " + safeText(node.title, "project coordinator") + ", " + label);

  var marker = document.createElement("span");
  marker.className = prefix + "coop-project-coordinator-marker";
  marker.setAttribute("aria-hidden", "true");
  marker.setAttribute("title", label);
  row.appendChild(marker);

  var title = document.createElement("span");
  title.className = prefix + "coop-project-coordinator-title";
  title.textContent = safeText(node.title, depth === 0 ? "Project coordinator" :
    (depth === 1 ? "Task coordinator" : "Worker session"));
  row.appendChild(title);

  var state = document.createElement("span");
  state.className = prefix + "coop-project-coordinator-state";
  state.textContent = label;
  row.appendChild(state);

  row.addEventListener("click", function () {
    if (!node.sessionRef || typeof options.send !== "function") return;
    var scope = depth > 0 ? "owner_request_hierarchy" : null;
    if (!requestCanonicalSession(node.sessionRef, options.send, scope)) return;
    if (typeof options.onNavigate === "function") options.onNavigate();
  });
  return row;
}

function createHierarchyNode(node, depth, prefix, options) {
  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-project-coordinator-node " + depthClass(depth);
  wrapper.appendChild(createHierarchyRow(node, depth, prefix, options));
  var nextDepth = depth + 1;
  var children = depth < 2 ? safeArray(node.children).filter(function (child) {
    return visibleHierarchyNode(child, nextDepth);
  }) : [];
  if (children.length > 0) {
    var childList = document.createElement("div");
    childList.className = prefix + "coop-project-coordinator-children";
    for (var i = 0; i < children.length; i++) {
      childList.appendChild(createHierarchyNode(children[i], depth + 1, prefix, options));
    }
    wrapper.appendChild(childList);
  }
  return wrapper;
}

export function renderCoopProjectHierarchy(container, nodes, options) {
  var list = safeArray(nodes).filter(function (node) {
    return node && node.role === "project_coordinator" && node.sessionRef;
  }).slice(0, 1);
  if (!container || list.length === 0) return 0;
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var hierarchy = document.createElement("div");
  hierarchy.className = prefix + "coop-project-hierarchy";
  hierarchy.setAttribute("aria-label", "Project coordinator hierarchy");
  for (var i = 0; i < list.length; i++) {
    hierarchy.appendChild(createHierarchyNode(list[i], 0, prefix, opts));
  }
  container.appendChild(hierarchy);
  return list.length;
}
