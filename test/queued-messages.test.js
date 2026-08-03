var test = require("node:test");
var assert = require("node:assert/strict");
var attachSessionQueuedMessages = require("../lib/sessions-queued-messages").attachSessionQueuedMessages;
var hasStaleProcessingState = require("../lib/sessions-queued-messages").hasStaleProcessingState;
var attachUserMessage = require("../lib/project-user-message").attachUserMessage;
var shouldQueueMessage = require("../lib/project-user-message").shouldQueueMessage;

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

test("an idle session with a pending backlog keeps new messages queued", function () {
  assert.equal(shouldQueueMessage({
    isProcessing: false,
    pendingUserMessageQueue: [{ queueId: "q-first" }],
  }), true);
  assert.equal(shouldQueueMessage({
    isProcessing: false,
    pendingUserMessageQueue: [],
  }), false);
});

test("processing-state reconciliation preserves a genuinely active follow-on turn", function () {
  assert.equal(hasStaleProcessingState({
    isProcessing: true,
    _queryStartTs: 201,
    history: [{ type: "done", code: 0, _ts: 200 }],
  }), false);
  assert.equal(hasStaleProcessingState({
    isProcessing: true,
    _queryStartTs: 100,
    history: [
      { type: "done", code: 0, _ts: 200 },
      { type: "user_message", text: "Next turn", _ts: 201 },
    ],
  }), false);
});

test("a completed turn does not trap a follow-up behind a stale processing flag", async function () {
  var session = {
    localId: 42,
    title: "Existing session",
    vendor: "codex",
    isProcessing: true,
    _queryStartTs: 100,
    _lastStreamEventAt: 200,
    history: [
      { type: "user_message", text: "Earlier request", _ts: 100 },
      { type: "done", code: 0, _ts: 200 },
    ],
    pendingUserMessageQueue: [],
  };
  var dispatched = [];
  var sm = {
    sessions: new Map([[session.localId, session]]),
    queuedUserMessagesForClient: function () { return []; },
    appendToSessionFile: function () {},
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
    type: "message",
    text: "Follow up",
    intent: "chat",
    sessionId: session.localId,
  });

  await new Promise(function (resolve) { setImmediate(resolve); });

  assert.deepEqual(dispatched, ["Follow up"]);
  assert.deepEqual(session.pendingUserMessageQueue, []);
  assert.equal(session.isProcessing, true);
  assert.equal(session._queryStartTs > 200, true);
  assert.equal(session.history[session.history.length - 1].queuedPending, undefined);
});

test("steering one queued message resumes the remaining queue automatically", async function () {
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

  assert.deepEqual(dispatched, ["Selected", "First"]);
  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), ["q-last"]);

  session.isProcessing = false;
  handler.scheduleQueuedUserMessageFlush(session);
  await new Promise(function (resolve) { setTimeout(resolve, 150); });

  assert.deepEqual(dispatched, ["Selected", "First", "Last"]);
  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), []);
});

test("coordinating a queued follow-up starts background work without steering the parent", async function () {
  var queueApi = attachSessionQueuedMessages({ encodedCwd: "test" });
  var session = {
    localId: 42,
    isProcessing: true,
    history: [queuedHistoryItem("q-context", "this is what you asked")],
    pendingUserMessageQueue: [{
      queueId: "q-context",
      text: "this is what you asked",
      displayText: "this is what you asked",
    }],
  };
  var coordinated = [];
  var aborted = false;
  session.abortController = {
    abort: function () { aborted = true; },
  };
  var sm = {
    sessions: new Map([[session.localId, session]]),
    queuedUserMessagesForClient: queueApi.queuedUserMessagesForClient,
    saveSessionFile: function () {},
    appendToSessionFile: function () {},
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
        dispatched.push({ session: targetSession, text: text });
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
    coordinateQueuedMessage: function (targetSession, item) {
      targetSession.coordinationMode = true;
      coordinated.push({ session: targetSession, item: item });
      targetSession.orchestrationTasks = [{ taskId: "task-background", status: "running" }];
      return targetSession.orchestrationTasks[0];
    },
    _loop: { handleLoopMessage: function () { return false; } },
    browserState: {},
    scheduleMessage: function () {},
    cancelScheduledMessage: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    adapter: {},
  });

  handler.handleUserMessage({ _clayActiveSession: session.localId }, {
    type: "coordinate_queued_message",
    queueId: "q-context",
    sessionId: session.localId,
  });

  assert.equal(session.coordinationMode, true);
  assert.equal(coordinated.length, 1);
  assert.equal(coordinated[0].session, session);
  assert.equal(coordinated[0].item.text, "this is what you asked");
  assert.equal(aborted, false);
  assert.equal(session.isProcessing, true);
  assert.equal(session.steerInterruptRequested, undefined);
  assert.equal(session.taskStopRequested, undefined);
  assert.equal(session.history[0].coordinationRequest, true);
  assert.equal(session.orchestrationTasks[0].taskId, "task-background");

  handler.handleUserMessage({ _clayActiveSession: session.localId }, {
    type: "message",
    text: "Launch this as an explicit task",
    intent: "task",
    sessionId: session.localId,
  });
  await new Promise(function (resolve) {
    setImmediate(resolve);
  });

  assert.equal(session.pendingUserMessageQueue.length, 0);
  assert.equal(coordinated.length, 2);
  assert.equal(coordinated[1].session, session);
  assert.equal(coordinated[1].item.text, "Launch this as an explicit task");
  assert.equal(aborted, false);
});
