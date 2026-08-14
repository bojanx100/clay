// Pure normalization for one project carried by the canonical Coop projection.

import { safeTopicList } from './sidebar-coop-topic-model.js';
import { cloneCoopProjectHierarchy } from './sidebar-coop-hierarchy-model.js';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback) {
  var text = typeof value === "string" ? value.trim() : "";
  return text || fallback || "";
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
    metrics: {
      activeCoordinators: Number.isInteger(value.metrics && value.metrics.activeCoordinators)
        ? value.metrics.activeCoordinators : 0,
      activeWorkers: Number.isInteger(value.metrics && value.metrics.activeWorkers)
        ? value.metrics.activeWorkers : 0,
      activeTaskWorkers: Number.isInteger(value.metrics && value.metrics.activeTaskWorkers)
        ? value.metrics.activeTaskWorkers : 0,
      health: safeText(value.metrics && value.metrics.health, "quiet"),
    },
    coordinatorTree: cloneCoopProjectHierarchy(value.coordinatorTree),
  };
}

export function cloneGlobalCoopProject(project) {
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
