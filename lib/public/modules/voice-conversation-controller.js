// Browser-independent conversation lifecycle. A recording and its callbacks
// belong to one destination; a reply belongs to one dispatched user turn.
import { sanitizeVoiceText, voiceSpeechChunks } from './voice-sanitization.js';
import { isSafeVoiceConversationRouting } from './voice-conversation-routing.js';

function clone(value) { return value ? JSON.parse(JSON.stringify(value)) : null; }

export function createVoiceConversationController(options) {
  var opts = options || {};
  var recognition = null;
  var utterance = null;
  var generation = 0;
  var finalTimer = null;
  var finalText = "";
  var activeTurn = null;
  var repliesToActiveTurn = false;
  var assistantText = "";
  var speechQueue = [];
  var schedule = opts.setTimeout || setTimeout;
  var unschedule = opts.clearTimeout || clearTimeout;
  var state = {
    phase: "idle", listening: false, working: false, speaking: false,
    reconnecting: opts.connected === false, pending: [], error: "", routing: null,
    wantsListening: false,
  };

  function snapshot() {
    return {
      phase: state.phase, listening: state.listening, working: state.working,
      speaking: state.speaking, reconnecting: state.reconnecting,
      pendingCount: state.pending.length + (finalText ? 1 : 0), error: state.error,
      routing: clone(state.routing), wantsListening: state.wantsListening,
    };
  }
  function publish() { if (opts.onState) opts.onState(snapshot()); }
  function transcript(role, text, final) {
    if (opts.onTranscript) opts.onTranscript({ role: role, text: text, final: final });
  }
  function stopRecognition() {
    var previous = recognition;
    recognition = null;
    state.listening = false;
    if (!previous) return;
    previous.onresult = previous.onend = previous.onerror = null;
    try { previous.abort ? previous.abort() : previous.stop(); } catch (e) {}
  }
  function silence() {
    utterance = null;
    speechQueue = [];
    state.speaking = false;
    if (opts.speechSynthesis) opts.speechSynthesis.cancel();
  }
  function setError(message) {
    generation++;
    state.wantsListening = false;
    stopRecognition();
    state.error = message;
    state.phase = "error";
    publish();
  }
  function newId() {
    return "voice-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }
  function flushPending() {
    if (state.reconnecting || activeTurn || state.speaking || !state.pending.length ||
        opts.questions && opts.questions.isWaiting()) return;
    var item = state.pending[0];
    if (!opts.sendVoiceText || !opts.sendVoiceText(item.text, clone(item.routing), item.id)) return;
    state.pending.shift();
    activeTurn = item;
    repliesToActiveTurn = false;
    assistantText = "";
    state.working = true;
    state.phase = state.listening ? "listening" : "working";
    publish();
  }
  function flushFinal() {
    if (finalTimer) unschedule(finalTimer);
    finalTimer = null;
    var text = finalText.trim();
    finalText = "";
    if (!text || !state.routing) return;
    transcript("user", text, true);
    // An exact, explicitly named audio command cannot accidentally stop work.
    if (/^(?:end|stop) voice conversation[.!?]?$/i.test(text)) {
      end("Voice conversation ended.");
      return;
    }
    var questionAnswer = opts.questions && opts.questions.consume(text);
    if (questionAnswer && questionAnswer.handled) {
      if (questionAnswer.clientMessageId) {
        activeTurn = { id: questionAnswer.clientMessageId, routing: clone(state.routing) };
        repliesToActiveTurn = false;
        assistantText = "";
        state.working = true;
      }
      publish();
      return;
    }
    state.pending.push({ text: text, routing: clone(state.routing), id: newId() });
    flushPending();
    publish();
  }
  function collectResults(event) {
    var results = event && event.results || [];
    var start = Number.isInteger(event && event.resultIndex) ? event.resultIndex : 0;
    var interim = "";
    for (var i = start; i < results.length; i++) {
      var text = results[i] && results[i][0] && results[i][0].transcript || "";
      if (results[i].isFinal) finalText += (finalText ? " " : "") + text.trim();
      else interim += text;
    }
    transcript("user", [finalText, interim].filter(Boolean).join(" "), false);
    if (finalTimer) unschedule(finalTimer);
    // Recognition may finalize each phrase separately. Wait for a short pause
    // so one spoken request is one message, without pressing Send.
    if (finalText) finalTimer = schedule(flushFinal, opts.endOfUtteranceMs === undefined ? 800 : opts.endOfUtteranceMs);
    publish();
  }
  function beginRecognition() {
    if (!state.wantsListening || state.reconnecting || state.speaking || recognition) return false;
    var owned;
    try {
      owned = opts.createRecognition && opts.createRecognition();
      if (!owned) {
        setError("Speech recognition is not supported in this browser. You can still use the text composer.");
        return false;
      }
      recognition = owned;
      owned.continuous = opts.singleUtteranceMode !== true;
      owned.interimResults = true;
      if (opts.language) owned.lang = opts.language;
      owned.onresult = function (event) { if (recognition === owned) collectResults(event); };
      owned.onerror = function (event) {
        if (recognition !== owned) return;
        var code = event && event.error || "unknown";
        if (code === "no-speech") return;
        if (code === "not-allowed" || code === "service-not-allowed") {
          setError("Microphone access was denied. Allow microphone access in site settings, then try again.");
        } else if (code === "audio-capture") {
          setError("No microphone is available. Connect a microphone and try again.");
        } else setError("Speech recognition stopped: " + code + ".");
      };
      owned.onend = function () {
        if (recognition !== owned) return;
        recognition = null;
        state.listening = false;
        if (state.wantsListening && !state.speaking && !state.reconnecting) beginRecognition();
        else publish();
      };
      owned.start();
      state.error = "";
      state.listening = true;
      state.phase = "listening";
      publish();
      return true;
    } catch (error) {
      setError("Unable to start speech recognition. Try Listen again after checking your microphone.");
      return false;
    }
  }
  function resume() {
    if (state.wantsListening && !state.reconnecting) beginRecognition();
    flushPending();
    if (!state.listening && !state.speaking) state.phase = state.working ? "working" : "idle";
    publish();
  }
  function speakNext() {
    if (!speechQueue.length) {
      utterance = null;
      state.speaking = false;
      resume();
      return;
    }
    try {
      utterance = opts.createUtterance(speechQueue.shift());
      if (!utterance) throw new Error("unavailable");
      var owned = utterance;
      owned.onend = function () { if (utterance === owned) speakNext(); };
      owned.onerror = function () {
        if (utterance !== owned) return;
        utterance = null;
        speechQueue = [];
        state.speaking = false;
        state.error = "Speech playback stopped. The full reply is in the conversation.";
        resume();
      };
      opts.speechSynthesis.speak(owned);
    } catch (error) {
      utterance = null;
      speechQueue = [];
      state.speaking = false;
      state.error = "Speech playback is unavailable. The full reply is in the conversation.";
      resume();
    }
  }
  function speak(text) {
    var speakable = sanitizeVoiceText(text, 0);
    if (!speakable) { resume(); return; }
    transcript("assistant", speakable, true);
    if (!opts.speechSynthesis || !opts.createUtterance) {
      state.error = "Speech playback is unavailable in this browser.";
      resume();
      return;
    }
    // Half duplex avoids hearing our own answer as an owner instruction.
    state.speaking = true;
    stopRecognition();
    state.phase = "speaking";
    speechQueue = voiceSpeechChunks(speakable);
    publish();
    speakNext();
  }
  function end(reason) {
    generation++;
    state.wantsListening = false;
    stopRecognition();
    silence();
    if (finalTimer) unschedule(finalTimer);
    finalTimer = null;
    finalText = "";
    state.pending = [];
    activeTurn = null;
    assistantText = "";
    repliesToActiveTurn = false;
    state.working = false;
    state.reconnecting = false;
    state.routing = null;
    if (opts.questions) opts.questions.reset();
    state.phase = "idle";
    state.error = reason || "";
    publish();
  }
  return {
    start: function (routing) {
      if (!isSafeVoiceConversationRouting(routing)) {
        setError("Open Coop with Lead on, or select a session with Lead off, before starting Voice.");
        return Promise.resolve(false);
      }
      if (state.routing && JSON.stringify(state.routing) !== JSON.stringify(routing)) end();
      if (state.speaking) silence();
      if (recognition || state.phase === "connecting") return Promise.resolve(true);
      var needsQuestions = !state.routing;
      state.routing = clone(routing);
      if (needsQuestions && opts.questions) opts.questions.start(state.routing);
      state.wantsListening = true;
      state.error = "";
      state.phase = "connecting";
      var ownedGeneration = ++generation;
      publish();
      var permission;
      try {
        permission = opts.mediaDevices && opts.mediaDevices.getUserMedia ?
          opts.mediaDevices.getUserMedia({ audio: true }) : null;
      } catch (error) { permission = Promise.reject(error); }
      return Promise.resolve(permission).then(function (stream) {
        var tracks = stream && stream.getTracks ? stream.getTracks() : [];
        tracks.forEach(function (track) { track.stop(); });
        if (generation !== ownedGeneration || !state.wantsListening) return false;
        return beginRecognition();
      }).catch(function (error) {
        if (generation !== ownedGeneration) return false;
        setError(error && (error.name === "NotAllowedError" || error.name === "SecurityError") ?
          "Microphone access was denied. Allow microphone access in site settings, then try again." :
          "Unable to open the microphone. Check the device and try again.");
        return false;
      });
    },
    stopListening: function () {
      generation++;
      state.wantsListening = false;
      stopRecognition();
      flushFinal();
      if (!state.speaking) state.phase = state.working ? "working" : "idle";
      publish();
    },
    stopSpeech: function () { silence(); resume(); },
    cancelTurn: function () {
      state.pending = [];
      activeTurn = null;
      assistantText = "";
      state.working = false;
      silence();
      resume();
    },
    receive: function (message, replayingHistory) {
      if (!message || replayingHistory || !state.routing) return;
      if (message.sessionId !== undefined && String(message.sessionId) !== String(state.routing.sessionId)) return;
      if (message.type === "user_turn_started") {
        repliesToActiveTurn = !!(activeTurn && message.clientMessageId === activeTurn.id);
        assistantText = "";
        return;
      }
      if (message.type === "coop_internal_turn_started") { repliesToActiveTurn = false; assistantText = ""; return; }
      if (!activeTurn) return;
      if (message.type === "message_failed" && message.clientMessageId === activeTurn.id) {
        activeTurn = null;
        state.working = false;
        speak(message.text || "Your voice message could not be sent.");
        return;
      }
      if (!repliesToActiveTurn) return;
      if (message.type === "delta" && typeof message.text === "string") assistantText += message.text;
      if (message.type === "delta_replace" && typeof message.text === "string") assistantText = message.text;
      if (message.type === "error") assistantText = message.text || message.message || "The turn failed. Please try again.";
      if (message.type === "done") {
        activeTurn = null;
        repliesToActiveTurn = false;
        state.working = false;
        var response = assistantText;
        assistantText = "";
        if (opts.questions && opts.questions.hasQuestion()) resume();
        else speak(response);
      }
    },
    speakPrompt: function (text) {
      // A pending question may change during the pause before an utterance is
      // sent. Speech captured before this prompt cannot answer its new revision.
      if (finalTimer) unschedule(finalTimer);
      finalTimer = null;
      finalText = "";
      silence(); speak(text);
    },
    refreshPending: flushPending,
    setConnected: function (connected) {
      state.reconnecting = !connected;
      if (!state.routing) return;
      if (!connected) {
        stopRecognition();
        silence();
        state.phase = "reconnecting";
        publish();
      } else {
        if (opts.questions) opts.questions.reconnect();
        resume();
      }
    },
    end: end,
    getState: snapshot,
  };
}
