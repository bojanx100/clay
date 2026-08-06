var test = require("node:test");
var assert = require("node:assert/strict");

var controlModule = require("../lib/coop-conversation-control");
var queueModule = require("../lib/project-user-message-queue");

function makeHarness(session) {
  var events = [];
  var sm = {
    saveSessionFile: function () { events.push("save"); },
    broadcastSessionList: function () { events.push("broadcast"); },
    queuedUserMessagesForClient: function () { return []; },
  };
  var control = controlModule.attachCoopConversationControl({
    sm: sm,
    sendToSession: function (id, message) { events.push(message.type); },
  });
  var queue = queueModule.attachProjectUserMessageQueue({
    sm: sm,
    coopControl: control,
    sdk: {
      startQuery: function (target, text) { events.push("start:" + text); },
      pushMessage: function (target, text) { events.push("push:" + text); },
    },
    sendToSession: function (id, message) { events.push(message.type); },
    onProcessingChanged: function () { events.push("processing"); },
    onUserMessageDispatched: function () { return ""; },
    ensureProjectAccessForSession: function () { return null; },
  });
  return { control: control, events: events, queue: queue };
}

test("Coop ingress has stable FIFO text and voice ids and rejects reconnect duplicates", function () {
  var session = { localId: 7, storageId: "coop-home", coopHome: true, history: [] };
  var h = makeHarness(session);
  var first = h.control.reserveIngress(session, { clientMessageId: "text-a", text: "first" });
  var second = h.control.reserveIngress(session, { clientMessageId: "voice-b", ingressType: "voice", text: "second" });
  var duplicate = h.control.reserveIngress(session, { clientMessageId: "text-a", text: "first again" });
  var duplicateVoice = h.control.reserveIngress(session, { clientMessageId: "voice-b", ingressType: "voice", text: "second again" });

  assert.deepEqual([first.ingressId, second.ingressId], ["coop:coop-home:1", "coop:coop-home:2"]);
  assert.equal(first.kind, "text");
  assert.equal(second.kind, "voice");
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ingressId, first.ingressId);
  assert.equal(duplicateVoice.accepted, false);
  assert.equal(duplicateVoice.duplicate, true);
  assert.equal(duplicateVoice.ingressId, second.ingressId);
});

test("active Coop turns prioritize later ingress without using the normal queue", function () {
  var session = {
    localId: 8,
    storageId: "coop-active",
    coopHome: true,
    history: [
      { type: "user_message", coopIngressId: "coop:coop-active:1", coopIngressPending: true },
      { type: "user_message", coopIngressId: "coop:coop-active:2", coopIngressPending: true },
    ],
    isProcessing: true,
    pendingUserMessageQueue: [],
  };
  var aborted = 0;
  session.abortController = { abort: function () { aborted++; } };
  var h = makeHarness(session);

  h.queue.dispatchPreparedToSdk(session, {
    coopIngress: true, ingressId: "coop:coop-active:2", ingressSequence: 2,
    finalText: "second", displayText: "second", images: null, pastes: null,
    imageCount: 0, clientMessageId: "two", intent: "chat",
  });
  h.queue.dispatchPreparedToSdk(session, {
    coopIngress: true, ingressId: "coop:coop-active:1", ingressSequence: 1,
    finalText: "first", displayText: "first", images: null, pastes: null,
    imageCount: 0, clientMessageId: "one", intent: "chat",
  });

  assert.deepEqual(session.pendingCoopIngress.map(function (item) { return item.ingressId; }),
    ["coop:coop-active:1", "coop:coop-active:2"]);
  assert.equal(session.pendingUserMessageQueue.length, 0);
  assert.equal(session.coopPriorityInterruptRequested, true);
  assert.ok(aborted >= 1);

  session.isProcessing = false;
  h.queue.flushCoopIngress(session);
  assert.equal(h.events.includes("start:first"), true);
  assert.equal(session.history[0].coopIngressPending, undefined);
  assert.equal(session.history[0].coopIngressDispatchedAt > 0, true);
});

test("restart recovery rebuilds only undispatched Coop ingress and preserves foreground priority", function () {
  var session = {
    localId: 9,
    storageId: "coop-restart",
    coopHome: true,
    history: [
      {
        type: "user_message",
        text: "resume text",
        coopIngressId: "coop:coop-restart:3",
        coopIngressSequence: 3,
        coopIngressKind: "voice",
        coopIngressPending: true,
        coopProjectRef: { projectId: "11111111-1111-5111-8111-111111111111" },
      },
      {
        type: "user_message",
        text: "already dispatched",
        coopIngressId: "coop:coop-restart:2",
        coopIngressSequence: 2,
        coopIngressDispatchedAt: 1,
      },
    ],
    isProcessing: false,
  };
  var h = makeHarness(session);

  assert.equal(h.queue.rebuildCoopIngressFromHistory(session), true);
  assert.equal(h.queue.rebuildCoopIngressFromHistory(session), false);
  assert.equal(session.pendingCoopIngress.length, 1);
  assert.equal(session.pendingCoopIngress[0].ingressId, "coop:coop-restart:3");
  assert.match(session.pendingCoopIngress[0].finalText, /<coop_foreground_turn>/);
  assert.match(session.pendingCoopIngress[0].finalText, /<coop_project_context>/);
});
