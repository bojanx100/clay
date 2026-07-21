var test = require("node:test");
var assert = require("node:assert/strict");
var attachSessionQueuedMessages = require("../lib/sessions-queued-messages").attachSessionQueuedMessages;
var attachUserMessage = require("../lib/project-user-message").attachUserMessage;

function queuedHistoryItem(queueId, text, options) {
  options = options || {};
  return {
    type: "user_message",
    queueId: queueId,
    text: text,
    queuedPending: !options.steerPending,
    steerPending: !!options.steerPending,
  };
}

test("queue state serialization preserves a selected steer at the front", function () {
  var api = attachSessionQueuedMessages({ encodedCwd: "test" });
  var session = {
    history: [
      queuedHistoryItem("q-first", "First"),
      queuedHistoryItem("q-selected", "Selected", { steerPending: true }),
      queuedHistoryItem("q-last", "Last"),
    ],
    pendingUserMessageQueue: [
      { queueId: "q-selected", displayText: "Selected", hidden: true },
      { queueId: "q-first", displayText: "First" },
      { queueId: "q-last", displayText: "Last" },
    ],
  };

  var clientQueue = api.queuedUserMessagesForClient(session);

  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), ["q-selected", "q-first", "q-last"]);
  assert.deepEqual(clientQueue.map(function (item) {
    return item.queueId;
  }), ["q-first", "q-last"]);
});

test("queue state serialization restores pending messages after a restart", function () {
  var api = attachSessionQueuedMessages({ encodedCwd: "test" });
  var session = {
    history: [
      queuedHistoryItem("q-first", "First"),
      queuedHistoryItem("q-selected", "Selected", { steerPending: true }),
    ],
  };

  var clientQueue = api.queuedUserMessagesForClient(session);

  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), ["q-first", "q-selected"]);
  assert.deepEqual(clientQueue.map(function (item) {
    return item.queueId;
  }), ["q-first"]);
});

test("steering one queued message leaves the remaining messages queued", async function () {
  var queueApi = attachSessionQueuedMessages({ encodedCwd: "test" });
  var session = {
    localId: 42,
    isProcessing: true,
    history: [
      queuedHistoryItem("q-first", "First"),
      queuedHistoryItem("q-selected", "Selected"),
      queuedHistoryItem("q-last", "Last"),
    ],
    pendingUserMessageQueue: [
      { queueId: "q-first", text: "First", displayText: "First" },
      { queueId: "q-selected", text: "Selected", displayText: "Selected" },
      { queueId: "q-last", text: "Last", displayText: "Last" },
    ],
    abortController: { abort: function () {} },
  };
  var dispatched = [];
  var sm = {
    sessions: new Map([[session.localId, session]]),
    queuedUserMessagesForClient: queueApi.queuedUserMessagesForClient,
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  var handler = attachUserMessage({
    cwd: process.cwd(),
    slug: "test",
    isMate: false,
    osUsers: false,
    sm: sm,
    sdk: {
      startQuery: function (targetSession, text) {
        dispatched.push(text);
      },
      pushMessage: function (targetSession, text) {
        dispatched.push(text);
      },
    },
    nm: {},
    tm: {},
    send: function () {},
    sendTo: function () {},
    sendToSession: function () {},
    sendToSessionOthers: function () {},
    clients: new Set(),
    opts: {},
    usersModule: { isMultiUser: function () { return false; } },
    matesModule: {},
    getSessionForWs: function () { return session; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () {},
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (item) { return item; },
    saveImageFile: function () { return null; },
    imagesDir: process.cwd(),
    onProcessingChanged: function () {},
    onUserMessageDispatched: function () { return ""; },
    _loop: { handleLoopMessage: function () { return false; } },
    browserState: {},
    scheduleMessage: function () {},
    cancelScheduledMessage: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    adapter: {},
  });

  handler.handleUserMessage({ _clayActiveSession: session.localId }, {
    type: "steer_queued_message",
    queueId: "q-selected",
    sessionId: session.localId,
  });
  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), ["q-selected", "q-first", "q-last"]);

  session.isProcessing = false;
  handler.flushQueuedUserMessage(session);
  assert.deepEqual(dispatched, ["Selected"]);

  session.isProcessing = false;
  handler.scheduleQueuedUserMessageFlush(session);
  await new Promise(function (resolve) { setTimeout(resolve, 150); });

  assert.deepEqual(dispatched, ["Selected"]);
  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), ["q-first", "q-last"]);

  handler.handleUserMessage({ _clayActiveSession: session.localId }, {
    type: "steer_queued_message",
    queueId: "q-last",
    sessionId: session.localId,
  });
  assert.deepEqual(dispatched, ["Selected", "Last"]);
  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), ["q-first"]);

  session.isProcessing = false;
  handler.scheduleQueuedUserMessageFlush(session);
  await new Promise(function (resolve) { setTimeout(resolve, 150); });

  assert.deepEqual(dispatched, ["Selected", "Last"]);
  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), ["q-first"]);
});
