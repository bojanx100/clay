var test = require("node:test");
var assert = require("node:assert/strict");
require("./helpers/isolated-clay-home");
var fixture = require("./helpers/voice-question-fixture");
var route = { projectSlug: "lead", sessionId: 7, canonicalCoop: true, scope: "topic", topicRef: { topicId: "topic" } };

async function harness() {
  var mod = await import("../lib/public/modules/voice-questions.js");
  var h = fixture(), sent = [], spoken = [], rejected = [], timers = new Map(), serial = 0;
  var q = mod.createVoiceQuestions({ send: function (message) { sent.push(message); return true; },
    speak: function (text) { spoken.push(text); }, onRejected: function (id, text) { rejected.push({ id: id, text: text }); },
    setTimeout: function (fn) { timers.set(++serial, fn); return serial; }, clearTimeout: function (id) { timers.delete(id); } });
  function snapshot() {
    var request = sent.filter(function (msg) { return msg.type === "voice_question_state_request"; }).slice(-1)[0];
    h.send(request); q.receive(h.events[h.events.length - 1]);
  }
  return { server: h, q: q, sent: sent, spoken: spoken, rejected: rejected, timers: timers, snapshot: snapshot,
    start: function () { q.start(route); snapshot(); },
    submit: function () {
      q.consume("option one"); q.consume("submit answers");
      return sent[sent.length - 1];
    } };
}

test("spoken options match complete utterances, preserve free-text conditions and reject ambiguous assent", async function () {
  var resolve = (await import("../lib/public/modules/voice-questions.js")).resolveSpokenAnswer;
  var q = { options: [{ label: "Small change" }, { label: "Rebuild" }], allowOther: true };
  assert.deepEqual(resolve(q, "the second option."), ["Rebuild"]);
  assert.deepEqual(resolve(q, "SMALL CHANGE"), ["Small change"]);
  assert.deepEqual(resolve(q, "Rebuild only if the existing approach cannot handle it"), ["Rebuild only if the existing approach cannot handle it"]);
  assert.equal(resolve(q, "yes"), null);
  assert.equal(resolve(q, "option 99"), null);
  assert.deepEqual(resolve(Object.assign({}, q, { multiSelect: true }), "one and two"), ["Small change", "Rebuild"]);
  assert.equal(resolve(Object.assign({}, q, { allowOther: false }), "Rebuild unless it is costly"), null);
});

test("Voice discovers live questions, reads options, reviews all answers and submits once to that exact instance", async function () {
  var h = await harness(); h.server.add("live");
  h.server.session.pendingAskUser.live.input.questions.push({ question: "What must stay?", options: [] });
  h.start();
  assert.match(h.spoken[0], /Which approach\?.*Option 1: Keep it simple.*Option 2: Rebuild/);
  assert.equal(h.q.consume("yes").handled, true);
  assert.match(h.spoken.slice(-1)[0], /could not match/);
  h.q.consume("one"); h.q.consume("Keep existing manual project workflows");
  assert.match(h.spoken.slice(-1)[0], /Your answers:.*Keep it simple.*Keep existing manual project workflows.*submit answers/);
  assert.equal(h.sent.some(function (msg) { return msg.type === "voice_question_answer"; }), false);
  h.q.consume("submit answers");
  var answer = h.sent.slice(-1)[0];
  assert.equal(answer.requestId, "live");
  assert.equal(answer.coopComposerScope, route.scope);
  assert.deepEqual(answer.coopTopicRef, route.topicRef);
  h.q.consume("submit answers");
  assert.equal(h.sent.filter(function (msg) { return msg.type === "voice_question_answer"; }).length, 1);
  h.server.send(answer);
  assert.equal(h.server.starts.length, 1);
  h.q.receive(h.server.events.slice(-1)[0]); h.snapshot();
  assert.equal(h.q.isWaiting(), false);
  assert.equal(h.q.consume("what changed?"), null);
  h.q.reset();
});

test("changed questions discard unsent answers; replay and repeated snapshots never resurrect or repeat a question", async function () {
  var h = await harness(); h.server.add("same-id"); h.start();
  h.q.consume("one"); var count = h.spoken.length;
  h.q.refresh(); h.snapshot(); assert.equal(h.spoken.length, count);
  h.server.add("same-id", "mcp", "A new decision?");
  h.q.refresh(); h.snapshot(); assert.match(h.spoken.slice(-1)[0], /A new decision/);
  h.q.consume("submit answers");
  assert.equal(h.sent.some(function (msg) { return msg.type === "voice_question_answer"; }), false);
  var before = h.sent.length;
  h.q.receive({ type: "tool_executing", name: "AskUserQuestion" }, true);
  h.q.receive({ type: "done", sessionId: 8 });
  assert.equal(h.sent.length, before);
  h.q.reset();
});

test("reconnect reconciles a lost question acknowledgement without automatic resubmission", async function () {
  for (var consumed of [false, true]) {
    var h = await harness(); h.server.add("live"); h.start();
    var answer = h.submit();
    if (consumed) h.server.send(answer);
    h.q.reconnect(); h.snapshot();
    assert.equal(h.sent.filter(function (msg) { return msg.type === "voice_question_answer"; }).length, 1);
    if (consumed) {
      assert.equal(h.q.isWaiting(), false);
      assert.equal(h.server.starts.length, 1);
    } else {
      assert.equal(h.rejected.length, 1);
      h.q.consume("submit answers");
      h.server.send(h.sent.slice(-1)[0]);
      assert.equal(h.server.starts.length, 1);
    }
    h.q.reset();
  }
});

test("unavailable state, private forms and missing backend never turn spoken answers into chat", async function () {
  var h = await harness(); h.q.start(route);
  assert.equal(h.q.consume("yes").handled, true);
  Array.from(h.timers.values()).forEach(function (fn) { fn(); });
  assert.match(h.spoken.slice(-1)[0], /retry questions/);
  h.server.session.pendingPermissions.x = {};
  h.snapshot(); assert.equal(h.q.consume("yes").handled, true);
  assert.match(h.spoken.slice(-1)[0], /needs attention on screen/);
  assert.equal(h.sent.some(function (msg) { return msg.type === "voice_question_answer"; }), false);
  h.q.reset(); assert.equal(h.q.consume("hello"), null);
});

test("Codex question identifiers cannot alter the client answer object's prototype", async function () {
  var h = await harness();
  h.server.session.pendingElicitations.code = { request: { questionKind: "codex_user_input",
    questions: [{ id: "__proto__", question: "Which approach?", options: [{ label: "Keep it simple" }] }] }, resolve: function () {} };
  h.start(); var answer = h.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(answer.answers)), JSON.parse('{"__proto__":["Keep it simple"]}'));
  h.server.send(answer); assert.equal(h.server.events.slice(-1)[0].ok, true);
  h.q.reset();
});

test("recognized speech completes a pending Claude question and reads its attributed follow-up without sending a stray chat message", async function () {
  var module = await import("../lib/public/modules/voice-questions.js");
  var controllerModule = await import("../lib/public/modules/voice-conversation-controller.js");
  var h = fixture(), network = [], chats = [], speech = [], recognition = [], timers = new Map(), serial = 0, played = 0;
  h.add("live");
  var questions = module.createVoiceQuestions({ send: function (msg) { network.push(msg); return true; },
    speak: function (text) { controller.speakPrompt(text); }, onReady: function () { controller.refreshPending(); },
    setTimeout: function () { return 1; }, clearTimeout: function () {} });
  var controller = controllerModule.createVoiceConversationController({ questions: questions,
    createRecognition: function () { var r = { start: function () {}, stop: function () {} }; recognition.push(r); return r; },
    sendVoiceText: function (text) { chats.push(text); return true; },
    speechSynthesis: { speak: function (u) { speech.push(u); }, cancel: function () {} }, createUtterance: function (text) { return { text: text }; },
    setTimeout: function (fn) { timers.set(++serial, fn); return serial; }, clearTimeout: function (id) { timers.delete(id); } });
  function receive(msg) { controller.receive(msg); questions.receive(msg); }
  function pump() {
    while (network.length) {
      var before = h.events.length; h.send(network.shift());
      h.events.slice(before).forEach(receive);
    }
  }
  function listen() { while (played < speech.length) speech[played++].onend(); }
  function say(text) {
    var r = recognition.slice(-1)[0]; assert.equal(typeof r.onresult, "function", "listening resumes without a click");
    r.onresult({ results: [{ isFinal: true, 0: { transcript: text } }], resultIndex: 0 });
    var callbacks = Array.from(timers.values()); timers.clear(); callbacks.forEach(function (fn) { fn(); });
  }
  await controller.start(route); pump(); listen();
  say("one"); listen(); say("submit answers"); pump();
  assert.equal(chats.length, 0);
  assert.equal(h.starts.length, 1);
  assert.match(h.starts[0].text, /Which approach\? → Keep it simple/);
  // The normal queue announces actual SDK dispatch separately from acceptance.
  receive({ type: "user_turn_started", clientMessageId: h.starts[0].clientMessageId });
  receive({ type: "delta", text: "I will keep the existing flow." }); receive({ type: "done" }); pump(); listen();
  assert.equal(speech.slice(-1)[0].text, "I will keep the existing flow.");
  assert.equal(controller.getState().listening, true);
  say("what is next?"); assert.deepEqual(chats, ["what is next?"]);
  controller.end();
});
