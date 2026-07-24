var test = require("node:test");
var assert = require("node:assert/strict");
var attachTaskOrchestrator = require("../lib/project-task-orchestrator").attachTaskOrchestrator;

function testContext(existingSessions) {
  var sessions = existingSessions || new Map();
  var nextId = 2;
  var events = [];
  var starts = [];
  var pushes = [];
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
      pushMessage: function (session, prompt) {
        pushes.push({ session: session, prompt: prompt });
      },
    },
    sendToSession: function (id, event) {
      events.push({ id: id, event: event });
    },
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () {},
  });
  return {
    sm: sm,
    sessions: sessions,
    events: events,
    starts: starts,
    pushes: pushes,
    api: api,
  };
}

function coordinator(ctx) {
  var parent = {
    localId: 1,
    title: "Coordinator",
    vendor: "codex",
    model: "gpt-test",
    history: [],
    orchestrationTasks: [],
    isProcessing: false,
    coordinationMode: true,
  };
  ctx.sessions.set(parent.localId, parent);
  return parent;
}

function brief(parent) {
  return {
    coordinatorSessionId: parent.localId,
    title: "Review reconnect logic",
    objective: "Find and fix the reconnect regression.",
    context: "The parent has already isolated the issue to resume handling.",
    acceptanceCriteria: "Tests pass and reconnect happens once.",
    ownedPaths: "lib/reconnect.js and its tests",
  };
}

test("activates the current session as coordinator with the queued request", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  parent.coordinationMode = false;

  var prompt = ctx.api.activateCoordinator(parent, "this is what you asked");

  assert.equal(parent.coordinationMode, true);
  assert.match(prompt, /coordinatorSessionId for orchestration tool calls is 1/);
  assert.match(prompt, /this is what you asked/);
  assert.match(prompt, /delegate_task/);
});

test("rejects delegation from a session that is not the coordinator", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  parent.coordinationMode = false;

  var result = ctx.api.delegateFromTool(brief(parent));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /non-coordinator/);
});

test("starts a worker from a complete coordinator brief and returns its result", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);

  var result = ctx.api.delegateFromTool(brief(parent));

  assert.equal(result.isError, undefined);
  assert.equal(parent.orchestrationTasks.length, 1);
  assert.equal(parent.orchestrationTasks[0].status, "running");
  assert.equal(parent.orchestrationTasks[0].provider, "codex");
  assert.equal(ctx.starts.length, 1);
  assert.match(ctx.starts[0].prompt, /Find and fix the reconnect regression/);
  assert.match(ctx.starts[0].prompt, /resume handling/);
  assert.match(ctx.starts[0].prompt, /Tests pass and reconnect happens once/);
  assert.match(ctx.starts[0].prompt, /lib\/reconnect.js and its tests/);

  var worker = ctx.starts[0].session;
  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Fixed resume handling.\nVERIFICATION: tests pass",
  });
  worker.isProcessing = false;
  worker._subscriber({ type: "done" });

  assert.equal(parent.orchestrationTasks[0].status, "completed");
  assert.equal(parent.isProcessing, true);
  assert.equal(ctx.starts.length, 2);
  assert.equal(ctx.starts[1].session, parent);
  assert.match(ctx.starts[1].prompt, /Fixed resume handling/);
  assert.match(ctx.starts[1].prompt, /You own this result/);
});

test("holds worker results while the coordinator is busy", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var worker = ctx.starts[0].session;
  parent.isProcessing = true;
  worker.history.push({ type: "delta", text: "WORKER_STATUS: completed\nSUMMARY: Done." });
  worker.isProcessing = false;

  worker._subscriber({ type: "done" });

  assert.equal(parent.pendingCoordinatorUpdates.length, 1);
  assert.equal(ctx.api.flushCoordinatorUpdates(parent), false);
  parent.isProcessing = false;
  assert.equal(ctx.api.flushCoordinatorUpdates(parent), true);
  assert.equal(ctx.starts.length, 2);
});

test("runs a queued coordinator update after the worker turn", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var worker = ctx.starts[0].session;

  var result = ctx.api.messageFromTool({
    coordinatorSessionId: parent.localId,
    taskId: task.taskId,
    message: "Also verify the recovery canary.",
  });
  assert.match(result.content[0].text, /Queued the update/);

  worker.isProcessing = false;
  worker._subscriber({ type: "done" });

  assert.equal(ctx.starts.length, 2);
  assert.equal(ctx.starts[1].session, worker);
  assert.match(ctx.starts[1].prompt, /verify the recovery canary/);
  assert.equal(task.status, "running");
});

test("restores a running worker subscription", function () {
  var sessions = new Map();
  var worker = { localId: 2, isProcessing: true, history: [] };
  var parent = {
    localId: 1,
    history: [],
    orchestrationTasks: [{
      taskId: "task-existing",
      title: "Existing task",
      status: "running",
      workerSessionId: 2,
    }],
  };
  sessions.set(parent.localId, parent);
  sessions.set(worker.localId, worker);

  testContext(sessions);

  assert.equal(typeof worker._subscriber, "function");
});
