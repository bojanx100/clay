import { store } from './store.js';
import { createTopicLinksExpander } from './sidebar-coop-topic-links.js';
import { globalProjectRefKey, requestCoopTopic } from './global-coop-projection.js';
import { canonicalTopicTitle } from './coop-identity.js';

function finishNavigation(options) {
  if (options && typeof options.onNavigate === "function") options.onNavigate();
}

function topicStatusClass(status) {
  var value = typeof status === "string" ? status.trim() : "quiet";
  return (value || "quiet").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
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

var THREAD_STATE_LABELS = {
  exploring: "Exploring",
  parked: "Parked",
  handed_off: "Handed off",
  closed: "Closed",
};

function topicActivity(topic) {
  var state = topic && typeof topic.threadState === "string" ? topic.threadState : "";
  var lifecycle = THREAD_STATE_LABELS[state] || "";
  var conversation = store.get("coopConversationState") || {};
  var id = topic && topic.threadRef && topic.threadRef.threadId ||
    topic && topic.topicRef && topic.topicRef.topicId || "";
  function includes(refs) {
    var list = Array.isArray(refs) ? refs : [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i] && (list[i].threadId || list[i].topicId) || "") === String(id)) return true;
    }
    return false;
  }
  var foreground = includes(conversation.activeThreadRefs) ? "Working" :
    (includes(conversation.queuedThreadRefs) ? "Queued" : "");
  // Working is transient conversation activity. It may pulse a Parked Thread
  // without changing its durable lifecycle, which remains visible to assistive
  // technology and returns as the row label when the foreground turn ends.
  return { label: foreground || lifecycle, lifecycle: lifecycle,
    foreground: foreground, status: foreground ? foreground.toLowerCase() : state };
}

function topicAriaLabel(topic, activity) {
  var parts = [canonicalTopicTitle(topic, "")];
  if (activity && activity.label) parts.push(activity.label);
  if (activity && activity.lifecycle && activity.lifecycle !== activity.label) parts.push(activity.lifecycle);
  if (topic.unread > 0) parts.push(topic.unread + " unread");
  return parts.join(", ");
}

export function createCoopTopicRow(topic, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var activeTopic = topicIsActive(topic);
  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-topic-wrapper" + (activeTopic ? " active" : "") +
    (topic.attention ? " attention" : "");
  var main = document.createElement("div");
  main.className = prefix + "coop-topic-main";
  var row = document.createElement("button");
  row.type = "button";
  var activity = topicActivity(topic);
  if (activity.foreground) wrapper.classList.add("foreground-" + activity.foreground.toLowerCase());
  row.className = prefix + "coop-topic-row" + (activeTopic ? " active" : "");
  row.dataset.topicId = String(topic.topicRef.topicId || topic.topicRef.topicKey || topic.topicRef.id || topic.topicRef.key || "");
  row.setAttribute("aria-label", topicAriaLabel(topic, activity));
  if (activeTopic) row.setAttribute("aria-current", "page");

  var title = document.createElement("span");
  title.className = prefix + "coop-topic-title";
  title.textContent = canonicalTopicTitle(topic, "");
  row.appendChild(title);
  if (topic.unread > 0) {
    var unread = document.createElement("span");
    unread.className = prefix + "coop-topic-unread";
    unread.textContent = topic.unread > 99 ? "99+" : String(topic.unread);
    unread.setAttribute("aria-label", topic.unread + " unread messages");
    row.appendChild(unread);
  }
  if (activity.label) {
    var stateLabel = document.createElement("span");
    stateLabel.className = prefix + "coop-topic-state-label";
    stateLabel.textContent = activity.label;
    row.appendChild(stateLabel);
    var marker = document.createElement("span");
    marker.className = prefix + "coop-topic-status " + prefix +
      "coop-topic-status-" + topicStatusClass(activity.status);
    marker.setAttribute("aria-hidden", "true");
    marker.setAttribute("title", activity.label);
    row.appendChild(marker);
  }
  row.addEventListener("click", function () {
    if (requestCoopTopic(topic, opts.send)) finishNavigation(opts);
  });
  main.appendChild(row);
  wrapper.appendChild(main);
  var expander = createTopicLinksExpander(topic, opts);
  if (expander) wrapper.appendChild(expander);
  return wrapper;
}
