// coop-topic-decision-surface.js - The contextual decision surface for the
// selected Coop topic, rendered above the conversation.
//
// This is where consequential owner decisions live. The sidebar shows a
// link-only "Now" index and plain topic rows; choosing Accept,
// Request changes, Keep waiting or Reopen happens HERE, next to the evidence:
// the worker's recorded result and artifacts for task-scoped acceptance
// (coop-action-decision-panel.js), or the state's durable provenance and note
// history for topic-scoped dispositions (sidebar-coop-topic-review.js).
//
// Fail closed everywhere: no selected topic, no actionable decision, or no
// canonical evidence means no panel -- never a verbs-only card. Deduplication
// is inherent: a task-linked topic renders its task panels and never the
// topic-scoped verbs (topicReviewVerbs already refuses task-derived states),
// so one decision has exactly one surface.

import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { getActionQueue } from './coop-action-queue-ui.js';
import { createActionDecisionPanel } from './coop-action-decision-panel.js';
import { createTopicDecisionPanel } from './sidebar-coop-topic-review.js';
import { findGlobalCoopTopic } from './global-coop-projection.js';
import { canonicalTopicTitle, isCoopProjectSlug } from './coop-identity.js';

var SURFACE_ID = "coop-topic-decision";

function topicIdOf(ref) {
  if (!ref) return "";
  return String(ref.topicId || ref.topicKey || ref.id || ref.key || "").trim();
}

// The selected topic, resolved against the live projection so a stale
// selection cannot offer a decision on state that no longer exists.
function selectedTopic() {
  if (!isCoopProjectSlug(store.get("currentSlug"))) return null;
  var lens = store.get("activeCoopLens") || {};
  var topicRef = store.get("activeCoopTopicRef") || lens.topicRef || null;
  if (!topicIdOf(topicRef)) return null;
  var projectRef = store.get("activeCoopProjectRef") || lens.projectRef || null;
  return findGlobalCoopTopic(topicRef, projectRef);
}

// Task-scoped decisions that belong to this topic, by canonical TopicRef.
export function topicActionItems(topic, items) {
  var wanted = topicIdOf(topic && topic.topicRef);
  if (!wanted) return [];
  var list = Array.isArray(items) ? items : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (topicIdOf(list[i] && list[i].topicRef) === wanted) out.push(list[i]);
  }
  return out;
}

// Builds the surface content for one topic, or null when there is nothing the
// owner can decide here. Exported for tests; the DOM plumbing below is thin.
export function buildTopicDecisionSurface(topic, options) {
  if (!topic) return null;
  var opts = options || {};
  var items = topicActionItems(topic, opts.items || getActionQueue());
  var panels = [];
  for (var i = 0; i < items.length; i++) {
    panels.push(createActionDecisionPanel(items[i], opts));
  }
  // Topic-scoped disposition verbs exist only when no task evidence governs
  // the state, so this never doubles a task decision.
  var dispositionPanel = createTopicDecisionPanel(topic, opts);
  if (dispositionPanel) panels.push(dispositionPanel);
  if (!panels.length) return null;

  var surface = document.createElement("section");
  surface.className = "coop-topic-decision";
  surface.setAttribute("aria-label", "Decisions for " + canonicalTopicTitle(topic, "this topic"));
  var heading = document.createElement("div");
  heading.className = "coop-topic-decision-heading";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "2");
  heading.textContent = "Your decision — " + canonicalTopicTitle(topic, "this topic");
  surface.appendChild(heading);
  for (var p = 0; p < panels.length; p++) surface.appendChild(panels[p]);
  return surface;
}

function containerEl() {
  var messages = document.getElementById("messages");
  if (!messages || !messages.parentNode) return null;
  var existing = document.getElementById(SURFACE_ID);
  if (existing) return existing;
  var host = document.createElement("div");
  host.id = SURFACE_ID;
  messages.parentNode.insertBefore(host, messages);
  return host;
}

export function renderCoopTopicDecisionSurface() {
  var host = containerEl();
  if (!host) return false;
  var topic = selectedTopic();
  var surface = topic
    ? buildTopicDecisionSurface(topic, { send: sendUserAction })
    : null;
  host.textContent = "";
  if (surface) host.appendChild(surface);
  host.hidden = !surface;
  return !!surface;
}

// Repaint on everything the surface derives from: the selection, the
// authoritative projection, the queue, and per-decision interaction state.
store.subscribe(function (state, previous) {
  if (state.currentSlug !== previous.currentSlug ||
      state.activeCoopLens !== previous.activeCoopLens ||
      state.activeCoopTopicRef !== previous.activeCoopTopicRef ||
      state.activeCoopProjectRef !== previous.activeCoopProjectRef ||
      state.coopProjectionVersion !== previous.coopProjectionVersion ||
      state.coopActionQueue !== previous.coopActionQueue ||
      state.coopActionPending !== previous.coopActionPending ||
      state.coopActionError !== previous.coopActionError ||
      state.coopActionNote !== previous.coopActionNote ||
      state.coopActionDone !== previous.coopActionDone ||
      state.coopTopicReviewPending !== previous.coopTopicReviewPending ||
      state.coopTopicReviewErrors !== previous.coopTopicReviewErrors) {
    renderCoopTopicDecisionSurface();
  }
});
