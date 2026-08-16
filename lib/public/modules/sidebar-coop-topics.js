// Reference-only Coop topic rows and the ordered topic sections.
//
// Desktop and mobile both render through renderCoopTopicSections so category
// order and the "omit empty wrappers" rule cannot drift between them. Each row
// carries navigation plus a collapsed expander listing related top-level
// project sessions. Lifecycle changes come from ordinary owner language in the
// selected Thread; no decision control or card is rendered here.

import { sendUserAction } from './app-connection.js';
import { buildCoopTopicActionMessage, coopTopicSections } from './sidebar-coop-topic-model.js';
import { createCoopTopicRow } from './sidebar-coop-topic-row.js';
import {
  findGlobalCoopTopic,
  requestAllCoopTopics,
  requestCanonicalSession,
  requestCoopTopic,
  requestMainCoopLens,
  activeCoopLensScope,
} from './global-coop-projection.js';
import { renderCoopNowIndex } from './coop-action-queue-ui.js';
import { renderCoopProjectHierarchy } from './sidebar-coop-hierarchy.js';

function text(value, fallback) {
  var valueText = typeof value === "string" ? value.trim() : "";
  return valueText || fallback || "";
}

function finishNavigation(options) {
  if (options && typeof options.onNavigate === "function") options.onNavigate();
}

// Retained for callers that surface topic management outside primary navigation.
export function sendTopicAction(action, topic, values, transport) {
  var knownTopic = topic && findGlobalCoopTopic(topic.topicRef, topic.projectRef);
  var payload = buildCoopTopicActionMessage(action, knownTopic, values);
  var send = typeof transport === "function" ? transport : sendUserAction;
  if (!payload) return false;
  return send(payload);
}

// Returns the number of rows rendered. An empty list renders no wrapper at all,
// so a category that the owner cannot populate leaves no trace in the sidebar.
export function renderCoopTopicGroup(container, label, topics, options) {
  var opts = options || {};
  var items = Array.isArray(topics) ? topics : [];
  if (items.length === 0 && opts.allowEmpty !== true) return 0;
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
  for (var i = 0; i < items.length; i++) group.appendChild(createCoopTopicRow(items[i], opts));
  container.appendChild(group);
  return items.length;
}

export function renderCoopTopicOverview(container, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var overview = document.createElement("div");
  overview.className = prefix + "coop-topic-overview";

  // Two lenses, mutually exclusive. The active one is decided by the scope, not
  // by "no topic is selected" -- that test was true for Main, All and a project
  // lens alike, so it would light more than one of them at once.
  var scope = activeCoopLensScope();

  function lensButton(label, ariaLabel, isActive, onSelect) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = prefix + "coop-topic-all" + (isActive ? " active" : "");
    button.textContent = label;
    button.setAttribute("aria-label", ariaLabel);
    if (isActive) button.setAttribute("aria-current", "page");
    button.addEventListener("click", function () {
      if (onSelect(sendUserAction)) finishNavigation(opts);
    });
    overview.appendChild(button);
    return button;
  }

  lensButton("Main", "Open the main Coop conversation", scope === "main", requestMainCoopLens);
  lensButton("All", "Open the complete Coop history, including internal activity",
    scope === "canonical", requestAllCoopTopics);

  container.appendChild(overview);
}

export function renderCoopProjectTopics(container, topics, options) {
  var opts = Object.assign({}, options || {}, { showHeading: false });
  return renderCoopTopicGroup(container, "Threads", topics, opts);
}

function appendProjectSection(container, section, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var group = document.createElement("section");
  group.className = prefix + "coop-project-control-plane";
  group.setAttribute("aria-label", text(section.label, "Project") + " coordinator");
  var rendered = renderCoopProjectHierarchy(group, section.hierarchy, opts);
  if (rendered === 0) return 0;
  container.appendChild(group);
  return rendered;
}

function controlStatusLabel(status) {
  var value = text(status, "idle");
  if (value === "running") return "Running";
  if (value === "needs_input" || value === "waiting_user") return "Needs input";
  if (value === "reviewing") return "Reviewing";
  if (value === "blocked") return "Blocked";
  if (value === "failed") return "Failed";
  if (value === "completed") return "Done";
  if (value === "queued" || value === "ready") return "Waiting";
  return value.replace(/_/g, " ");
}

function controlStatusClass(status) {
  return text(status, "idle").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

function appendControlResult(container, result, options) {
  var opts = options || {};
  if (!result || !text(result.summary, "")) return 0;
  var prefix = opts.mobile ? "mobile-" : "";
  var row = document.createElement("button");
  row.type = "button";
  row.className = prefix + "coop-control-result";
  var topicId = result.topicRef && (result.topicRef.topicId || result.topicRef.topicKey ||
    result.topicRef.id || result.topicRef.key);
  if (topicId) row.dataset.topicId = String(topicId);
  row.setAttribute("aria-label", "Open " + text(result.title, result.role === "council" ?
    "Council result" : "Triage result"));
  var title = document.createElement("span");
  title.className = prefix + "coop-control-result-title";
  title.textContent = text(result.title, result.role === "council" ?
    "Council result" : "Triage result");
  row.appendChild(title);
  var summary = document.createElement("span");
  summary.className = prefix + "coop-control-result-summary";
  summary.textContent = text(result.summary, "Control review completed.");
  row.appendChild(summary);
  row.addEventListener("click", function () {
    if (!result.topicRef) return;
    var send = typeof opts.send === "function" ? opts.send : sendUserAction;
    if (!requestCoopTopic({ topicRef: result.topicRef, projectRef: null }, send)) return;
    finishNavigation(opts);
  });
  container.appendChild(row);
  return 1;
}

function appendControlPlaneSession(container, section, options) {
  var opts = options || {};
  if (!section || !section.sessionRef || !section.sessionRef.projectId ||
      !section.sessionRef.sessionStorageId) return 0;
  var prefix = opts.mobile ? "mobile-" : "";
  var status = text(section.status, "idle");
  var label = controlStatusLabel(status);
  var processing = status === "running" && section.processing === true;
  var row = document.createElement("button");
  row.type = "button";
  row.className = prefix + "coop-control-plane-row " + prefix +
    "coop-control-plane-" + text(section.role, "session") + " " + prefix +
    "coop-project-coordinator-status-" + controlStatusClass(status) +
    (processing ? " processing" : "");
  row.setAttribute("aria-label", "Open " + text(section.title, section.label) + ", " + label);
  var marker = document.createElement("span");
  marker.className = prefix + "coop-project-coordinator-marker";
  marker.setAttribute("aria-hidden", "true");
  row.appendChild(marker);
  var title = document.createElement("span");
  title.className = prefix + "coop-control-plane-title";
  title.textContent = text(section.title, section.label);
  row.appendChild(title);
  var state = document.createElement("span");
  state.className = prefix + "coop-control-plane-state";
  state.textContent = label;
  row.appendChild(state);
  row.addEventListener("click", function () {
    if (!section.sessionRef || !requestCanonicalSession(section.sessionRef, opts.send)) return;
    finishNavigation(opts);
  });
  container.appendChild(row);
  return 1;
}

function appendControlGroup(container, section, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var group = document.createElement("section");
  group.className = prefix + "coop-topic-group " + prefix + "coop-control-group " + prefix +
    "coop-control-group-" + text(section.kind, "sessions");
  var heading = document.createElement("div");
  heading.className = prefix + "coop-topic-group-heading";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", opts.headingLevel || "2");
  heading.textContent = section.label;
  group.appendChild(heading);

  var rendered = 0;
  if (section.kind === "project_coordinators") {
    var coordinators = Array.isArray(section.coordinators) ? section.coordinators : [];
    for (var i = 0; i < coordinators.length; i++) {
      rendered += appendProjectSection(group, coordinators[i], opts);
    }
  } else {
    var sessions = Array.isArray(section.sessions) ? section.sessions : [];
    for (var si = 0; si < sessions.length; si++) {
      rendered += appendControlPlaneSession(group, sessions[si], opts);
    }
    var results = Array.isArray(section.results) ? section.results : [];
    for (var ri = 0; ri < results.length; ri++) {
      rendered += appendControlResult(group, results[ri], opts);
    }
  }
  if (rendered === 0) return 0;
  container.appendChild(group);
  return rendered;
}

// Renders the ordered sections that coopTopicSections decided on. Ordering and
// emptiness live in the pure model, so this function only draws what it is
// given -- and both surfaces are given the same thing.
export function renderCoopTopicSections(container, model, options) {
  var opts = Object.assign({ send: sendUserAction }, options || {});
  var prefix = opts.mobile ? "mobile-" : "";
  // The server may continue sending its legacy Now projection during rollout,
  // but persistent project coordinators are now the only active-work surface.
  // Discard those entries at the shared desktop/mobile rendering boundary so
  // no separate Now section or duplicate execution row can appear.
  renderCoopNowIndex(container, Object.assign({}, opts, {
    entries: [],
    openTopic: function (entry) {
      var found = findGlobalCoopTopic(entry.topicRef, entry.projectRef);
      if (!found) return false;
      return requestCoopTopic(found, sendUserAction);
    },
  }));
  renderCoopTopicOverview(container, opts);
  if (!model.hasProjection) {
    var loading = document.createElement("div");
    loading.className = prefix + "global-coop-empty";
    loading.textContent = "Loading project conversations…";
    container.appendChild(loading);
    return container;
  }
  var sections = coopTopicSections(model);
  for (var i = 0; i < sections.length; i++) {
    if (sections[i].kind === "threads") {
      renderCoopTopicGroup(container, sections[i].label, sections[i].topics, opts);
    } else {
      appendControlGroup(container, sections[i], opts);
    }
  }
  return container;
}
