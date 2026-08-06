// Reference-only Coop topic rows. Topic actions remain available through their
// durable API, but the primary navigation stays a compact conversation list.

import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { buildCoopTopicActionMessage } from './sidebar-coop-topic-model.js';
import {
  findGlobalCoopTopic,
  globalProjectRefKey,
  requestAllCoopTopics,
  requestCoopTopic,
} from './global-coop-projection.js';

function text(value, fallback) {
  var valueText = typeof value === "string" ? value.trim() : "";
  return valueText || fallback || "";
}

function finishNavigation(options) {
  if (options && typeof options.onNavigate === "function") options.onNavigate();
}

function topicStatusClass(status) {
  return text(status, "quiet").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

function topicIsActive(topic) {
  var lens = store.get("activeCoopLens") || {};
  var active = store.get("activeCoopTopicRef") || lens.topicRef;
  var activeProject = store.get("activeCoopProjectRef") || lens.projectRef || null;
  if (!active || !topic || !topic.topicRef) return false;
  return String(active.topicId || active.topicKey || active.id || active.key || "") ===
    String(topic.topicRef.topicId || topic.topicRef.topicKey || topic.topicRef.id || topic.topicRef.key || "") &&
    globalProjectRefKey(activeProject) === globalProjectRefKey(topic.projectRef);
}

function topicActivity(topic) {
  if (topic && topic.currentActivity) return topic.currentActivity;
  return topic && topic.active ? "Active" : "";
}

function topicAriaLabel(topic, activity) {
  var parts = [text(topic.title, "Untitled topic"), text(topic.status, "quiet")];
  if (activity) parts.push(activity);
  if (topic.unread > 0) parts.push(topic.unread + " unread");
  if (topic.attention) parts.push("Needs attention");
  return parts.join(", ");
}

// Retained for callers that surface topic management outside primary navigation.
export function sendTopicAction(action, topic, values, transport) {
  var knownTopic = topic && findGlobalCoopTopic(topic.topicRef, topic.projectRef);
  var payload = buildCoopTopicActionMessage(action, knownTopic, values);
  var send = typeof transport === "function" ? transport : sendUserAction;
  if (!payload) return false;
  return send(payload);
}

function createTopicRow(topic, options) {
  var prefix = options.mobile ? "mobile-" : "";
  var activeTopic = topicIsActive(topic);
  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-topic-wrapper" + (activeTopic ? " active" : "");
  var row = document.createElement("button");
  row.type = "button";
  row.className = prefix + "coop-topic-row" + (activeTopic ? " active" : "") + (topic.attention ? " attention" : "");
  row.dataset.topicId = String(topic.topicRef.topicId || topic.topicRef.topicKey || topic.topicRef.id || topic.topicRef.key || "");
  var activity = topicActivity(topic);
  row.setAttribute("aria-label", topicAriaLabel(topic, activity));
  if (activeTopic) row.setAttribute("aria-current", "page");

  var marker = document.createElement("span");
  marker.className = prefix + "coop-topic-status coop-topic-status-" + topicStatusClass(topic.status);
  marker.setAttribute("aria-hidden", "true");
  row.appendChild(marker);

  var title = document.createElement("span");
  title.className = prefix + "coop-topic-title";
  title.textContent = text(topic.title, "Untitled topic");
  row.appendChild(title);

  if (activity) {
    var activityEl = document.createElement("span");
    activityEl.className = prefix + "coop-topic-activity";
    activityEl.textContent = activity;
    activityEl.setAttribute("aria-hidden", "true");
    row.appendChild(activityEl);
  }

  if (topic.unread > 0) {
    var unread = document.createElement("span");
    unread.className = prefix + "coop-topic-unread";
    unread.textContent = topic.unread > 99 ? "99+" : String(topic.unread);
    unread.setAttribute("aria-label", topic.unread + " unread messages");
    row.appendChild(unread);
  }

  row.addEventListener("click", function () {
    if (requestCoopTopic(topic, sendUserAction)) finishNavigation(options);
  });
  wrapper.appendChild(row);
  return wrapper;
}

export function renderCoopTopicGroup(container, label, topics, options) {
  if (!topics || topics.length === 0) return 0;
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var group = document.createElement("div");
  group.className = prefix + "coop-topic-group";
  if (opts.showHeading !== false) {
    var heading = document.createElement("div");
    heading.className = prefix + "coop-topic-group-heading";
    heading.setAttribute("role", "heading");
    heading.setAttribute("aria-level", opts.headingLevel || "2");
    heading.textContent = label;
    group.appendChild(heading);
  }
  for (var i = 0; i < topics.length; i++) group.appendChild(createTopicRow(topics[i], opts));
  container.appendChild(group);
  return topics.length;
}

export function renderCoopTopicOverview(container, model, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var overview = document.createElement("div");
  overview.className = prefix + "coop-topic-overview";
  var all = document.createElement("button");
  all.type = "button";
  all.className = prefix + "coop-topic-all" + (!store.get("activeCoopTopicRef") ? " active" : "");
  all.textContent = "All";
  all.setAttribute("aria-label", "Open all Coop conversations");
  if (!store.get("activeCoopTopicRef")) all.setAttribute("aria-current", "page");
  all.addEventListener("click", function () {
    if (requestAllCoopTopics(sendUserAction)) finishNavigation(opts);
  });
  overview.appendChild(all);
  container.appendChild(overview);
  if (opts.includeGroups !== false) {
    renderCoopTopicGroup(container, "Cross-project", model.crossProjectTopics, opts);
    renderCoopTopicGroup(container, "Uncategorised", model.uncategorisedTopics, opts);
  }
}

export function renderCoopProjectTopics(container, topics, options) {
  var opts = Object.assign({}, options || {}, { showHeading: false });
  return renderCoopTopicGroup(container, "Topics", topics, opts);
}
