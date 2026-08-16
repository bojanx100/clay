// Owner-focused control surface projection for canonical Coop Session Context.
//
// This stays deliberately above the execution tree: a row represents one
// canonical Thread, while exact coordinator and session references are exposed
// as destinations rather than rendered as a second worker inventory.

var ACTIVE_STATUSES = { queued: true, ready: true, running: true, reviewing: true, paused: true };
var ATTENTION_STATUSES = { needs_input: true, waiting_user: true, blocked: true, failed: true };
var MAX_RECENT = 8;

function text(value, fallback) {
  var result = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return result || fallback || "";
}

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function sessionKey(ref) {
  return ref && ref.projectId && ref.sessionStorageId
    ? ref.projectId + ":" + ref.sessionStorageId : "";
}

function copy(ref) {
  return ref ? JSON.parse(JSON.stringify(ref)) : null;
}

function addSession(sessions, ref, title) {
  var key = sessionKey(ref);
  if (!key) return;
  for (var i = 0; i < sessions.length; i++) if (sessionKey(sessions[i].sessionRef) === key) return;
  sessions.push({ sessionRef: copy(ref), title: text(title, "Project session") });
}

function projectIndex(projects) {
  var index = {};
  var list = Array.isArray(projects) ? projects : [];
  for (var i = 0; i < list.length; i++) {
    var project = list[i] || {};
    var id = project.projectRef && project.projectRef.projectId;
    if (!id) continue;
    var tree = project.summary && Array.isArray(project.summary.coordinatorTree)
      ? project.summary.coordinatorTree : [];
    index[id] = { projectRef: copy(project.projectRef), title: text(project.title, "Project"),
      coordinator: tree[0] && tree[0].sessionRef ? {
        sessionRef: copy(tree[0].sessionRef), title: text(tree[0].title, "Project coordinator"),
      } : null, tree: tree };
  }
  return index;
}

function collectThreadNodes(nodes, byTopic) {
  var list = Array.isArray(nodes) ? nodes : [];
  for (var i = 0; i < list.length; i++) {
    var node = list[i] || {};
    if (node.role === "thread" && topicId(node.topicRef)) byTopic[topicId(node.topicRef)] = node;
    collectThreadNodes(node.children, byTopic);
  }
}

function threadNodeIndex(projects) {
  var result = {};
  var list = Array.isArray(projects) ? projects : [];
  for (var i = 0; i < list.length; i++) {
    var tree = list[i] && list[i].summary && list[i].summary.coordinatorTree;
    collectThreadNodes(tree, result);
  }
  return result;
}

function firstExecutionStatus(node) {
  var children = node && Array.isArray(node.children) ? node.children : [];
  for (var i = 0; i < children.length; i++) {
    var status = text(children[i].status, "").toLowerCase();
    if (ATTENTION_STATUSES[status] || ACTIVE_STATUSES[status]) return status;
  }
  return "";
}

function executionSessions(node) {
  var result = [];
  function visit(current) {
    var children = current && Array.isArray(current.children) ? current.children : [];
    for (var i = 0; i < children.length; i++) {
      var child = children[i] || {};
      addSession(result, child.sessionRef, child.title);
      visit(child);
    }
  }
  visit(node);
  return result;
}

function detailForTopic(topic, projects, threadNodes) {
  var topicIdValue = topicId(topic && topic.topicRef);
  var projectRef = topic && (topic.projectRef ||
    Array.isArray(topic.executionProjectRefs) && topic.executionProjectRefs[0]) || null;
  var project = projectRef && projects[projectRef.projectId] || null;
  var node = threadNodes[topicIdValue] || null;
  var sessions = [];
  var related = topic && Array.isArray(topic.relatedSessions) ? topic.relatedSessions : [];
  for (var i = 0; i < related.length; i++) addSession(sessions, related[i].sessionRef, related[i].title);
  var execution = executionSessions(node);
  for (var j = 0; j < execution.length; j++) addSession(sessions, execution[j].sessionRef, execution[j].title);
  return {
    topicRef: copy(topic && topic.topicRef),
    threadRef: copy(topic && topic.threadRef || topic && topic.topicRef && { threadId: topic.topicRef.topicId }),
    projectRef: copy(projectRef),
    projectTitle: project && project.title || "",
    coordinator: project && project.coordinator || null,
    sessions: sessions,
    executionStatus: firstExecutionStatus(node),
    activity: text(node && node.activity || topic && topic.currentActivity, ""),
  };
}

function baseEntry(topic, details, extra) {
  return Object.assign({
    entryId: topicId(topic.topicRef),
    title: text(topic.title, "Untitled Thread"),
    status: details.executionStatus || text(topic.workState, "quiet"),
    activity: details.activity,
    updatedAt: Number(topic.updatedAt) || 0,
    topicRef: details.topicRef,
    threadRef: details.threadRef,
    projectRef: details.projectRef,
    projectTitle: details.projectTitle,
    coordinator: details.coordinator,
    sessions: details.sessions,
  }, extra || {});
}

function mapTopics(topics, projects, threadNodes) {
  var byId = {};
  var list = Array.isArray(topics) ? topics : [];
  for (var i = 0; i < list.length; i++) {
    var id = topicId(list[i] && list[i].topicRef);
    if (id && !byId[id]) byId[id] = list[i];
  }
  return byId;
}

function priorityOrder(entries, priority) {
  var order = priority && Array.isArray(priority.order) ? priority.order : [];
  var rank = {};
  for (var i = 0; i < order.length; i++) rank[order[i]] = i;
  return entries.slice().sort(function (a, b) {
    var ar = Object.prototype.hasOwnProperty.call(rank, a.entryId) ? rank[a.entryId] : Number.MAX_SAFE_INTEGER;
    var br = Object.prototype.hasOwnProperty.call(rank, b.entryId) ? rank[b.entryId] : Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    return a.entryId < b.entryId ? -1 : (a.entryId > b.entryId ? 1 : 0);
  });
}

function activityOrder(entries) {
  return entries.slice().sort(function (a, b) {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.entryId < b.entryId ? -1 : (a.entryId > b.entryId ? 1 : 0);
  });
}

function nowEntries(nowIndex, topicById, projects, threadNodes) {
  var list = Array.isArray(nowIndex) ? nowIndex : [];
  var result = [];
  for (var i = 0; i < list.length; i++) {
    var current = list[i] || {};
    // Attention has its own owner-action sections below. Keeping it out of
    // Now prevents one blocked Thread appearing twice with different calls to
    // action; Now is reserved for execution that is actually progressing.
    if (current.kind !== "working") continue;
    var topic = topicById[topicId(current.topicRef)];
    if (!topic) continue;
    var details = detailForTopic(topic, projects, threadNodes);
    // The Now index is the current-work authority. A linked sibling can be
    // blocked or queued while other work in this Thread is genuinely running;
    // never copy that sibling state onto a row whose reason says Working now.
    var status = details.executionStatus === "running" || details.executionStatus === "reviewing"
      ? details.executionStatus : "running";
    result.push(baseEntry(topic, details, {
      status: status,
      reason: text(current.reason, "Current work"),
      kind: current.kind || "working",
    }));
  }
  return result;
}

function nextEntries(topicById, now, projects, threadNodes, priority) {
  var present = {};
  for (var i = 0; i < now.length; i++) present[now[i].entryId] = true;
  var ids = Object.keys(topicById);
  var result = [];
  for (var j = 0; j < ids.length; j++) {
    var topic = topicById[ids[j]];
    var details = detailForTopic(topic, projects, threadNodes);
    if (present[ids[j]] || !details.executionStatus ||
        (details.executionStatus !== "queued" && details.executionStatus !== "ready" &&
          details.executionStatus !== "paused")) continue;
    result.push(baseEntry(topic, details, {
      status: details.executionStatus,
      reason: details.executionStatus === "ready" ? "Ready to start" :
        (details.executionStatus === "paused" ? "Paused — not running" : "Queued behind current work"),
      kind: "next",
    }));
  }
  return priorityOrder(result, priority);
}

function actionEntry(action, topic, details) {
  var destination = action && action.destination || null;
  var sessions = details.sessions.slice();
  if (destination && destination.ref) addSession(sessions, destination.ref, action.title || "Related session");
  return baseEntry(topic, Object.assign({}, details, { sessions: sessions }), {
    entryId: text(action.itemId, topicId(topic.topicRef)),
    title: text(action.title, topic.title),
    status: text(action.status, "needs_input"),
    reason: text(action.decision, "Needs your attention"),
    unblockAction: text(action.decision, "Open the Thread to unblock this work"),
    evidence: text(action.evidence, ""),
    updatedAt: Number(action.updatedAt) || Number(topic.updatedAt) || 0,
  });
}

function attentionEntries(actionQueue, topicById, projects, threadNodes) {
  var needsYou = [];
  var blocked = [];
  var list = Array.isArray(actionQueue) ? actionQueue : [];
  for (var i = 0; i < list.length; i++) {
    var action = list[i] || {};
    var topic = topicById[topicId(action.topicRef)];
    if (!topic) continue;
    var entry = actionEntry(action, topic, detailForTopic(topic, projects, threadNodes));
    if (entry.status === "blocked" || entry.status === "failed" || entry.status === "waiting_user") blocked.push(entry);
    else needsYou.push(entry);
  }
  return { needsYou: activityOrder(needsYou), blocked: activityOrder(blocked) };
}

function recentEntries(topicById, projects, threadNodes) {
  var ids = Object.keys(topicById);
  var result = [];
  for (var i = 0; i < ids.length; i++) {
    var topic = topicById[ids[i]];
    if (topic.workState !== "done") continue;
    var details = detailForTopic(topic, projects, threadNodes);
    result.push(baseEntry(topic, details, {
      status: "completed",
      reason: "Completed",
      kind: "completed",
    }));
  }
  return activityOrder(result).slice(0, MAX_RECENT);
}

function buildOwnerSidebar(input) {
  var value = input || {};
  var projects = projectIndex(value.projects);
  var threadNodes = threadNodeIndex(value.projects);
  var topics = mapTopics(value.topics, projects, threadNodes);
  var now = nowEntries(value.nowIndex, topics, projects, threadNodes);
  var attention = attentionEntries(value.actionQueue, topics, projects, threadNodes);
  return {
    priorityRevision: Number(value.priority && value.priority.revision) || 0,
    now: now,
    next: nextEntries(topics, now, projects, threadNodes, value.priority),
    needsYou: attention.needsYou,
    blocked: attention.blocked,
    recentlyCompleted: recentEntries(topics, projects, threadNodes),
  };
}

module.exports = { buildOwnerSidebar: buildOwnerSidebar };
