// Owner-facing status for the one permanent Coop conversational lane.

import { store } from './store.js';

function currentState() {
  return store.get("coopConversationState") || null;
}

export function coopConversationDisplayModel(state) {
  var value = state || {};
  var active = !!value.active;
  var count = Number.isInteger(value.backgroundTaskCount) ? value.backgroundTaskCount : 0;
  return {
    visible: active,
    primary: value.replying ? "Replying" : "Listening",
    pending: Number.isInteger(value.pendingIngressCount) ? value.pendingIngressCount : 0,
    backgroundCount: count,
    backgroundActivity: typeof value.backgroundActivity === "string" ? value.backgroundActivity : "",
    projectTitle: store.get("activeCoopLens") && store.get("activeCoopLens").title || "",
  };
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
  status.setAttribute("aria-live", "polite");
  inputArea.insertBefore(status, inputWrapper);
  return status;
}

function render() {
  var status = ensureStatus();
  if (!status) return;
  var model = coopConversationDisplayModel(currentState());
  status.innerHTML = "";
  status.classList.toggle("hidden", !model.visible);
  if (!model.visible) return;

  var primary = document.createElement("span");
  primary.className = "coop-conversation-primary";
  primary.textContent = model.primary;
  status.appendChild(primary);

  if (model.projectTitle) {
    var lens = document.createElement("span");
    lens.className = "coop-conversation-lens";
    lens.textContent = "Project: " + model.projectTitle;
    status.appendChild(lens);
  }

  if (model.pending > 0) {
    var pending = document.createElement("span");
    pending.className = "coop-conversation-pending";
    pending.textContent = model.pending + " waiting";
    status.appendChild(pending);
  }

  var background = document.createElement("span");
  background.className = "coop-conversation-background";
  background.textContent = model.backgroundCount > 0
    ? model.backgroundCount + " background task" + (model.backgroundCount === 1 ? "" : "s")
    : "No background tasks";
  if (model.backgroundActivity) background.title = model.backgroundActivity;
  status.appendChild(background);
}

export function setCoopConversationState(message) {
  var state = message && message.active ? {
    active: true,
    listening: !!message.listening,
    replying: !!message.replying,
    activeIngressId: message.activeIngressId || null,
    pendingIngressCount: message.pendingIngressCount || 0,
    backgroundTaskCount: message.backgroundTaskCount || 0,
    backgroundActivity: message.backgroundActivity || "",
  } : null;
  store.set({ coopConversationState: state });
  return state;
}

store.subscribe(function (state, previous) {
  if (state.coopConversationState !== previous.coopConversationState ||
      state.activeCoopHome !== previous.activeCoopHome ||
      state.activeCoopChannel !== previous.activeCoopChannel ||
      state.activeCoopLens !== previous.activeCoopLens) render();
});
