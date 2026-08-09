// Reference-only Coop topic rows and the ordered topic sections.
//
// Desktop and mobile both render through renderCoopTopicSections so category
// order and the "omit empty wrappers" rule cannot drift between them. Each row
// carries exactly two controls beyond navigation: a conventional Close action
// behind an explicit confirmation, and a collapsed expander listing related
// top-level project sessions. Nothing else is offered inline.

import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { buildCoopTopicActionMessage, coopTopicSections } from './sidebar-coop-topic-model.js';
import { createTopicCloseButton } from './sidebar-coop-topic-close.js';
import { createTopicLinksExpander } from './sidebar-coop-topic-links.js';
import { createTopicReviewControl } from './sidebar-coop-topic-review.js';
import {
  findGlobalCoopTopic,
  globalProjectRefKey,
  requestAllCoopTopics,
  requestCoopTopic,
  requestMainCoopLens,
  activeCoopLensScope,
} from './global-coop-projection.js';
import { canonicalTopicTitle } from './coop-identity.js';
import { renderCoopActionQueue } from './coop-action-queue-ui.js';

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

// Exactly three owner-facing states. The server guarantees every projected
// topic carries one: task evidence, foreground work, a durable owner
// disposition, an explicit close, or the unlinked-historical default -- never
// a blank row, and never Working merely because the topic is open.
var WORK_STATE_LABELS = {
  working: "Working",
  needs_input: "Needs input",
  done: "Done",
};

// Every row states its own condition in words. Colour alone failed the owner
// outright: all 41 topics rendered the same small blue dot with no text, no
// differentiation and no legend, so the state was unreadable. Text is the
// primary signal now and the dot is only reinforcement.
function topicActivity(topic) {
  var state = topic && typeof topic.workState === "string" ? topic.workState : "";
  return WORK_STATE_LABELS[state] || "";
}

function topicAriaLabel(topic, activity) {
  // Announce only what is true. The old label always read "open", which is the
  // durable lifecycle status of every visible topic and told a screen-reader
  // user nothing; the derived state is announced when there is one.
  var parts = [canonicalTopicTitle(topic, "")];
  if (activity) parts.push(activity);
  if (topic.unread > 0) parts.push(topic.unread + " unread");
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
  var main = document.createElement("div");
  main.className = prefix + "coop-topic-main";
  var row = document.createElement("button");
  row.type = "button";
  var activity = topicActivity(topic);
  // The state affordance exists ONLY when there is a truthful state to show.
  // Reverting the fabricated label left the two-line layout and the dot behind,
  // so every stateless row rendered a blank reserved status line with a floating
  // dot above the title. No state means no dot, no reserved row, no wrap.
  row.className = prefix + "coop-topic-row" + (activeTopic ? " active" : "") +
    (topic.attention ? " attention" : "") + (activity ? " has-state" : "");
  row.dataset.topicId = String(topic.topicRef.topicId || topic.topicRef.topicKey || topic.topicRef.id || topic.topicRef.key || "");
  row.setAttribute("aria-label", topicAriaLabel(topic, activity));
  if (activeTopic) row.setAttribute("aria-current", "page");

  if (activity) {
    var marker = document.createElement("span");
    // Reinforces the text label; it is never the only carrier of the state.
    marker.className = prefix + "coop-topic-status " + prefix +
      "coop-topic-status-" + topicStatusClass(topic.workState);
    marker.setAttribute("aria-hidden", "true");
    row.appendChild(marker);
  }

  var title = document.createElement("span");
  title.className = prefix + "coop-topic-title";
  // Canonical record wins over anything the row was constructed with, and an
  // internal id ("auto-<hex>", a slug) never reaches the owner.
  title.textContent = canonicalTopicTitle(topic, "");
  row.appendChild(title);

  if (activity) {
    var activityEl = document.createElement("span");
    activityEl.className = prefix + "coop-topic-activity " + prefix +
      "coop-topic-activity-" + topicStatusClass(topic.workState);
    activityEl.textContent = activity;
    // Not aria-hidden: when a state IS shown it must be real, selectable,
    // translatable text rather than a colour a screen reader and a colour-blind
    // owner both miss.
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
  main.appendChild(row);
  main.appendChild(createTopicCloseButton(topic, options));
  wrapper.appendChild(main);
  // Only for topics whose state is a topic-level record (unproven historical
  // topics and prior owner decisions): the owner's compact per-topic decision
  // flow. Task-linked topics are decided in the Action required queue instead.
  var review = createTopicReviewControl(topic, options);
  if (review) wrapper.appendChild(review);
  // Null when the topic has no ACL-visible related sessions: no expander row and
  // no empty panel, matching the omit-empty-wrapper rule the sections follow.
  var expander = createTopicLinksExpander(topic, options);
  if (expander) wrapper.appendChild(expander);
  return wrapper;
}

// Returns the number of rows rendered. An empty list renders no wrapper at all,
// so a category that the owner cannot populate leaves no trace in the sidebar.
export function renderCoopTopicGroup(container, label, topics, options) {  if (!topics || topics.length === 0) return 0;
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

// Resolved topics stay discoverable without crowding the live list: one
// compact group, collapsed by default, that names its own count. Expanding is
// a per-session view toggle (shared desktop/mobile via the store), not a
// setting. An empty Done list never reaches here -- coopTopicSections omits
// the section entirely.
export function renderCoopTopicDoneSection(container, topics, options) {
  if (!topics || topics.length === 0) return 0;
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var open = !!store.get("coopDoneSectionOpen");
  var group = document.createElement("div");
  group.className = prefix + "coop-topic-group " + prefix + "coop-topic-done" + (open ? " open" : "");
  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = prefix + "coop-topic-done-toggle";
  toggle.textContent = (open ? "▾ " : "▸ ") + "Done (" + topics.length + ")";
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.setAttribute("aria-label", (open ? "Collapse" : "Expand") + " " + topics.length + " done topic" + (topics.length === 1 ? "" : "s"));
  toggle.addEventListener("click", function () {
    store.set({ coopDoneSectionOpen: !open });
  });
  group.appendChild(toggle);
  if (open) {
    for (var i = 0; i < topics.length; i++) group.appendChild(createTopicRow(topics[i], opts));
  }
  container.appendChild(group);
  return topics.length;
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
  return renderCoopTopicGroup(container, "Topics", topics, opts);
}

function appendProjectSection(container, section, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var projectId = section.projectRef && section.projectRef.projectId || "";
  var group = document.createElement("section");
  var lens = store.get("activeCoopLens");
  group.className = prefix + "global-coop-project" +
    (lens && lens.projectRef && lens.projectRef.projectId === projectId ? " active" : "");
  var heading = document.createElement("div");
  heading.className = prefix + "global-coop-project-heading";
  heading.id = prefix + "coop-project-" + String(projectId).replace(/[^a-zA-Z0-9_-]/g, "-");
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "2");
  heading.textContent = (section.icon ? section.icon + " " : "") + section.label;
  group.setAttribute("aria-labelledby", heading.id);
  group.appendChild(heading);
  renderCoopProjectTopics(group, section.topics, Object.assign({}, opts, { projectRef: section.projectRef }));
  container.appendChild(group);
  return section.topics.length;
}

// Renders the ordered sections that coopTopicSections decided on. Ordering and
// emptiness live in the pure model, so this function only draws what it is
// given -- and both surfaces are given the same thing.
export function renderCoopTopicSections(container, model, options) {
  var opts = Object.assign({ send: sendUserAction }, options || {});
  var prefix = opts.mobile ? "mobile-" : "";
  // What needs the boss comes first, above the lenses and the topic list, and is
  // readable without entering any project.
  renderCoopActionQueue(container, opts);
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
    if (sections[i].kind === "project") appendProjectSection(container, sections[i], opts);
    else if (sections[i].kind === "done") renderCoopTopicDoneSection(container, sections[i].topics, opts);
    else renderCoopTopicGroup(container, sections[i].label, sections[i].topics, opts);
  }
  return container;
}
