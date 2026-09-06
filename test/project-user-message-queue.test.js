var test = require("node:test");
var assert = require("node:assert/strict");
var queueModule = require("../lib/project-user-message-queue");

function harness(options) {
  options = options || {};
  var events = [];
  var stateMessages = [];
  var session = { localId: 7, history: [], pendingUserMessageQueue: [], isProcessing: false };
  var sm = {
    queuedUserMessagesForClient: function (target) {
      return (target.pendingUserMessageQueue || []).filter(function (item) { return !item.hidden; });
    },
    saveSessionFile: function () { events.push("save"); },
    broadcastSessionList: function () { events.push("broadcast"); },
    sendAndRecord: function (target, message) {
      events.push(message.type);
      target.history.push(message);
    },
  };
  var api = queueModule.attachProjectUserMessageQueue({
    sm: sm,
    sdk: {
      startQuery: function (target, text) {
        events.push("start:" + text);
        if (options.startError) return Promise.reject(options.startError);
      },
      pushMessage: function () {
        events.push("push");
        return options.pushResult === undefined ? true : options.pushResult;
      },
    },
    sendToSession: function (id, message) {
      events.push(message.type);
      if (message.type === "queued_user_messages_state") stateMessages.push(message);
    },
    onProcessingChanged: function () { events.push("processing"); },
    onUserMessageDispatched: function () { events.push("intent"); return ""; },
    ensureProjectAccessForSession: function () { return null; },
  });
  return { api: api, session: session, events: events, states: stateMessages };
}

test("queue append/front/silent/hidden preserves client visibility and ordering", function () {
  var h = harness();
  h.api.queuePreparedMessage(h.session, "tail", null, "q-tail", "Tail", 0, "cm-tail", null);
  h.api.queuePreparedMessage(h.session, "front", null, "q-front", "Front", 0, "cm-front", null,
    { front: true, silent: true, hidden: true });
  assert.deepEqual(h.session.pendingUserMessageQueue.map(function (item) { return item.queueId; }), ["q-front", "q-tail"]);
  assert.equal(h.session.pendingUserMessageQueue[0].hidden, true);
  assert.equal(h.events.filter(function (event) { return event === "queued_user_message"; }).length, 1);
  assert.deepEqual(h.states.at(-1).queuedUserMessages.map(function (item) { return item.queueId; }), ["q-tail"]);
});

test("task, queue, steer, and direct SDK dispatch keep their distinct order", function () {
  var h = harness();
  h.api.dispatchPreparedToSdk(h.session, {
    finalText: "direct", images: null, steer: false, queueId: null, displayText: "direct",
    imageCount: 0, clientMessageId: null, pastes: null, fromQueue: false, intent: "chat",
  });
  assert.ok(h.events.indexOf("start:direct") > h.events.indexOf("status"));

  var coordinated = [];
  var task = harness();
  task.api = queueModule.attachProjectUserMessageQueue({
    sm: { saveSessionFile: function () { coordinated.push("save"); }, broadcastSessionList: function () {} },
    sdk: { startQuery: function () { coordinated.push("sdk"); }, pushMessage: function () {} },
    sendToSession: function () {}, onProcessingChanged: function () {},
    coordinateQueuedMessage: function () { coordinated.push("coordinate"); },
    ensureProjectAccessForSession: function () {},
  });
  task.api.dispatchPreparedToSdk(task.session, {
    finalText: "task", displayText: "task", images: null, pastes: null,
    steer: false, fromQueue: false, intent: "task",
  });
  assert.deepEqual(coordinated, ["coordinate", "save"]);

  var queued = harness();
  queued.session.isProcessing = true;
  queued.api.dispatchPreparedToSdk(queued.session, {
    finalText: "queued", displayText: "queued", images: null, pastes: null,
    steer: false, fromQueue: false, intent: "queue",
  });
  assert.equal(queued.session.pendingUserMessageQueue.length, 1);
  assert.equal(queued.events.includes("start"), false);

  var steered = harness();
  steered.session.isProcessing = true;
  var aborted = 0;
  steered.session.abortController = { abort: function () { aborted++; } };
  steered.api.dispatchPreparedToSdk(steered.session, {
    finalText: "steer", displayText: "steer", images: null, pastes: null,
    steer: true, fromQueue: false, intent: "steer",
  });
  assert.equal(steered.session.pendingUserMessageQueue[0].text, "steer");
  assert.equal(steered.session.steerInterruptRequested, true);
  assert.equal(aborted, 1);
});

test("a stale processing state starts a fresh query when no push consumer exists", function () {
  var h = harness({ pushResult: false });
  h.session.isProcessing = true;

  h.api.dispatchPreparedToSdk(h.session, {
    finalText: "recover me", images: null, steer: false, queueId: "q-recover",
    displayText: "recover me", imageCount: 0, clientMessageId: null, pastes: null,
    fromQueue: true, intent: "chat",
  });

  assert.deepStrictEqual(h.events.filter(function (event) {
    return event === "push" || event.indexOf("start:") === 0;
  }), ["push", "start:recover me"]);
});

test("a rejected provider start clears processing and emits a retryable terminal error", async function () {
  var h = harness({ startError: new Error("provider unavailable") });
  h.api.dispatchPreparedToSdk(h.session, {
    finalText: "retry me", images: null, steer: false, queueId: null,
    displayText: "retry me", imageCount: 0, clientMessageId: "cm-retry",
    pastes: null, fromQueue: false, intent: "chat",
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(h.session.isProcessing, false);
  assert.deepEqual(h.session.history.map(function (item) { return item.type; }), ["user_turn_started", "error", "done"]);
  assert.equal(h.session.history[0].clientMessageId, "cm-retry");
  assert.match(h.session.history[1].text, /provider unavailable/);
});
