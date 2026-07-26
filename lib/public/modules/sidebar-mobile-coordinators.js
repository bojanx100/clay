// sidebar-mobile-coordinators.js - Mobile coordinator/worker grouping and collapse state

var expandedCoordinatorGroups = new Set();

export function buildMobileCoordinatorItems(sessions) {
  var normalById = {};
  var coordinatorChildren = {};
  var items = [];

  for (var i = 0; i < sessions.length; i++) normalById[sessions[i].id] = sessions[i];

  for (var wi = 0; wi < sessions.length; wi++) {
    var workerSession = sessions[wi];
    var ownerId = workerSession.orchestrationParent && workerSession.orchestrationParent.sessionId;
    if (!ownerId || !normalById[ownerId] || !normalById[ownerId].coordinationMode) continue;
    if (!coordinatorChildren[ownerId]) coordinatorChildren[ownerId] = [];
    coordinatorChildren[ownerId].push(workerSession);
  }

  for (var si = 0; si < sessions.length; si++) {
    var session = sessions[si];
    var parentId = session.orchestrationParent && session.orchestrationParent.sessionId;
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

function coordinatorGroupExpanded(item) {
  if (expandedCoordinatorGroups.has(item.data.id)) return true;
  for (var i = 0; i < item.children.length; i++) {
    if (item.children[i].active) return true;
  }
  return false;
}

export function createMobileCoordinatorGroup(item, deps) {
  var wrapper = document.createElement("div");
  wrapper.className = "mobile-coordinator-group";
  wrapper.dataset.coordinatorSessionId = item.data.id;

  var parentRow = deps.createSessionItem(item.data);
  parentRow.classList.add("mobile-coordinator-parent");
  var expanded = coordinatorGroupExpanded(item);
  var toggle = document.createElement("span");
  toggle.className = "mobile-coordinator-toggle";
  toggle.setAttribute("role", "button");
  toggle.setAttribute("aria-label", expanded ? "Collapse workers" : "Expand workers");
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.innerHTML = deps.iconHtml(expanded ? "chevron-down" : "chevron-right");
  toggle.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (expandedCoordinatorGroups.has(item.data.id)) {
      expandedCoordinatorGroups.delete(item.data.id);
    } else {
      expandedCoordinatorGroups.add(item.data.id);
    }
    deps.refresh();
  });
  parentRow.insertBefore(toggle, parentRow.firstChild);
  wrapper.appendChild(parentRow);

  if (expanded) {
    var children = document.createElement("div");
    children.className = "mobile-coordinator-workers";
    for (var i = 0; i < item.children.length; i++) {
      var childRow = deps.createSessionItem(item.children[i]);
      childRow.classList.add("mobile-coordinator-worker");
      children.appendChild(childRow);
    }
    wrapper.appendChild(children);
  }

  return wrapper;
}
