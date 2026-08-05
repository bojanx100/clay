var test = require("node:test");
var assert = require("node:assert");

var { attachBridgeStream } = require("../lib/sdk-bridge-stream");

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
