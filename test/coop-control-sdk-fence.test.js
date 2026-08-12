var test = require("node:test");
var assert = require("node:assert/strict");
var attachBridgeQueryStart = require("../lib/sdk-bridge-query-start").attachBridgeQueryStart;
var attachBridgeStream = require("../lib/sdk-bridge-stream").attachBridgeStream;
var fenceModule = require("../lib/coop-control-fence");
var watchdogModule = require("../lib/sdk-bridge-stream-watchdog");

var REFS = Object.freeze({
  executionId: "exec:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  incarnationId: "inc:11111111-1111-4111-8111-111111111111",
  epoch: 1,
  role: "worker",
  authorityId: "auth:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});

function fakeFence(state, calls, refs) {
  return {
    refs: refs || REFS,
    assert: function (action) {
      calls.push("assert:" + action);
      if (state[action] === false) {
        var error = new Error("stale " + action);
        error.code = "COOP_CONTROL_FENCE_REJECTED";
        throw error;
      }
      return true;
    },
    isCurrent: function (action) {
      calls.push("current:" + action);
      return state[action] !== false;
    },
    isIncarnationCurrent: function () {
      calls.push("incarnation-current");
      return state.incarnationCurrent !== false;
    },
    markProviderStarted: function () { calls.push("started"); return true; },
    abandon: function (reason) {
      calls.push("abandon:" + reason);
      state.incarnationCurrent = false;
      return true;
    },
  };
}

function controlledSession(fence) {
  var session = {
    localId: 9,
    storageId: "controlled-session",
    vendor: "codex",
    model: "gpt-5.6-sol",
    orchestrationPolicy: { portfolioExecution: { control: Object.assign({}, REFS) } },
    history: [],
    blocks: {},
    sentToolResults: {},
    activeTaskToolIds: {},
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
    pendingUserDialogs: {},
    allowedTools: {},
    interactiveToolWaits: {},
    isProcessing: true,
  };
  fenceModule.attachFence(session, fence);
  return session;
}

function queryHarness(fence, calls, options) {
  var opts = options || {};
  var queryOptions = null;
  var handle = {
    pushMessage: function () {
      calls.push("push");
      if (opts.pushError) throw new Error(opts.pushError);
    },
    close: function () { calls.push("close"); },
  };
  var adapter = {
    vendor: "codex",
    createQuery: async function (options) {
      calls.push("create");
      queryOptions = options;
      if (opts.createError) throw new Error(opts.createError);
      if (typeof opts.afterCreate === "function") opts.afterCreate();
      return handle;
    },
  };
  if (typeof opts.adapterInit === "function") adapter.init = opts.adapterInit;
  var sm = {
    currentEffort: "medium",
    currentPermissionMode: "bypassPermissions",
    modelsByVendor: Object.prototype.hasOwnProperty.call(opts, "modelsByVendor") ?
      opts.modelsByVendor : { codex: [] },
    availableVendors: ["codex"],
    installedVendors: ["codex"],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  var bridge = attachBridgeQueryStart({
    adapters: { codex: adapter },
    adapter: adapter,
    cwd: process.cwd(),
    dangerouslySkipPermissions: false,
    clayPort: 7292,
    clayTls: false,
    clayAuthToken: "",
    slug: "target",
    isMate: false,
    sm: sm,
    send: function () {},
    sendToSession: function () {},
    sendAndRecord: function () { calls.push("record"); },
    onProcessingChanged: function () { calls.push("processing"); },
    ensureLinuxUserProjectDir: function () {},
    getFreshAuthState: function () { return { codex: true }; },
    logAuthDecision: function () {},
    getVendorDisplayName: function () { return "Codex"; },
    getLoginCommand: function () { return "codex login"; },
    notifyAuthRequired: function () {},
    copilotRouteIdForModel: function () { return null; },
    getModelsForSession: function () { return []; },
    modelListContains: function () { return true; },
    resolveModelInList: function () { return null; },
    modelEntryValue: function (value) { return value; },
    mergeMcpServers: function () { return {}; },
    getMcpServers: function () {
      if (typeof opts.beforeCreate === "function") opts.beforeCreate();
      return {};
    },
    getRemoteMcpServers: function () { return {}; },
    handleCanUseTool: function () { calls.push("tool-effect"); return Promise.resolve({ behavior: "allow" }); },
    handleElicitation: function () { calls.push("elicitation-effect"); },
    handleUserDialog: function () { calls.push("dialog-effect"); },
    processQueryStream: function (session, suppliedFence) {
      calls.push(suppliedFence === fence ? "stream-fence" : "wrong-fence");
      return Promise.resolve();
    },
  });
  return {
    bridge: bridge,
    options: function () { return queryOptions; },
  };
}

function deferred() {
  var resolve;
  var promise = new Promise(function (done) { resolve = done; });
  return { promise: promise, resolve: resolve };
}

function installSuccessor(session, calls) {
  var refs = Object.assign({}, REFS, {
    incarnationId: "inc:22222222-2222-4222-8222-222222222222",
    epoch: 2,
  });
  var fence = fakeFence({}, calls, refs);
  session.orchestrationPolicy.portfolioExecution.control = Object.assign({}, refs);
  fenceModule.attachFence(session, fence);
  session.blocks = { successor: true };
  session.sentToolResults = { successor: true };
}

test("provider creation and every provider tool callback use the captured execution fence", async function () {
  var calls = [];
  var fence = fakeFence({}, calls);
  var session = controlledSession(fence);
  var harness = queryHarness(fence, calls);
  await harness.bridge.startQuery(session, "start", null, null);
  assert.ok(calls.indexOf("assert:provider_start") < calls.indexOf("create"));
  assert.ok(calls.indexOf("create") < calls.indexOf("started"));
  assert.ok(calls.indexOf("started") < calls.indexOf("push"));
  assert.ok(calls.indexOf("stream-fence") !== -1);

  await harness.options().canUseTool("Read", {}, {});
  assert.ok(calls.lastIndexOf("assert:tool") < calls.lastIndexOf("tool-effect"));
  harness.options().onElicitation({}, {});
  harness.options().onUserDialog({}, {});
  assert.ok(calls.indexOf("assert:callback") !== -1);
});

test("a stale provider-start capability is rejected before adapter creation", async function () {
  var calls = [];
  var fence = fakeFence({ provider_start: false }, calls);
  var session = controlledSession(fence);
  var harness = queryHarness(fence, calls);
  await assert.rejects(harness.bridge.startQuery(session, "start", null, null), function (error) {
    return error && error.code === "COOP_CONTROL_FENCE_REJECTED";
  });
  assert.equal(calls.indexOf("create"), -1);
  assert.equal(calls.indexOf("push"), -1);
});

test("provider start is rechecked after async preparation and before construction", async function () {
  var calls = [];
  var state = {};
  var fence = fakeFence(state, calls);
  var session = controlledSession(fence);
  var harness = queryHarness(fence, calls, {
    beforeCreate: function () { state.provider_start = false; },
  });
  var result = await harness.bridge.startQuery(session, "start", null, null);
  assert.deepEqual(result, { ok: false, reason: "provider_start_failed" });
  assert.equal(calls.indexOf("create"), -1);
  assert.ok(calls.indexOf("abandon:provider_start_failed") !== -1);
  assert.equal(calls.indexOf("push"), -1);
});

test("a stale provider start cannot reset its successor after adapter preparation", async function () {
  var calls = [];
  var started = deferred();
  var release = deferred();
  var fence = fakeFence({}, calls);
  var session = controlledSession(fence);
  var harness = queryHarness(fence, calls, {
    modelsByVendor: {},
    adapterInit: async function () {
      started.resolve();
      await release.promise;
    },
  });

  var pending = harness.bridge.startQuery(session, "start", null, null);
  await started.promise;
  installSuccessor(session, calls);
  release.resolve();
  var result = await pending;

  assert.deepEqual(result, { ok: false, reason: "provider_start_failed" });
  assert.deepEqual(session.blocks, { successor: true });
  assert.deepEqual(session.sentToolResults, { successor: true });
  assert.equal(session.isProcessing, true);
  assert.equal(calls.indexOf("create"), -1);
  assert.equal(calls.indexOf("record"), -1);
  assert.equal(calls.indexOf("processing"), -1);
  assert.equal(calls.indexOf("abandon:provider_start_failed"), -1);
});

test("a stale provider start cannot reset its successor after worker exit", async function () {
  var calls = [];
  var release = deferred();
  var fence = fakeFence({}, calls);
  var session = controlledSession(fence);
  session._workerExitPromise = release.promise;
  var harness = queryHarness(fence, calls);

  var pending = harness.bridge.startQuery(session, "start", null, null);
  while (session._workerExitPromise) await new Promise(function (resolve) { setImmediate(resolve); });
  installSuccessor(session, calls);
  release.resolve();
  var result = await pending;

  assert.deepEqual(result, { ok: false, reason: "provider_start_failed" });
  assert.deepEqual(session.blocks, { successor: true });
  assert.deepEqual(session.sentToolResults, { successor: true });
  assert.equal(session.isProcessing, true);
  assert.equal(calls.indexOf("create"), -1);
  assert.equal(calls.indexOf("record"), -1);
  assert.equal(calls.indexOf("processing"), -1);
  assert.equal(calls.indexOf("abandon:provider_start_failed"), -1);
});

test("a current provider-start failure cleans live state after durable abandonment", async function () {
  var calls = [];
  var fence = fakeFence({}, calls);
  var session = controlledSession(fence);
  var harness = queryHarness(fence, calls, { createError: "injected create failure" });

  var result = await harness.bridge.startQuery(session, "start", null, null);

  assert.deepEqual(result, { ok: false, reason: "provider_start_failed" });
  assert.ok(calls.indexOf("abandon:provider_start_failed") !== -1);
  assert.equal(session.isProcessing, false);
  assert.equal(calls.filter(function (item) { return item === "record"; }).length, 2);
  assert.ok(calls.indexOf("processing") !== -1);
});

test("a post-create push failure closes the provider and abandons the durable start", async function () {
  var calls = [];
  var fence = fakeFence({}, calls);
  var session = controlledSession(fence);
  var harness = queryHarness(fence, calls, { pushError: "injected push failure" });
  var result = await harness.bridge.startQuery(session, "start", null, null);
  assert.deepEqual(result, { ok: false, reason: "provider_start_failed" });
  assert.ok(calls.indexOf("started") < calls.indexOf("push"));
  assert.ok(calls.indexOf("close") > calls.indexOf("push"));
  assert.ok(calls.indexOf("abandon:provider_start_failed") > calls.indexOf("push"));
  assert.equal(calls.indexOf("stream-fence"), -1);
  assert.equal(session.queryInstance, null);
});

test("a provider created after its incarnation goes stale is closed without touching the successor", async function () {
  var calls = [];
  var state = {};
  var fence = fakeFence(state, calls);
  var session = controlledSession(fence);
  var harness = queryHarness(fence, calls, {
    afterCreate: function () {
      state.provider_start = false;
      session.orchestrationPolicy.portfolioExecution.control = Object.assign({}, REFS, {
        incarnationId: "inc:22222222-2222-4222-8222-222222222222",
        epoch: 2,
      });
    },
  });

  var result = await harness.bridge.startQuery(session, "start", null, null);

  assert.deepEqual(result, { ok: false, reason: "provider_start_failed" });
  assert.ok(calls.indexOf("close") !== -1);
  assert.equal(calls.indexOf("processing"), -1);
  assert.equal(calls.indexOf("record"), -1);
  assert.equal(session.isProcessing, true);
});

function asyncHandle(messages, calls) {
  return {
    close: function () { calls.push("close"); },
    [Symbol.asyncIterator]: async function* () {
      for (var i = 0; i < messages.length; i++) yield messages[i];
    },
  };
}

function streamHarness(calls) {
  return attachBridgeStream({
    adapter: { vendor: "codex" },
    sm: { broadcastSessionList: function () { calls.push("broadcast"); } },
    send: function () { calls.push("send"); },
    sendAndRecord: function () { calls.push("record"); },
    sendToSession: function () { calls.push("session-send"); },
    processSDKMessage: function () { calls.push("process"); },
    onProcessingChanged: function () { calls.push("processing"); },
    onTurnDone: function () { calls.push("turn-done"); },
    opts: {},
    getVendorDisplayName: function () { return "Codex"; },
    isAuthErrorMessage: function () { return false; },
    getFreshAuthState: function () { return {}; },
    getLinuxUserForSession: function () { return null; },
    logAuthDecision: function () {},
    getLoginCommand: function () { return ""; },
    notifyAuthRequired: function () {},
    findConflictingClaude: function () { return []; },
    isTransientStreamError: function () { return false; },
    autoResumeAllowed: function () { return false; },
    scheduleInterruptResume: function () {},
    sendModelInfoForVendor: function () {},
    rateLimitResumeLabel: "resume",
    debugEvents: false,
    slug: "target",
  });
}

test("stale callbacks and completions are dropped before processor or terminal effects", async function () {
  var staleCalls = [];
  var staleFence = fakeFence({ callback: false }, staleCalls);
  var staleSession = controlledSession(staleFence);
  staleSession.queryInstance = asyncHandle([{ yokeType: "text_delta", text: "stale" }], staleCalls);
  await streamHarness(staleCalls).processQueryStream(staleSession, staleFence);
  assert.equal(staleCalls.indexOf("process"), -1);
  assert.equal(staleCalls.indexOf("record"), -1);
  assert.equal(staleCalls.indexOf("turn-done"), -1);

  var completionCalls = [];
  var completionFence = fakeFence({ callback: true, completion: false }, completionCalls);
  var completionSession = controlledSession(completionFence);
  completionSession.queryInstance = asyncHandle([{ yokeType: "text_delta", text: "accepted" }], completionCalls);
  await streamHarness(completionCalls).processQueryStream(completionSession, completionFence);
  assert.equal(completionCalls.filter(function (item) { return item === "process"; }).length, 1);
  assert.equal(completionCalls.indexOf("record"), -1);
  assert.equal(completionCalls.indexOf("turn-done"), -1);
});

test("a stream captured by an older incarnation is closed when session metadata advances", async function () {
  var calls = [];
  var fence = fakeFence({}, calls);
  var session = controlledSession(fence);
  session.queryInstance = asyncHandle([{ yokeType: "text_delta", text: "stale" }], calls);
  session.orchestrationPolicy.portfolioExecution.control = Object.assign({}, REFS, {
    incarnationId: "inc:22222222-2222-4222-8222-222222222222",
    epoch: 2,
  });
  await streamHarness(calls).processQueryStream(session, fence);
  assert.equal(calls.indexOf("process"), -1);
  assert.equal(calls.indexOf("record"), -1);
  assert.equal(calls.indexOf("turn-done"), -1);
  assert.ok(calls.indexOf("close") !== -1);
  assert.equal(session.queryInstance, null);
});

test("a stale watchdog callback cannot abort or mark a newer incarnation", function () {
  var calls = [];
  var fence = fakeFence({}, calls);
  var session = controlledSession(fence);
  var aborted = 0;
  session.abortController = {
    abort: function () { aborted++; },
    signal: { aborted: false },
  };
  var state = watchdogModule.createState(session, fence);
  state.turnStartedAt = 0;
  state.watchdogTimer = setInterval(function () {}, 10000);
  if (state.watchdogTimer.unref) state.watchdogTimer.unref();
  session.orchestrationPolicy.portfolioExecution.control = Object.assign({}, REFS, {
    incarnationId: "inc:33333333-3333-4333-8333-333333333333",
    epoch: 3,
  });

  watchdogModule.watchdogTick({ adapter: { vendor: "codex" } }, state);

  assert.equal(state.fencedOut, true);
  assert.equal(aborted, 0);
  assert.equal(session._watchdogAbort, undefined);
});

test("historical control metadata is pass-through when the Slice 2 flag is off", function () {
  var oldStore = process.env.CLAY_COOP_CONTROL_STORE;
  var oldExecutions = process.env.CLAY_COOP_CONTROL_EXECUTIONS;
  try {
    delete process.env.CLAY_COOP_CONTROL_STORE;
    delete process.env.CLAY_COOP_CONTROL_EXECUTIONS;
    var session = controlledSession(fakeFence({}, []));
    delete session._coopExecutionFence;
    assert.equal(fenceModule.assertAction(session, "tool"), true);
  } finally {
    if (oldStore === undefined) delete process.env.CLAY_COOP_CONTROL_STORE;
    else process.env.CLAY_COOP_CONTROL_STORE = oldStore;
    if (oldExecutions === undefined) delete process.env.CLAY_COOP_CONTROL_EXECUTIONS;
    else process.env.CLAY_COOP_CONTROL_EXECUTIONS = oldExecutions;
  }
});
