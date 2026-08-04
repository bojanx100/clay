// sidebar-mobile-coordinators.js - Mobile coordinator/worker grouping

import { coordinatorWorkerDisplay, createCoordinatorWorkersToggle } from './sidebar-coordinator-workers.js';

function mobileOrchestrationParent(session) {
  return session.orchestrationGroupParent || session.orchestrationParent;
}

function indexMobileSessions(sessions) {
  var normalById = {};
  for (var i = 0; i < sessions.length; i++) normalById[sessions[i].id] = sessions[i];
  return normalById;
}

function collectMobileCoordinatorChildren(sessions, normalById) {
  var coordinatorChildren = {};
  for (var i = 0; i < sessions.length; i++) {
    var workerSession = sessions[i];
    var workerParent = mobileOrchestrationParent(workerSession);
    var ownerId = workerParent && workerParent.sessionId;
    if (!ownerId) continue;
    if (!normalById[ownerId]) continue;
    if (!normalById[ownerId].coordinationMode) continue;
    if (!coordinatorChildren[ownerId]) coordinatorChildren[ownerId] = [];
    coordinatorChildren[ownerId].push(workerSession);
  }
  return coordinatorChildren;
}

function isNestedMobileWorker(session, coordinatorChildren) {
  var sessionParent = mobileOrchestrationParent(session);
  var parentId = sessionParent && sessionParent.sessionId;
  return !!(parentId && coordinatorChildren[parentId]);
}

function compareMobileWorkerActivity(a, b) {
  return (b.lastActivity || 0) - (a.lastActivity || 0);
}

function buildMobileCoordinatorItem(session, coordinatorChildren) {
  var children = coordinatorChildren[session.id];
  if (!session.coordinationMode || !children) {
    return { type: "session", data: session, lastActivity: session.lastActivity || 0 };
  }
  children.sort(compareMobileWorkerActivity);
  return {
    type: "coordinator",
    data: session,
    children: children,
    lastActivity: session.lastActivity || 0
  };
}

export function buildMobileCoordinatorItems(sessions) {
  var normalById = indexMobileSessions(sessions);
  var coordinatorChildren = collectMobileCoordinatorChildren(sessions, normalById);
  var items = [];
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    if (isNestedMobileWorker(session, coordinatorChildren)) continue;
    items.push(buildMobileCoordinatorItem(session, coordinatorChildren));
  }
  return items;
}

export function createMobileCoordinatorGroup(item, deps) {
  var wrapper = document.createElement("div");
  wrapper.className = "mobile-coordinator-group";
  wrapper.dataset.coordinatorSessionId = item.data.id;

  var parentRow = deps.createSessionItem(item.data);
  parentRow.classList.add("mobile-coordinator-parent");
  wrapper.appendChild(parentRow);

  var children = document.createElement("div");
  children.className = "mobile-coordinator-workers";
  var display = coordinatorWorkerDisplay(item.children, item.data.id, false);
  for (var i = 0; i < display.workers.length; i++) {
    var childRow = deps.createSessionItem(display.workers[i]);
    childRow.classList.add("mobile-coordinator-worker");
    children.appendChild(childRow);
  }
  var toggle = createCoordinatorWorkersToggle(
    item.data.id,
    display,
    "mobile-coordinator-workers-toggle",
    deps.rerender
  );
  if (toggle) children.appendChild(toggle);
  wrapper.appendChild(children);

  return wrapper;
}
