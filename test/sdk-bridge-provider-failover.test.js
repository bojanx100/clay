var test = require("node:test");
var assert = require("node:assert");
require("./helpers/isolated-clay-home");

var { attachBridgeStream } = require("../lib/sdk-bridge-stream");
var { attachBridgeRecovery } = require("../lib/sdk-bridge-recovery");

function emptyQueryHandle() {
  return {
    close: function () {},
    [Symbol.asyncIterator]: async function* () {},
  };
}

test("terminal provider failure fails over only after the old stream is cleaned up", async function () {
  var failovers = [];
  var turnDoneCalls = 0;
  var handle = emptyQueryHandle();
  var session = {
    localId: 8,
    vendor: "claude",
    queryInstance: handle,
    abortController: null,
    messageQueue: null,
    isProcessing: false,
    providerFailoverPending: {
      vendor: "claude",
      reason: "usage-credits-exhausted",
    },
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
  };
  var stream = attachBridgeStream({
    adapter: { vendor: "claude" },
    sm: {
      broadcastSessionList: function () {},
      saveSessionFile: function () {},
    },
    send: function () {},
    sendAndRecord: function () {},
    sendToSession: function () {},
    processSDKMessage: function () {},
    onProcessingChanged: function () {},
    onTurnDone: function () { turnDoneCalls++; },
    opts: {
      getAutoContinueSetting: function () { return true; },
      failoverAndContinue: function (targetSession, failure) {
        assert.strictEqual(targetSession.queryInstance, null, "old query is closed before failover starts");
        assert.strictEqual(targetSession.messageQueue, null, "old message queue is cleared before failover starts");
        failovers.push(failure);
        return true;
      },
    },
    getVendorDisplayName: function () { return "Claude"; },
    isAuthErrorMessage: function () { return false; },
    getFreshAuthState: function () { return {}; },
    logAuthDecision: function () {},
    getLoginCommand: function () { return "claude login"; },
    notifyAuthRequired: function () {},
    findConflictingClaude: function () { return []; },
    isTransientStreamError: function () { return false; },
    autoResumeAllowed: function () { return true; },
    scheduleInterruptResume: function () {},
    sendModelInfoForVendor: function () {},
    rateLimitResumeLabel: "↻ Continuing after rate limit",
    debugEvents: false,
  });

  await stream.processQueryStream(session);

  assert.strictEqual(failovers.length, 1);
  assert.strictEqual(failovers[0].reason, "usage-credits-exhausted");
  assert.strictEqual(session.providerFailoverPending, null);
  assert.strictEqual(turnDoneCalls, 0);
});

test("intentional failover closure does not schedule a same-provider resume or completion", async function () {
  var scheduled = 0;
  var completed = 0;
  var handle = emptyQueryHandle();
  var session = {
    localId: 9,
    vendor: "claude",
    queryInstance: handle,
    isProcessing: true,
    _providerFailoverClosing: true,
    onQueryComplete: function () { completed++; },
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
  };
  var stream = attachBridgeStream({
    adapter: { vendor: "claude" },
    sm: {
      broadcastSessionList: function () {},
      saveSessionFile: function () {},
    },
    send: function () {},
    sendAndRecord: function () {},
    sendToSession: function () {},
    processSDKMessage: function () {},
    onProcessingChanged: function () {},
    onTurnDone: function () { completed++; },
    opts: {
      getAutoContinueSetting: function () { return true; },
      scheduleMessage: function () { scheduled++; },
    },
    getVendorDisplayName: function () { return "Claude"; },
    isAuthErrorMessage: function () { return false; },
    getFreshAuthState: function () { return {}; },
    logAuthDecision: function () {},
    getLoginCommand: function () { return "claude login"; },
    notifyAuthRequired: function () {},
    findConflictingClaude: function () { return []; },
    isTransientStreamError: function () { return false; },
    autoResumeAllowed: function () { return true; },
    scheduleInterruptResume: function () { scheduled++; },
    sendModelInfoForVendor: function () {},
    rateLimitResumeLabel: "↻ Continuing after rate limit",
    debugEvents: false,
  });

  await stream.processQueryStream(session);

  assert.strictEqual(scheduled, 0);
  assert.strictEqual(completed, 0);
});

test("interrupted turns reconcile queued messages only after stream cleanup", async function () {
  var reconciled = [];
  var handle = emptyQueryHandle();
  var abortController = { abort: function () {} };
  var session = {
    localId: 10,
    vendor: "claude",
    queryInstance: handle,
    abortController: abortController,
    messageQueue: { end: function () {} },
    isProcessing: true,
    taskStopRequested: true,
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
  };
  var stream = attachBridgeStream({
    adapter: { vendor: "claude" },
    sm: {
      broadcastSessionList: function () {},
      saveSessionFile: function () {},
    },
    send: function () {},
    sendAndRecord: function () {},
    sendToSession: function () {},
    processSDKMessage: function () {},
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    opts: {
      getAutoContinueSetting: function () { return false; },
      reconcileQueuedUserMessages: function (targetSession) {
        reconciled.push({
          isProcessing: targetSession.isProcessing,
          queryInstance: targetSession.queryInstance,
          messageQueue: targetSession.messageQueue,
          abortController: targetSession.abortController,
          taskStopRequested: targetSession.taskStopRequested,
        });
      },
    },
    getVendorDisplayName: function () { return "Claude"; },
    isAuthErrorMessage: function () { return false; },
    getFreshAuthState: function () { return {}; },
    logAuthDecision: function () {},
    getLoginCommand: function () { return "claude login"; },
    notifyAuthRequired: function () {},
    findConflictingClaude: function () { return []; },
    isTransientStreamError: function () { return false; },
    autoResumeAllowed: function () { return false; },
    scheduleInterruptResume: function () {},
    sendModelInfoForVendor: function () {},
    rateLimitResumeLabel: "↻ Continuing after rate limit",
    debugEvents: false,
  });

  await stream.processQueryStream(session);

  assert.deepStrictEqual(reconciled, [{
    isProcessing: false,
    queryInstance: null,
    messageQueue: null,
    abortController: null,
    taskStopRequested: false,
  }]);
});

test("adapter shutdown never auto-retries a direct portfolio leaf", async function () {
  var scheduled = 0;
  var recorded = [];
  var recovery = attachBridgeRecovery({
    opts: { scheduleMessage: function () { scheduled++; } },
  });
  var session = {
    localId: 11,
    vendor: "codex",
    queryInstance: emptyQueryHandle(),
    isProcessing: true,
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
    orchestrationPolicy: { portfolioExecution: { mode: "direct_leaf" } },
  };
  var stream = attachBridgeStream({
    adapter: { vendor: "codex" },
    sm: { broadcastSessionList: function () {}, saveSessionFile: function () {} },
    send: function () {},
    sendAndRecord: function (target, event) { recorded.push(event); },
    sendToSession: function () {},
    processSDKMessage: function () {},
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    opts: { getAutoContinueSetting: function () { return true; }, scheduleMessage: function () { scheduled++; } },
    getVendorDisplayName: function () { return "Codex"; },
    isAuthErrorMessage: function () { return false; },
    getFreshAuthState: function () { return {}; },
    logAuthDecision: function () {},
    getLoginCommand: function () { return "codex login"; },
    notifyAuthRequired: function () {},
    findConflictingClaude: function () { return []; },
    isTransientStreamError: recovery.isTransientStreamError,
    autoResumeAllowed: recovery.autoResumeAllowed,
    scheduleInterruptResume: recovery.scheduleInterruptResume,
    sendModelInfoForVendor: function () {},
    rateLimitResumeLabel: "continue",
    debugEvents: false,
  });

  await stream.processQueryStream(session);

  assert.equal(scheduled, 0);
  assert.equal(recorded.some(function (event) { return event.type === "done" && event.code === 1; }), true);
  assert.equal(session.streamEndedAutoRetryQueued, undefined);
});

// --- Adapter-delivered connectivity drops must retry, not fail over --------
//
// Regression for the 2026-08-11 Codex park (session 019fd26a). The Codex CLI
// ran its own reconnect ladder, gave up, and delivered the failure as an
// ADAPTER ERROR EVENT rather than a thrown error. That branch never consulted
// isTransientStreamError, so a network blip was recorded as a strong provider
// failure and pushed into the rate-limit scheduling path.

function errorQueryHandle(text) {
  return {
    close: function () {},
    [Symbol.asyncIterator]: async function* () {
      yield { yokeType: "error", text: text };
    },
  };
}

function makeTransientStreamHarness(session) {
  var recovery = attachBridgeRecovery({
    opts: {
      scheduleMessage: function (targetSession, kind, at, prompt, label, opts) {
        session._scheduled.push({ kind: kind, at: at, prompt: prompt, label: label, options: opts });
      },
    },
  });
  return attachBridgeStream({
    adapter: { vendor: "codex" },
    sm: {
      broadcastSessionList: function () {},
      saveSessionFile: function () {},
      sendAndRecord: function () {},
    },
    send: function () {},
    sendAndRecord: function (targetSession, obj) { session._sent.push(obj); },
    sendToSession: function () {},
    processSDKMessage: function () {},
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    opts: {
      getAutoContinueSetting: function () { return true; },
      scheduleMessage: function (targetSession, kind, at, prompt, label, opts) {
        session._scheduled.push({ kind: kind, at: at, prompt: prompt, label: label, options: opts });
      },
      failoverAndContinue: function (targetSession, failure) {
        session._failovers.push(failure);
        return true;
      },
      queueProviderFailover: function (targetSession, failure) {
        session._failovers.push(failure);
        return true;
      },
    },
    getVendorDisplayName: function () { return "Codex"; },
    isAuthErrorMessage: function () { return false; },
    getFreshAuthState: function () { return {}; },
    logAuthDecision: function () {},
    getLoginCommand: function () { return "codex login"; },
    notifyAuthRequired: function () {},
    findConflictingClaude: function () { return []; },
    isTransientStreamError: recovery.isTransientStreamError,
    autoResumeAllowed: recovery.autoResumeAllowed,
    scheduleInterruptResume: recovery.scheduleInterruptResume,
    sendModelInfoForVendor: function () {},
    rateLimitResumeLabel: "↻ Continuing after rate limit",
    debugEvents: false,
  });
}

function makeStreamSession(errorText) {
  return {
    localId: 42,
    vendor: "codex",
    queryInstance: errorQueryHandle(errorText),
    abortController: null,
    messageQueue: null,
    isProcessing: true,
    providerFailoverPending: null,
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
    _sent: [],
    _scheduled: [],
    _failovers: [],
  };
}

test("a Codex adapter connectivity error retries once instead of queueing a failover", async function () {
  var providerHealth = require("../lib/provider-health");
  providerHealth._reset();
  var codexGiveUp = "stream disconnected before completion: error sending request for url "
    + "(https://chatgpt.com/backend-api/codex/responses)";
  var session = makeStreamSession(codexGiveUp);
  var stream = makeTransientStreamHarness(session);

  await stream.processQueryStream(session);

  assert.strictEqual(session._failovers.length, 0, "a blip must not queue a provider failover");
  assert.strictEqual(session.providerFailoverPending, null);
  assert.strictEqual(providerHealth.getHealth("codex").state, "healthy",
    "a self-clearing connectivity drop must not degrade provider health");
  assert.strictEqual(session._scheduled.length, 1, "exactly one resume is scheduled");
  assert.ok(session._scheduled[0].at <= Date.now(), "the resume runs now, not after a reset window");
  assert.ok(session._sent.some(function (item) {
    return item.type === "info" && String(item.text || "").indexOf("Retrying") !== -1;
  }), "the user sees a retry, not a raw provider error");
  providerHealth._reset();
});

test("a Codex adapter connectivity error becomes a real failure once the retry budget is spent", async function () {
  var providerHealth = require("../lib/provider-health");
  providerHealth._reset();
  var codexGiveUp = "stream disconnected before completion: error sending request for url (https://chatgpt.com)";
  var session = makeStreamSession(codexGiveUp);
  session._transientRetryUsed = true; // the one-shot retry already ran
  // A stale reset from an unrelated limit hours ago — the field that used to
  // get resurrected and park the session.
  session.rateLimitLastResetsAt = Date.now() + 11 * 3600000;
  var stream = makeTransientStreamHarness(session);

  // Provider health needs a failure streak before it declares an outage, so
  // drive the failing turn until the vendor is actually unhealthy.
  for (var i = 0; i < 3; i++) {
    session.queryInstance = errorQueryHandle(codexGiveUp);
    session.isProcessing = true;
    await stream.processQueryStream(session);
  }

  assert.strictEqual(session._scheduled.length, 0, "no retry once the one-shot budget is spent");
  assert.strictEqual(providerHealth.getHealth("codex").state, "unhealthy",
    "escalation still reaches a real provider failure");
  assert.strictEqual(session._failovers.length, 1, "the failover path takes over exactly once");
  assert.strictEqual(session._failovers[0].isLimitFailure, false,
    "a connectivity failure is never treated as a limit with a reset time");
  assert.strictEqual(session._failovers[0].resetsAt, null,
    "the stale rate-limit reset must not ride along into the failover");
  providerHealth._reset();
});
