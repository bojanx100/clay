// Reference-only Coop topic rows and durable topic actions.

import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { buildCoopTopicActionMessage } from './sidebar-coop-topic-model.js';
import {
  findGlobalCoopTopic,
  globalProjectRefKey,
  requestAllCoopTopics,
  requestCanonicalEvent,
  requestCanonicalSession,
  requestCoopTopic,
} from './global-coop-projection.js';
import { showToast } from './utils.js';

var dialogEl = null;

function cloneRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  try { return JSON.parse(JSON.stringify(ref)); } catch (e) { return null; }
}

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

function appendDetailLine(container, label, value) {
  if (!value) return;
  var line = document.createElement("div");
  line.className = "coop-topic-detail-line";
  var labelEl = document.createElement("span");
  labelEl.className = "coop-topic-detail-label";
  labelEl.textContent = label;
  line.appendChild(labelEl);
  var valueEl = document.createElement("span");
  valueEl.className = "coop-topic-detail-value";
  valueEl.textContent = value;
  line.appendChild(valueEl);
  container.appendChild(line);
}

function appendExecution(container, execution, options, depth) {
  if (!execution) return;
  var row = document.createElement("div");
  row.className = (options.mobile ? "mobile-" : "") + "coop-topic-execution";
  row.style.setProperty("--coop-topic-depth", String(depth || 0));
  var label = document.createElement("span");
  label.className = "coop-topic-execution-label";
  label.textContent = text(execution.title, "Related execution");
  row.appendChild(label);
  var status = text(execution.status, "");
  if (status) {
    var statusEl = document.createElement("span");
    statusEl.className = "coop-topic-execution-status";
    statusEl.textContent = status;
    row.appendChild(statusEl);
  }
  if (execution.activity) {
    var activity = document.createElement("span");
    activity.className = "coop-topic-execution-activity";
    activity.textContent = execution.activity;
    row.appendChild(activity);
  }
  if (execution.sessionRef) {
    row.classList.add("coop-topic-execution-link");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    function openExecution() {
      if (!requestCanonicalSession(cloneRef(execution.sessionRef), sendUserAction)) {
        showToast("That related execution is unavailable or you no longer have access.", "error");
        return;
      }
      finishNavigation(options);
    }
    row.addEventListener("click", openExecution);
    row.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openExecution();
    });
  }
  container.appendChild(row);
  var children = execution.children || [];
  for (var i = 0; i < children.length; i++) appendExecution(container, children[i], options, (depth || 0) + 1);
}

function appendTopicEvents(container, topic, options) {
  var events = topic.canonicalEvents || [];
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    var button = document.createElement("button");
    button.type = "button";
    button.className = (options.mobile ? "mobile-" : "") + "coop-topic-event";
    button.textContent = text(event.title, "Canonical event") + (event.summary ? " · " + event.summary : "");
    button.setAttribute("aria-label", "Open canonical event " + text(event.title, "Canonical event"));
    button.addEventListener("click", (function (eventRef, topicRef, projectRef) {
      return function () {
        if (!requestCanonicalEvent(eventRef, topicRef, projectRef, sendUserAction)) {
          showToast("That canonical event is unavailable or you no longer have access.", "error");
          return;
        }
        finishNavigation(options);
      };
    })(event.eventRef, topic.topicRef, topic.projectRef));
    container.appendChild(button);
  }
}

export function sendTopicAction(action, topic, values, transport) {
  var knownTopic = topic && findGlobalCoopTopic(topic.topicRef, topic.projectRef);
  var payload = buildCoopTopicActionMessage(action, knownTopic, values);
  var send = typeof transport === "function" ? transport : sendUserAction;
  if (!payload) return false;
  return send(payload);
}

function closeTopicDialog() {
  if (!dialogEl) return;
  dialogEl.remove();
  dialogEl = null;
}

function openTopicDialog(title, label, initial, onSubmit, withInput) {
  closeTopicDialog();
  var overlay = document.createElement("div");
  overlay.className = "coop-topic-dialog-backdrop";
  overlay.setAttribute("role", "presentation");
  var dialog = document.createElement("form");
  dialog.className = "coop-topic-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  var heading = document.createElement("h2");
  heading.textContent = title;
  dialog.appendChild(heading);
  var copy = document.createElement("p");
  copy.className = "coop-topic-dialog-copy";
  copy.textContent = label;
  dialog.appendChild(copy);
  var input = null;
  if (label && withInput !== false) {
    input = document.createElement("input");
    input.type = "text";
    input.value = initial || "";
    input.className = "coop-topic-dialog-input";
    input.setAttribute("aria-label", label);
    dialog.appendChild(input);
  }
  var actions = document.createElement("div");
  actions.className = "coop-topic-dialog-actions";
  var cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeTopicDialog);
  actions.appendChild(cancel);
  var submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Save";
  actions.appendChild(submit);
  dialog.appendChild(actions);
  dialog.addEventListener("submit", function (event) {
    event.preventDefault();
    var value = input ? input.value.trim() : "";
    if (input && !value) return;
    onSubmit(value);
    closeTopicDialog();
  });
  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) closeTopicDialog();
  });
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  dialogEl = overlay;
  if (input) input.focus();
}

function openAction(action, topic) {
  var title = topic ? topic.title : "topic";
  if (action === "close" || action === "reopen") {
    openTopicDialog(action === "close" ? "Close topic" : "Reopen topic", "This changes the durable topic state for “" + title + "”.", "", function () {
      sendTopicAction(action, topic);
    }, false);
    return;
  }
  if (action === "move") {
    openTopicDialog("Move topic", "Enter the target ProjectRef projectId.", "", function (value) {
      sendTopicAction(action, topic, { targetProjectRef: { projectId: value } });
    });
    return;
  }
  if (action === "merge") {
    openTopicDialog("Merge topic", "Enter the target TopicRef topicId.", "", function (value) {
      sendTopicAction(action, topic, { targetTopicRef: { topicId: value } });
    });
    return;
  }
  if (action === "split") {
    openTopicDialog("Split topic", "Name the new topic.", "", function (value) {
      sendTopicAction(action, topic, { title: value });
    });
    return;
  }
  if (action !== "rename") return;
  openTopicDialog("Rename topic", "Enter the new topic name.", title, function (value) {
    sendTopicAction(action, topic, { title: value });
  });
}

function createActionButton(action, topic) {
  var button = document.createElement("button");
  button.type = "button";
  button.className = "coop-topic-action";
  button.textContent = action.charAt(0).toUpperCase() + action.slice(1);
  button.addEventListener("click", function (event) {
    event.stopPropagation();
    openAction(action, topic);
  });
  return button;
}

function createTopicRow(topic, options) {
  var prefix = options.mobile ? "mobile-" : "";
  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-topic-wrapper" + (topicIsActive(topic) ? " active" : "");
  var row = document.createElement("button");
  row.type = "button";
  row.className = prefix + "coop-topic-row" + (topicIsActive(topic) ? " active" : "") + (topic.attention ? " attention" : "");
  row.dataset.topicId = String(topic.topicRef.topicId || topic.topicRef.topicKey || topic.topicRef.id || topic.topicRef.key || "");
  var marker = document.createElement("span");
  marker.className = prefix + "coop-topic-status coop-topic-status-" + topicStatusClass(topic.status);
  row.appendChild(marker);
  var title = document.createElement("span");
  title.className = prefix + "coop-topic-title";
  title.textContent = topic.title;
  row.appendChild(title);
  if (topic.active) {
    var active = document.createElement("span");
    active.className = prefix + "coop-topic-active";
    active.textContent = "Active";
    row.appendChild(active);
  }
  if (topic.unread > 0) {
    var unread = document.createElement("span");
    unread.className = prefix + "coop-topic-unread";
    unread.textContent = topic.unread > 99 ? "99+" : String(topic.unread);
    row.appendChild(unread);
  }
  if (topic.attention) {
    var attention = document.createElement("span");
    attention.className = prefix + "coop-topic-attention";
    attention.textContent = "Needs attention";
    row.appendChild(attention);
  }
  row.addEventListener("click", function () {
    if (requestCoopTopic(topic, sendUserAction)) finishNavigation(options);
  });
  wrapper.appendChild(row);

  var details = document.createElement("div");
  details.className = prefix + "coop-topic-drawer hidden";
  details.setAttribute("aria-hidden", "true");
  appendDetailLine(details, "Status", topic.status);
  appendDetailLine(details, "Summary", topic.rollingSummary);
  appendDetailLine(details, "Decisions", topic.decisions.join(" · "));
  appendDetailLine(details, "Current activity", topic.currentActivity);
  appendDetailLine(details, "Unread", topic.unread > 0 ? String(topic.unread) : "None");
  appendDetailLine(details, "Attention", topic.attention ? "Needs attention" : "None");
  var executions = topic.relatedExecution || [];
  for (var i = 0; i < executions.length; i++) appendExecution(details, executions[i], options, 0);
  appendTopicEvents(details, topic, options);
  var actionBar = document.createElement("div");
  actionBar.className = prefix + "coop-topic-actions";
  var actionNames = ["rename", "move", "merge", "split", topic.status === "closed" ? "reopen" : "close"];
  for (var ai = 0; ai < actionNames.length; ai++) actionBar.appendChild(createActionButton(actionNames[ai], topic));
  details.appendChild(actionBar);
  wrapper.appendChild(details);
  var detailToggle = document.createElement("button");
  detailToggle.type = "button";
  detailToggle.className = prefix + "coop-topic-details-toggle";
  detailToggle.textContent = "Details";
  detailToggle.addEventListener("click", function (event) {
    event.stopPropagation();
    var hidden = details.classList.toggle("hidden");
    details.setAttribute("aria-hidden", hidden ? "true" : "false");
  });
  wrapper.appendChild(detailToggle);
  return wrapper;
}

export function renderCoopTopicGroup(container, label, topics, options) {
  if (!topics || topics.length === 0) return 0;
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var group = document.createElement("div");
  group.className = prefix + "coop-topic-group";
  var heading = document.createElement("div");
  heading.className = prefix + "coop-topic-group-heading";
  heading.textContent = label;
  group.appendChild(heading);
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
  var opts = options || {};
  return renderCoopTopicGroup(container, "Topics", topics, opts);
}
