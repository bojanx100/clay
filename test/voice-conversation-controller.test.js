var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

var route = { canonicalCoop: true, scope: "main", projectSlug: "lead", sessionId: 7 };
async function harness(extra) {
  var mod = await import(pathToFileURL(path.join(__dirname, "../lib/public/modules/voice-conversation-controller.js")).href);
  var recognized = [], sent = [], spoken = [], transcripts = [], timers = new Map();
  var next = 1, cancelled = 0;
  var options = {
    createRecognition: function () {
      var r = { stops: 0, start: function () {}, stop: function () { this.stops++; },
        final: function (text) { if (this.onresult) this.onresult({ results: [{ isFinal: true, 0: { transcript: text } }], resultIndex: 0 }); } };
      recognized.push(r); return r;
    },
    setTimeout: function (fn) { var id = next++; timers.set(id, fn); return id; },
    clearTimeout: function (id) { timers.delete(id); },
    sendVoiceText: function (text, routing, id) { sent.push({ text: text, routing: routing, id: id }); return true; },
    speechSynthesis: { cancel: function () { cancelled++; }, speak: function (u) { spoken.push(u); } },
    createUtterance: function (text) { return { text: text }; },
    onTranscript: function (item) { transcripts.push(item); },
  };
  var controller = mod.createVoiceConversationController(Object.assign(options, extra || {}));
  function tick() { var callbacks = Array.from(timers.values()); timers.clear(); callbacks.forEach(function (fn) { fn(); }); }
  function receive(msg, replay) { controller.receive(Object.assign({ sessionId: 7 }, msg), !!replay); }
  return { controller: controller, recognized: recognized, sent: sent, spoken: spoken, transcripts: transcripts,
    tick: tick, receive: receive, cancelCount: function () { return cancelled; },
    say: function (text) { recognized[recognized.length - 1].final(text); tick(); },
    reply: function (text) { receive({ type: "user_turn_started", clientMessageId: sent[sent.length - 1].id });
      receive({ type: "delta", text: text }); receive({ type: "done" }); } };
}

test("speech combines finalized phrases after a pause and retains its copied destination", async function () {
  var h = await harness();
  var captured = Object.assign({}, route);
  await h.controller.start(captured);
  captured.sessionId = 99;
  h.recognized[0].final("check the issue");
  h.recognized[0].final("and its screenshot");
  assert.equal(h.sent.length, 0);
  h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, "check the issue and its screenshot");
  assert.equal(h.sent[0].routing.sessionId, 7);
});

test("two complete spoken exchanges send and resume listening without Send or Listen clicks", async function () {
  var h = await harness();
  await h.controller.start(route);
  h.say("what changed?");
  h.reply("The requested fix is ready.");
  assert.equal(h.controller.getState().speaking, true);
  assert.equal(h.controller.getState().listening, false);
  h.spoken[0].onend();
  assert.equal(h.controller.getState().listening, true);
  h.say("check it again");
  h.reply("The checks passed.");
  h.spoken[1].onend();
  assert.deepEqual(h.sent.map(function (item) { return item.text; }), ["what changed?", "check it again"]);
  assert.equal(h.controller.getState().listening, true);
  h.say("end voice conversation");
  assert.equal(h.controller.getState().listening, false);
  assert.equal(h.controller.getState().routing, null);
  assert.equal(h.sent.length, 2, "audio end command does not become a work stop");
});

test("a queued request ignores the preceding task, another session, and replayed output", async function () {
  var h = await harness();
  await h.controller.start(route);
  h.say("give me a status");
  h.receive({ type: "delta", text: "Previous task is done" }); h.receive({ type: "done" });
  h.receive({ type: "user_turn_started", clientMessageId: "someone-else" });
  h.receive({ type: "delta", text: "Other user's reply" }); h.receive({ type: "done" });
  h.receive({ type: "user_turn_started", clientMessageId: h.sent[0].id, sessionId: 8 });
  h.receive({ type: "delta", text: "Another session", sessionId: 8 }); h.receive({ type: "done", sessionId: 8 });
  h.receive({ type: "user_turn_started", clientMessageId: h.sent[0].id }, true);
  h.receive({ type: "delta", text: "Old replay" }, true); h.receive({ type: "done" }, true);
  assert.equal(h.spoken.length, 0);
  assert.equal(h.controller.getState().working, true);
  h.reply("Your requested status");
  assert.equal(h.spoken[0].text, "Your requested status");
});

test("long replies remain complete, redacted, and resume after the last speech chunk", async function () {
  var h = await harness();
  await h.controller.start(route); h.say("explain");
  var expected = "Here is the explanation. ".repeat(75) + "The final decision is yours.";
  h.reply(expected + " token=super-secret-value `code` [Details](https://example.invalid)");
  for (var i = 0; i < h.spoken.length; i++) h.spoken[i].onend();
  var full = h.spoken.map(function (u) { return u.text; }).join(" ");
  assert.match(full, /The final decision is yours/);
  assert.match(full, /\[redacted\]/);
  assert.match(full, /Details/);
  assert.doesNotMatch(full, /super-secret-value|code|example.invalid/);
  assert.equal(full.startsWith(expected), true);
  assert.equal(h.controller.getState().listening, true);
});

test("Stop during microphone permission cannot resurrect recording or leak the permission stream", async function () {
  var grant, stopped = 0;
  var h = await harness({ mediaDevices: { getUserMedia: function () { return new Promise(function (resolve) { grant = resolve; }); } } });
  var starting = h.controller.start(route);
  h.controller.stopListening();
  grant({ getTracks: function () { return [{ stop: function () { stopped++; } }]; } });
  assert.equal(await starting, false);
  assert.equal(stopped, 1);
  assert.equal(h.recognized.length, 0);
});

test("fatal recognition errors cannot loop through a delayed onend or onresult", async function () {
  var h = await harness(); await h.controller.start(route);
  var oldEnd = h.recognized[0].onend, oldResult = h.recognized[0].onresult;
  h.recognized[0].onerror({ error: "not-allowed" });
  oldEnd(); oldResult({ results: [{ isFinal: true, 0: { transcript: "must not send" } }] }); h.tick();
  assert.equal(h.controller.getState().listening, false);
  assert.match(h.controller.getState().error, /Microphone access was denied/);
  assert.equal(h.recognized.length, 1); assert.equal(h.sent.length, 0);
});

test("old recognition callbacks cannot disturb listening after speech playback", async function () {
  var h = await harness(); await h.controller.start(route);
  var oldEnd = h.recognized[0].onend;
  h.say("hello"); h.reply("Hello."); h.spoken[0].onend();
  oldEnd();
  assert.equal(h.recognized.length, 2);
  assert.equal(h.controller.getState().listening, true);
});

test("confirmed unsent speech waits through reconnect with its original identity and is sent once", async function () {
  var h = await harness(); await h.controller.start(route);
  h.recognized[0].final("send when back");
  h.controller.setConnected(false); h.tick();
  assert.equal(h.sent.length, 0);
  h.controller.setConnected(true); h.controller.setConnected(true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].routing, route);
});

test("navigation ends pending speech and rejects late results instead of targeting the new session", async function () {
  var h = await harness(); await h.controller.start(route);
  var oldResult = h.recognized[0].onresult;
  h.recognized[0].final("pending");
  h.controller.end("Conversation changed");
  oldResult({ results: [{ isFinal: true, 0: { transcript: "late" } }] }); h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.controller.getState().working, false);
});

test("speech failure returns to listening and manual barge-in stops audio only", async function () {
  var h = await harness(); await h.controller.start(route);
  h.say("hello"); h.reply("Hello.");
  h.spoken[0].onerror();
  assert.equal(h.controller.getState().listening, true);
  h.say("more"); h.reply("Another response.");
  await h.controller.start(route);
  assert.equal(h.cancelCount() > 0, true);
  assert.equal(h.controller.getState().listening, true);
  assert.equal(h.sent.length, 2);
});

test("unsupported recognition and permission rejection give visible failures", async function () {
  var h = await harness({ createRecognition: function () { return null; } });
  assert.equal(await h.controller.start(route), false);
  assert.match(h.controller.getState().error, /not supported/);
  h = await harness({ mediaDevices: { getUserMedia: function () { return Promise.reject({ name: "NotAllowedError" }); } } });
  assert.equal(await h.controller.start(route), false);
  assert.match(h.controller.getState().error, /Microphone access was denied/);
});
