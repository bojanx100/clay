// Read-only, bounded project summaries rendered only in the global Coop scope.
// Project transcripts, session trees, and worker attempts remain canonical to
// their project and are deliberately absent from this model.

var projection = null;

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
  if (typeof project.channel.localId === "number") {
    return send({ type: "switch_session", id: project.channel.localId }) !== false;
  }
  if (!project.slug) return false;
  return send({ type: "ensure_coop_channel", projectSlug: project.slug }) !== false;
}
