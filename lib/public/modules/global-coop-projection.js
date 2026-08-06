// Read-only, bounded project lenses rendered only in the global Coop scope.
// They expose stable references and task state, never copied transcripts.

import { store } from './store.js';

var projection = null;
var LENS_QUERY_KEY = "coopProject";

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
    summary: cloneSummary(project && project.summary),
  };
}

function cloneProjection(message) {
  if (!message || message.type !== "global_coop_projection") return null;
  return {
    type: message.type,
    coop: message.coop || null,
    projects: safeArray(message.projects).map(cloneProject),
  };
}

function itemText(item) {
  return [item && item.title, item && item.status, item && item.activity, item && item.summary].join(" ");
}

function projectMatches(project, query) {
  if (!query) return true;
  var summary = project.summary || {};
  var text = [project.title, project.slug, summary.nextAction]
    .concat(summary.goals || [], summary.decisions || [])
    .concat((summary.activeWork || []).map(itemText))
    .concat((summary.attention || []).map(itemText))
    .concat((summary.outcomes || []).map(itemText))
    .join(" ").toLowerCase();
  return text.indexOf(query) !== -1;
}

export function setGlobalCoopProjection(message) {
  projection = cloneProjection(message);
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

export function projectLensPath(pathname, search, projectRef) {
  var params = new URLSearchParams(search || "");
  var projectId = globalProjectRefKey(projectRef);
  if (projectId) params.set(LENS_QUERY_KEY, projectId);
  else params.delete(LENS_QUERY_KEY);
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

function lensForProject(project) {
  if (!project || !project.projectRef) return null;
  return {
    projectRef: project.projectRef,
    title: project.title || "Project",
    slug: project.slug || "",
  };
}

export function syncCoopLensFromUrl() {
  if (typeof location === "undefined" || location.pathname !== "/p/lead/") return false;
  var projectId = "";
  try { projectId = new URLSearchParams(location.search).get(LENS_QUERY_KEY) || ""; } catch (e) {}
  if (!projectId) {
    store.set({ activeCoopLens: null });
    return true;
  }
  var projects = projection && projection.projects || [];
  for (var i = 0; i < projects.length; i++) {
    if (globalProjectRefKey(projects[i].projectRef) !== projectId) continue;
    store.set({ activeCoopLens: lensForProject(projects[i]) });
    return true;
  }
  store.set({ activeCoopLens: null });
  return false;
}

export function buildGlobalCoopDisplayModel(searchQuery) {
  var query = safeText(searchQuery, "").toLowerCase();
  var projects = projection ? projection.projects : [];
  return {
    projects: projects.filter(function (project) { return projectMatches(project, query); }),
    hasProjection: !!projection,
  };
}

export function requestProjectChannel(project, send) {
  if (!project || !project.channel || typeof send !== "function") return false;
  var lens = lensForProject(project);
  if (!lens) return false;
  syncProjectLensUrl(lens.projectRef, "pushState");
  store.set({ activeCoopLens: lens });
  if (typeof project.channel.localId !== "number") return false;
  if (store.get("activeSessionId") === project.channel.localId && store.get("activeCoopHome")) return true;
  return send({ type: "switch_session", id: project.channel.localId }) !== false;
}

export function requestCoopHome(send) {
  syncProjectLensUrl(null, "pushState");
  store.set({ activeCoopLens: null });
  if (typeof send !== "function") return false;
  var coop = getGlobalCoopReference();
  if (!coop || typeof coop.localId !== "number") return false;
  if (store.get("activeSessionId") === coop.localId && store.get("activeCoopHome")) return true;
  return send({ type: "switch_session", id: coop.localId }) !== false;
}

export function requestCanonicalSession(sessionRef, send) {
  if (!sessionRef || typeof send !== "function") return false;
  return send({ type: "resolve_session_ref", sessionRef: sessionRef }) !== false;
}
