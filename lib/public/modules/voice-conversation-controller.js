// Browser-independent Voice conversation turn controller. Browser bindings
// provide Web Speech, microphone permission, and speech synthesis; this module
// owns turn provenance, reconnect queuing, and stop-speech semantics.

import { sanitizeVoiceText } from './voice-sanitization.js';

function clone(value) {
  if (!value || typeof value !== "object") return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return null; }
}

function textFromResults(event) {
  var finalText = "";
  var interimText = "";
  var results = event && event.results ? event.results : [];
  var start = Number.isInteger(event && event.resultIndex) ? event.resultIndex : 0;
  for (var i = start; i < results.length; i++) {
    var result = results[i];
    var text = result && result[0] && typeof result[0].transcript === "string" ? result[0].transcript : "";
    if (result && result.isFinal) finalText += text;
    else interimText += text;
  }
  return { final: finalText.trim(), interim: interimText.trim() };
}

function stateSnapshot(state) {
  return {
    phase: state.phase,
    listening: state.listening,
    working: state.working,
    speaking: state.speaking,
    reconnecting: state.reconnecting,
    pendingCount: state.pending.length,
    error: state.error,
    routing: clone(state.routing),
  };
}

export function createVoiceConversationController(options) {
  var opts = options || {};
  var recognition = null;
  var utterance = null;
  var state = {
    phase: "idle",
    listening: false,
    working: false,
    speaking: false,
    reconnecting: false,
    pending: [],
    error: "",
    routing: null,
    wantsListening: false,
    assistantText: "",
  };

  function publish() {
    if (typeof opts.onState === "function") opts.onState(stateSnapshot(state));
  }

  function setError(message) {
    state.error = String(message || "Voice conversation is unavailable.");
    state.phase = "error";
    state.listening = false;
    publish();
  }

  function releaseStream(stream) {
    var tracks = stream && typeof stream.getTracks === "function" ? stream.getTracks() : [];
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i] && typeof tracks[i].stop === "function") tracks[i].stop();
    }
  }

  function stopRecognition() {
    if (!recognition) return;
    try { recognition.stop(); } catch (e) {}
    recognition = null;
    state.listening = false;
  }

  function flushPending() {
    if (state.reconnecting || !state.pending.length) return;
    var remaining = [];
    for (var i = 0; i < state.pending.length; i++) {
      var item = state.pending[i];
      var accepted = typeof opts.sendVoiceText === "function" && opts.sendVoiceText(item.text, clone(item.routing));
      if (!accepted) remaining.push(item);
      else state.working = true;
    }
    state.pending = remaining;
    if (state.working) state.phase = state.listening ? "listening" : "working";
    publish();
  }

  function dispatchFinal(text) {
    var normalized = String(text || "").trim();
    if (!normalized || !state.routing) return;
    if (typeof opts.onTranscript === "function") opts.onTranscript({ role: "user", text: normalized, final: true });
    state.assistantText = "";
    state.working = true;
    state.pending.push({ text: normalized, routing: clone(state.routing) });
    flushPending();
  }

  function beginRecognition() {
    var factory = opts.createRecognition;
    if (typeof factory !== "function") {
      setError("Speech recognition is not supported in this browser. You can still use the text composer.");
      return false;
    }
    try {
      recognition = factory();
      if (!recognition) {
        setError("Speech recognition is not supported in this browser. You can still use the text composer.");
        return false;
      }
      recognition.continuous = true;
      recognition.interimResults = true;
      if (opts.language) recognition.lang = opts.language;
      recognition.onresult = function (event) {
        var text = textFromResults(event);
        if (text.interim && typeof opts.onTranscript === "function") {
          opts.onTranscript({ role: "user", text: text.interim, final: false });
        }
        if (text.final) dispatchFinal(text.final);
      };
      recognition.onerror = function (event) {
        var code = event && event.error || "unknown";
        if (code === "no-speech") return;
        stopRecognition();
        if (code === "not-allowed" || code === "service-not-allowed") {
          setError("Microphone access was denied. Allow microphone access in site settings, then try again.");
        } else if (code === "audio-capture") {
          setError("No microphone is available. Connect a microphone and try again.");
        } else {
          setError("Speech recognition stopped: " + code + ".");
        }
      };
      recognition.onend = function () {
        recognition = null;
        state.listening = false;
        if (state.wantsListening && !state.speaking && !state.reconnecting) {
          beginRecognition();
          return;
        }
        publish();
      };
      recognition.start();
      state.error = "";
      state.listening = true;
      state.phase = "listening";
      publish();
      return true;
    } catch (error) {
      recognition = null;
      setError("Unable to start speech recognition. Try again after checking your microphone.");
      return false;
    }
  }

  function requestPermissionAndStart() {
    var media = opts.mediaDevices;
    if (!media || typeof media.getUserMedia !== "function") return Promise.resolve(beginRecognition());
    return media.getUserMedia({ audio: true }).then(function (stream) {
      releaseStream(stream);
      return beginRecognition();
    }).catch(function (error) {
      var name = error && error.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError("Microphone access was denied. Allow microphone access in site settings, then try again.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No usable microphone was found. Check the selected input device and try again.");
      } else {
        setError("Unable to open the microphone. Check the device and try again.");
      }
      return false;
    });
  }

  function stopSpeech(resumeListening) {
    if (opts.speechSynthesis && typeof opts.speechSynthesis.cancel === "function") opts.speechSynthesis.cancel();
    utterance = null;
    state.speaking = false;
    if (resumeListening !== false && state.wantsListening && !state.reconnecting && !state.listening) beginRecognition();
    if (!state.listening && !state.working) state.phase = "idle";
    publish();
  }

  function speak(text) {
    var speakable = sanitizeVoiceText(text);
    if (!speakable || !opts.speechSynthesis || typeof opts.createUtterance !== "function") return false;
    stopRecognition(); // Half-duplex: prevent Clay's own TTS from becoming input.
    state.speaking = true;
    state.phase = "speaking";
    utterance = opts.createUtterance(speakable);
    utterance.onend = function () {
      if (utterance !== this) return;
      utterance = null;
      state.speaking = false;
      if (state.wantsListening && !state.reconnecting) beginRecognition();
      else { state.phase = state.working ? "working" : "idle"; publish(); }
    };
    utterance.onerror = function () {
      if (utterance !== this) return;
      utterance = null;
      state.speaking = false;
      state.phase = state.working ? "working" : "idle";
      publish();
    };
    if (typeof opts.onTranscript === "function") opts.onTranscript({ role: "assistant", text: speakable, final: true });
    publish();
    opts.speechSynthesis.speak(utterance);
    return true;
  }

  return {
    start: function (routing) {
      var captured = clone(routing);
      if (!captured || captured.stale || !captured.scope || !captured.topicRef) {
        setError("Open the Voice Thread before starting a voice conversation.");
        return Promise.resolve(false);
      }
      if (state.speaking) stopSpeech(false); // Explicit mic press is a barge-in.
      state.routing = captured;
      state.wantsListening = true;
      state.reconnecting = false;
      state.error = "";
      state.phase = "connecting";
      publish();
      return requestPermissionAndStart();
    },
    stopListening: function () {
      state.wantsListening = false;
      stopRecognition();
      if (!state.speaking) state.phase = state.working ? "working" : "idle";
      publish();
    },
    cancelTurn: function () {
      state.pending = [];
      state.assistantText = "";
      state.working = false;
      stopSpeech(); // This never sends a work-stop command.
      if (!state.listening) state.phase = "idle";
      publish();
    },
    receive: function (message, replayingHistory) {
      if (replayingHistory || !message || !state.working) return;
      if (message.type === "delta" && typeof message.text === "string") state.assistantText += message.text;
      else if (message.type === "delta_replace" && typeof message.text === "string") state.assistantText = message.text;
      else if (message.type === "error") {
        state.working = false;
        state.phase = state.listening ? "listening" : "idle";
        publish();
      } else if (message.type === "done") {
        state.working = false;
        var response = state.assistantText;
        state.assistantText = "";
        if (!state.speaking) speak(response);
        else publish();
      }
    },
    setConnected: function (connected) {
      if (!connected) {
        state.reconnecting = true;
        stopRecognition();
        if (opts.speechSynthesis && typeof opts.speechSynthesis.cancel === "function") opts.speechSynthesis.cancel();
        utterance = null;
        state.speaking = false;
        state.phase = "reconnecting";
        publish();
        return;
      }
      var resume = state.reconnecting;
      state.reconnecting = false;
      if (resume && state.wantsListening && !state.speaking) beginRecognition();
      flushPending();
      if (!state.listening && !state.speaking && !state.working) state.phase = "idle";
      publish();
    },
    getState: function () { return stateSnapshot(state); },
    stopSpeech: stopSpeech,
  };
}
