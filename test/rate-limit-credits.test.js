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

test("usage-credit rate limit rejection does not schedule while turn is processing", function () {
  var spies = { scheduled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, overageRejectedMessage());

  assert.strictEqual(spies.scheduled, 0);
  assert.strictEqual(spies.continued, 0);
  assert.strictEqual(session.rateLimitUseCreditsPending, true);
  assert.strictEqual(session.rateLimitResetsAt, null);
});

test("usage-credit rate limit rejection continues immediately after turn ends", function () {
  var spies = { scheduled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(false);

  processor.processSDKMessage(session, overageRejectedMessage());

  assert.strictEqual(spies.scheduled, 0);
  assert.strictEqual(spies.continued, 1);
  assert.strictEqual(session.rateLimitUseCreditsPending, false);
  assert.strictEqual(session.rateLimitResetsAt, null);
});
