// sidebar-coordinator-workers.js - Shared coordinator worker visibility rules

import { iconHtml } from './icons.js';
import { store } from './store.js';

export var MAX_COLLAPSED_COORDINATOR_WORKERS = 3;

function workerParent(worker) {
  return worker && (worker.orchestrationGroupParent || worker.orchestrationParent) || {};
}

function workerStatus(worker) {
  var parent = workerParent(worker);
  if (parent.taskStatus) return parent.taskStatus;
  return worker && worker.isProcessing ? "running" : "queued";
}

function isResolvedStatus(status) {
  return status === "completed" || status === "dismissed" || status === "cancelled";
}

function isAttentionStatus(status) {
  return status === "blocked" || status === "failed" || status === "needs_input" ||
    status === "reviewing" || status === "waiting_user";
}

function workerPriority(worker) {
  var status = workerStatus(worker);
  if (worker && worker.active) return 0;
  if (isAttentionStatus(status)) return 1;
  if (!isResolvedStatus(status)) return 2;
  return 3;
}

function compareWorkers(a, b) {
  var priorityDelta = workerPriority(a) - workerPriority(b);
  if (priorityDelta !== 0) return priorityDelta;
  return (b.lastActivity || 0) - (a.lastActivity || 0);
}

function expansionKey(coordinatorId) {
  return (store.get("currentSlug") || "") + ":" + coordinatorId;
}

export function isCoordinatorWorkersExpanded(coordinatorId) {
  var expanded = store.get("expandedCoordinatorWorkerGroups") || {};
  return !!expanded[expansionKey(coordinatorId)];
}

export function toggleCoordinatorWorkers(coordinatorId) {
  var key = expansionKey(coordinatorId);
  var expanded = Object.assign({}, store.get("expandedCoordinatorWorkerGroups") || {});
  if (expanded[key]) delete expanded[key];
  else expanded[key] = true;
  store.set({ expandedCoordinatorWorkerGroups: expanded });
}

export function coordinatorWorkerDisplay(children, coordinatorId, forceExpanded) {
  var ranked = (children || []).slice().sort(compareWorkers);
  var expanded = !!forceExpanded || isCoordinatorWorkersExpanded(coordinatorId);
  var current = ranked.filter(function (worker) {
    return !isResolvedStatus(workerStatus(worker)) || worker.active;
  });
  var workers = expanded ? ranked : current.slice(0, MAX_COLLAPSED_COORDINATOR_WORKERS);
  var visibleIds = {};
  var hiddenActive = 0;
  var hiddenResolved = 0;

  for (var i = 0; i < workers.length; i++) visibleIds[workers[i].id] = true;
  for (var j = 0; j < ranked.length; j++) {
    if (visibleIds[ranked[j].id]) continue;
    if (isResolvedStatus(workerStatus(ranked[j]))) hiddenResolved++;
    else hiddenActive++;
  }

  return {
    workers: workers,
    expanded: expanded,
    hiddenCount: hiddenActive + hiddenResolved,
    hiddenActive: hiddenActive,
    hiddenResolved: hiddenResolved,
  };
}

function collapsedLabel(display) {
  if (display.hiddenActive > 0 && display.hiddenResolved > 0) {
    return "More \u00b7 " + display.hiddenActive + " active, " + display.hiddenResolved + " completed";
  }
  if (display.hiddenActive > 0) return "More \u00b7 " + display.hiddenActive + " active";
  return "More \u00b7 " + display.hiddenResolved + " completed";
}

export function createCoordinatorWorkersToggle(coordinatorId, display, className, onToggle) {
  if (!display.expanded && display.hiddenCount === 0) return null;
  var button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-expanded", display.expanded ? "true" : "false");
  button.setAttribute("aria-label", display.expanded ? "Show fewer workers" : "Show all workers");

  var label = document.createElement("span");
  label.textContent = display.expanded ? "Less" : collapsedLabel(display);
  button.appendChild(label);

  var icon = document.createElement("span");
  icon.className = "coordinator-workers-toggle-icon";
  icon.innerHTML = iconHtml(display.expanded ? "chevron-up" : "chevron-down");
  icon.setAttribute("aria-hidden", "true");
  button.appendChild(icon);

  button.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    toggleCoordinatorWorkers(coordinatorId);
    if (onToggle) onToggle();
  });
  return button;
}
