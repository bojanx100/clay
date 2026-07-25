var test = require("node:test");
var assert = require("node:assert/strict");
var attachProjectSessionsRecords = require("../lib/project-sessions-records").attachProjectSessionsRecords;

function setup(session) {
  var direct = [];
  var sessionMessages = [];
  var hidden = [];
  var sm = {
    sessions: new Map([[session.localId, session]]),
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    hideSession: function (id) { hidden.push(id); },
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
    userPresence: {},
    adapter: {},
    loadContextSources: function () { return []; },
    stopTitleWatcher: function () {},
  });
  return { handler: handler, direct: direct, sessionMessages: sessionMessages, hidden: hidden, sm: sm };
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
