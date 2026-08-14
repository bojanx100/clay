// Pure normalization for the reference-only Coop topic projection.

export function cloneReference(ref) {
  if (!ref || typeof ref !== "object") return null;
  try { return JSON.parse(JSON.stringify(ref)); } catch (e) { return null; }
}

export function topicRefKey(ref) {
  if (!ref || typeof ref !== "object") return "";
  return String(ref.topicId || ref.topicKey || ref.id || ref.key || "");
}

export function canonicalEventRefKey(ref) {
  if (!ref || typeof ref !== "object") return "";
  if (ref.sessionStorageId && Number.isInteger(ref.eventIndex)) {
    return String(ref.projectId || "system-lead") + ":" + ref.sessionStorageId + ":" + ref.eventIndex;
  }
  if (ref.eventId || ref.canonicalEventId || ref.eventKey || ref.id || ref.key) {
    return String(ref.eventId || ref.canonicalEventId || ref.eventKey || ref.id || ref.key);
  }
  return "";
}

function safeText(value, fallback) {
  var text = typeof value === "string" ? value.trim() : "";
  return text || fallback || "";
}

export function safeTopicList(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.topics)) return value.topics;
  return [];
}

function cloneDecision(value) {
  if (typeof value === "string") return safeText(value, "");
  if (!value || typeof value !== "object") return "";
  return safeText(value.text || value.title || value.summary || value.decision, "");
}

function cloneCanonicalEvent(value) {
  if (typeof value === "string") return { eventRef: { eventId: value }, title: value };
  var event = value || {};
  var eventRef = cloneReference(event.eventRef || event.canonicalEventRef || event.ref);
  if (event.projectId && event.sessionStorageId && Number.isInteger(event.eventIndex)) {
    eventRef = cloneReference({
      projectId: event.projectId,
      sessionStorageId: event.sessionStorageId,
      eventIndex: event.eventIndex,
    });
  }
  if (!eventRef && (event.eventId || event.canonicalEventId || event.id)) {
    eventRef = cloneReference({ eventId: event.eventId || event.canonicalEventId || event.id });
  }
  if (!eventRef && event.sessionStorageId && Number.isInteger(event.eventIndex)) {
    eventRef = cloneReference({
      projectId: event.projectId || "system-lead",
      sessionStorageId: event.sessionStorageId,
      eventIndex: event.eventIndex,
    });
  }
  if (!eventRef || !canonicalEventRefKey(eventRef)) return null;
  return {
    eventRef: eventRef,
    title: safeText(event.title || event.label || event.name, "Canonical event"),
    summary: safeText(event.summary || event.activity || event.detail, ""),
    status: safeText(event.status, ""),
    sessionRef: cloneReference(event.sessionRef || event.canonicalSessionRef || (eventRef && eventRef.sessionStorageId ? {
      projectId: eventRef.projectId,
      sessionStorageId: eventRef.sessionStorageId,
    } : null)),
    updatedAt: typeof event.updatedAt === "number" ? event.updatedAt : null,
  };
}

// Related work is modelled as a flat list of links to top-level canonical
// project sessions. The server already filtered these by ACL and parentage, and
// the model keeps only a title plus the exact ProjectRef/SessionRef needed to
// navigate. No worker roles, nested children, task refs, statuses, or attempt
// history are carried, so nothing in this shape can leak them into the UI.
function cloneRelatedSessions(value) {
  var list = Array.isArray(value) ? value : (value ? [value] : []);
  var seen = {};
  var links = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i] || {};
    var sessionRef = cloneReference(item.sessionRef || item.canonicalSessionRef);
    if (!sessionRef || !sessionRef.projectId || !sessionRef.sessionStorageId) continue;
    var key = sessionRef.projectId + ":" + sessionRef.sessionStorageId;
    if (seen[key]) continue;
    seen[key] = true;
    links.push({
      sessionRef: sessionRef,
      projectRef: cloneReference(item.projectRef) || { projectId: sessionRef.projectId },
      title: safeText(item.title || item.label || item.name, "Project session"),
    });
  }
  return links;
}

function cloneDisposition(value) {
  if (!value || typeof value !== "object") return null;
  var status = safeText(value.status, "");
  if (status !== "done" && status !== "needs_input") return null;
  var revision = Number(value.revision);
  return {
    status: status,
    source: safeText(value.source, ""),
    at: typeof value.at === "number" ? value.at : null,
    note: safeText(value.note, ""),
    // Concurrency token echoed back with any decision; pre-revision records
    // count as 1, matching the server.
    revision: isFinite(revision) && revision >= 1 ? Math.floor(revision) : 1,
  };
}

export function cloneTopic(topic, fallbackProjectRef, fallbackGroup) {
  var value = topic || {};
  var topicRef = cloneReference(value.topicRef || value.ref);
  if (!topicRef && (value.topicId || value.topicKey || value.id)) {
    topicRef = { topicId: value.topicId || value.topicKey || value.id };
  }
  if (!topicRef || !topicRefKey(topicRef)) return null;
  var rawGroup = value.group || fallbackGroup;
  var groupProjectRef = rawGroup && typeof rawGroup === "object" ? rawGroup.projectRef : null;
  var groupName = rawGroup && typeof rawGroup === "object" ? rawGroup.kind || rawGroup.type : rawGroup;
  var projectRef = cloneReference(value.projectRef || value.targetProject || groupProjectRef || fallbackProjectRef);
  var status = safeText(value.status, "quiet").toLowerCase().replace(/\s+/g, "_");
  var unread = Number.isInteger(value.unreadCount) ? value.unreadCount
    : (Number.isInteger(value.unread) ? value.unread : 0);
  var attention = !!(value.attention || value.needsAttention || value.attentionCount > 0);
  var decisions = safeTopicList(value.decisions || value.decisionLog).map(cloneDecision).filter(Boolean);
  var events = safeTopicList(value.canonicalEvents || value.events || value.eventRefs)
    .map(cloneCanonicalEvent).filter(Boolean);
  return {
    topicRef: topicRef,
    projectRef: projectRef,
    group: safeText(groupName || value.category || fallbackGroup, fallbackGroup || "uncategorised").toLowerCase(),
    title: safeText(value.title || value.name || value.label, "Untitled topic"),
    status: status,
    // Derived owner-facing state. The server guarantees a projected topic is
    // never blank: unproven historical topics arrive as needs_input with a
    // stateSource naming why.
    workState: safeText(value.workState, ""),
    awaitingAcceptance: !!value.awaitingAcceptance,
    stateSource: safeText(value.stateSource, ""),
    ownerDisposition: cloneDisposition(value.ownerDisposition),
    unread: unread > 0 ? unread : 0,
    attention: attention,
    rollingSummary: safeText(value.rollingSummary || value.summary || value.latestSummary, ""),
    currentActivity: safeText(value.currentActivity || value.activity, ""),
    decisions: decisions,
    relatedSessions: cloneRelatedSessions(value.relatedSessions),
    canonicalEvents: events,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
  };
}

function topicGroupIs(group, name) {
  var value = String(group || "").toLowerCase().replace(/[- ]/g, "_");
  return value === name || value === name + "_project" || value === name + "_projects" ||
    (name === "cross_project" && value === "crossproject");
}

export function buildTopicBuckets(message, projects, projectKey) {
  var buckets = { projects: {}, crossProject: [], uncategorised: [], all: [] };
  var seen = {};
  for (var pi = 0; pi < projects.length; pi++) buckets.projects[projectKey(projects[pi].projectRef)] = [];

  function add(raw, fallbackProjectRef, fallbackGroup) {
    var topic = cloneTopic(raw, fallbackProjectRef, fallbackGroup);
    if (!topic) return;
    var key = topicRefKey(topic.topicRef);
    if (seen[key]) return;
    seen[key] = true;
    var projectId = projectKey(topic.projectRef);
    var group = topic.group;
    if (topicGroupIs(group, "cross_project") || topicGroupIs(group, "cross")) {
      buckets.crossProject.push(topic);
    } else if (topicGroupIs(group, "uncategorised") || topicGroupIs(group, "uncategorized")) {
      buckets.uncategorised.push(topic);
    } else if (projectId && buckets.projects[projectId]) {
      buckets.projects[projectId].push(topic);
    } else {
      buckets.uncategorised.push(topic);
    }
    buckets.all.push(topic);
  }

  for (var i = 0; i < projects.length; i++) {
    var project = projects[i];
    var projectTopics = safeTopicList(project._rawTopics);
    for (var pti = 0; pti < projectTopics.length; pti++) add(projectTopics[pti], project.projectRef, "project");
  }
  var rawTopics = safeTopicList(message && message.topics);
  for (var ti = 0; ti < rawTopics.length; ti++) add(rawTopics[ti], null, "");

  var groups = message && (message.topicGroups || message.topicProjection && message.topicProjection.groups || message.groups) || null;
  if (Array.isArray(groups)) {
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi] || {};
      var groupTopics = safeTopicList(group.topics || group.items);
      for (var gti = 0; gti < groupTopics.length; gti++) add(groupTopics[gti], group.projectRef || null, group.group || group.kind || group.key || group.category || "");
    }
  } else if (groups && typeof groups === "object") {
    var groupKeys = Object.keys(groups);
    for (var gki = 0; gki < groupKeys.length; gki++) {
      var groupKey = groupKeys[gki];
      var groupValue = groups[groupKey];
      var groupItems = safeTopicList(groupValue && (groupValue.topics || groupValue.items) || groupValue);
      var fallbackProjectRef = groupValue && groupValue.projectRef ||
        (buckets.projects[groupKey] ? { projectId: groupKey } : null);
      for (var gvi = 0; gvi < groupItems.length; gvi++) add(groupItems[gvi], fallbackProjectRef, groupValue && (groupValue.group || groupValue.kind) || groupKey);
    }
  }
  var cross = safeTopicList(message && (message.crossProjectTopics || message.crossProject));
  for (var ci = 0; ci < cross.length; ci++) add(cross[ci], null, "cross_project");
  var uncategorised = safeTopicList(message && (message.uncategorisedTopics || message.uncategorizedTopics || message.uncategorised || message.uncategorized));
  for (var ui = 0; ui < uncategorised.length; ui++) add(uncategorised[ui], null, "uncategorised");
  return buckets;
}

// The single source of truth for topic-section order and visibility, shared by
// the desktop sidebar and the mobile sheet so the two cannot drift.
//
// Order: Uncategorised, then projects, then Cross-project, then one compact
// collapsed Done section. Done topics leave their home section -- resolved
// work must not crowd the live list -- but they never disappear: the Done
// section keeps them discoverable and reviewable. A project with a persistent
// coordinator hierarchy remains visible even when it has no open topics; a
// category with neither topics nor hierarchy yields no descriptor at all.
export function coopTopicSections(model) {
  var value = model || {};
  var sections = [];
  var doneTopics = [];
  function splitDone(topics) {
    var open = [];
    var list = Array.isArray(topics) ? topics : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].workState === "done") doneTopics.push(list[i]);
      else open.push(list[i]);
    }
    return open;
  }
  var uncategorised = splitDone(value.uncategorisedTopics);
  if (uncategorised.length > 0) {
    sections.push({ kind: "uncategorised", label: "Uncategorised", projectRef: null, icon: "", topics: uncategorised });
  }
  var projects = Array.isArray(value.projects) ? value.projects : [];
  for (var i = 0; i < projects.length; i++) {
    var project = projects[i] || {};
    var projectTopics = splitDone(project.topics);
    var hierarchy = project.summary && Array.isArray(project.summary.coordinatorTree)
      ? project.summary.coordinatorTree : [];
    if (projectTopics.length === 0 && hierarchy.length === 0) continue;
    sections.push({
      kind: "project",
      label: safeText(project.title, "Project"),
      projectRef: cloneReference(project.projectRef),
      icon: safeText(project.icon, ""),
      topics: projectTopics,
      hierarchy: hierarchy,
    });
  }
  var cross = splitDone(value.crossProjectTopics);
  if (cross.length > 0) {
    sections.push({ kind: "cross_project", label: "Cross-project", projectRef: null, icon: "", topics: cross });
  }
  if (doneTopics.length > 0) {
    sections.push({ kind: "done", label: "Done", projectRef: null, icon: "", topics: doneTopics });
  }
  return sections;
}

export function topicText(topic) {
  return [topic && topic.title, topic && topic.status, topic && topic.rollingSummary]
    .concat(topic && topic.decisions || []).join(" ");
}

export function topicMatches(topic, query) {
  return !query || topicText(topic).toLowerCase().indexOf(query) !== -1;
}

function actionType(action) {
  return {
    rename: "coop_topic_rename",
    move: "coop_topic_move",
    merge: "coop_topic_merge",
    split: "coop_topic_split",
    close: "coop_topic_close",
    reopen: "coop_topic_reopen",
  }[action] || "";
}

export function buildCoopTopicActionMessage(action, topic, values) {
  var type = actionType(action);
  var value = values || {};
  var knownTopic = topic || null;
  if (!type || !knownTopic) return null;
  var payload = { type: type };
  payload.topicRef = cloneReference(knownTopic.topicRef);
  payload.projectRef = cloneReference(knownTopic.projectRef);
  if (value.title) payload.title = safeText(value.title, "");
  if (value.targetProjectRef) payload.targetProjectRef = cloneReference(value.targetProjectRef);
  if (value.targetTopicRef) payload.targetTopicRef = cloneReference(value.targetTopicRef);
  if (value.canonicalEventRef) payload.canonicalEventRef = cloneReference(value.canonicalEventRef);
  return payload;
}

var DISPOSITION_VERBS = {
  accept_done: true,
  request_changes: true,
  keep_waiting: true,
  reopen: true,
};

// One explicit owner decision on one topic's disposition. Topic-scoped by
// construction (a single topicRef, no bulk form) and carrying the state the
// owner was actually looking at: the server re-derives from live evidence and
// rejects the decision as stale if the row changed underneath them.
export function buildCoopTopicDispositionMessage(topic, verb, values) {
  if (!topic || !topic.topicRef || !DISPOSITION_VERBS[verb]) return null;
  var value = values || {};
  return {
    type: "coop_topic_disposition",
    requestId: safeText(value.requestId, ""),
    topicRef: cloneReference(topic.topicRef),
    projectRef: cloneReference(topic.projectRef),
    verb: verb,
    expectedState: safeText(topic.workState, ""),
    // The revision of the record the owner was looking at (0 = no record).
    // The server rejects a mismatch, so a decision against a superseded
    // record -- even one showing the same state label -- never lands.
    expectedRevision: topic.ownerDisposition && topic.ownerDisposition.revision || 0,
    note: safeText(value.note, ""),
  };
}
