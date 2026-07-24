var test = require("node:test");
var assert = require("node:assert/strict");
var attachTaskOrchestrator = require("../lib/project-task-orchestrator").attachTaskOrchestrator;

function testContext() {
  var sessions = new Map();
  var nextId = 2;
  var events = [];
  var starts = [];
  var sm = {
    sessions: sessions,
    defaultVendor: "claude",
    createSessionRaw: function (opts) {
      var session = Object.assign({
        localId: nextId++,
        history: [],
        isProcessing: false,
      }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    appendToSessionFile: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    subscribeSession: function (id, cb) {
      sessions.get(id)._subscriber = cb;
    },
  };
  var api = attachTaskOrchestrator({
    sm: sm,
    sdk: {
      startQuery: function (session, prompt) {
        starts.push({ session: session, prompt: prompt });
      },
    },
    sendToSession: function (id, event) {
      events.push({ id: id, event: event });
    },
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () {},
  });
  return { sm: sm, sessions: sessions, events: events, starts: starts, api: api };
}

test("starts a queued message as a tracked worker session", function () {
  var ctx = testContext();
  var parent = {
    localId: 1,
    title: "Coordinator",
    vendor: "codex",
    model: "gpt-test",
    orchestrationTasks: [],
  };
  ctx.sessions.set(parent.localId, parent);

  var result = ctx.api.startTask(parent, {
    text: "Review the reconnect logic",
    displayText: "Review the reconnect logic",
  }, null);

  assert.ok(result.taskId.indexOf("task-") === 0);
  assert.equal(parent.orchestrationTasks.length, 1);
  assert.equal(parent.orchestrationTasks[0].status, "running");
  assert.equal(parent.orchestrationTasks[0].provider, "codex");
  assert.equal(ctx.starts.length, 1);
  assert.match(ctx.starts[0].prompt, /Complete only the task below/);
  assert.match(ctx.starts[0].prompt, /Review the reconnect logic/);
  assert.equal(ctx.starts[0].session.isProcessing, true);

  ctx.starts[0].session._subscriber({ type: "done" });
  assert.equal(parent.orchestrationTasks[0].status, "completed");
  assert.equal(ctx.events[ctx.events.length - 1].event.type, "orchestration_tasks_state");
});

test("restores a running worker subscription", function () {
  var sessions = new Map();
  var worker = { localId: 2, isProcessing: true };
  var parent = {
    localId: 1,
    orchestrationTasks: [{
      taskId: "task-existing",
      title: "Existing task",
      status: "running",
      workerSessionId: 2,
    }],
  };
  sessions.set(parent.localId, parent);
  sessions.set(worker.localId, worker);
  var sm = {
    sessions: sessions,
    saveSessionFile: function () {},
    subscribeSession: function (id, cb) {
      sessions.get(id)._subscriber = cb;
    },
  };

  attachTaskOrchestrator({
    sm: sm,
    sdk: {},
    sendToSession: function () {},
  });

  assert.equal(typeof worker._subscriber, "function");
  worker._subscriber({ type: "done" });
  assert.equal(parent.orchestrationTasks[0].status, "completed");
});
