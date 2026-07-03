var test = require("node:test");
var assert = require("node:assert");

var processorModule = require("../lib/sdk-message-processor");

function makeProcessor(spies) {
  var sm = {
    modelsByVendor: {},
    availableModels: [],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    sendToSession: function () {},
    sendAndRecord: function (session, obj) {
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
    opts: {
      getAutoContinueSetting: function () { return true; },
      scheduleMessage: function () { spies.scheduled++; },
      cancelScheduledMessage: function () { spies.cancelled++; },
      continueWithUsageCredits: function (session) {
        spies.continued++;
        session.rateLimitUseCreditsPending = false;
      },
    },
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
  });
}

function makeSession(isProcessing) {
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
    isProcessing: isProcessing,
  };
}

function overageRejectedMessage() {
  return {
    yokeType: "rate_limit",
    rateLimitInfo: {
      status: "rejected",
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      rateLimitType: "five_hour",
      utilization: 1,
      isUsingOverage: true,
    },
  };
}

function resetRejectedMessage() {
  return {
    yokeType: "rate_limit",
    rateLimitInfo: {
      status: "rejected",
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      rateLimitType: "five_hour",
      utilization: null,
      isUsingOverage: false,
    },
  };
}

function monthlySpendLimitToolResult() {
  return {
    yokeType: "tool_result",
    toolId: "toolu_spend_limit",
    content: "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit",
    isError: false,
  };
}

test("usage-credit rate limit rejection does not schedule while turn is processing", function () {
  var spies = { scheduled: 0, cancelled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, overageRejectedMessage());

  assert.strictEqual(spies.scheduled, 0);
  assert.strictEqual(spies.continued, 0);
  assert.strictEqual(session.rateLimitUseCreditsPending, true);
  assert.strictEqual(session.rateLimitResetsAt, null);
});

test("usage-credit rate limit rejection continues immediately after turn ends", function () {
  var spies = { scheduled: 0, cancelled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(false);

  processor.processSDKMessage(session, overageRejectedMessage());

  assert.strictEqual(spies.scheduled, 0);
  assert.strictEqual(spies.continued, 1);
  assert.strictEqual(session.rateLimitUseCreditsPending, false);
  assert.strictEqual(session.rateLimitResetsAt, null);
});

test("Claude monthly spend-limit tool result cancels scheduled auto-continue", function () {
  var spies = { scheduled: 0, cancelled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, resetRejectedMessage());
  processor.processSDKMessage(session, monthlySpendLimitToolResult());

  assert.strictEqual(spies.scheduled, 1);
  assert.strictEqual(spies.cancelled, 1);
  assert.strictEqual(spies.continued, 0);
  assert.strictEqual(session.rateLimitAutoContinuePending, false);
  assert.strictEqual(session.rateLimitUseCreditsPending, false);
  assert.strictEqual(session.rateLimitResetsAt, null);
  assert.ok(session.history.some(function (item) {
    return item.type === "info" && String(item.text || "").indexOf("usage credits are exhausted") !== -1;
  }));
  assert.strictEqual(session.history.some(function (item) {
    return item.type === "tool_result" && String(item.content || "").indexOf("monthly spend limit") !== -1;
  }), false);
});
