var test = require("node:test");
var assert = require("node:assert/strict");
var state = require("../lib/project-connection-state");
var attachSessionBroadcast = require("../lib/sessions-broadcast").attachSessionBroadcast;

function restoreOptions(overrides) {
  var sessions = new Map([
    [1, { localId: 1, storageId: "storage-one", cliSessionId: "cli-one", lastActivity: 1 }],
    [2, { localId: 2, storageId: "storage-two", cliSessionId: "cli-two", lastActivity: 2 }],
    [3, { localId: 3, storageId: "storage-three", cliSessionId: "cli-three", lastActivity: 3 }],
  ]);
  var options = {
    sessions: sessions,
    allSessions: Array.from(sessions.values()),
    requestedSessionId: null,
    storedPresence: null,
    usersModule: { canAccessSession: function () { return true; } },
    multiUser: false,
    user: null,
  };
  return Object.assign(options, overrides || {});
}

test("requested local, storage, and CLI ids outrank stored presence and recency", function () {
  var requestedLocal = state.findRestoredActiveSession(restoreOptions({
    requestedSessionId: "2",
    storedPresence: { sessionId: 3 },
  }));
  assert.equal(requestedLocal.active.localId, 2);

  var requestedStorage = state.findRestoredActiveSession(restoreOptions({
    requestedSessionId: "storage-one",
    storedPresence: { sessionId: 3 },
  }));
  assert.equal(requestedStorage.active.localId, 1);

  var requestedCli = state.findRestoredActiveSession(restoreOptions({
    requestedSessionId: "cli-two",
    storedPresence: { sessionId: 1 },
  }));
  assert.equal(requestedCli.active.localId, 2);
});

test("exact requested ids do not fall back to presence or recency on miss", function () {
  var missing = state.findRestoredActiveSession(restoreOptions({
    requestedSessionId: "missing-storage-id",
    requestedSessionExact: true,
    storedPresence: { sessionId: 1 },
  }));
  assert.equal(missing.active, null);
  assert.equal(missing.exactMiss, true);

  var denied = state.findRestoredActiveSession({
    sessions: new Map([[9, { localId: 9, storageId: "private-storage", lastActivity: 100 }]]),
    allSessions: [{ localId: 11, storageId: "public-storage", lastActivity: 1 }],
    requestedSessionId: "private-storage",
    requestedSessionExact: true,
    storedPresence: { sessionId: 11 },
    usersModule: { canAccessSession: function () { return false; } },
    multiUser: true,
    user: { id: "user" },
  });
  assert.equal(denied.active, null);
  assert.equal(denied.exactMiss, true);
});

test("Lead defaults to Coop home while exact reference navigation keeps the requested session", function () {
  var home = { localId: 1, storageId: "coop-home", cliSessionId: "coop-cli", coopHome: true, lastViewedAt: 1 };
  var worker = { localId: 2, storageId: "legacy-worker", cliSessionId: "worker-cli", lastViewedAt: 99 };
  var sessions = new Map([[home.localId, home], [worker.localId, worker]]);
  var options = {
    sessions: sessions,
    allSessions: [home, worker],
    requestedSessionId: "legacy-worker",
    requestedSessionExact: false,
    canonicalCoopHome: true,
    storedPresence: { sessionId: worker.localId },
    usersModule: { canAccessSession: function () { return true; } },
    multiUser: false,
    user: null,
  };

  assert.equal(state.findRestoredActiveSession(options).active, home);

  var exact = state.findRestoredActiveSession(Object.assign({}, options, {
    requestedSessionExact: true,
  }));
  assert.equal(exact.active, worker);
});

test("stored presence is the fallback before recency, including CLI ids", function () {
  var restored = state.findRestoredActiveSession(restoreOptions({
    storedPresence: { sessionId: "cli-one" },
  }));
  assert.equal(restored.active.localId, 1);
  assert.deepEqual(restored.storedPresence, { sessionId: "cli-one" });
});

test("hidden, inaccessible, and owned sessions are rejected", function () {
  var hidden = { localId: 8, hidden: true, lastActivity: 100 };
  var inaccessible = { localId: 9, lastActivity: 90 };
  var owned = { localId: 10, ownerId: "owner", lastActivity: 80 };
  var publicSession = { localId: 11, lastActivity: 1 };
  var sessions = new Map([[8, hidden], [9, inaccessible], [10, owned], [11, publicSession]]);
  var inaccessibleRestore = state.findRestoredActiveSession({
    sessions: sessions,
    allSessions: [publicSession],
    requestedSessionId: "9",
    storedPresence: null,
    usersModule: { canAccessSession: function () { return false; } },
    multiUser: true,
    user: { id: "user" },
  });
  assert.equal(inaccessibleRestore.active, publicSession);

  var hiddenRestore = state.findRestoredActiveSession({
    sessions: sessions,
    allSessions: [publicSession],
    requestedSessionId: "8",
    storedPresence: null,
    usersModule: { canAccessSession: function () { return true; } },
    multiUser: false,
    user: null,
  });
  assert.equal(hiddenRestore.active, publicSession);

  var singleUser = state.findRestoredActiveSession({
    sessions: sessions,
    allSessions: [],
    requestedSessionId: "10",
    storedPresence: null,
    usersModule: { canAccessSession: function () { return true; } },
    multiUser: false,
    user: null,
  });
  assert.equal(singleUser.active, null);
  assert.deepEqual(state.visibleSessions([hidden, inaccessible, owned], {
    usersModule: { canAccessSession: function (userId, session) { return session !== inaccessible; } },
    multiUser: true,
    user: { id: "user" },
  }), [owned], "hidden and inaccessible sessions do not enter the restore candidate list");
});

test("recency uses viewed time when any session was viewed, otherwise activity", function () {
  var activity = state.findRestoredActiveSession(restoreOptions({
    allSessions: [
      { localId: 1, lastActivity: 20 },
      { localId: 2, lastActivity: 30 },
    ],
  }));
  assert.equal(activity.active.localId, 2);

  var viewed = state.findRestoredActiveSession(restoreOptions({
    allSessions: [
      { localId: 1, lastActivity: 100, lastViewedAt: 10 },
      { localId: 2, lastActivity: 200, lastViewedAt: 5 },
      { localId: 3, lastActivity: 1, lastViewedAt: 20 },
    ],
  }));
  assert.equal(viewed.active.localId, 3);
});

test("ordinary project restore never selects an internal session omitted from the sidebar", function () {
  var internal = {
    localId: 1,
    storageId: "internal-crafting",
    lastViewedAt: 100,
    loop: { loopId: "loop-1", role: "crafting", source: "autoplan" },
  };
  var visible = { localId: 2, storageId: "visible-session", lastViewedAt: 10 };
  var sessions = new Map([[1, internal], [2, visible]]);
  var ordinary = state.findRestoredActiveSession(restoreOptions({
    sessions: sessions,
    allSessions: [internal, visible],
    requestedSessionId: internal.storageId,
    storedPresence: { sessionId: internal.localId },
  }));
  assert.equal(ordinary.active, visible);

  var exact = state.findRestoredActiveSession(restoreOptions({
    sessions: sessions,
    allSessions: [internal, visible],
    requestedSessionId: internal.storageId,
    requestedSessionExact: true,
  }));
  assert.equal(exact.active, internal, "an explicit durable conversation link remains authoritative");
});

test("vendor, route, and Codex fallback model selection is deterministic", function () {
  var codex = state.selectInitialModelState({
    active: { vendor: "codex", providerRouteId: "codex-openai", requestedModel: "missing-model" },
    sessionManager: { defaultVendor: "claude", modelsByVendor: { codex: [] }, availableModels: [] },
  });
  assert.equal(codex.vendor, "codex");
  assert.equal(codex.route.id, "codex-openai");
  assert.equal(codex.model, "gpt-5.6-sol");
  assert.equal(codex.models[0].value, "gpt-5.6-sol");

  var copilot = state.selectInitialModelState({
    active: { vendor: "github-copilot", providerRouteId: "claude-github-copilot", model: "claude-sonnet-4.6" },
    sessionManager: { defaultVendor: "claude", modelsByVendor: {}, availableModels: ["local-model"] },
  });
  assert.equal(copilot.vendor, "github-copilot");
  assert.equal(copilot.model, "claude-sonnet-4.6");
  assert.ok(copilot.models.indexOf("claude-sonnet-4.6") !== -1);
});

test("session-list serialization exposes validated Lead ownership without Coop identifiers", function () {
  var session = {
    localId: 4,
    cliSessionId: "cli-4",
    title: "Worker",
    isProcessing: true,
    lastActivity: 44,
    lastViewedAt: 33,
    loop: { loopId: "loop-4", source: "old" },
    ownerId: "user",
    sessionVisibility: "private",
    bookmarked: true,
    favoriteOrder: 2,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.5",
    mode: "gui",
    terminalId: 5,
    runtimeMode: "tui",
    runtimeTerminalId: 6,
    taskLauncher: { autoLaunch: true, autoKind: "pr", workflowCompleted: true },
    coordinationMode: true,
    orchestrationTasks: [{ taskId: "task-4", status: "running" }],
    coopControlledBy: { coopSessionStorageId: "coop-home-private", since: 123 },
  };
  var record = state.serializeSessionListEntry(session, {
    restoredActive: session,
    activeSessionId: null,
    loopRegistry: { getById: function () { return { name: "Nightly", source: "schedule" }; } },
    orchestrationGroups: {},
  });
  assert.deepEqual(record.loop, { loopId: "loop-4", source: "schedule", name: "Nightly" });
  assert.deepEqual(record.taskLauncher, { autoLaunch: true, kind: "pr", completed: true });
  assert.equal(record.active, true);
  assert.equal(record.orchestrationActiveCount, 1);
  assert.equal(record.vendor, "codex");
  assert.equal(record.runtimeTerminalId, 6);
  assert.equal(record.leadOwned, true);
  assert.equal(Object.prototype.hasOwnProperty.call(record, "coopControlledBy"), false);
  assert.equal(JSON.stringify(record).includes("coop-home-private"), false);

  var directRecord = state.serializeSessionListEntry({ localId: 5, coopControlledBy: { coopSessionStorageId: "missing-since" } }, {
    restoredActive: null,
    activeSessionId: null,
    loopRegistry: null,
    orchestrationGroups: {},
  });
  assert.equal(directRecord.leadOwned, false);
});

test("session-list broadcasts expose Lead ownership without Coop identifiers", async function () {
  var messages = [];
  var controlled = {
    localId: 1,
    title: "Lead controlled",
    coopControlledBy: { coopSessionStorageId: "coop-home-private", since: 1 },
  };
  var direct = { localId: 2, title: "Direct" };
  var broadcast = attachSessionBroadcast({
    send: function (message) { messages.push(message); },
    getVisibleSessions: function () { return [controlled, direct]; },
    getActiveSessionId: function () { return 1; },
    getSingleUserUnread: function () { return {}; },
    getEffectiveAutomationMode: function () { return "ask"; },
  });
  broadcast.broadcastSessionList();
  await new Promise(function (resolve) { setTimeout(resolve, 80); });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].sessions.map(function (session) { return session.leadOwned; }), [true, false]);
  assert.equal(JSON.stringify(messages[0]).includes("coop-home-private"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(messages[0].sessions[0], "coopControlledBy"), false);
});
