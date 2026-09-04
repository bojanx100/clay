// Dedicated conversational Voice mode. This is intentionally separate from
// composer dictation: it is available only from canonical Coop and retains
// the Coop scope copied before microphone permission is requested.

import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';
import { sendVoiceConversationMessage } from './input.js';
import { captureVoiceConversationRouting, isSafeVoiceConversationRouting } from './voice-conversation-routing.js';
import { createVoiceConversationController } from './voice-conversation-controller.js';

var controller = null;
var panelOpen = false;
var refs = {};
var transcriptItems = [];
var deviceListenerBound = false;

function selectedCanonicalCoopScope() {
  return isSafeVoiceConversationRouting(captureVoiceConversationRouting());
}

function browserRecognition() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setTranscript(item) {
  var value = item || {};
  if (!value.final && transcriptItems.length && transcriptItems[transcriptItems.length - 1].provisional) {
    transcriptItems.pop();
  }
  transcriptItems.push({
    role: value.role === "assistant" ? "assistant" : "user",
    text: String(value.text || ""),
    provisional: !value.final,
  });
  if (transcriptItems.length > 8) transcriptItems.shift();
  renderTranscript();
}

function renderTranscript() {
  var list = refs.transcript;
  if (!list) return;
  list.innerHTML = "";
  for (var i = 0; i < transcriptItems.length; i++) {
    var entry = transcriptItems[i];
    var row = document.createElement("div");
    row.className = "voice-conversation-transcript-row voice-conversation-" + entry.role;
    if (entry.provisional) row.classList.add("provisional");
    row.textContent = (entry.role === "assistant" ? "Clay: " : "You: ") + entry.text;
    list.appendChild(row);
  }
}

function stateLabel(state) {
  if (!state) return "Ready";
  if (state.error) return state.error;
  if (state.reconnecting) return "Reconnecting — your confirmed utterance will send when Clay reconnects.";
  if (state.speaking) return "Clay is speaking. Press Listen to interrupt and reply.";
  if (state.listening && state.working) return "Listening while Clay works";
  if (state.listening) return "Listening";
  if (state.working) return "Working on your last voice turn";
  return "Ready to listen";
}

function renderState(state) {
  var current = state || controller && controller.getState() || {};
  store.set({
    voiceListening: !!current.listening,
    voiceConversationActive: !!(current.listening || current.working || current.speaking || current.reconnecting),
    voiceConversationState: current,
  });
  if (refs.status) {
    refs.status.textContent = stateLabel(current);
    refs.status.classList.toggle("voice-conversation-error", !!current.error);
  }
  if (refs.listen) {
    refs.listen.textContent = current.listening ? "Stop listening" : "Listen";
    refs.listen.setAttribute("aria-pressed", current.listening ? "true" : "false");
    refs.listen.disabled = !!current.reconnecting;
  }
  if (refs.stopSpeech) refs.stopSpeech.disabled = !current.speaking;
  if (refs.cancel) refs.cancel.disabled = !(current.working || current.pendingCount || current.speaking);
  if (refs.button) {
    refs.button.classList.toggle("voice-conversation-active", !!current.listening);
    refs.button.setAttribute("aria-expanded", panelOpen ? "true" : "false");
  }
}

function updateDeviceLabel() {
  var media = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
  if (!refs.device) return;
  if (!media || typeof media.enumerateDevices !== "function") {
    refs.device.textContent = "Browser default microphone";
    return;
  }
  media.enumerateDevices().then(function (devices) {
    var inputs = (devices || []).filter(function (device) { return device.kind === "audioinput"; });
    var named = inputs.find(function (device) { return device.label; });
    refs.device.textContent = named ? "Microphone: " + named.label : "Browser default microphone";
  }).catch(function () {
    refs.device.textContent = "Browser default microphone";
  });
}

function renderVisibility() {
  var active = controller && controller.getState();
  var shouldShow = selectedCanonicalCoopScope();
  if (refs.button) refs.button.classList.toggle("hidden", !shouldShow);
  if (refs.panel) refs.panel.classList.toggle("hidden", !shouldShow || !panelOpen);
  if (refs.threadHint) refs.threadHint.textContent = "Messages stay in the Coop scope captured when recording began.";
  renderState(active);
}

function startOrStopListening() {
  var state = controller.getState();
  if (state.listening) {
    controller.stopListening();
    return;
  }
  if (store.get("voiceDictationActive")) {
    refs.status.textContent = "Stop composer dictation before starting Voice conversation.";
    refs.status.classList.add("voice-conversation-error");
    return;
  }
  var routing = captureVoiceConversationRouting();
  if (!isSafeVoiceConversationRouting(routing)) {
    refs.status.textContent = "Open canonical Coop before listening.";
    refs.status.classList.add("voice-conversation-error");
    return;
  }
  controller.start(routing);
}

function createPanel() {
  var inputWrapper = document.getElementById("input-wrapper");
  var inputRow = document.getElementById("input-row");
  var attachWrap = document.getElementById("attach-wrap");
  if (!inputWrapper || !inputRow || !attachWrap) return false;

  var button = document.createElement("button");
  button.id = "voice-conversation-btn";
  button.type = "button";
  button.className = "hidden";
  button.setAttribute("aria-label", "Open Voice conversation");
  button.setAttribute("aria-controls", "voice-conversation-panel");
  button.setAttribute("aria-expanded", "false");
  button.title = "Voice conversation";
  button.innerHTML = iconHtml("audio-lines");
  button.addEventListener("click", function () {
    panelOpen = !panelOpen;
    renderVisibility();
    if (panelOpen) updateDeviceLabel();
  });
  attachWrap.insertBefore(button, document.getElementById("stt-btn") || null);

  var panel = document.createElement("section");
  panel.id = "voice-conversation-panel";
  panel.className = "voice-conversation-panel hidden";
  panel.setAttribute("aria-label", "Voice conversation");
  panel.innerHTML =
    '<div class="voice-conversation-heading">' +
      '<span class="voice-conversation-title">Voice conversation</span>' +
      '<span class="voice-conversation-thread" id="voice-conversation-thread"></span>' +
    '</div>' +
    '<div class="voice-conversation-status" id="voice-conversation-status" role="status" aria-live="polite"></div>' +
    '<div class="voice-conversation-device" id="voice-conversation-device"></div>' +
    '<div class="voice-conversation-transcript" id="voice-conversation-transcript" aria-live="polite"></div>' +
    '<div class="voice-conversation-actions">' +
      '<button type="button" id="voice-conversation-listen" aria-pressed="false">Listen</button>' +
      '<button type="button" id="voice-conversation-stop-speech" disabled>Stop speech</button>' +
      '<button type="button" id="voice-conversation-cancel" disabled>Cancel turn</button>' +
    '</div>';
  inputWrapper.insertBefore(panel, inputRow);
  refs = {
    button: button,
    panel: panel,
    status: panel.querySelector("#voice-conversation-status"),
    device: panel.querySelector("#voice-conversation-device"),
    transcript: panel.querySelector("#voice-conversation-transcript"),
    listen: panel.querySelector("#voice-conversation-listen"),
    stopSpeech: panel.querySelector("#voice-conversation-stop-speech"),
    cancel: panel.querySelector("#voice-conversation-cancel"),
    threadHint: panel.querySelector("#voice-conversation-thread"),
  };
  refs.listen.addEventListener("click", startOrStopListening);
  refs.stopSpeech.addEventListener("click", function () { controller.stopSpeech(); });
  refs.cancel.addEventListener("click", function () { controller.cancelTurn(); });
  refreshIcons();
  return true;
}

function createController() {
  controller = createVoiceConversationController({
    createRecognition: function () {
      var Recognition = browserRecognition();
      return Recognition ? new Recognition() : null;
    },
    mediaDevices: typeof navigator !== "undefined" ? navigator.mediaDevices : null,
    speechSynthesis: typeof window !== "undefined" ? window.speechSynthesis : null,
    createUtterance: function (text) {
      return typeof window !== "undefined" && window.SpeechSynthesisUtterance ? new window.SpeechSynthesisUtterance(text) : null;
    },
    sendVoiceText: function (text, routing) {
      if (!store.get("connected")) return false;
      return sendVoiceConversationMessage(text, routing);
    },
    onState: function (state) {
      renderState(state);
      renderVisibility();
    },
    onTranscript: setTranscript,
  });
}

export function initVoiceConversation() {
  if (controller) return controller;
  createController();
  if (!createPanel()) return controller;
  store.subscribe(function (state, previous) {
    if (state.connected !== previous.connected) controller.setConnected(!!state.connected);
    if (state.activeCoopHome !== previous.activeCoopHome ||
        state.activeCoopTopicRef !== previous.activeCoopTopicRef ||
        state.activeCoopLensScope !== previous.activeCoopLensScope) renderVisibility();
  });
  var media = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
  if (media && typeof media.addEventListener === "function" && !deviceListenerBound) {
    deviceListenerBound = true;
    media.addEventListener("devicechange", updateDeviceLabel);
  }
  renderVisibility();
  return controller;
}

export function observeVoiceConversationMessage(message) {
  if (controller) controller.receive(message, !!store.get("replayingHistory"));
}

export function getVoiceConversationController() {
  return controller;
}
