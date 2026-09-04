var test = require("node:test");
var assert = require("node:assert");

var informational = require("../lib/sdk-informational-events");
var processorModule = require("../lib/sdk-message-processor");

function makeProcessor(recorded, sent) {
  var sm = {
    modelsByVendor: {},
    availableModels: [],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    sendToSession: function (session, obj) {
      sent.push(obj);
    },
    sendAndRecord: function (session, obj) {
      recorded.push(obj);
      session.history.push(obj);
    },
  };
  return processorModule.attachMessageProcessor({
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

function makeSession() {
  return {
    localId: 1,
    vendor: "claude",
    history: [],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    isProcessing: false,
  };
}

test("model switch informational content matches escaped SDK text", function () {
  assert.strictEqual(
    informational.normalizeInformationalContent("Set model to opus[1m] (claude-opus-4-8[1m])"),
    "Set model to opus (claude-opus-4-8)"
  );
  assert.strictEqual(
    informational.isModelSwitchInformational("Set model to \u001b[1mopus\u001b[22m (claude-opus-4-8)"),
    true
  );
});

test("model switch informational messages are not recorded or rendered", function () {
  var recorded = [];
  var sent = [];
  var processor = makeProcessor(recorded, sent);
  var session = makeSession();

  processor.processSDKMessage(session, {
    yokeType: "informational",
    level: "info",
    content: "Set model to opus[1m] (claude-opus-4-8[1m])",
  });

  assert.deepStrictEqual(recorded, []);
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(session.history, []);
});

test("non-model informational messages are still recorded", function () {
  var recorded = [];
  var sent = [];
  var processor = makeProcessor(recorded, sent);
  var session = makeSession();

  processor.processSDKMessage(session, {
    yokeType: "informational",
    level: "warning",
    content: "Tool output was truncated.",
    toolUseId: "toolu_1",
    preventContinuation: true,
  });

  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].type, "informational");
  assert.strictEqual(recorded[0].content, "Tool output was truncated.");
  assert.strictEqual(recorded[0].preventContinuation, true);
  assert.strictEqual(session.history.length, 1);
});
