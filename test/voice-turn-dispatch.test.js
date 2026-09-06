var test = require("node:test");
var assert = require("node:assert/strict");
var queueModule = require("../lib/project-user-message-queue");

test("Voice reply attribution is emitted at actual SDK dispatch, after queuing, for ordinary and Coop turns", function () {
  [false, true].forEach(function (coopHome) {
    var events = [];
    var session = { localId: 7, coopHome: coopHome, history: [], isProcessing: true, pendingUserMessageQueue: [] };
    var queue = queueModule.attachProjectUserMessageQueue({
      sm: { saveSessionFile: function () {}, broadcastSessionList: function () {}, queuedUserMessagesForClient: function () { return []; },
        sendAndRecord: function (target, message) { target.history.push(message); } },
      sdk: { startQuery: function () { events.push({ type: "sdk_started" }); }, pushMessage: function () { return false; } },
      sendToSession: function (id, event) { assert.equal(id, 7); events.push(event); },
      onProcessingChanged: function () {}, ensureProjectAccessForSession: function () {},
    });
    queue.dispatchPreparedToSdk(session, { finalText: "status please", displayText: "status please", clientMessageId: "voice-regression",
      steer: false, intent: "chat", fromQueue: false, coopIngress: coopHome,
      ingressId: coopHome ? "coop:home:1" : null, ingressSequence: 1 });
    assert.equal(events.some(function (e) { return e.type === "user_turn_started"; }), false);
    assert.equal(coopHome ? session.pendingCoopIngress.length : session.pendingUserMessageQueue.length, 1);
    session.isProcessing = false;
    session.taskStopRequested = false;
    assert.equal(coopHome ? queue.flushCoopIngress(session) : queue.flushQueuedUserMessage(session), true);
    var start = events.findIndex(function (e) { return e.type === "user_turn_started"; });
    assert.ok(start >= 0);
    assert.equal(events[start].clientMessageId, "voice-regression");
    assert.ok(events.findIndex(function (e) { return e.type === "sdk_started"; }) > start);
  });
});
