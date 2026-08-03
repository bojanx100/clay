// sidebar-mobile-coordinators.js - Mobile coordinator/worker grouping

export function buildMobileCoordinatorItems(sessions) {
  var normalById = {};
  var coordinatorChildren = {};
  var items = [];

  for (var i = 0; i < sessions.length; i++) normalById[sessions[i].id] = sessions[i];

  for (var wi = 0; wi < sessions.length; wi++) {
    var workerSession = sessions[wi];
    var workerParent = workerSession.orchestrationGroupParent || workerSession.orchestrationParent;
    var ownerId = workerParent && workerParent.sessionId;
    if (!ownerId || !normalById[ownerId] || !normalById[ownerId].coordinationMode) continue;
    if (!coordinatorChildren[ownerId]) coordinatorChildren[ownerId] = [];
    coordinatorChildren[ownerId].push(workerSession);
  }

  for (var si = 0; si < sessions.length; si++) {
    var session = sessions[si];
    var sessionParent = session.orchestrationGroupParent || session.orchestrationParent;
    var parentId = sessionParent && sessionParent.sessionId;
    if (parentId && coordinatorChildren[parentId]) continue;
    if (session.coordinationMode && coordinatorChildren[session.id]) {
      coordinatorChildren[session.id].sort(function (a, b) {
        return (b.lastActivity || 0) - (a.lastActivity || 0);
      });
      items.push({
        type: "coordinator",
        data: session,
        children: coordinatorChildren[session.id],
        lastActivity: session.lastActivity || 0
      });
    } else {
      items.push({ type: "session", data: session, lastActivity: session.lastActivity || 0 });
    }
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
  for (var i = 0; i < item.children.length; i++) {
    var childRow = deps.createSessionItem(item.children[i]);
    childRow.classList.add("mobile-coordinator-worker");
    children.appendChild(childRow);
  }
  wrapper.appendChild(children);

  return wrapper;
}
