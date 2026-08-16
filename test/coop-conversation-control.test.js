var test = require("node:test");
var assert = require("node:assert/strict");

var controlModule = require("../lib/coop-conversation-control");
var queueModule = require("../lib/project-user-message-queue");

function makeHarness(session) {
  var events = [];
  var subscribers = [];
  var sm = {
    saveSessionFile: function () { events.push("save"); },
    broadcastSessionList: function () { events.push("broadcast"); },
    queuedUserMessagesForClient: function () { return []; },
    subscribeSession: function (_, callback) {
      subscribers.push(callback);
      return function () {
        var index = subscribers.indexOf(callback);
        if (index !== -1) subscribers.splice(index, 1);
      };
    },
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
  return {
    control: control,
    emit: function (event) {
      subscribers.slice().forEach(function (callback) { callback(event); });
    },
    events: events,
    queue: queue,
    subscriberCount: function () { return subscribers.length; },
  };
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

  // The interrupted turn's finalizer clears the stop state before reconciling
  // the foreground queue.
  session.isProcessing = false;
  session.taskStopRequested = false;
  session.steerInterruptRequested = false;
  h.queue.flushCoopIngress(session);
  assert.equal(h.events.includes("start:first"), true);
  assert.equal(session.history[0].coopIngressPending, undefined);
  assert.equal(session.history[0].coopIngressDispatchedAt > 0, true);
});

test("a later Coop ingress queues without aborting the active owner answer", function () {
  var activeIngressId = "coop:coop-active-owner:1";
  var session = {
    localId: 81,
    storageId: "coop-active-owner",
    coopHome: true,
    history: [
      { type: "user_message", coopIngressId: activeIngressId,
        coopThreadRef: { threadId: "thread-a" }, coopTopicRef: { topicId: "thread-a" } },
      { type: "user_message", coopIngressId: "coop:coop-active-owner:2", coopIngressPending: true,
        coopThreadRef: { threadId: "thread-b" }, coopTopicRef: { topicId: "thread-b" } },
    ],
    coopConversationIngress: { activeIngressId: activeIngressId, nextSequence: 3, recent: [] },
    isProcessing: true,
    pendingUserMessageQueue: [],
  };
  var aborted = 0;
  session.abortController = { abort: function () { aborted++; } };
  var h = makeHarness(session);

  h.queue.dispatchPreparedToSdk(session, {
    coopIngress: true, ingressId: "coop:coop-active-owner:2", ingressSequence: 2,
    finalText: "second", displayText: "second", images: null, pastes: null,
    imageCount: 0, clientMessageId: "two", intent: "chat",
    coopThreadRef: { threadId: "thread-b" }, coopTopicRef: { topicId: "thread-b" },
  });

  assert.equal(aborted, 0);
  assert.equal(session.taskStopRequested, undefined);
  assert.equal(session.coopPriorityInterruptRequested, undefined);
  assert.deepEqual(session.pendingCoopIngress.map(function (item) { return item.ingressId; }),
    ["coop:coop-active-owner:2"]);
  var state = h.control.clientState(session);
  assert.deepEqual(state.activeThreadRefs, [{ threadId: "thread-a" }]);
  assert.deepEqual(state.queuedThreadRefs, [{ threadId: "thread-b" }]);
});

test("a queued owner ingress interrupts only after the active answer reaches a semantic checkpoint", function () {
  var activeIngressId = "coop:coop-checkpoint:1";
  var session = {
    localId: 82,
    storageId: "coop-checkpoint",
    coopHome: true,
    history: [{ type: "user_message", coopIngressId: activeIngressId }],
    coopConversationIngress: {
      activeIngressId: activeIngressId, activeResponseStartIndex: 1,
      nextSequence: 3, recent: [],
    },
    isProcessing: true,
    pendingUserMessageQueue: [],
  };
  var aborted = 0;
  session.abortController = { abort: function () { aborted++; } };
  var h = makeHarness(session);

  h.queue.dispatchPreparedToSdk(session, {
    coopIngress: true, ingressId: "coop:coop-checkpoint:2", ingressSequence: 2,
    finalText: "second", displayText: "second", intent: "chat",
  });
  assert.equal(aborted, 0, "the current sentence is never cut in half");
  assert.equal(h.subscriberCount(), 1, "the deferred interrupt watches the live turn");

  var partial = { type: "delta", text: "The first answer is still" };
  session.history.push(partial);
  h.emit(partial);
  assert.equal(aborted, 0);

  var checkpoint = { type: "delta", text: " coherent." };
  session.history.push(checkpoint);
  h.emit(checkpoint);
  assert.equal(aborted, 1);
  assert.equal(session.coopPriorityInterruptRequested, true);
  assert.equal(session.coopCheckpointInterruptRequested, true);
  assert.equal(h.subscriberCount(), 0);
});

test("a naturally completed active answer cancels its deferred interrupt", function () {
  var session = {
    localId: 83,
    storageId: "coop-natural-completion",
    coopHome: true,
    history: [{ type: "user_message", coopIngressId: "coop:coop-natural-completion:1" }],
    coopConversationIngress: {
      activeIngressId: "coop:coop-natural-completion:1", activeResponseStartIndex: 1,
      nextSequence: 3, recent: [],
    },
    isProcessing: true,
    pendingUserMessageQueue: [],
  };
  var aborted = 0;
  session.abortController = { abort: function () { aborted++; } };
  var h = makeHarness(session);
  h.queue.dispatchPreparedToSdk(session, {
    coopIngress: true, ingressId: "coop:coop-natural-completion:2", ingressSequence: 2,
    finalText: "second", displayText: "second", intent: "chat",
  });

  session.isProcessing = false;
  var done = { type: "done", code: 0 };
  session.history.push(done);
  h.emit(done);
  assert.equal(aborted, 0);
  assert.equal(h.subscriberCount(), 0);
});

test("client state attributes one active ingress to every exact Thread membership", function () {
  var storageId = "coop-multi-membership";
  var session = {
    localId: 84,
    storageId: storageId,
    coopHome: true,
    history: [{ type: "user_message", coopIngressId: "coop:multi:1" }],
    coopConversationIngress: { activeIngressId: "coop:multi:1", activeResponseStartIndex: 1 },
    isProcessing: true,
  };
  var topicIndex = { load: function () { return { topics: {
    alpha: { threadRef: { threadId: "alpha" }, status: "open",
      eventRefs: [{ sessionStorageId: storageId, eventIndex: 0 }], turnRefs: [] },
    beta: { threadRef: { threadId: "beta" }, status: "open",
      eventRefs: [{ sessionStorageId: storageId, eventIndex: 0 }], turnRefs: [] },
  } }; } };
  var state = controlModule.clientState(session, { topicIndex: topicIndex });
  assert.deepEqual(state.activeThreadRefs, [{ threadId: "alpha" }, { threadId: "beta" }]);
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
        coopTopicRef: { topicId: "queued-message-recovery" },
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
  assert.match(session.pendingCoopIngress[0].finalText, /<coop_topic_context>/);
  assert.match(session.pendingCoopIngress[0].finalText, /<coop_project_context>/);
});
