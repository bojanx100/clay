var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function loadController() {
  var file = path.join(__dirname, "..", "lib", "public", "modules", "voice-conversation-controller.js");
  return import(pathToFileURL(file).href + "?voice-controller=" + Date.now() + Math.random());
}

function fakeRecognitionFactory(items) {
  return function () {
    var recognition = {
      starts: 0,
      stops: 0,
      start: function () { this.starts++; },
      stop: function () { this.stops++; },
      emitFinal: function (text) {
        this.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
      },
    };
    items.push(recognition);
    return recognition;
  };
}

function fakeMedia() {
  var track = { stopped: false, stop: function () { this.stopped = true; } };
  return {
    track: track,
    getUserMedia: function () { return Promise.resolve({ getTracks: function () { return [track]; } }); },
  };
}

test("a confirmed voice utterance retains the ThreadRef captured before recording", async function () {
  var mod = await loadController();
  var recognitions = [];
  var sent = [];
  var media = fakeMedia();
  var controller = mod.createVoiceConversationController({
    createRecognition: fakeRecognitionFactory(recognitions),
    mediaDevices: media,
    sendVoiceText: function (text, routing) { sent.push({ text: text, routing: routing }); return true; },
  });
  var routing = { scope: "topic", topicRef: { topicId: "recovery-voice-ingresses-360-362" }, projectRef: { projectId: "clay" } };

  await controller.start(routing);
  routing.topicRef.topicId = "wrong-thread";
  recognitions[0].emitFinal("keep this in Voice");

  assert.equal(media.track.stopped, true);
  assert.deepEqual(sent, [{
    text: "keep this in Voice",
    routing: { scope: "topic", topicRef: { topicId: "recovery-voice-ingresses-360-362" }, projectRef: { projectId: "clay" } },
  }]);
  assert.equal(controller.getState().listening, true);
  assert.equal(controller.getState().working, true);
});

test("speech is sanitized, uses half-duplex playback, and a new Listen press barges in", async function () {
  var mod = await loadController();
  var recognitions = [];
  var media = fakeMedia();
  var spoken = [];
  var synthesis = {
    cancelled: 0,
    cancel: function () { this.cancelled++; },
    speak: function (utterance) { spoken.push(utterance); },
  };
  var controller = mod.createVoiceConversationController({
    createRecognition: fakeRecognitionFactory(recognitions),
    mediaDevices: media,
    speechSynthesis: synthesis,
    createUtterance: function (text) { return { text: text }; },
    sendVoiceText: function () { return true; },
  });
  var routing = { scope: "topic", topicRef: { topicId: "recovery-voice-ingresses-360-362" } };
  await controller.start(routing);
  recognitions[0].emitFinal("what changed?");
  controller.receive({ type: "delta", text: "Done. token=super-secret-value and `code` are hidden." }, false);
  controller.receive({ type: "done" }, false);

  assert.equal(controller.getState().speaking, true);
  assert.match(spoken[0].text, /\[redacted\]/);
  assert.doesNotMatch(spoken[0].text, /super-secret-value|code/);
  assert.equal(recognitions[0].stops > 0, true, "TTS pauses recognition to prevent echo approval");

  await controller.start(routing);
  assert.equal(synthesis.cancelled > 0, true, "manual Listen is an immediate barge-in");
  assert.equal(controller.getState().listening, true);
});

test("permission failures are actionable and do not leave the conversation listening", async function () {
  var mod = await loadController();
  var controller = mod.createVoiceConversationController({
    createRecognition: function () { throw new Error("must not create recognition"); },
    mediaDevices: { getUserMedia: function () { return Promise.reject({ name: "NotAllowedError" }); } },
  });
  var started = await controller.start({ scope: "topic", topicRef: { topicId: "recovery-voice-ingresses-360-362" } });

  assert.equal(started, false);
  assert.equal(controller.getState().listening, false);
  assert.match(controller.getState().error, /Microphone access was denied/);
});

test("confirmed audio waits through reconnect and flushes with its original ThreadRef", async function () {
  var mod = await loadController();
  var recognitions = [];
  var sent = [];
  var controller = mod.createVoiceConversationController({
    createRecognition: fakeRecognitionFactory(recognitions),
    mediaDevices: fakeMedia(),
    sendVoiceText: function (text, routing) { sent.push({ text: text, routing: routing }); return true; },
  });
  var routing = { scope: "topic", topicRef: { topicId: "recovery-voice-ingresses-360-362" } };
  await controller.start(routing);
  controller.setConnected(false);
  recognitions[0].emitFinal("send after reconnect");
  assert.equal(sent.length, 0);

  controller.setConnected(true);
  assert.deepEqual(sent, [{ text: "send after reconnect", routing: routing }]);
  assert.equal(controller.getState().pendingCount, 0);
});

test("cancel turn silences only Voice state and never emits a work-stop operation", async function () {
  var mod = await loadController();
  var operations = [];
  var controller = mod.createVoiceConversationController({
    createRecognition: fakeRecognitionFactory([]),
    mediaDevices: fakeMedia(),
    sendVoiceText: function (text) { operations.push({ type: "message", text: text }); return true; },
    speechSynthesis: { cancel: function () { operations.push({ type: "stop_speech" }); }, speak: function () {} },
    createUtterance: function () { return {}; },
  });
  await controller.start({ scope: "topic", topicRef: { topicId: "recovery-voice-ingresses-360-362" } });
  controller.cancelTurn();

  assert.equal(operations.some(function (operation) { return operation.type === "stop_work"; }), false);
  assert.equal(controller.getState().working, false);
});
