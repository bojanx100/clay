var test = require("node:test");
var assert = require("node:assert/strict");
var attachProjectSessionsRecords = require("../lib/project-sessions-records").attachProjectSessionsRecords;

function createHarness(sessionList, options) {
  options = options || {};
  var events = [];
  var sessions = new Map();
  var i;
  for (i = 0; i < sessionList.length; i++) sessions.set(sessionList[i].localId, sessionList[i]);

  var sm = {
    sessions: sessions,
    saveSessionFile: function (session) { events.push(["save", session.localId]); },
    broadcastSessionList: function () { events.push(["broadcast"]); },
    setSessionVisibility: function (id, value) {
      sessions.get(id).sessionVisibility = value;
      events.push(["visibility", id, value]);
    },
    setSessionBookmarked: function (id, bookmarked) {
      sessions.get(id).bookmarked = bookmarked;
      events.push(["bookmark", id, bookmarked]);
    },
    reorderBookmarkedSessions: function (sourceId, targetId, insertBefore) {
      events.push(["reorder", sourceId, targetId, insertBefore]);
    },
    hideSession: function (id) {
      events.push(["hide", id]);
      if (sessions.has(id)) sessions.get(id).hidden = true;
    },
    deleteSession: function (id) {
      events.push(["delete", id]);
      sessions.delete(id);
    },
    deleteSessionsBulk: function (ids) {
      events.push(["bulk_delete", ids.slice()]);
      for (var bi = 0; bi < ids.length; bi++) sessions.delete(ids[bi]);
    },
  };

  var usersModule = {
    isMultiUser: function () { return !!options.multiUser; },
    canAccessSession: options.canAccessSession || function () { return true; },
    getEffectivePermissions: options.getEffectivePermissions || function () { return { sessionDelete: true }; },
  };
  var presence = {
    setPresence: function (slug, key, id, value) { events.push(["presence", slug, key, id, value]); },
    clearPresence: function (slug, key) { events.push(["clear_presence", slug, key]); },
  };
  var handler = attachProjectSessionsRecords({
    cwd: "/tmp/records",
    slug: "records",
    osUsers: false,
    sm: sm,
    tm: {
      close: function (id) { events.push(["pty_close", id]); },
    },
    sendTo: function (ws, message) { events.push(["send", message]); },
    sendToSession: function (id, message) { events.push(["send_session", id, message]); },
    usersModule: usersModule,
    userPresence: presence,
    loadContextSources: options.loadContextSources,
    stopTitleWatcher: function (session) { events.push(["title_watcher_stop", session.localId]); },
    adapter: options.adapter || {},
  });
  return { handler: handler, sm: sm, sessions: sessions, events: events };
}

function messagesOf(state, type) {
  return state.events.filter(function (event) {
    return (event[0] === "send" || event[0] === "send_session") && event[1] && event[1].type === type;
  });
}

test("dispatches every records family and rejects invalid or inherited handler names", function () {
  var session = { localId: 1, title: "Record" };
  var state = createHarness([session]);
  var recognized = [
    "demote_session_from_coordinator",
    "set_session_visibility",
    "set_session_bookmark",
    "reorder_session_bookmarks",
    "bulk_delete_sessions",
    "delete_session",
    "hide_session",
    "rename_session",
  ];
  var i;

  assert.equal(state.handler.handleRecordsMessage({}, null), false);
  assert.equal(state.handler.handleRecordsMessage({}, undefined), false);
  assert.equal(state.handler.handleRecordsMessage({}, {}), false);
  assert.equal(state.handler.handleRecordsMessage({}, { type: "unknown_record" }), false);
  assert.equal(state.handler.handleRecordsMessage({}, { type: "constructor" }), false);
  assert.equal(state.handler.handleRecordsMessage({}, { type: "toString" }), false);
  var inherited = Object.create({ type: "unknown_record" });
  assert.equal(state.handler.handleRecordsMessage({}, inherited), false);

  for (i = 0; i < recognized.length; i++) {
    assert.equal(state.handler.handleRecordsMessage({}, { type: recognized[i] }), true);
  }
  assert.equal(state.handler.handleRecordsMessage({}, { type: "set_session_visibility", sessionId: 1 }), true);
  assert.equal(state.events.filter(function (event) { return event[0] === "visibility"; }).length, 0);
});

test("headless lifecycle dispatches visibility, bookmarks, reorder, and coordinator demotion", function () {
  var worker = {
    localId: 3,
    storageId: "worker-records-stable",
    orchestrationParent: { taskId: "active" },
    abortController: { abort: function () {} },
  };
  var coordinator = {
    localId: 2,
    title: "Coordinator",
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "active", status: "running", workerSessionId: 999,
      workerStorageId: "worker-records-stable",
    }],
  };
  var ordinary = { localId: 1, bookmarked: false };
  var favorite = { localId: 4, bookmarked: true, favoriteOrder: 0 };
  var state = createHarness([ordinary, coordinator, worker, favorite]);
  var ws = {};

  assert.equal(state.handler.handleRecordsMessage(ws, {
    type: "set_session_visibility", sessionId: 1, visibility: "shared",
  }), true);
  assert.equal(ordinary.sessionVisibility, "shared");
  assert.equal(state.handler.handleRecordsMessage(ws, {
    type: "set_session_bookmark", sessionId: 1, bookmarked: true,
  }), true);
  assert.equal(ordinary.bookmarked, true);
  assert.equal(state.handler.handleRecordsMessage(ws, {
    type: "reorder_session_bookmarks", sourceId: 1, targetId: 4, insertBefore: false,
  }), true);
  assert.deepEqual(state.events.at(-1), ["reorder", 1, 4, false]);

  assert.equal(state.handler.handleRecordsMessage(ws, {
    type: "demote_session_from_coordinator", sessionId: 2,
  }), true);
  assert.equal(messagesOf(state, "coordinator_demote_required").length, 1);
  assert.equal(state.handler.handleRecordsMessage(ws, {
    type: "demote_session_from_coordinator", sessionId: 2, action: "after",
  }), true);
  assert.equal(coordinator.demoteCoordinatorWhenIdle, true);
  assert.equal(state.handler.handleRecordsMessage(ws, {
    type: "demote_session_from_coordinator", sessionId: 2, action: "cancel",
  }), true);
  assert.equal(coordinator.demoteCoordinatorWhenIdle, false);
  assert.equal(state.handler.handleRecordsMessage(ws, {
    type: "demote_session_from_coordinator", sessionId: 2, action: "stop",
  }), true);
  assert.equal(coordinator.coordinationMode, false);
  assert.equal(state.events.some(function (event) { return event[0] === "hide" && event[1] === 3; }), true);
});

test("multi-user access denial filters bookmarks, reorder, and bulk deletion", function () {
  var denied = { localId: 2, bookmarked: true, favoriteOrder: 1 };
  var allowed = { localId: 1, bookmarked: true, favoriteOrder: 0 };
  var state = createHarness([allowed, denied], {
    multiUser: true,
    canAccessSession: function (userId, session) { return userId === "owner" && session.localId === 1; },
  });
  var ws = { _clayUser: { id: "other" } };

  state.handler.handleRecordsMessage(ws, { type: "set_session_bookmark", sessionId: 1, bookmarked: false });
  state.handler.handleRecordsMessage(ws, { type: "reorder_session_bookmarks", sourceId: 1, targetId: 2 });
  state.handler.handleRecordsMessage(ws, { type: "bulk_delete_sessions", sessionIds: [1, 2] });
  var coordinator = { localId: 4, coordinationMode: true, orchestrationTasks: [] };
  state.sessions.set(coordinator.localId, coordinator);
  state.handler.handleRecordsMessage(ws, { type: "demote_session_from_coordinator", sessionId: 4 });
  assert.equal(state.events.some(function (event) {
    return event[0] === "bookmark" || event[0] === "reorder" || event[0] === "bulk_delete";
  }), false);
  assert.equal(coordinator.coordinationMode, true);
});

test("delete permission denial is reported without cleanup", function () {
  var session = { localId: 1, mode: "tui", terminalId: 9 };
  var state = createHarness([session], {
    getEffectivePermissions: function () { return { sessionDelete: false }; },
  });

  assert.equal(state.handler.handleRecordsMessage({ _clayUser: { id: "user" } }, {
    type: "delete_session", id: 1,
  }), true);
  assert.equal(messagesOf(state, "error").length, 1);
  assert.equal(state.sessions.has(1), true);
  assert.equal(state.events.some(function (event) { return event[0] === "pty_close"; }), false);
});

test("Coop home and channel remain permanent through all destructive record messages", function () {
  var home = { localId: 1, coopHome: true };
  var channel = { localId: 2, coopChannel: { projectSlug: "webapp" } };
  var ordinary = { localId: 3, mode: "tui", terminalId: 10 };
  var state = createHarness([home, channel, ordinary]);
  var ws = {};

  state.handler.handleRecordsMessage(ws, { type: "set_session_visibility", sessionId: 1, visibility: "shared" });
  state.handler.handleRecordsMessage(ws, { type: "hide_session", id: 1 });
  state.handler.handleRecordsMessage(ws, { type: "delete_session", id: 2 });
  state.handler.handleRecordsMessage(ws, { type: "bulk_delete_sessions", sessionIds: [1, 2, 3] });
  assert.equal(messagesOf(state, "error").length, 3);
  assert.equal(state.sessions.has(1), true);
  assert.equal(state.sessions.has(2), true);
  assert.equal(state.sessions.has(3), false);
  assert.deepEqual(state.events.filter(function (event) { return event[0] === "bulk_delete"; }), [["bulk_delete", [3]]]);
});

test("hide closes coordinator workers only after confirmation and restores presence context", function () {
  var worker = { localId: 2, orchestrationParent: { taskId: "needs-input" } };
  var coordinator = {
    localId: 1,
    title: "Coordinator",
    coordinationMode: true,
    orchestrationTasks: [{ taskId: "needs-input", status: "needs_input", workerSessionId: 2 }],
  };
  var state = createHarness([coordinator, worker], {
    loadContextSources: function () { return ["fallback-source"]; },
  });
  var ws = { _clayActiveSession: 1, _clayUser: { id: "owner" } };

  state.handler.handleRecordsMessage(ws, { type: "hide_session", id: 1 });
  assert.equal(messagesOf(state, "coordinator_close_required").length, 1);
  assert.equal(state.events.some(function (event) { return event[0] === "hide"; }), false);
  state.handler.handleRecordsMessage(ws, { type: "hide_session", id: 1, closeWorkers: true });
  assert.equal(coordinator.orchestrationTasks[0].status, "cancelled");
  assert.deepEqual(state.events.filter(function (event) { return event[0] === "hide"; }), [["hide", 2], ["hide", 1]]);
  assert.deepEqual(state.events.at(-2), ["presence", "records", "owner", 1, null]);
  assert.deepEqual(state.events.at(-1), ["send", { type: "context_sources_state", active: ["fallback-source"] }]);
});

test("hide clears presence when no active session remains", function () {
  var session = { localId: 1 };
  var state = createHarness([session]);

  state.handler.handleRecordsMessage({}, { type: "hide_session", id: 1 });
  assert.deepEqual(state.events.at(-1), ["clear_presence", "records", "_default"]);
});

test("single and bulk delete stop PTYs and title watchers before records", function () {
  var single = { localId: 1, mode: "tui", terminalId: 11 };
  var bulk = { localId: 2, mode: "tui", terminalId: 12 };
  var state = createHarness([single, bulk]);
  var ws = {};

  state.handler.handleRecordsMessage(ws, { type: "delete_session", id: 1 });
  assert.deepEqual(state.events.slice(0, 3), [["pty_close", 11], ["title_watcher_stop", 1], ["delete", 1]]);
  state.handler.handleRecordsMessage(ws, { type: "bulk_delete_sessions", sessionIds: [2] });
  assert.deepEqual(state.events.slice(3), [["pty_close", 12], ["title_watcher_stop", 2], ["bulk_delete", [2]]]);
});

test("rename truncates, persists, broadcasts, and contains SDK failures", async function () {
  var session = { localId: 1, title: "Old", cliSessionId: "sdk-1" };
  var renameCalls = [];
  var state = createHarness([session], {
    adapter: {
      renameSession: function (id, title, options) {
        renameCalls.push([id, title, options]);
        return Promise.reject(new Error("SDK unavailable"));
      },
    },
  });
  var title = "x".repeat(140);

  assert.equal(state.handler.handleRecordsMessage({}, { type: "rename_session", id: 1, title: title }), true);
  assert.equal(session.title.length, 100);
  assert.equal(session.titleManuallySet, true);
  assert.deepEqual(renameCalls, [["sdk-1", title.substring(0, 100), { dir: "/tmp/records" }]]);
  assert.deepEqual(state.events.slice(0, 2), [["save", 1], ["broadcast"]]);
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(state.sessions.has(1), true);
});
