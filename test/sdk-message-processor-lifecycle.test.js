var test = require("node:test");
var assert = require("node:assert/strict");
require("./helpers/isolated-clay-home");

var attachMessageProcessor = require("../lib/sdk-message-processor").attachMessageProcessor;
var providerHealth = require("../lib/provider-health");
var coopModelPolicy = require("../lib/coop-model-policy");
var flattenCodexEvent = require("../lib/yoke/adapters/codex-events").flattenEvent;
require("../lib/recovery-log").recordRecoveryEvent = function () {};

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
    messageUUIDs: [],
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

function codexResult(outputTokens) {
  var codexState = {
    threadId: "codex-thread",
    model: "gpt-5.6-sol",
    contextWindowTokens: 258400,
    lastInputTokens: 1200,
    aborted: false,
  };
  return flattenCodexEvent({
    method: "turn/completed",
    params: {
      status: "completed",
      usage: {
        input_tokens: 1200,
        cached_input_tokens: 0,
        output_tokens: outputTokens,
      },
      turn: { status: "completed", items: [] },
    },
  }, codexState).filter(function (event) {
    return event.yokeType === "result";
  })[0];
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

test("turn telemetry separates model activity from visible text", function () {
  var session = makeSession();
  session._turnPerfId = "17:4";
  session._firstActivityLogged = false;
  session._firstTextLogged = false;
  var processor = makeProcessor();
  var lines = [];
  var originalLog = console.log;
  console.log = function () {
    lines.push(Array.prototype.join.call(arguments, " "));
  };
  try {
    processor.processSDKMessage(session, { yokeType: "turn_start" });
    processor.processSDKMessage(session, { yokeType: "thinking_start", blockId: "think-1" });
    processor.processSDKMessage(session, {
      yokeType: "thinking_delta", blockId: "think-1", text: "reasoning",
    });
    processor.processSDKMessage(session, { yokeType: "text_start", blockId: "text-1" });
    processor.processSDKMessage(session, {
      yokeType: "text_delta", blockId: "text-1", text: "answer",
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.filter(function (line) {
    return line.indexOf("turn=17:4 first_model_activity") !== -1 &&
      line.indexOf("type=thinking_delta") !== -1;
  }).length, 1);
  assert.equal(lines.filter(function (line) {
    return line.indexOf("turn=17:4 first_visible_text") !== -1;
  }).length, 1);
});

test("a token-backed Codex turn recovers Astra so canonical Coop can run", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "fable",
    immediate: true,
    unavailableUntil: Date.now() + 3600000,
  });
  providerHealth.recordFailure("codex", "provider-error:session-local-overflow", {
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
    strong: true,
  });
  assert.equal(coopModelPolicy.selectRoute("execution").ok, false,
    "with Fable unavailable and Astra degraded, Coop must fail closed");

  var session = makeSession();
  session.vendor = "codex";
  session.providerRouteId = "codex-openai";
  session.model = "gpt-6-astra";
  var processor = makeProcessor();
  processor.processSDKMessage(session, { yokeType: "text_start", blockId: "answer" });
  processor.processSDKMessage(session, {
    yokeType: "text_delta",
    blockId: "answer",
    text: "Astra completed real work.",
  });

  var result = codexResult(40);
  assert.equal(result.cost, null, "the real Codex adapter has no dollar-cost signal");

  processor.processSDKMessage(session, result);

  assert.equal(session._lastTurnCompletedProductively, true);
  assert.equal(providerHealth.getRouteHealth(
    "codex", "codex-openai", "gpt-6-astra").state, "healthy");
  var recoveredRoute = coopModelPolicy.selectRoute("execution");
  assert.equal(recoveredRoute.ok, true);
  assert.equal(recoveredRoute.providerRouteId, "codex-openai");
  assert.equal(recoveredRoute.model, "gpt-6-astra");
  providerHealth._reset();
});

test("an empty token-accounted Codex turn does not recover Astra", function () {
  providerHealth._reset();
  providerHealth.recordFailure("codex", "provider-error:session-local-overflow", {
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
    strong: true,
  });
  var session = makeSession();
  session.vendor = "codex";
  session.providerRouteId = "codex-openai";
  session.model = "gpt-6-astra";

  makeProcessor().processSDKMessage(session, codexResult(0));

  assert.equal(session._turnSawActivity, false);
  assert.equal(session._lastTurnCompletedProductively, false);
  assert.equal(providerHealth.getRouteHealth(
    "codex", "codex-openai", "gpt-6-astra").state, "degraded");
  providerHealth._reset();
});
