// Owner controls for the selected Coop Thread. All durable changes go through
// the canonical WebSocket; modal state is ephemeral DOM state only.

import { cloneReference, topicRefKey } from './sidebar-coop-topic-model.js';
import { getGlobalCoopTopics } from './global-coop-projection.js';
import { canonicalTopicTitle } from './coop-identity.js';

var STATE_LABELS = {
  exploring: "Exploring",
  parked: "Parked",
  handed_off: "Handed off",
  closed: "Closed",
};

export function buildThreadControlMessage(action, topic, values) {
  var input = values || {};
  if (!topic || !topic.topicRef) return null;
  var threadRef = cloneReference(topic.threadRef) || { threadId: topicRefKey(topic.topicRef) };
  if (!threadRef.threadId) return null;
  var common = { topicRef: cloneReference(topic.topicRef),
    threadRef: threadRef };
  if (action === "state") return Object.assign(common, {
    type: "coop_thread_state", state: input.state,
    closeOutcome: input.closeOutcome || null,
  });
  if (action === "reassign") return Object.assign(common, {
    type: "coop_thread_reassign", sourceThreadRef: cloneReference(threadRef),
    targetThreadRef: cloneReference(input.targetThreadRef),
    turnRef: cloneReference(input.turnRef || topic.lastTurnRef),
  });
  if (action === "merge") return Object.assign(common, {
    type: "coop_thread_merge", sourceThreadRefs: [cloneReference(threadRef)],
    targetThreadRef: cloneReference(input.targetThreadRef),
  });
  if (action === "undo") return Object.assign(common, { type: "coop_thread_undo" });
  return null;
}

function sendControl(action, topic, values, send) {
  var message = buildThreadControlMessage(action, topic, values);
  return message && typeof send === "function" ? send(message) : false;
}

function closeOverlay(overlay, restore) {
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  if (restore && typeof restore.focus === "function") restore.focus();
}

function focusable(overlay) {
  return Array.from(overlay.querySelectorAll("button:not([disabled])"));
}

function dialog(title, description, restore) {
  var overlay = document.createElement("div");
  overlay.className = "coop-thread-dialog-overlay";
  var panel = document.createElement("section");
  panel.className = "coop-thread-dialog";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  var heading = document.createElement("h2");
  heading.textContent = title;
  panel.setAttribute("aria-labelledby", "coop-thread-dialog-title");
  heading.id = "coop-thread-dialog-title";
  panel.appendChild(heading);
  if (description) {
    var copy = document.createElement("p");
    copy.textContent = description;
    panel.appendChild(copy);
  }
  overlay.appendChild(panel);
  overlay.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOverlay(overlay, restore);
      return;
    }
    if (event.key !== "Tab") return;
    var controls = focusable(overlay);
    if (!controls.length) { event.preventDefault(); return; }
    var first = controls[0];
    var last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });
  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) closeOverlay(overlay, restore);
  });
  document.body.appendChild(overlay);
  return { overlay: overlay, panel: panel };
}

function dialogButton(label, className, onClick) {
  var button = document.createElement("button");
  button.type = "button";
  button.className = className || "coop-thread-dialog-button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

export function openThreadCloseDialog(topic, send, restore) {
  var title = canonicalTopicTitle(topic, "this Thread");
  var built = dialog("Do not implement", "Remove “" + title +
    "” from Threads? Its canonical transcript remains in Coop history.", restore);
  var actions = document.createElement("div");
  actions.className = "coop-thread-dialog-actions";
  var chosen = false;
  function choose(outcome) {
    if (chosen) return;
    chosen = true;
    sendControl("state", topic, { state: "closed", closeOutcome: outcome }, send);
    closeOverlay(built.overlay, restore);
  }
  actions.appendChild(dialogButton("Do not implement", "coop-thread-dialog-button destructive", function () {
    choose("not_pursuing");
  }));
  actions.appendChild(dialogButton("Cancel", "coop-thread-dialog-button quiet", function () {
    closeOverlay(built.overlay, restore);
  }));
  built.panel.appendChild(actions);
  actions.querySelector("button").focus();
}

function availableTargets(topic) {
  var current = topicRefKey(topic.threadRef || topic.topicRef);
  return getGlobalCoopTopics().filter(function (candidate) {
    var state = candidate && candidate.threadState;
    return candidate && topicRefKey(candidate.threadRef || candidate.topicRef) !== current &&
      state !== "handed_off" && state !== "closed";
  });
}

function targetDialog(action, topic, send, restore) {
  var targets = availableTargets(topic);
  var verb = action === "merge" ? "Merge Thread" : "Reassign latest turn";
  var built = dialog(verb, targets.length ? "Choose the destination Thread." :
    "There are no other active Threads available.", restore);
  var list = document.createElement("div");
  list.className = "coop-thread-target-list";
  for (var i = 0; i < targets.length; i++) {
    (function (target) {
      var item = dialogButton(canonicalTopicTitle(target, "Untitled Thread"),
        "coop-thread-target", function () {
          sendControl(action, topic, { targetThreadRef: target.threadRef }, send);
          closeOverlay(built.overlay, restore);
        });
      list.appendChild(item);
    })(targets[i]);
  }
  list.appendChild(dialogButton("Cancel", "coop-thread-dialog-button quiet", function () {
    closeOverlay(built.overlay, restore);
  }));
  built.panel.appendChild(list);
  list.querySelector("button").focus();
}

function control(label, onClick) {
  var button = document.createElement("button");
  button.type = "button";
  button.className = "coop-thread-control";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

export function createThreadControls(topic, options) {
  if (!topic) return null;
  var opts = options || {};
  var send = opts.send;
  var wrapper = document.createElement("div");
  wrapper.className = "coop-thread-controls";
  var state = document.createElement("span");
  state.className = "coop-thread-state";
  state.textContent = STATE_LABELS[topic.threadState] || "Exploring";
  wrapper.appendChild(state);
  if (topic.threadState === "parked") {
    wrapper.appendChild(control("Resume", function () {
      sendControl("state", topic, { state: "exploring" }, send);
    }));
  } else if (topic.threadState === "exploring") {
    wrapper.appendChild(control("Park", function () {
      sendControl("state", topic, { state: "parked" }, send);
    }));
  }
  if (topic.threadState !== "closed" && topic.threadState !== "handed_off") {
    wrapper.appendChild(control("Reassign latest", function (event) {
      targetDialog("reassign", topic, send, event.currentTarget);
    }));
    wrapper.appendChild(control("Merge", function (event) {
      targetDialog("merge", topic, send, event.currentTarget);
    }));
    wrapper.appendChild(control("Close…", function (event) {
      openThreadCloseDialog(topic, send, event.currentTarget);
    }));
  }
  wrapper.appendChild(control("Undo correction", function () {
    sendControl("undo", topic, null, send);
  }));
  return wrapper;
}
