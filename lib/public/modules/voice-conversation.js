// Voice follows the owner interaction model: canonical Coop with Lead on,
// the selected ordinary session with Lead off.

import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';
import { sendVoiceConversationMessage } from './input.js';
import { captureVoiceConversationRouting, isSafeVoiceConversationRouting, isCurrentVoiceConversationRouting } from './voice-conversation-routing.js';
import { createVoiceConversationController } from './voice-conversation-controller.js';
import { switchProject } from './app-projects.js';
import { createVoiceQuestions } from './voice-questions.js';
import { sendWsJson } from './ws-ref.js';

var controller = null;
var questions = null;
var panelOpen = false;
var refs = {};
var transcriptItems = [];
var deviceListenerBound = false;

function selectedVoiceDestination() {
  return isSafeVoiceConversationRouting(captureVoiceConversationRouting());
}

function browserRecognition() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setTranscript(item) {
  var value = item || {};
  if (transcriptItems.length && transcriptItems[transcriptItems.length - 1].provisional) {
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
  if (state.reconnecting) return "Reconnecting — your unsent speech will wait for this conversation.";
  if (state.phase === "connecting") return "Opening the microphone…";
  if (state.speaking) return state.interruptionListening ?
    "Say ‘Coop pause’ to stop playback, then give your reply." : "Clay is speaking. Press Listen to interrupt and reply.";
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
    refs.listen.textContent = current.listening || current.phase === "connecting" ? "Stop listening" : "Listen";
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
  var shouldShow = store.get("leadModeEnabled") === true || selectedVoiceDestination();
  if (refs.button) refs.button.classList.toggle("hidden", !shouldShow);
  if (refs.panel) refs.panel.classList.toggle("hidden", !shouldShow || !panelOpen);
  if (refs.threadHint) refs.threadHint.textContent = store.get("leadModeEnabled") === true ?
    "Talking with Coop" : "Talking with " + (store.get("activeSessionTitle") || "this session");
  renderState(active);
}

function startOrStopListening() {
  var state = controller.getState();
  if (state.listening || state.phase === "connecting") {
    controller.stopListening();
    return;
  }
  if (store.get("voiceDictationActive")) {
    refs.status.textContent = "Stop composer dictation before starting Voice conversation.";
    refs.status.classList.add("voice-conversation-error");
    return;
  }
  if (store.get("leadModeEnabled") === true && (store.get("currentSlug") !== "lead" || !store.get("activeCoopHome"))) {
    store.set({ voiceStartPending: true });
    switchProject("lead", { exactProject: true });
    return;
  }
  var routing = state.routing && isCurrentVoiceConversationRouting(state.routing) ?
    state.routing : captureVoiceConversationRouting();
  if (!isSafeVoiceConversationRouting(routing)) {
    refs.status.textContent = "Select a conversation before listening.";
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
    if (panelOpen) {
      updateDeviceLabel();
      startOrStopListening();
    } else {
      store.set({ voiceStartPending: false });
      controller.end();
    }
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
    '<div class="voice-conversation-device">Speech sends after a short pause. Say “end voice conversation” when finished.</div>' +
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
  questions = createVoiceQuestions({
    send: function (message, routing) {
      return store.get("connected") && isCurrentVoiceConversationRouting(routing) && sendWsJson(message);
    },
    speak: function (text) { if (controller) controller.speakPrompt(text); },
    onState: function (state) { store.set({ voiceQuestionState: state }); },
    onReady: function () { if (controller) controller.refreshPending(); },
    onRejected: function (id, text) {
      controller.receive({ type: "message_failed", clientMessageId: id, text: text }, false);
    },
  });
  controller = createVoiceConversationController({
    questions: questions,
    connected: !!store.get("connected"),
    requestTurnState: function (routing, clientMessageId, clientRequestId) {
      return store.get("connected") && isCurrentVoiceConversationRouting(routing) && sendWsJson({
        type: "voice_turn_state_request", sessionId: routing.sessionId,
        clientMessageId: clientMessageId, clientRequestId: clientRequestId,
      });
    },
    createInterruptionRecognition: function () {
      var Recognition = browserRecognition();
      return Recognition ? new Recognition() : null;
    },
    createRecognition: function () {
      var Recognition = browserRecognition();
      return Recognition ? new Recognition() : null;
    },
    mediaDevices: typeof navigator !== "undefined" ? navigator.mediaDevices : null,
    speechSynthesis: typeof window !== "undefined" ? window.speechSynthesis : null,
    createUtterance: function (text) {
      return typeof window !== "undefined" && window.SpeechSynthesisUtterance ? new window.SpeechSynthesisUtterance(text) : null;
    },
    sendVoiceText: function (text, routing, clientMessageId) {
      return sendVoiceConversationMessage(text, routing, clientMessageId);
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
    var active = controller.getState();
    if (active.routing && (state.currentSlug !== previous.currentSlug ||
        state.activeSessionId !== previous.activeSessionId ||
        state.leadModeEnabled !== previous.leadModeEnabled ||
        state.dmMode !== previous.dmMode) && !isCurrentVoiceConversationRouting(active.routing)) {
      controller.end("Voice paused because the conversation changed.");
    }
    if (state.connected !== previous.connected) controller.setConnected(!!state.connected);
    if (state.voiceStartPending && state.connected && !state.replayingHistory &&
        state.activeCoopHome && selectedVoiceDestination()) {
      store.set({ voiceStartPending: false });
      startOrStopListening();
    }
    if (state.voiceStartPending && (state.leadModeEnabled !== true ||
        previous.currentSlug === "lead" && state.currentSlug !== "lead")) store.set({ voiceStartPending: false });
    if (state.activeCoopHome !== previous.activeCoopHome ||
        state.activeSessionId !== previous.activeSessionId ||
        state.leadModeEnabled !== previous.leadModeEnabled ||
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
  if (controller && isCurrentVoiceConversationRouting(controller.getState().routing)) {
    var replaying = !!store.get("replayingHistory");
    // These are fresh, correlated protocol replies, even when historical chat
    // rendering is still in progress after reconnect. Their request IDs guard
    // against stale responses; suppressing them would strand recovery.
    var liveReply = message.type === "voice_turn_state" || message.type === "voice_question_state" ||
      message.type === "voice_question_answer_result";
    // The current turn finishes before a refreshed question snapshot is read;
    // otherwise every done event would suppress its own spoken reply.
    controller.receive(message, replaying && !liveReply);
    questions.receive(message, message.type === "history_done" || liveReply ? false : replaying);
  }
}

export function getVoiceConversationController() {
  return controller;
}
