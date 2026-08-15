// Pure session-list model helpers shared by the desktop session sidebar.

// coop-identity.js is a dependency-free leaf (constants and pure functions), so
// importing it here keeps the owner-facing identity single-sourced without
// pulling any graph into this pure module.
import { COOP_IDENTITY } from './coop-identity.js';

function sessionData(item) {
  return item && (item.type === "session" || item.type === "coordinator") ? item.data : item;
}

export function orchestrationParent(session) {
  return session && (session.orchestrationGroupParent || session.orchestrationParent);
}

var ACTIVE_COOP_STATUSES = {
  active: true, queued: true, ready: true, running: true, reviewing: true,
};
var ATTENTION_COOP_STATUSES = {
  blocked: true, failed: true, needs_input: true, waiting_user: true,
};
var TERMINAL_COOP_STATUSES = {
  completed: true, superseded: true,
};

function coopProjectionStatuses(session) {
  var parent = orchestrationParent(session);
  return [parent && parent.taskStatus, session && session.coopExecutionStatus]
    .filter(function (status) { return typeof status === "string" && status; });
}

function hasStatus(statuses, allowed) {
  return statuses.some(function (status) { return !!allowed[status]; });
}

function provenTerminalCoopProjection(session) {
  var statuses = coopProjectionStatuses(session);
  if (hasStatus(statuses, ACTIVE_COOP_STATUSES) ||
      hasStatus(statuses, ATTENTION_COOP_STATUSES)) return false;
  return hasStatus(statuses, TERMINAL_COOP_STATUSES);
}

export function sessionsForOrdinaryProjectSidebar(sessions) {
  var list = Array.isArray(sessions) ? sessions : [];
  return list.filter(function (session) {
    if (!session || !session.leadOwned) return true;
    return !provenTerminalCoopProjection(session);
  });
}

export function compareSessionListItems(a, b) {
  var aData = sessionData(a);
  var bData = sessionData(b);
  var aBookmarked = !!(aData && aData.bookmarked);
  var bBookmarked = !!(bData && bData.bookmarked);
  if (aBookmarked !== bBookmarked) return aBookmarked ? -1 : 1;
  if (aBookmarked && bBookmarked) {
    var ao = aData && typeof aData.favoriteOrder === "number" ? aData.favoriteOrder : Number.MAX_SAFE_INTEGER;
    var bo = bData && typeof bData.favoriteOrder === "number" ? bData.favoriteOrder : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
  }
  return (b.lastActivity || 0) - (a.lastActivity || 0);
}

function isVisible(sessionId, searchMatchIds) {
  return searchMatchIds === null || searchMatchIds === undefined || searchMatchIds.has(sessionId);
}

function visibleSessionId(session, searchMatchIds) {
  if (!session || typeof session.id !== "number") return [];
  return isVisible(session.id, searchMatchIds) ? [session.id] : [];
}

function visibleChildIds(children, searchMatchIds, requireNumericId) {
  var ids = [];
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if ((!requireNumericId || typeof child.id === "number") && isVisible(child.id, searchMatchIds)) {
      ids.push(child.id);
    }
  }
  return ids;
}

export function collectItemSessionIds(item, searchMatchIds) {
  if (!item) return [];
  if (item.type === "session") return visibleSessionId(item.data, searchMatchIds);
  if (item.type === "coordinator") {
    var coordinatorIds = visibleSessionId(item.data, searchMatchIds);
    return coordinatorIds.concat(visibleChildIds(item.children || [], searchMatchIds, false));
  }
  if (item.type === "loop" && Array.isArray(item.children)) {
    return visibleChildIds(item.children, searchMatchIds, true);
  }
  return [];
}

function isHiddenCraftingSession(session) {
  var loop = session && session.loop;
  return !!(loop && loop.loopId && loop.role === "crafting" &&
    loop.source !== "ralph" && loop.source !== "debate");
}

function loopGroupKey(session) {
  var loop = session.loop;
  var startedAt = loop.startedAt || 0;
  var dateStr = startedAt ? new Date(startedAt).toISOString().slice(0, 10) : "unknown";
  return loop.loopId + ":" + dateStr;
}

export function partitionSessionList(sessions) {
  var loopGroups = {};
  var normalSessions = [];
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    if (isHiddenCraftingSession(session)) continue;
    if (session.loop && session.loop.loopId) {
      var key = loopGroupKey(session);
      if (!loopGroups[key]) loopGroups[key] = [];
      loopGroups[key].push(session);
    } else {
      normalSessions.push(session);
    }
  }
  return { loopGroups: loopGroups, normalSessions: normalSessions };
}

function indexSessions(sessions) {
  var byId = {};
  for (var i = 0; i < sessions.length; i++) byId[sessions[i].id] = sessions[i];
  return byId;
}

function groupCoordinatorChildren(normalSessions, normalById) {
  var children = {};
  for (var i = 0; i < normalSessions.length; i++) {
    var worker = normalSessions[i];
    var parent = orchestrationParent(worker);
    var ownerId = parent && parent.sessionId;
    if (!ownerId || !normalById[ownerId] || !normalById[ownerId].coordinationMode) continue;
    if (!children[ownerId]) children[ownerId] = [];
    children[ownerId].push(worker);
  }
  return children;
}

function createCoordinatorItem(session, children) {
  children.sort(function (a, b) {
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
  return {
    type: "coordinator",
    data: session,
    children: children,
    lastActivity: session.lastActivity || 0,
  };
}

export function buildSessionListItems(normalSessions, loopGroups) {
  var normalById = indexSessions(normalSessions);
  var coordinatorChildren = groupCoordinatorChildren(normalSessions, normalById);
  var items = [];
  for (var i = 0; i < normalSessions.length; i++) {
    var session = normalSessions[i];
    var parent = orchestrationParent(session);
    if (parent && coordinatorChildren[parent.sessionId]) continue;
    if (session.coordinationMode && coordinatorChildren[session.id]) {
      items.push(createCoordinatorItem(session, coordinatorChildren[session.id]));
    } else {
      items.push({ type: "session", data: session, lastActivity: session.lastActivity || 0 });
    }
  }

  var groupKeys = Object.keys(loopGroups);
  for (var j = 0; j < groupKeys.length; j++) {
    var groupKey = groupKeys[j];
    var children = loopGroups[groupKey];
    var maxActivity = 0;
    for (var k = 0; k < children.length; k++) {
      maxActivity = Math.max(maxActivity, children[k].lastActivity || 0);
    }
    items.push({
      type: "loop",
      loopId: children[0].loop.loopId,
      groupKey: groupKey,
      children: children,
      lastActivity: maxActivity,
    });
  }
  return items;
}

export function sessionItemKey(item) {
  return item.type === "loop" ? "l:" + item.groupKey : "s:" + (item.data && item.data.id);
}

export function orderSessionListItems(items, frozenOrder, frozenOrderSlug, currentSlug) {
  if (frozenOrderSlug !== currentSlug || !frozenOrder) {
    var sorted = items.slice().sort(compareSessionListItems);
    return {
      items: sorted,
      frozenOrder: sorted.map(sessionItemKey),
      frozenOrderSlug: currentSlug,
    };
  }

  var rank = {};
  for (var i = 0; i < frozenOrder.length; i++) rank[frozenOrder[i]] = i;
  var known = [];
  var fresh = [];
  for (var j = 0; j < items.length; j++) {
    if (rank[sessionItemKey(items[j])] !== undefined) known.push(items[j]);
    else fresh.push(items[j]);
  }
  known.sort(function (a, b) { return rank[sessionItemKey(a)] - rank[sessionItemKey(b)]; });
  fresh.sort(compareSessionListItems);
  return {
    items: fresh.concat(known),
    frozenOrder: fresh.length ? fresh.map(sessionItemKey).concat(frozenOrder) : frozenOrder,
    frozenOrderSlug: frozenOrderSlug,
  };
}

function visibleItem(item, searchMatchIds) {
  if (item.type === "session") return isVisible(item.data.id, searchMatchIds);
  if (item.type !== "coordinator" || isVisible(item.data.id, searchMatchIds)) return true;
  return item.children.some(function (child) { return isVisible(child.id, searchMatchIds); });
}

export function splitVisibleSessionItems(items, searchMatchIds) {
  var bookmarkedItems = [];
  var regularItems = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!visibleItem(item, searchMatchIds)) continue;
    if ((item.type === "session" || item.type === "coordinator") && item.data.bookmarked) {
      bookmarkedItems.push(item);
    } else {
      regularItems.push(item);
    }
  }
  return { bookmarkedItems: bookmarkedItems, regularItems: regularItems };
}

function itemIsLeadOwned(item) {
  if (item.type === "loop") {
    return (item.children || []).some(function (session) { return !!session.leadOwned; });
  }
  return !!(item.data && item.data.leadOwned);
}

var GROUP_RANK = { "Today": 0, "Yesterday": 1, "This Week": 2, "Older": 3 };

export function orderRegularItemsByDate(regularItems, getDateGroup) {
  var buckets = [[], [], [], []];
  for (var i = 0; i < regularItems.length; i++) {
    var rank = GROUP_RANK[getDateGroup(regularItems[i].lastActivity || 0)];
    if (rank === undefined) rank = 3;
    buckets[rank].push(regularItems[i]);
  }
  return buckets[0].concat(buckets[1], buckets[2], buckets[3]);
}

export function groupSessionItemsByDate(regularItems, getDateGroup, searchMatchIds) {
  var groups = [];
  for (var i = 0; i < regularItems.length; i++) {
    var item = regularItems[i];
    var name = getDateGroup(item.lastActivity || 0);
    var group = groups[groups.length - 1];
    if (!group || group.name !== name) {
      group = { name: name, items: [], sessionIds: [] };
      groups.push(group);
    }
    group.items.push(item);
    group.sessionIds = group.sessionIds.concat(collectItemSessionIds(item, searchMatchIds));
  }
  return groups;
}

export function buildOwnershipSections(regularItems, getDateGroup, searchMatchIds) {
  var meItems = [];
  var leadItems = [];
  for (var i = 0; i < regularItems.length; i++) {
    if (itemIsLeadOwned(regularItems[i])) leadItems.push(regularItems[i]);
    else meItems.push(regularItems[i]);
  }
  var definitions = [
    { key: "me", label: "ME", items: meItems },
    // Owner-facing heading for work Coop owns. The key stays "lead" because it
    // is the internal slug; only the label the owner reads changes.
    { key: "lead", label: COOP_IDENTITY, items: leadItems },
  ];
  var sections = [];
  for (var j = 0; j < definitions.length; j++) {
    var definition = definitions[j];
    if (definition.items.length === 0) continue;
    var orderedItems = orderRegularItemsByDate(definition.items, getDateGroup);
    sections.push({
      key: definition.key,
      label: definition.label,
      items: orderedItems,
      dateGroups: groupSessionItemsByDate(orderedItems, getDateGroup, searchMatchIds),
    });
  }
  return sections;
}

function roleSignature(session, parent) {
  if (session.coordinationMode) return "coordinator";
  if (parent) return "worker";
  return "";
}

function parentSignatureFields(parent) {
  if (!parent) return ["", "", "", "", ""];
  return [
    parent.sessionId || "",
    parent.workerColor || "",
    parent.taskStatus || "",
    parent.attempt || "",
    parent.attemptCount || "",
  ];
}

function loopSignature(loop) {
  if (!loop) return "";
  return loop.loopId + "/" +
    (loop.role || "") + "/" +
    (loop.iteration || "") + "/" +
    (loop.status || "") + "/" +
    (loop.source || "") + "/" +
    (loop.startedAt || "");
}

function sessionSignaturePart(session) {
  var loop = session.loop || null;
  var parent = orchestrationParent(session);
  return [
    session.id,
    session.title || "",
    session.isProcessing ? 1 : 0,
    session.bookmarked ? 1 : 0,
    session.unread || session.unreadCount || 0,
    session.visibility || "",
    session.vendor || "",
    session.leadOwned ? 1 : 0,
    roleSignature(session, parent),
    session.coordinationRole || "",
    session.coopExecutionStatus || "",
    session.orchestrationActiveCount || 0,
    session.orchestrationPhase || "",
    session.orchestrationUnresolvedCount || 0,
  ].concat(parentSignatureFields(parent), [
    session.demotionPending ? 1 : 0,
    loopSignature(loop),
  ]).join("\u0001");
}

function activeGroupState(sessions) {
  var activeGroup = "";
  var activeCoordinator = "";
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    if (session.active && session.loop && session.loop.loopId) {
      activeGroup = session.loop.loopId;
      break;
    }
    var parent = orchestrationParent(session);
    if (session.active && parent) activeCoordinator = parent.sessionId || "";
  }
  return { activeGroup: activeGroup, activeCoordinator: activeCoordinator };
}

function expandedWorkerSignature(expandedWorkerGroups) {
  return Object.keys(expandedWorkerGroups || {}).filter(function (key) {
    return expandedWorkerGroups[key];
  }).sort().join(",");
}

function expandedSetSignature(expandedItems) {
  return expandedItems ? Array.from(expandedItems).sort().join(",") : "";
}

function searchSignature(searchQuery, searchMatchIds) {
  return (searchQuery || "") + "|" + (searchMatchIds ? Array.from(searchMatchIds).sort().join(",") : "");
}

export function sessionListSignature(
  sessions,
  searchQuery,
  searchMatchIds,
  expandedWorkerGroups,
  expandedLoopGroups,
  expandedLoopRuns
) {
  var active = activeGroupState(sessions);
  return sessions.map(sessionSignaturePart).join("\u0002") +
    "||g:" + active.activeGroup +
    "||c:" + active.activeCoordinator +
    "||s:" + searchSignature(searchQuery, searchMatchIds) +
    "||w:" + expandedWorkerSignature(expandedWorkerGroups) +
    "||lg:" + expandedSetSignature(expandedLoopGroups) +
    "||lr:" + expandedSetSignature(expandedLoopRuns);
}

export function buildSessionListModel(sessions, options) {
  var partition = partitionSessionList(sessionsForOrdinaryProjectSidebar(sessions));
  var items = buildSessionListItems(partition.normalSessions, partition.loopGroups);
  var ordered = orderSessionListItems(items, options.frozenOrder, options.frozenOrderSlug, options.currentSlug);
  var split = splitVisibleSessionItems(ordered.items, options.searchMatchIds);
  var regularItems = orderRegularItemsByDate(split.regularItems, options.getDateGroup);
  return {
    bookmarkedItems: split.bookmarkedItems,
    regularItems: regularItems,
    dateGroups: groupSessionItemsByDate(regularItems, options.getDateGroup, options.searchMatchIds),
    ownershipSections: buildOwnershipSections(split.regularItems, options.getDateGroup, options.searchMatchIds),
    frozenOrder: ordered.frozenOrder,
    frozenOrderSlug: ordered.frozenOrderSlug,
  };
}
