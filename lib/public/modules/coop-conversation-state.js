// Owner-facing state for the one permanent Coop conversational lane.
//
// Two independent things are shown here and they are deliberately not merged:
//
//   1. Work activity  -- what Coop is doing (Working on X / Reviewing /
//      Waiting / Idle - waiting for you) plus how many background tasks are
//      active. This is server-serialized and survives restart and reconnect.
//   2. Listening      -- whether this browser's microphone is open. It is a
//      voice INPUT state only, owned by the client, and it coexists with any
//      work state.

import { store } from './store.js';
import { activeCoopLensDisplay } from './global-coop-projection.js';

var WORK_LABELS = {
  reviewing: "Reviewing",
  waiting: "Waiting",
  idle: "Idle — waiting for you",
};

// The client owns the wording for the server's bounded waiting-reason codes.
// Anything outside this set renders as a bare "Waiting": the server only sends
// a reason it can substantiate, and an unknown code must never be echoed to the
// owner as if it were a sentence.
var WAITING_REASON_LABELS = {
  reviewer_unavailable: "reviewer unavailable",
  model_unavailable: "model unavailable",
  capacity: "no worker capacity",
  target_unavailable: "target unavailable",
};

function currentState() {
  return store.get("coopConversationState") || null;
}

function normalizedWorkState(value) {
  var state = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (state === "working") return "working";
  return Object.prototype.hasOwnProperty.call(WORK_LABELS, state) ? state : "idle";
}

function normalizedWorkReason(value) {
  var reason = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(WAITING_REASON_LABELS, reason) ? reason : "";
}

function workLabel(state, target, reason) {
  if (state === "working") return target ? "Working on " + target : "Working";
  // Only Waiting carries a reason. Naming why Coop is stuck is the difference
  // between an owner who knows to unblock it and one who thinks it is done.
  if (state === "waiting" && reason) return "Waiting — " + WAITING_REASON_LABELS[reason];
  return WORK_LABELS[state] || WORK_LABELS.idle;
}

function backgroundLabel(count) {
  if (count <= 0) return "No background tasks";
  return count + " background task" + (count === 1 ? "" : "s");
}

export function coopConversationDisplayModel(state, options) {
  var value = state || {};
  var opts = options || {};
  var workState = normalizedWorkState(value.workState);
  var count = Number.isInteger(value.backgroundTaskCount) && value.backgroundTaskCount > 0
    ? value.backgroundTaskCount : 0;
  var target = typeof value.workTarget === "string" ? value.workTarget.trim() : "";
  var reason = workState === "waiting" ? normalizedWorkReason(value.workReason) : "";
  return {
    visible: !!value.active,
    workState: workState,
    workLabel: workLabel(workState, target, reason),
    workReason: reason,
    workTarget: target,
    backgroundCount: count,
    backgroundLabel: backgroundLabel(count),
    pending: Number.isInteger(value.pendingIngressCount) ? value.pendingIngressCount : 0,
    // Voice input, not work. Reported separately so both can be true at once.
    listening: !!opts.listening,
    // Resolved from the canonical projection on every render, and carrying its
    // own kind: a topic lens used to be captioned "Project: <topic>", which
    // named the wrong thing, and it used the click-time title snapshot, which
    // drifted once the projection was rebuilt.
    lens: activeCoopLensDisplay(),
  };
}

function lensCaption(lens) {
  if (!lens || !lens.title) return "";
  return (lens.kind === "topic" ? "Thread: " : "Project: ") + lens.title;
}

function accessibleSummary(model) {
  var parts = [model.workLabel, model.backgroundLabel];
  if (model.pending > 0) parts.push(model.pending + " waiting to send");
  if (model.listening) parts.push("Listening");
  return parts.join(", ");
}

function ensureStatus() {
  var existing = document.getElementById("coop-conversation-status");
  if (existing) return existing;
  var inputArea = document.getElementById("input-area");
  var inputWrapper = document.getElementById("input-wrapper");
  if (!inputArea || !inputWrapper) return null;
  var status = document.createElement("div");
  status.id = "coop-conversation-status";
  status.className = "coop-conversation-status hidden";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  inputArea.insertBefore(status, inputWrapper);
  return status;
}

function appendSpan(parent, className, textContent) {
  var span = document.createElement("span");
  span.className = className;
  span.textContent = textContent;
  parent.appendChild(span);
  return span;
}

function render() {
  var status = ensureStatus();
  if (!status) return;
  var model = coopConversationDisplayModel(currentState(), { listening: !!store.get("voiceListening") });
  status.innerHTML = "";
  status.classList.toggle("hidden", !model.visible);
  if (!model.visible) {
    status.removeAttribute("aria-label");
    status.removeAttribute("data-work-state");
    status.dataset.workReason = "";
    return;
  }

  status.dataset.workState = model.workState;
  status.dataset.workReason = model.workReason;
  status.setAttribute("aria-label", accessibleSummary(model));

  appendSpan(status, "coop-conversation-work", model.workLabel);

  var caption = lensCaption(model.lens);
  if (caption) appendSpan(status, "coop-conversation-lens", caption);

  if (model.pending > 0) appendSpan(status, "coop-conversation-pending", model.pending + " waiting");

  appendSpan(status, "coop-conversation-background", model.backgroundLabel);

  // Voice input indicator, rendered alongside -- never instead of -- work state.
  if (model.listening) appendSpan(status, "coop-conversation-listening", "Listening");
}

export function setCoopConversationState(message) {
  var state = message && message.active ? {
    active: true,
    replying: !!message.replying,
    activeIngressId: message.activeIngressId || null,
    pendingIngressCount: message.pendingIngressCount || 0,
    workState: message.workState || "idle",
    workReason: message.workReason || "",
    workTarget: message.workTarget || "",
    backgroundTaskCount: message.backgroundTaskCount || 0,
  } : null;
  store.set({ coopConversationState: state });
  return state;
}

store.subscribe(function (state, previous) {
  if (state.coopConversationState !== previous.coopConversationState ||
      state.voiceListening !== previous.voiceListening ||
      state.activeCoopHome !== previous.activeCoopHome ||
      state.activeCoopChannel !== previous.activeCoopChannel ||
      state.activeCoopLens !== previous.activeCoopLens ||
      // The lens caption is resolved from the canonical projection, so a
      // projection-only rename has to repaint it even when the lens refs and
      // every other key are unchanged.
      state.coopProjectionVersion !== previous.coopProjectionVersion) render();
});
