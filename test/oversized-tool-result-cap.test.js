// Proves a single tool_result cannot blow up session history (and with it the
// daemon's heap). A grep whose matches included Clay's own session .jsonl files
// produced a 130MB tool_result, which was recorded verbatim. Because the daemon
// parses every session file into memory at startup, a handful of those entries
// pushed it past the 4GB V8 limit, so it OOM-crashed ~27s into every boot and
// the supervisor restarted it into the same crash, forever.
var test = require("node:test");
var assert = require("node:assert/strict");

var attachMessageProcessor = require("../lib/sdk-message-processor").attachMessageProcessor;

var CAP = 256 * 1024;

function makeSession() {
  return {
    localId: 17,
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    history: [],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    isProcessing: true,
    _queryStartTs: Date.now(),
    responsePreview: "",
    streamedText: false,
  };
}

function makeProcessor(recorded) {
  var sm = {
    modelsByVendor: { claude: ["claude-opus-4.8"] },
    availableModels: ["claude-opus-4.8"],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    sendToSession: function () {},
    sendAndRecord: function (session, obj) {
      session.history.push(obj);
      recorded.push(obj);
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

test("an oversized tool_result is truncated before it reaches session history", function () {
  var recorded = [];
  var processor = makeProcessor(recorded);
  var session = makeSession();

  // 2MB of output, the shape of a grep that matched a session transcript.
  var huge = "x".repeat(2 * 1024 * 1024);
  processor.processSDKMessage(session, {
    yokeType: "tool_result",
    toolId: "exec-huge",
    content: huge,
    isError: false,
  });

  var entry = recorded.find(function (item) { return item.type === "tool_result"; });
  assert.ok(entry, "the tool_result is still recorded");
  assert.equal(entry.id, "exec-huge");
  assert.ok(entry.content.length < huge.length, "content was truncated");
  assert.ok(entry.content.length <= CAP + 200, "content is bounded by the cap");
  assert.ok(entry.content.startsWith("x".repeat(1024)), "the prefix is preserved verbatim");
  assert.match(entry.content, /\[Clay truncated \d+ characters of tool output\]$/);
});

test("a normal-sized tool_result passes through untouched", function () {
  var recorded = [];
  var processor = makeProcessor(recorded);
  var session = makeSession();

  var normal = "ok: 42 files scanned";
  processor.processSDKMessage(session, {
    yokeType: "tool_result",
    toolId: "exec-small",
    content: normal,
    isError: false,
  });

  var entry = recorded.find(function (item) { return item.type === "tool_result"; });
  assert.ok(entry, "the tool_result is recorded");
  assert.equal(entry.content, normal, "short content is not rewritten");
});

test("an oversized tool_result arriving as a content block is truncated too", function () {
  var recorded = [];
  var processor = makeProcessor(recorded);
  var session = makeSession();

  var huge = "y".repeat(2 * 1024 * 1024);
  processor.processSDKMessage(session, {
    yokeType: "message",
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "block-huge", content: huge }],
  });

  var entry = recorded.find(function (item) { return item.type === "tool_result"; });
  if (entry) {
    assert.ok(entry.content.length <= CAP + 200,
      "the content-block path is capped as well as the streaming path");
  }
});
