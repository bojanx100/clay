var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var attachUserMessage = require("../lib/project-user-message").attachUserMessage;

function makeHarness(processing, handleSwitchCommand) {
  var session = {
    localId: 42,
    isProcessing: processing,
    history: [],
    title: "Existing session",
    vendor: "codex",
  };
  var sentToSession = [];
  var sentToOthers = [];
  var sm = {
    sessions: new Map([[session.localId, session]]),
    appendToSessionFile: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    queuedUserMessagesForClient: function () { return []; },
  };
  var handler = attachUserMessage({
    cwd: process.cwd(),
    slug: "test",
    isMate: false,
    osUsers: false,
    sm: sm,
    sdk: {
      startQuery: function () {},
      pushMessage: function () {},
    },
    nm: {},
    tm: {
      getScrollback: function () { return null; },
      list: function () { return []; },
    },
    send: function () {},
    sendTo: function () {},
    sendToSession: function (sessionId, msg) {
      sentToSession.push({ sessionId: sessionId, msg: msg });
    },
    sendToSessionOthers: function (ws, sessionId, msg) {
      sentToOthers.push({ ws: ws, sessionId: sessionId, msg: msg });
    },
    clients: new Set(),
    opts: {},
    usersModule: {
      isMultiUser: function () { return false; },
    },
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
    handleSwitchCommand: handleSwitchCommand,
    _loop: {
      handleLoopMessage: function () { return false; },
    },
    browserState: {
      _browserTabList: {},
      pendingExtensionRequests: {},
    },
    scheduleMessage: function () {},
    cancelScheduledMessage: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    adapter: {
      renameSession: function () { return Promise.resolve(); },
    },
  });

  return {
    session: session,
    sentToSession: sentToSession,
    sentToOthers: sentToOthers,
    handle: function (msg) {
      return handler.handleUserMessage({
        _clayActiveSession: session.localId,
        readyState: 1,
      }, msg);
    },
  };
}

function waitForDispatch() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

test("idle messages receive an authoritative echo in the sending tab", async function () {
  var harness = makeHarness(false);
  harness.handle({
    type: "message",
    text: "hello",
    clientMessageId: "cm-test-idle",
  });
  await waitForDispatch();

  var echoes = harness.sentToSession.filter(function (entry) {
    return entry.msg.type === "user_message";
  });
  assert.equal(echoes.length, 1);
  assert.equal(echoes[0].msg.clientMessageId, "cm-test-idle");
  assert.equal(harness.sentToOthers.filter(function (entry) {
    return entry.msg.type === "user_message";
  }).length, 0);
});

test("queue notifications reconcile a stale optimistic sender bubble", function () {
  var sourcePath = path.join(__dirname, "..", "lib", "public", "modules", "app-messages-sessions.js");
  var source = fs.readFileSync(sourcePath, "utf8");

  assert.match(source, /import \{ removeOptimisticUserMessage \} from '\.\/app-rendering\.js';/);
  assert.match(source, /function handleQueuedUserMessageMessage\(msg\)[\s\S]*?removeOptimisticUserMessage\(msg\.clientMessageId\);[\s\S]*?handleQueuedUserMessage\(msg\);/);
  assert.match(source, /function handleQueuedUserMessagesState\(msg\)[\s\S]*?setQueueingDisabled\(msg\.queueingDisabled\);[\s\S]*?removeQueuedOptimisticMessages\(queued\);[\s\S]*?setQueuedUserMessages\(queued\);/);
});

test("provider commands are consumed before they reach the model", function () {
  var commands = [];
  var harness = makeHarness(false, function (ws, session, text) {
    commands.push({ session: session, text: text });
    return true;
  });

  harness.handle({ type: "message", text: "/provider copilot" });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].session, harness.session);
  assert.equal(commands[0].text, "/provider copilot");
  assert.equal(harness.session.history.length, 0);
  assert.equal(harness.sentToSession.length, 0);
});
