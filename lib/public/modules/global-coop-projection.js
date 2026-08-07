// Read-only, bounded project lenses rendered only in the global Coop scope.
// They expose stable references and task state, never copied transcripts.

import { store } from './store.js';
import {
  buildTopicBuckets,
  canonicalEventRefKey,
  cloneReference,
  safeTopicList,
  topicMatches,
  topicRefKey,
  topicText,
} from './sidebar-coop-topic-model.js';
import { canonicalTopicTitle, topicIdOf } from './coop-identity.js';

var projection = null;
var LENS_QUERY_KEY = "coopProject";
var TOPIC_QUERY_KEY = "coopTopic";
var PENDING_SELECTION_KEY = "pendingCoopSelection";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback) {
  var text = typeof value === "string" ? value.trim() : "";
  return text || fallback || "";
}

function stableProjectId(project) {
  return project && project.projectRef && typeof project.projectRef.projectId === "string"
    ? project.projectRef.projectId : "";
}

function cloneItem(item) {
  return {
    title: safeText(item && item.title, ""),
    status: safeText(item && item.status, ""),
    activity: safeText(item && item.activity, ""),
    summary: safeText(item && item.summary, ""),
    updatedAt: typeof (item && item.updatedAt) === "number" ? item.updatedAt : null,
    verifiedAt: typeof (item && item.verifiedAt) === "number" ? item.verifiedAt : null,
  };
}

function cloneCoordinatorNode(node) {
  var value = node || {};
  return {
    sessionRef: value.sessionRef || null,
    title: safeText(value.title, "Project work"),
    role: safeText(value.role, "worker"),
    status: safeText(value.status, "queued"),
    activity: safeText(value.activity, ""),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
    children: safeArray(value.children).map(cloneCoordinatorNode),
  };
}

function cloneSummary(summary) {
  var value = summary || {};
  return {
    goals: safeArray(value.goals).map(function (item) { return safeText(item, ""); }).filter(Boolean),
    decisions: safeArray(value.decisions).map(function (item) { return safeText(item, ""); }).filter(Boolean),
    activeWork: safeArray(value.activeWork).map(cloneItem),
    attention: safeArray(value.attention).map(cloneItem),
    outcomes: safeArray(value.outcomes).map(cloneItem),
    freshness: {
      updatedAt: typeof (value.freshness && value.freshness.updatedAt) === "number"
        ? value.freshness.updatedAt : null,
      stale: !!(value.freshness && value.freshness.stale),
    },
    nextAction: safeText(value.nextAction, "Open this project channel to set the next action."),
    metrics: {
      activeCoordinators: Number.isInteger(value.metrics && value.metrics.activeCoordinators)
        ? value.metrics.activeCoordinators : 0,
      activeWorkers: Number.isInteger(value.metrics && value.metrics.activeWorkers)
        ? value.metrics.activeWorkers : 0,
      health: safeText(value.metrics && value.metrics.health, "quiet"),
    },
    coordinatorTree: safeArray(value.coordinatorTree).map(cloneCoordinatorNode),
  };
}

function cloneProject(project) {
  var channel = project && project.channel || {};
  return {
    projectRef: project && project.projectRef || null,
    slug: safeText(project && project.slug, ""),
    title: safeText(project && project.title, "Project"),
    icon: safeText(project && project.icon, ""),
    channel: {
      sessionRef: channel.sessionRef || null,
      localId: typeof channel.localId === "number" ? channel.localId : null,
      isLens: !!channel.isLens,
    },
    _rawTopics: safeTopicList(project && (project.topics || project.topicList || project.summary && project.summary.topics)),
    topics: [],
    summary: cloneSummary(project && project.summary),
  };
}

function cloneProjection(message) {
  if (!message || message.type !== "global_coop_projection") return null;
  var projects = safeArray(message.projects).map(cloneProject);
  var buckets = buildTopicBuckets(message, projects, globalProjectRefKey);
  for (var i = 0; i < projects.length; i++) {
    var projectId = globalProjectRefKey(projects[i].projectRef);
    projects[i].topics = buckets.projects[projectId] || [];
    delete projects[i]._rawTopics;
  }
  return {
    type: message.type,
    coop: message.coop || null,
    projects: projects,
    topics: buckets.all,
    crossProjectTopics: buckets.crossProject,
    uncategorisedTopics: buckets.uncategorised,
  };
}

function projectMatches(project, query) {
  if (!query) return true;
  var text = [project.title, project.slug]
    .concat((project.topics || []).map(topicText))
    .join(" ").toLowerCase();
  return text.indexOf(query) !== -1;
}

export function setGlobalCoopProjection(message) {
  projection = cloneProjection(message);
  var pending = store.get(PENDING_SELECTION_KEY);
  if (pending && pending.topicRef && !findGlobalCoopTopic(pending.topicRef, pending.projectRef)) clearPendingSelection(true);
  else if (pending && pending.projectRef && !findGlobalCoopProject(pending.projectRef)) clearPendingSelection(true);
  // The projection is module-local, so a rename that arrives without any store
  // change would leave canonical titles stale on every surface that reads it
  // (notably the composer lens caption). Bump a version key so subscribers
  // re-render on projection-only updates too.
  store.set({ coopProjectionVersion: (store.get("coopProjectionVersion") || 0) + 1 });
  return projection;
}

export function clearGlobalCoopProjection() {
  projection = null;
}

export function getGlobalCoopProjection() {
  return projection;
}

export function getGlobalCoopReference() {
  return projection && projection.coop || null;
}

export function globalCoopProjectionSignature() {
  return projection ? JSON.stringify(projection) : "";
}

export function globalProjectRefKey(ref) {
  return ref && ref.projectId ? String(ref.projectId) : "";
}

export function projectLensPath(pathname, search, projectRef, topicRef) {
  var params = new URLSearchParams(search || "");
  var projectId = globalProjectRefKey(projectRef);
  if (projectId) params.set(LENS_QUERY_KEY, projectId);
  else params.delete(LENS_QUERY_KEY);
  var topicId = topicRefKey(topicRef);
  if (topicId) params.set(TOPIC_QUERY_KEY, topicId);
  else params.delete(TOPIC_QUERY_KEY);
  var query = params.toString();
  return String(pathname || "/p/lead/") + (query ? "?" + query : "");
}

function syncProjectLensUrl(projectRef, method) {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  if (location.pathname !== "/p/lead/") return;
  var next = projectLensPath(location.pathname, location.search, projectRef);
  if (next === location.pathname + location.search) return;
  history[method || "pushState"](null, "", next);
}

function syncTopicLensUrl(projectRef, topicRef, method) {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  if (location.pathname !== "/p/lead/") return;
  var next = projectLensPath(location.pathname, location.search, projectRef, topicRef);
  if (next === location.pathname + location.search) return;
  history[method || "pushState"](null, "", next);
}

function lensForProject(project) {
  if (!project || !project.projectRef) return null;
  return {
    projectRef: project.projectRef,
    title: project.title || "Project",
    slug: project.slug || "",
  };
}

export function syncCoopLensFromUrl(send) {
  if (typeof location === "undefined" || location.pathname !== "/p/lead/") return false;
  var projectId = "";
  var topicId = "";
  try { projectId = new URLSearchParams(location.search).get(LENS_QUERY_KEY) || ""; } catch (e) {}
  try { topicId = new URLSearchParams(location.search).get(TOPIC_QUERY_KEY) || ""; } catch (e) {}
  var projects = projection && projection.projects || [];
  if (topicId) {
    var topics = projection && projection.topics || [];
    for (var ti = 0; ti < topics.length; ti++) {
      if (topicRefKey(topics[ti].topicRef) !== topicId) continue;
      if (projectId && globalProjectRefKey(topics[ti].projectRef) !== projectId) continue;
      if (typeof send !== "function") return false;
      if (topicRefKey(store.get("activeCoopTopicRef")) === topicId &&
          globalProjectRefKey(store.get("activeCoopProjectRef")) === projectId &&
          !store.get(PENDING_SELECTION_KEY)) return true;
      return beginCoopSelection(topics[ti].topicRef, topics[ti].projectRef, "topic", "replaceState", send);
    }
    restoreCommittedUrl();
    return false;
  }
  if (!projectId) {
    if (typeof send !== "function") return false;
    if (!store.get("activeCoopTopicRef") && !store.get("activeCoopProjectRef") && !store.get(PENDING_SELECTION_KEY)) return true;
    return beginCoopSelection(null, null, "canonical", "replaceState", send);
  }
  for (var i = 0; i < projects.length; i++) {
    if (globalProjectRefKey(projects[i].projectRef) !== projectId) continue;
    if (typeof send !== "function") return false;
    if (!store.get("activeCoopTopicRef") &&
        globalProjectRefKey(store.get("activeCoopProjectRef")) === projectId &&
        !store.get(PENDING_SELECTION_KEY)) return true;
    return beginCoopSelection(null, projects[i].projectRef, "canonical", "replaceState", send);
  }
  clearActiveTopicLens(true);
  return false;
}

function clearActiveTopicLens(stale) {
  store.set({ activeCoopLens: null, activeCoopTopicRef: null, activeCoopProjectRef: null, activeCoopTopicStale: !!stale });
}

function currentCoopUrl() {
  if (typeof location === "undefined") return "";
  var topicRef = store.get("activeCoopTopicRef") || (store.get("activeCoopLens") || {}).topicRef || null;
  var projectRef = store.get("activeCoopProjectRef") || (store.get("activeCoopLens") || {}).projectRef || null;
  return projectLensPath(location.pathname, location.search, projectRef, topicRef);
}

function restoreCommittedUrl() {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  var previous = store.get("committedCoopLensUrl") || currentCoopUrl();
  if (!previous || location.pathname !== "/p/lead/") return;
  if (previous !== location.pathname + location.search) history.replaceState(null, "", previous);
}

function clearPendingSelection(restore) {
  var pending = store.get(PENDING_SELECTION_KEY);
  if (!pending) return null;
  if (restore && pending.previousUrl) {
    if (typeof history !== "undefined" && typeof location !== "undefined" && location.pathname === "/p/lead/" && pending.previousUrl !== location.pathname + location.search) {
      history.replaceState(null, "", pending.previousUrl);
    }
  }
  store.set({ pendingCoopSelection: null });
  return pending;
}

function selectionMatches(left, topicRef, projectRef) {
  return topicRefKey(left && left.topicRef) === topicRefKey(topicRef) &&
    globalProjectRefKey(left && left.projectRef) === globalProjectRefKey(projectRef);
}

function setActiveTopicLens(topic) {
  var lens = {
    projectRef: cloneReference(topic.projectRef),
    topicRef: cloneReference(topic.topicRef),
    title: topic.title || "Topic",
  };
  store.set({
    activeCoopLens: lens,
    activeCoopTopicRef: lens.topicRef,
    activeCoopProjectRef: lens.projectRef,
    activeCoopTopicStale: false,
  });
}

export function buildGlobalCoopDisplayModel(searchQuery) {
  var query = safeText(searchQuery, "").toLowerCase();
  var projects = projection ? projection.projects : [];
  return {
    projects: projects.filter(function (project) { return projectMatches(project, query); }),
    hasProjection: !!projection,
    allTopics: (projection && projection.topics || []).filter(function (topic) { return topicMatches(topic, query); }),
    crossProjectTopics: (projection && projection.crossProjectTopics || []).filter(function (topic) { return topicMatches(topic, query); }),
    uncategorisedTopics: (projection && projection.uncategorisedTopics || []).filter(function (topic) { return topicMatches(topic, query); }),
  };
}

export function getGlobalCoopTopics() {
  return projection && projection.topics || [];
}

export function findGlobalCoopTopic(topicRef, projectRef) {
  var key = topicRefKey(topicRef);
  if (!key) return null;
  var topics = getGlobalCoopTopics();
  for (var i = 0; i < topics.length; i++) {
    if (topicRefKey(topics[i].topicRef) !== key) continue;
    if (projectRef && globalProjectRefKey(topics[i].projectRef) !== globalProjectRefKey(projectRef)) continue;
    return topics[i];
  }
  return null;
}

function findGlobalCoopProject(projectRef) {
  var key = globalProjectRefKey(projectRef);
  var projects = projection && projection.projects || [];
  for (var i = 0; i < projects.length; i++) {
    if (globalProjectRefKey(projects[i].projectRef) === key) return projects[i];
  }
  return null;
}

// What the current lens should be *called*, resolved against the live
// projection on every read. The lens itself only stores refs plus a title
// snapshot taken when the row was tapped; that snapshot goes stale whenever the
// projection is rebuilt, the socket reconnects, or history is replayed, so it is
// used only as a bridge until the canonical record is back.
export function activeCoopLensDisplay() {
  var lens = store.get("activeCoopLens");
  if (!lens) return null;
  if (lens.topicRef) {
    var topic = findGlobalCoopTopic(lens.topicRef, lens.projectRef);
    // Hand the ref's own id through, so a snapshot that IS the id is still
    // recognised as an identifier while the canonical record is unresolved.
    return { kind: "topic", title: canonicalTopicTitle(topic, lens.title, topicIdOf(lens.topicRef)) };
  }
  if (lens.projectRef) {
    var project = findGlobalCoopProject(lens.projectRef);
    var projectTitle = project && typeof project.title === "string" ? project.title.trim() : "";
    return { kind: "project", title: projectTitle || (typeof lens.title === "string" ? lens.title.trim() : "") };
  }
  return null;
}

export function getActiveCoopSelection() {
  if (!store.get("activeCoopHome")) return null;
  var topicRef = store.get("activeCoopTopicRef") || (store.get("activeCoopLens") || {}).topicRef;
  if (!topicRef) return null;
  var projectRef = store.get("activeCoopProjectRef") || (store.get("activeCoopLens") || {}).projectRef || null;
  var topic = findGlobalCoopTopic(topicRef, projectRef);
  if (!topic) return null;
  return { topicRef: cloneReference(topic.topicRef), projectRef: cloneReference(topic.projectRef) };
}

// Preserve the existing project-lens ingress contract while adding the
// stricter TopicRef+ProjectRef pair for topic selections.
export function getActiveCoopIngressRefs() {
  if (!store.get("activeCoopHome") || isActiveCoopTopicStale()) return null;
  var topicSelection = getActiveCoopSelection();
  if (topicSelection) return topicSelection;
  var lens = store.get("activeCoopLens") || {};
  return lens.projectRef ? { topicRef: null, projectRef: cloneReference(lens.projectRef) } : null;
}

export function isActiveCoopTopicStale() {
  var topicRef = store.get("activeCoopTopicRef") || (store.get("activeCoopLens") || {}).topicRef;
  return !!store.get("activeCoopTopicStale") || (!!topicRef && !getActiveCoopSelection());
}

export function requestProjectChannel(project, send) {
  if (!project || !project.channel || typeof send !== "function") return false;
  var lens = lensForProject(project);
  if (!lens) return false;
  return beginCoopSelection(null, lens.projectRef, "canonical", "pushState", send);
}

export function requestCoopHome(send) {
  return requestAllCoopTopics(send);
}

export function requestAllCoopTopics(send) {
  return beginCoopSelection(null, null, "canonical", "pushState", send);
}

function selectionMessage(topicRef, projectRef, historyScope) {
  var message = {
    type: "coop_topic_select",
    topicRef: cloneReference(topicRef),
    projectRef: cloneReference(projectRef),
  };
  if (historyScope) message.historyScope = historyScope;
  return message;
}

function beginCoopSelection(topicRef, projectRef, historyScope, historyMethod, send) {
  if (typeof send !== "function") return false;
  var coop = getGlobalCoopReference();
  if (!coop || typeof coop.localId !== "number") return false;
  clearPendingSelection(true);
  store.set({
    pendingCoopSelection: {
      topicRef: cloneReference(topicRef),
      projectRef: cloneReference(projectRef),
      historyScope: historyScope,
      historyMethod: historyMethod || "pushState",
      previousUrl: store.get("committedCoopLensUrl") || currentCoopUrl(),
      coopLocalId: coop.localId,
    },
  });
  if (send(selectionMessage(topicRef, projectRef, historyScope)) === false) {
    clearPendingSelection(true);
    return false;
  }
  return true;
}

export function requestCoopTopic(topic, send) {
  var selected = topic && findGlobalCoopTopic(topic.topicRef, topic.projectRef);
  if (!selected) return false;
  return beginCoopSelection(selected.topicRef, selected.projectRef, "topic", "pushState", send);
}

function commitPendingSelection(pending) {
  var selected = pending.topicRef ? findGlobalCoopTopic(pending.topicRef, pending.projectRef) : null;
  if (pending.topicRef && !selected) return false;
  if (pending.topicRef) {
    syncTopicLensUrl(selected.projectRef, selected.topicRef, pending.historyMethod);
    setActiveTopicLens(selected);
  } else if (pending.projectRef) {
    var project = findGlobalCoopProject(pending.projectRef);
    if (!project) return false;
    var lens = lensForProject(project);
    syncProjectLensUrl(lens.projectRef, pending.historyMethod);
    store.set({ activeCoopLens: lens, activeCoopTopicRef: null, activeCoopProjectRef: lens.projectRef, activeCoopTopicStale: false });
  } else {
    syncProjectLensUrl(null, pending.historyMethod);
    clearActiveTopicLens();
  }
  if (typeof location !== "undefined") store.set({ committedCoopLensUrl: location.pathname + location.search });
  return true;
}

export function handleCoopTopicSelected(message) {
  if (!message || message.type !== "coop_topic_selected") return false;
  var pending = store.get(PENDING_SELECTION_KEY);
  if (!pending) return true;
  if (!message.ok || !selectionMatches(message, pending.topicRef, pending.projectRef)) {
    clearPendingSelection(true);
    return true;
  }
  var coop = getGlobalCoopReference();
  if (!coop || coop.localId !== pending.coopLocalId) {
    clearPendingSelection(true);
    return true;
  }
  if (!commitPendingSelection(pending)) {
    clearPendingSelection(true);
    return true;
  }
  store.set({ pendingCoopSelection: null });
  return true;
}

export function handleCoopTopicResult(message) {
  if (!message || message.type !== "coop_topic_result") return false;
  store.set({ lastCoopTopicResult: {
    operation: message.operation || "",
    ok: !!message.ok,
    code: message.code || null,
    topicRefs: cloneReference(message.topicRefs || null),
  } });
  return true;
}

export function handleCanonicalEventResolved(message) {
  if (!message || message.type !== "canonical_event_resolved") return false;
  store.set({ lastCanonicalEventResolution: {
    ok: !!message.ok,
    code: message.code || null,
    topicRef: cloneReference(message.topicRef || null),
    eventRef: cloneReference(message.eventRef || null),
    turnRef: cloneReference(message.turnRef || null),
  } });
  return true;
}

export function requestCanonicalEvent(eventRef, topicRef, projectRef, send) {
  var selected = findGlobalCoopTopic(topicRef, projectRef);
  var exactEvent = null;
  if (selected) {
    for (var i = 0; i < selected.canonicalEvents.length; i++) {
      if (canonicalEventRefKey(selected.canonicalEvents[i].eventRef) === canonicalEventRefKey(eventRef)) {
        exactEvent = selected.canonicalEvents[i].eventRef;
        break;
      }
    }
  }
  if (!exactEvent || typeof send !== "function") return false;
  return send({ type: "resolve_canonical_event", eventRef: cloneReference(exactEvent), topicRef: cloneReference(selected.topicRef), projectRef: cloneReference(selected.projectRef) }) !== false;
}

export function requestCanonicalSession(sessionRef, send) {
  if (!sessionRef || typeof send !== "function") return false;
  return send({ type: "resolve_session_ref", sessionRef: sessionRef }) !== false;
}
