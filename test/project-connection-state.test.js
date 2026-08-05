var test = require("node:test");
var assert = require("node:assert/strict");
var state = require("../lib/project-connection-state");

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

test("session-list serialization preserves loop, orchestration, and launcher fields", function () {
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
});
