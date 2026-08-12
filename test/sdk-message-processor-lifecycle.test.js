var test = require("node:test");
var assert = require("node:assert/strict");

var attachMessageProcessor = require("../lib/sdk-message-processor").attachMessageProcessor;

function makeSession() {
  var startedAt = Date.now() - 100;
  return {
    localId: 17,
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    history: [{ type: "user_message", text: "Continue after restart", _ts: startedAt }],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    isProcessing: true,
    _queryStartTs: startedAt,
    _turnSawActivity: false,
    responsePreview: "",
    streamedText: false,
  };
}

function makeProcessor(onTerminalRecord) {
  var sm = {
    modelsByVendor: { claude: ["claude-opus-4.8"] },
    availableModels: ["claude-opus-4.8"],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    sendToSession: function () {},
    sendAndRecord: function (session, obj) {
      if (!obj._ts) obj._ts = Date.now();
      session.history.push(obj);
      if (obj.type === "done" && onTerminalRecord) onTerminalRecord(session, obj);
    },
  };
  return attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "test",
    isMate: false,
    mateDisplayName: "",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    getSDK: function () { return null; },
    adapter: { vendor: "claude" },
    cwd: process.cwd(),
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    onAutoTitle: function () {},
    opts: {},
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
  });
}

function emptyResult() {
  return {
    yokeType: "result",
    cost: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: null,
    sessionId: "thread-empty",
  };
}

test("terminal empty provider turns clear processing reasserted without a follow-on", function () {
  var session = makeSession();
  var processor = makeProcessor(function (target) {
    target.isProcessing = true;
  });

  processor.processSDKMessage(session, emptyResult());

  assert.strictEqual(session.history[session.history.length - 1].type, "done");
  assert.strictEqual(session.isProcessing, false);
});

test("terminal reconciliation preserves a follow-on dispatched by the done callback", function () {
  var session = makeSession();
  var processor = makeProcessor(function (target, done) {
    target._queryStartTs = done._ts + 1;
    target.history.push({
      type: "user_message",
      text: "Queued delivery now running",
      _ts: done._ts + 1,
    });
    target.isProcessing = true;
  });

  processor.processSDKMessage(session, emptyResult());

  assert.strictEqual(session.isProcessing, true);
  assert.strictEqual(session.history[session.history.length - 1].type, "user_message");
});
