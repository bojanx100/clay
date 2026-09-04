var test = require("node:test");
var assert = require("node:assert/strict");
var attachProjectSessionsRecords = require("../lib/project-sessions-records").attachProjectSessionsRecords;

function setup(session) {
  var direct = [];
  var sessionMessages = [];
  var hidden = [];
  var deleted = [];
  var bulkDeleted = [];
  var sm = {
    sessions: new Map([[session.localId, session]]),
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    hideSession: function (id) { hidden.push(id); },
    deleteSession: function (id) { deleted.push(id); },
    deleteSessionsBulk: function (ids) { bulkDeleted.push(ids.slice()); },
  };
  var handler = attachProjectSessionsRecords({
    cwd: process.cwd(),
    slug: "test",
    osUsers: false,
    sm: sm,
    tm: {},
    sendTo: function (ws, msg) { direct.push(msg); },
    sendToSession: function (id, msg) { sessionMessages.push({ id: id, msg: msg }); },
    usersModule: {
      isMultiUser: function () { return false; },
    },
    userPresence: {
      clearPresence: function () {},
    },
    adapter: {},
    loadContextSources: function () { return []; },
    stopTitleWatcher: function () {},
  });
  return { handler: handler, direct: direct, sessionMessages: sessionMessages, hidden: hidden, deleted: deleted, bulkDeleted: bulkDeleted, sm: sm };
}

test("an idle coordinator demotes immediately without losing task history", function () {
  var completedTask = { taskId: "done", status: "completed" };
  var session = {
    localId: 12,
    coordinationMode: true,
    orchestrationTasks: [completedTask],
  };
  var state = setup(session);

  state.handler.handleRecordsMessage({}, {
    type: "demote_session_from_coordinator",
    sessionId: session.localId,
  });

  assert.equal(session.coordinationMode, false);
  assert.deepEqual(session.orchestrationTasks, [completedTask]);
  assert.equal(state.hidden.length, 0);
  assert.equal(state.sessionMessages.at(-1).msg.coordinationMode, false);
});

test("an active coordinator can wait, cancel, or stop workers before demotion", function () {
  var worker = {
    localId: 13,
    orchestrationParent: { taskId: "active", sessionId: 12 },
    abortController: { abort: function () { worker.aborted = true; } },
  };
  var task = { taskId: "active", status: "running", workerSessionId: worker.localId };
  var session = {
    localId: 12,
    title: "Owner",
    coordinationMode: true,
    orchestrationTasks: [task],
  };
  var state = setup(session);
  state.sm.sessions.set(worker.localId, worker);

  state.handler.handleRecordsMessage({}, {
    type: "demote_session_from_coordinator",
    sessionId: session.localId,
  });
  assert.equal(state.direct.at(-1).type, "coordinator_demote_required");

  state.handler.handleRecordsMessage({}, {
    type: "demote_session_from_coordinator",
    sessionId: session.localId,
    action: "after",
  });
  assert.equal(session.demoteCoordinatorWhenIdle, true);
  assert.equal(session.coordinationMode, true);

  state.handler.handleRecordsMessage({}, {
    type: "demote_session_from_coordinator",
    sessionId: session.localId,
    action: "cancel",
  });
  assert.equal(session.demoteCoordinatorWhenIdle, false);

  state.handler.handleRecordsMessage({}, {
    type: "demote_session_from_coordinator",
    sessionId: session.localId,
    action: "stop",
  });
  assert.equal(session.coordinationMode, false);
  assert.equal(task.status, "cancelled");
  assert.equal(worker.aborted, true);
  assert.deepEqual(state.hidden, [worker.localId]);
});

test("closing a coordinator archives completed workers without cancelling their results", function () {
  var worker = {
    localId: 13,
    orchestrationParent: { taskId: "completed", sessionId: 12 },
  };
  var task = { taskId: "completed", status: "completed", workerSessionId: worker.localId };
  var session = {
    localId: 12,
    title: "Owner",
    coordinationMode: true,
    orchestrationTasks: [task],
  };
  var state = setup(session);
  state.sm.sessions.set(worker.localId, worker);

  state.handler.handleRecordsMessage({}, {
    type: "hide_session",
    id: session.localId,
  });

  assert.deepEqual(state.hidden, [worker.localId, session.localId]);
  assert.equal(worker.orchestrationParent, null);
  assert.equal(task.status, "completed");
});

test("closing a coordinator asks before archiving a worker that needs attention", function () {
  var worker = {
    localId: 13,
    orchestrationParent: { taskId: "needs-attention", sessionId: 12 },
  };
  var task = { taskId: "needs-attention", status: "needs_input", workerSessionId: worker.localId };
  var session = {
    localId: 12,
    title: "Owner",
    coordinationMode: true,
    orchestrationTasks: [task],
  };
  var state = setup(session);
  state.sm.sessions.set(worker.localId, worker);

  state.handler.handleRecordsMessage({}, {
    type: "hide_session",
    id: session.localId,
  });

  assert.equal(state.direct.at(-1).type, "coordinator_close_required");
  assert.equal(state.direct.at(-1).atRiskWorkerCount, 1);
  assert.deepEqual(state.hidden, []);

  state.handler.handleRecordsMessage({}, {
    type: "hide_session",
    id: session.localId,
    closeWorkers: true,
  });

  assert.deepEqual(state.hidden, [worker.localId, session.localId]);
  assert.equal(worker.orchestrationParent, null);
  assert.equal(task.status, "cancelled");
});

test("record handlers reject hide, delete, and bulk-delete of the Coop home", function () {
  var home = { localId: 12, title: "Coop", coopHome: true };
  var ordinary = { localId: 13, title: "Ordinary" };
  var state = setup(home);
  state.sm.sessions.set(ordinary.localId, ordinary);

  state.handler.handleRecordsMessage({}, { type: "hide_session", id: home.localId });
  assert.match(state.direct.at(-1).text, /cannot be hidden/);
  state.handler.handleRecordsMessage({}, { type: "delete_session", id: home.localId });
  assert.match(state.direct.at(-1).text, /cannot be deleted/);
  state.handler.handleRecordsMessage({}, {
    type: "bulk_delete_sessions",
    sessionIds: [home.localId, ordinary.localId],
  });

  assert.deepEqual(state.hidden, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.bulkDeleted, [[ordinary.localId]]);
});
