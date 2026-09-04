var test = require("node:test");
var assert = require("node:assert/strict");

var { createCodexAdapterPool } = require("../lib/yoke/adapters/codex-pool");
var appServer = require("../lib/yoke/codex-app-server");
var { attachBridgeQueryStart } = require("../lib/sdk-bridge-query-start");
var { attachBridgeAuth } = require("../lib/sdk-bridge-auth");
var { attachProjectSessionsHandoff } = require("../lib/project-sessions-handoff");
var { attachAutoTitle } = require("../lib/sdk-bridge-auto-title");
var { attachBridgeRewind } = require("../lib/sdk-bridge-rewind");

function createCoreFactory(calls) {
  return function(opts) {
    var identity = opts.linuxUser || "daemon";
    return {
      vendor: "codex",
      init: function(initOpts) {
        calls.push({ type: "init", identity: identity, linuxUser: initOpts.linuxUser || null });
        return Promise.resolve({ models: [], skills: [] });
      },
      supportedModels: function() { return Promise.resolve([]); },
      createQuery: function(queryOpts) {
        calls.push({ type: "query", identity: identity, linuxUser: queryOpts.linuxUser || null, resume: queryOpts.resumeSessionId || null });
        return Promise.resolve({ identity: identity });
      },
      shutdownIfIdle: function() {
        calls.push({ type: "idle", identity: identity });
        return Promise.resolve(true);
      },
      shutdown: function() {
        calls.push({ type: "shutdown", identity: identity });
        return Promise.resolve();
      },
    };
  };
}

test("Codex keeps fresh, resumed, and concurrent sessions on their owner's credential home", async function() {
  var calls = [];
  var adapter = createCodexAdapterPool({ createCoreAdapter: createCoreFactory(calls) });

  await adapter.init({ linuxUser: "owner-a" });
  await adapter.createQuery({ linuxUser: "owner-a", resumeSessionId: "thread-a" });
  await adapter.createQuery({ linuxUser: "owner-a" });
  await adapter.createQuery({ linuxUser: "owner-b", resumeSessionId: "thread-b" });

  assert.deepEqual(calls.filter(function(call) { return call.type === "query"; }), [
    { type: "query", identity: "owner-a", linuxUser: "owner-a", resume: "thread-a" },
    { type: "query", identity: "owner-a", linuxUser: "owner-a", resume: null },
    { type: "query", identity: "owner-b", linuxUser: "owner-b", resume: "thread-b" },
  ]);
  assert.equal(calls.filter(function(call) { return call.type === "init" && call.identity === "owner-a"; }).length, 1);
});

test("Codex refresh replaces only an idle owner's app-server after device login", async function() {
  var calls = [];
  var adapter = createCodexAdapterPool({ createCoreAdapter: createCoreFactory(calls) });

  await adapter.init({ linuxUser: "owner-a" });
  assert.equal(await adapter.refreshCredential({ linuxUser: "owner-a" }), true);
  await adapter.createQuery({ linuxUser: "owner-a" });

  assert.deepEqual(calls.map(function(call) { return call.type + ":" + call.identity; }), [
    "init:owner-a",
    "idle:owner-a",
    "query:owner-a",
  ]);
});

test("Codex app-server uses the supplied credential environment without daemon fallback", function() {
  var spec = appServer._test.buildSpawnSpec("/opt/codex", ["app-server"], {
    cwd: "/workspace",
    env: { HOME: "/home/owner-a", PATH: "/usr/bin" },
  });

  assert.equal(spec.options.env.HOME, "/home/owner-a");
  assert.equal(spec.options.env.PATH, "/usr/bin");
  assert.deepEqual(Object.keys(spec.options.env).sort(), ["HOME", "PATH"]);
});

test("Codex keeps resolved project values in an OS-isolated app-server environment", function() {
  var resolved = { HOME: "/home/owner-a", USER: "owner-a", PROJECT_TOKEN: "resolved" };
  var env = require("../lib/yoke/adapters/codex")._test.runtimeEnvironmentForCodex(
    { env: resolved },
    { uid: 1200, gid: 1200, home: "/home/owner-a", user: "owner-a", shell: "/bin/zsh" }
  );
  assert.equal(env, resolved, "the already-sanitized resolved environment remains authoritative");
  assert.equal(env.PROJECT_TOKEN, "resolved");
});

test("restart recovery forwards the session owner to a resumed Codex query", async function() {
  var captured = null;
  var adapter = {
    vendor: "codex",
    createQuery: async function(queryOpts) {
      captured = queryOpts;
      return { pushMessage: function() {} };
    },
  };
  var sm = {
    modelsByVendor: { codex: [{ value: "gpt-5.6-terra" }] },
    currentModel: "gpt-5.6-terra",
    currentEffort: "medium",
    currentPermissionMode: "default",
    saveSessionFile: function() {},
    broadcastSessionList: function() {},
  };
  var bridge = attachBridgeQueryStart({
    adapters: { codex: adapter },
    adapter: adapter,
    cwd: "/tmp/codex-owner-recovery",
    clayPort: 2633,
    clayTls: false,
    clayAuthToken: "",
    slug: "codex-owner-recovery",
    sm: sm,
    send: function() {},
    sendToSession: function() {},
    sendAndRecord: function() {},
    onProcessingChanged: function() {},
    ensureLinuxUserProjectDir: function() {},
    getFreshAuthState: function() { return { codex: true }; },
    logAuthDecision: function() {},
    getVendorDisplayName: function() { return "Codex"; },
    getLoginCommand: function() { return "codex login --device-auth"; },
    notifyAuthRequired: function() { return false; },
    copilotRouteIdForModel: function() { return null; },
    getModelsForSession: function() { return [{ value: "gpt-5.6-terra" }]; },
    modelListContains: function() { return true; },
    resolveModelInList: function() { return null; },
    modelEntryValue: function(model) { return model.value; },
    mergeMcpServers: function() { return null; },
    getMcpServers: function() { return {}; },
    getRemoteMcpServers: function() { return {}; },
    handleCanUseTool: function() { return Promise.resolve({ behavior: "allow" }); },
    handleElicitation: function() { return Promise.resolve({ action: "decline" }); },
    handleUserDialog: function() { return Promise.resolve({ action: "cancel" }); },
    processQueryStream: function() { return Promise.resolve(); },
    getRuntimeEnv: function() { return { PROJECT_TOKEN: "resolved" }; },
  });
  var session = {
    localId: 31,
    storageId: "restart-owner-session",
    cliSessionId: "persisted-codex-thread",
    vendor: "codex",
    history: [],
    permissionMode: "default",
  };

  await bridge.startQuery(session, "continue", null, "owner-a");

  assert.equal(captured.linuxUser, "owner-a");
  assert.equal(captured.resumeSessionId, "persisted-codex-thread");
  assert.deepEqual(captured.env, { PROJECT_TOKEN: "resolved" });
  assert.ok(captured.adapterOptions.CODEX.sandboxMode);
});

test("fresh auth checks are cached separately for each credential home", function() {
  var yoke = require("../lib/yoke");
  var originalCheckAuth = yoke.checkAuth;
  var originalInvalidateAuthCache = yoke.invalidateAuthCache;
  var calls = [];
  yoke.checkAuth = function(opts) {
    calls.push(opts.linuxUser || "daemon");
    return { codex: true };
  };
  yoke.invalidateAuthCache = function() { calls.push("invalidate"); };
  try {
    var auth = attachBridgeAuth({ getNotificationsModule: function() { return null; } });
    auth.getFreshAuthState(false, "owner-a");
    auth.getFreshAuthState(false, "owner-b");
    auth.getFreshAuthState(false, "owner-a");
    auth.getFreshAuthState(true, "owner-a");
    assert.deepEqual(calls, ["owner-a", "owner-b", "invalidate", "owner-a"]);
  } finally {
    yoke.checkAuth = originalCheckAuth;
    yoke.invalidateAuthCache = originalInvalidateAuthCache;
  }
});

test("remote device-login completion delegates refresh with the matching credential owner", async function() {
  var yoke = require("../lib/yoke");
  var originalCheckInstalled = yoke.checkInstalled;
  var calls = [];
  yoke.checkInstalled = function() { return { codex: true }; };
  try {
    var handoff = attachProjectSessionsHandoff({
      cwd: "/tmp/codex-device-login",
      slug: "codex-device-login",
      adapters: { codex: {} },
      sdk: {
        refreshVendor: async function(vendor, linuxUser) {
          calls.push({ type: "refresh", vendor: vendor, linuxUser: linuxUser });
        },
      },
      sm: { defaultVendor: "codex", modelsByVendor: {}, sessions: new Map() },
      sendTo: function() {},
      sendToSession: function() {},
      usersModule: { isMultiUser: function() { return false; } },
      getSessionForWs: function() { return { vendor: "codex" }; },
      cancelScheduledMessage: function() {},
      clearPendingQueuedMessages: function() {},
      sendConfigForSession: function() {},
    });
    handoff.handleHandoffMessage({ _clayUser: { linuxUser: "owner-a" } }, { type: "refresh_vendors" });
    await new Promise(function(resolve) { setImmediate(resolve); });
    assert.deepEqual(calls, [
      { type: "refresh", vendor: "codex", linuxUser: "owner-a" },
    ]);
  } finally {
    yoke.checkInstalled = originalCheckInstalled;
  }
});

test("Codex title and rewind helpers retain the session credential owner", async function() {
  var titleOpts = null;
  var renameOpts = null;
  var forkOpts = null;
  var rollbackOpts = null;
  var adapter = {
    vendor: "codex",
    generateTitle: function(messages, opts) {
      titleOpts = opts;
      return Promise.resolve("Owned title");
    },
    renameSession: function(threadId, title, opts) {
      renameOpts = opts;
      return Promise.resolve();
    },
    forkSession: function(threadId, opts) {
      forkOpts = opts;
      return Promise.resolve({ sessionId: "forked-thread" });
    },
    rollbackThread: function(threadId, turns, opts) {
      rollbackOpts = opts;
      return Promise.resolve();
    },
  };
  var session = {
    localId: 41,
    cliSessionId: "owned-thread",
    history: [{ type: "user_message", text: "Title this task" }],
  };
  var titles = attachAutoTitle({
    cwd: "/tmp/codex-owned-title",
    sm: { saveSessionFile: function() {}, broadcastSessionList: function() {} },
    getAdapterForSession: function() { return adapter; },
    getLinuxUserForSession: function() { return "owner-a"; },
  });
  titles.autoGenerateTitle(session);
  await new Promise(function(resolve) { setImmediate(resolve); });
  var rewind = attachBridgeRewind({
    cwd: "/tmp/codex-owned-rewind",
    sendAndRecord: function() {},
    getAdapterForSession: function() { return adapter; },
    getLinuxUserForSession: function() { return "owner-a"; },
  });
  await rewind.rollbackConversation(session, 1);
  await rewind.forkSession(session, "message-id");

  assert.equal(titleOpts.linuxUser, "owner-a");
  assert.equal(renameOpts.linuxUser, "owner-a");
  assert.equal(rollbackOpts.linuxUser, "owner-a");
  assert.equal(forkOpts.linuxUser, "owner-a");
});
