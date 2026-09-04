var test = require("node:test");
var assert = require("node:assert");
require("./helpers/isolated-clay-home");

var processorModule = require("../lib/sdk-message-processor");
var finalizeStream = require("../lib/sdk-bridge-stream-finalize").finalizeStream;
var providerHealth = require("../lib/provider-health");
require("../lib/recovery-log").recordRecoveryEvent = function () {};

function makeProcessor(spies, autoContinue, adapter) {
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
    adapter: adapter || { vendor: "claude" },
    cwd: process.cwd(),
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    onAutoTitle: function () {},
    opts: {
      getAutoContinueSetting: function () { return autoContinue !== false; },
      scheduleMessage: function () { spies.scheduled++; },
      cancelScheduledMessage: function () { spies.cancelled++; },
      continueWithUsageCredits: function (session) {
        spies.continued++;
        session.rateLimitUseCreditsPending = false;
      },
      queueProviderFailover: function (session, failure) {
        spies.failoverQueued = failure;
        return true;
      },
    },
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
    saveImageFile: spies.saveImageFile || null,
    getLinuxUserForSession: function () { return "clay-test"; },
  });
}

function makeSession(isProcessing, vendor) {
  return {
    localId: 1,
    vendor: vendor || "claude",
    history: [],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    isProcessing: isProcessing,
    responsePreview: "",
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

function allowedMessage() {
  return {
    yokeType: "rate_limit",
    rateLimitInfo: {
      status: "allowed",
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      rateLimitType: "five_hour",
      utilization: 0.2,
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

test("Claude tool-result images are persisted instead of recorded inline", function () {
  var saved = [];
  var spies = {
    scheduled: 0,
    cancelled: 0,
    continued: 0,
    saveImageFile: function (mediaType, data, linuxUser) {
      saved.push({ mediaType: mediaType, data: data, linuxUser: linuxUser });
      return "preview.png";
    },
  };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, {
    yokeType: "message",
    messageRole: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "tool-image",
      content: [{
        type: "image",
        source: {
          media_type: "image/png",
          data: "aGVsbG8=",
        },
      }],
    }],
  });
  var entry = session.history[0];

  assert.deepStrictEqual(saved, [{
    mediaType: "image/png",
    data: "aGVsbG8=",
    linuxUser: "clay-test",
  }]);
  assert.deepStrictEqual(entry.images, [{
    mediaType: "image/png",
    url: "/p/test/images/preview.png",
  }]);
  assert.deepStrictEqual(entry.imageRefs, [{
    mediaType: "image/png",
    file: "preview.png",
  }]);
  assert.strictEqual(JSON.stringify(entry).indexOf("aGVsbG8="), -1);
});

test("Claude tool-result images remain visible when persistence fails", function () {
  var spies = {
    scheduled: 0,
    cancelled: 0,
    continued: 0,
    saveImageFile: function () { return null; },
  };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, {
    yokeType: "tool_result",
    toolId: "tool-image",
    content: "Preview",
    images: [{
      mediaType: "image/png",
      data: "aGVsbG8=",
    }],
  });

  assert.deepStrictEqual(session.history[0].images, [{
    mediaType: "image/png",
    data: "aGVsbG8=",
  }]);
  assert.strictEqual(session.history[0].imageRefs, undefined);
});

test("routine allowed rate-limit events do not flood the daemon log", function () {
  var spies = { scheduled: 0, cancelled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(true);
  var logs = [];
  var originalLog = console.log;
  console.log = function () { logs.push(Array.prototype.join.call(arguments, " ")); };
  try {
    processor.processSDKMessage(session, allowedMessage());
  } finally {
    console.log = originalLog;
  }

  assert.strictEqual(logs.some(function (line) {
    return line.indexOf("rate_limit_event") !== -1;
  }), false);
});

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

test("productive usage-credit turn does not queue another continuation", function () {
  var spies = { scheduled: 0, cancelled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(true);
  var activeQuery = { close: function () {} };
  var abortController = { abort: function () {} };
  session.queryInstance = activeQuery;
  session.abortController = abortController;
  session._turnDoneSent = true;
  session._consecutiveAutoResumes = 3;

  processor.processSDKMessage(session, { yokeType: "turn_start" });
  processor.processSDKMessage(session, { yokeType: "text_start", blockId: "holding" });
  processor.processSDKMessage(session, {
    yokeType: "text_delta",
    blockId: "holding",
    text: "Holding.",
  });
  processor.processSDKMessage(session, overageRejectedMessage());
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0.01,
    usage: null,
    modelUsage: null,
    sessionId: "claude-session-1",
  });
  finalizeStream({
    session: session,
    query: activeQuery,
    abortController: abortController,
    clearInteractiveToolWaits: function () {},
    sm: {
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
    },
    sendAndRecord: function () {},
    opts: {
      getAutoContinueSetting: function () { return true; },
      continueWithUsageCredits: function () { spies.continued++; },
      reconcileQueuedUserMessages: function () {},
    },
    rateLimitResumeLabel: "auto-continue",
  });

  assert.strictEqual(spies.continued, 0);
  assert.strictEqual(session.rateLimitAutoContinuePending, false);
  assert.strictEqual(session.rateLimitUseCreditsPending, false);
  assert.strictEqual(session.rateLimitResetsAt, null);
  assert.strictEqual(session._lastTurnCompletedProductively, true);
  assert.strictEqual(session._consecutiveAutoResumes, 0);
});

test("late usage-credit rejection does not wake an already completed productive turn", function () {
  var spies = { scheduled: 0, cancelled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, { yokeType: "turn_start" });
  processor.processSDKMessage(session, { yokeType: "text_start", blockId: "answer" });
  processor.processSDKMessage(session, {
    yokeType: "text_delta",
    blockId: "answer",
    text: "Finished.",
  });
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0.01,
    usage: null,
    modelUsage: null,
    sessionId: "claude-session-1",
  });
  processor.processSDKMessage(session, overageRejectedMessage());

  assert.strictEqual(session.isProcessing, false);
  assert.strictEqual(session._lastTurnCompletedProductively, true);
  assert.strictEqual(spies.continued, 0);
  assert.strictEqual(session.rateLimitAutoContinuePending, false);
  assert.strictEqual(session.rateLimitUseCreditsPending, false);
  assert.strictEqual(session.rateLimitResetsAt, null);
});

test("plain rate-limit rejection marks the vendor unhealthy immediately instead of scheduling a same-provider wait", function () {
  providerHealth._reset();
  var spies = { scheduled: 0, cancelled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, resetRejectedMessage());

  // A hard rejection (no overage) means the vendor is unavailable until
  // resetsAt — same situation as usage-credits-exhausted. It should flag
  // provider health immediately (skipping the failure-streak threshold, see
  // {immediate: true}) rather than just scheduling a same-provider wait, so
  // the automatic failover in project-provider-failover.js gets a chance to
  // switch providers instead of always sitting out the reset window.
  assert.strictEqual(spies.scheduled, 0);
  assert.strictEqual(providerHealth.getHealth("claude").state, "unhealthy");
  assert.deepStrictEqual(session.providerFailoverPending, {
    vendor: "claude",
    reason: "rate-limit-rejected",
    isLimitFailure: true,
    resetsAt: session.rateLimitLastResetsAt,
  });
  providerHealth._reset();
});

test("Claude monthly spend-limit tool result cancels the stale resume and requests provider failover", function () {
  providerHealth._reset();
  var spies = { scheduled: 0, cancelled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, resetRejectedMessage());
  processor.processSDKMessage(session, monthlySpendLimitToolResult());

  assert.strictEqual(spies.scheduled, 0);
  assert.strictEqual(spies.cancelled, 1);
  assert.strictEqual(spies.continued, 0);
  assert.strictEqual(session.rateLimitAutoContinuePending, false);
  assert.strictEqual(session.rateLimitUseCreditsPending, false);
  assert.strictEqual(session.rateLimitResetsAt, null);
  assert.deepStrictEqual(session.providerFailoverPending, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
    isLimitFailure: true,
    resetsAt: session.rateLimitLastResetsAt,
  });
  assert.strictEqual(providerHealth.getHealth("claude").state, "unhealthy");
  assert.ok(session.history.some(function (item) {
    return item.type === "info" && String(item.text || "").indexOf("usage credits are exhausted") !== -1;
  }));
  assert.strictEqual(session.history.some(function (item) {
    return item.type === "tool_result" && String(item.content || "").indexOf("monthly spend limit") !== -1;
  }), false);
  providerHealth._reset();
});

test("Claude model-switch spend-limit text is treated as provider exhaustion", function () {
  providerHealth._reset();
  var spies = { scheduled: 0, cancelled: 0, continued: 0 };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, resetRejectedMessage());
  processor.processSDKMessage(session, {
    yokeType: "text_delta",
    blockId: "limit-text",
    text: "You've hit your monthly spend limit. /model to switch models.",
  });

  assert.strictEqual(spies.cancelled, 1);
  assert.deepStrictEqual(session.providerFailoverPending, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
    isLimitFailure: true,
    resetsAt: session.rateLimitLastResetsAt,
  });
  assert.strictEqual(session.history.some(function (item) {
    return item.type === "delta" && String(item.text || "").indexOf("/model to switch models") !== -1;
  }), false);
  providerHealth._reset();
});

test("Claude monthly spend-limit failover is queued at the terminal turn boundary", function () {
  providerHealth._reset();
  var spies = { scheduled: 0, cancelled: 0, continued: 0, failoverQueued: null };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, monthlySpendLimitToolResult());
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0,
    usage: null,
    modelUsage: null,
    sessionId: "claude-session-1",
  });

  assert.deepStrictEqual(spies.failoverQueued, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
    isLimitFailure: true,
    resetsAt: null,
  });
  assert.strictEqual(session.providerFailoverPending, null);
  assert.strictEqual(session.isProcessing, true, "the old query remains busy until it is detached");
  assert.ok(session.history.some(function (item) {
    return item.type === "done" && item.code === 1;
  }));
  providerHealth._reset();
});

test("GitHub Copilot monthly quota execution error requests exact-route provider failover", function () {
  providerHealth._reset();
  var spies = { scheduled: 0, cancelled: 0, continued: 0, failoverQueued: null };
  var processor = makeProcessor(spies, true, { vendor: "github-copilot" });
  var session = makeSession(true, "github-copilot");
  session.providerRouteId = "codex-github-copilot";
  session.model = "gpt-5.6-luna";

  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0,
    usage: null,
    modelUsage: null,
    sessionId: "copilot-session-1",
    subtype: "error_during_execution",
    errors: ["Error: You have exceeded your monthly quota (Request ID: ABCD:1234:EF56)"],
  });

  assert.deepStrictEqual(spies.failoverQueued, {
    vendor: "github-copilot",
    reason: "provider-quota-exhausted",
    isLimitFailure: true,
    resetsAt: null,
    providerRouteId: "codex-github-copilot",
    model: "gpt-5.6-luna",
  });
  assert.strictEqual(session.isProcessing, true, "the failover owns terminal cleanup");
  assert.strictEqual(providerHealth.getHealth("github-copilot", {
    providerRouteId: "codex-github-copilot",
    model: "gpt-5.6-luna",
  }).state, "unhealthy");
  assert.ok(session.history.some(function(item) {
    return item.type === "info" && String(item.text || "").indexOf("GitHub Copilot quota is exhausted") !== -1;
  }));
  assert.strictEqual(session.history.some(function(item) {
    return item.type === "error" && String(item.text || "").indexOf("monthly quota") !== -1;
  }), false);
  providerHealth._reset();
});

test("plain rate-limit rejection failover is queued at the terminal turn boundary", function () {
  providerHealth._reset();
  var spies = { scheduled: 0, cancelled: 0, continued: 0, failoverQueued: null };
  var processor = makeProcessor(spies);
  var session = makeSession(true);

  processor.processSDKMessage(session, resetRejectedMessage());
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0,
    usage: null,
    modelUsage: null,
    sessionId: "claude-session-1",
  });

  assert.deepStrictEqual(spies.failoverQueued, {
    vendor: "claude",
    reason: "rate-limit-rejected",
    isLimitFailure: true,
    resetsAt: session.rateLimitLastResetsAt,
  });
  assert.strictEqual(spies.scheduled, 0);
  assert.strictEqual(session.providerFailoverPending, null);
  assert.strictEqual(session.isProcessing, true, "the old query remains busy until it is detached");
  assert.ok(session.history.some(function (item) {
    return item.type === "done" && item.code === 1;
  }));
  providerHealth._reset();
});

test("disabled auto-continue leaves a plain rate-limit rejection idle without marking provider health", function () {
  providerHealth._reset();
  var spies = { scheduled: 0, cancelled: 0, continued: 0, failoverQueued: null };
  var processor = makeProcessor(spies, false);
  var session = makeSession(true);

  processor.processSDKMessage(session, resetRejectedMessage());

  assert.strictEqual(spies.scheduled, 0);
  assert.strictEqual(session.providerFailoverPending, undefined);
  assert.strictEqual(providerHealth.getHealth("claude").state, "healthy");
  providerHealth._reset();
});

test("disabled auto-continue leaves credit exhaustion idle without switching providers", function () {
  providerHealth._reset();
  var spies = { scheduled: 0, cancelled: 0, continued: 0, failoverQueued: null };
  var processor = makeProcessor(spies, false);
  var session = makeSession(true);

  processor.processSDKMessage(session, monthlySpendLimitToolResult());
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0,
    usage: null,
    modelUsage: null,
    sessionId: "claude-session-1",
  });

  assert.strictEqual(spies.failoverQueued, null);
  assert.strictEqual(session.providerFailoverPending, null);
  assert.strictEqual(session.isProcessing, false);
  providerHealth._reset();
});
