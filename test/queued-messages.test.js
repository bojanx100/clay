var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var attachSessionQueuedMessages = require("../lib/sessions-queued-messages").attachSessionQueuedMessages;
var hasStaleProcessingState = require("../lib/sessions-queued-messages").hasStaleProcessingState;
var attachUserMessage = require("../lib/project-user-message").attachUserMessage;
var attachProjectUserMessageQueue = require("../lib/project-user-message-queue").attachProjectUserMessageQueue;
var shouldQueueMessage = require("../lib/project-user-message").shouldQueueMessage;
var attachTaskOrchestrator = require("../lib/project-task-orchestrator").attachTaskOrchestrator;
var config = require("../lib/config");

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

function crossProjectEnvelope(eventId) {
  return {
    eventId: eventId,
    destination: { projectId: "system-target", sessionStorageId: "target-session" },
    payload: { type: "coordinator_update", text: "[durable update] " + eventId },
  };
}

function typedDeliveryOrchestrator(session, starts) {
  var sessions = new Map([[session.localId, session]]);
  var sm = {
    sessions: sessions,
    appendToSessionFile: function () {},
    saveSessionFile: function () { return true; },
    broadcastSessionList: function () {},
    subscribeSession: function () { return function () {}; },
  };
  return attachTaskOrchestrator({
    sm: sm,
    sdk: {
      startQuery: function (target, text) { starts.push({ target: target, text: text }); return { ok: true, submission: "submitted" }; },
      pushMessage: function (target, text) { starts.push({ target: target, text: text }); return { ok: true, submission: "submitted" }; },
    },
    sendToSession: function () {},
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () {},
  });
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

test("queue restart restores a persisted image with its local path", function (t) {
  var configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-queued-image-replay-"));
  var previousConfigDir = config.CONFIG_DIR;
  var encodedCwd = "queued-image-replay";
  var imagePath = path.join(configDir, "images", encodedCwd, "owner.png");
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from("replayed-image"));
  config.CONFIG_DIR = configDir;
  t.after(function() {
    config.CONFIG_DIR = previousConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  });
  var api = attachSessionQueuedMessages({ encodedCwd: encodedCwd });
  var session = {
    history: [{
      type: "user_message",
      queueId: "q-image",
      text: "Inspect the attachment",
      queuedPending: true,
      imageCount: 1,
      imageRefs: [{ mediaType: "image/png", file: "owner.png" }],
    }],
  };

  api.queuedUserMessagesForClient(session);

  assert.deepEqual(session.pendingUserMessageQueue[0].images, [{
    mediaType: "image/png",
    data: Buffer.from("replayed-image").toString("base64"),
    savedPath: imagePath,
  }]);
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

test("replayed typed delivery uses the durable pending/history event id and never reinjects it", function () {
  var starts = [];
  var original = {
    localId: 7,
    storageId: "target-session",
    history: [],
    pendingCoordinatorUpdates: [],
    isProcessing: true,
  };
  var event = crossProjectEnvelope("restart-safe-event");
  var first = typedDeliveryOrchestrator(original, starts);
  assert.equal(first.deliverCrossProjectEnvelope(event).ok, true);
  assert.equal(original.pendingCoordinatorUpdates.length, 1);
  assert.match(original.pendingCoordinatorUpdates[0].text, /restart-safe-event/);

  // Simulate daemon restart after application was persisted but before the
  // coordinator was available to run it. Replaying flushes that one queued
  // update; it does not start a worker or add a second transcript item.
  var restored = {
    localId: 9,
    storageId: "target-session",
    history: original.history.slice(),
    pendingCoordinatorUpdates: original.pendingCoordinatorUpdates.slice(),
    isProcessing: false,
  };
  var afterRestart = typedDeliveryOrchestrator(restored, starts);
  assert.equal(afterRestart.deliverCrossProjectEnvelope(event).duplicate, true);
  assert.equal(starts.length, 1);
  assert.equal(restored.pendingCoordinatorUpdates.length, 0);
  assert.match(restored.history[0].text, /restart-safe-event/);

  restored.isProcessing = false;
  assert.equal(afterRestart.deliverCrossProjectEnvelope(event).duplicate, true);
  assert.equal(starts.length, 1);
  assert.equal(restored.history.length, 1);
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

test("a restored idle queue starts once after user-message wiring and preserves FIFO", async function () {
  var session = {
    localId: 73,
    title: "Restored queue",
    vendor: "codex",
    isProcessing: false,
    queryInstance: {},
    history: [
      queuedHistoryItem("q-first", "First after restart"),
      queuedHistoryItem("q-second", "Second after restart"),
    ],
    pendingUserMessageQueue: [
      { queueId: "q-first", text: "First after restart", displayText: "First after restart" },
      { queueId: "q-second", text: "Second after restart", displayText: "Second after restart" },
    ],
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
      startQuery: function (targetSession, text) { dispatched.push(text); },
      pushMessage: function (targetSession, text) { dispatched.push(text); },
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

  await new Promise(function (resolve) { setTimeout(resolve, 160); });

  assert.deepEqual(dispatched, ["First after restart"]);
  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), ["q-second"]);
  assert.equal(session.isProcessing, true);

  session.isProcessing = false;
  handler.scheduleQueuedUserMessageFlush(session);
  handler.scheduleQueuedUserMessageFlush(session);
  await new Promise(function (resolve) { setTimeout(resolve, 160); });

  assert.deepEqual(dispatched, ["First after restart", "Second after restart"]);
  assert.deepEqual(session.pendingUserMessageQueue, []);
});

test("queued drain waits for a scheduled recovery before dispatching", async function () {
  var session = {
    localId: 74,
    isProcessing: false,
    scheduledMessage: { text: "continue", autoAction: true },
    history: [queuedHistoryItem("q-recovery", "Wait for recovery")],
    pendingUserMessageQueue: [{
      queueId: "q-recovery",
      text: "Wait for recovery",
      displayText: "Wait for recovery",
    }],
  };
  var dispatched = [];
  var queue = attachProjectUserMessageQueue({
    sm: {
      queuedUserMessagesForClient: function () { return []; },
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
    },
    sdk: {
      startQuery: function (targetSession, text) { dispatched.push(text); },
      pushMessage: function (targetSession, text) { dispatched.push(text); },
    },
    sendToSession: function () {},
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () {},
  });

  queue.scheduleQueuedUserMessageFlush(session);
  await new Promise(function (resolve) { setTimeout(resolve, 140); });
  assert.deepEqual(dispatched, []);
  assert.deepEqual(session.pendingUserMessageQueue.map(function (item) {
    return item.queueId;
  }), ["q-recovery"]);

  delete session.scheduledMessage;
  await new Promise(function (resolve) { setTimeout(resolve, 160); });
  assert.deepEqual(dispatched, ["Wait for recovery"]);
});

test("queued drain waits for failover and active tools before dispatching", async function () {
  var session = {
    localId: 75,
    isProcessing: false,
    providerFailoverPending: { vendor: "codex" },
    activeTaskToolIds: {},
    history: [queuedHistoryItem("q-failover", "Wait for failover")],
    pendingUserMessageQueue: [{
      queueId: "q-failover",
      text: "Wait for failover",
      displayText: "Wait for failover",
    }],
  };
  var dispatched = [];
  var queue = attachProjectUserMessageQueue({
    sm: {
      queuedUserMessagesForClient: function () { return []; },
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
    },
    sdk: {
      startQuery: function (targetSession, text) { dispatched.push(text); },
      pushMessage: function (targetSession, text) { dispatched.push(text); },
    },
    sendToSession: function () {},
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () {},
  });

  queue.scheduleQueuedUserMessageFlush(session);
  await new Promise(function (resolve) { setTimeout(resolve, 140); });
  assert.deepEqual(dispatched, []);

  session.providerFailoverPending = null;
  session.activeTaskToolIds.tool = true;
  await new Promise(function (resolve) { setTimeout(resolve, 140); });
  assert.deepEqual(dispatched, []);

  session.activeTaskToolIds = {};
  await new Promise(function (resolve) { setTimeout(resolve, 160); });
  assert.deepEqual(dispatched, ["Wait for failover"]);
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
  session.taskStopRequested = false;
  session.steerInterruptRequested = false;
  session.abortController = null;
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
