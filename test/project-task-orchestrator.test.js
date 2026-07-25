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
    deleteSession: function (id) {
      sessions.delete(id);
    },
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
    storageId: "coordinator-stable",
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
    coordinatorSessionId: parent.storageId,
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
  assert.match(prompt, /coordinatorSessionId for orchestration tool calls is coordinator-stable/);
  assert.match(prompt, /this is what you asked/);
  assert.match(prompt, /delegate_task/);
});

test("coordinates a queued request in a background worker with parent context", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  parent.isProcessing = true;
  parent.history = [{
    type: "user_message",
    text: "We are fixing the queue behavior.",
  }, {
    type: "delta",
    text: "I am working on the active task.",
  }];

  var task = ctx.api.coordinateQueuedMessage(parent, {
    text: "Add a regression test for background coordination.",
    displayText: "Add a regression test for background coordination.",
  });

  assert.equal(parent.isProcessing, true);
  assert.equal(parent.orchestrationTasks.length, 1);
  assert.equal(task, parent.orchestrationTasks[0]);
  assert.equal(ctx.starts.length, 1);
  assert.notEqual(ctx.starts[0].session, parent);
  assert.match(ctx.starts[0].prompt, /Add a regression test for background coordination/);
  assert.match(ctx.starts[0].prompt, /We are fixing the queue behavior/);
  assert.match(ctx.starts[0].prompt, /I am working on the active task/);
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

test("closing a coordinated task removes its worker conversation", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var workerId = task.workerSessionId;

  var closed = ctx.api.closeTask(parent, task.taskId, null);

  assert.equal(closed, true);
  assert.equal(parent.orchestrationTasks.length, 0);
  assert.equal(ctx.sessions.has(workerId), false);
  assert.deepEqual(ctx.events[ctx.events.length - 1].event.tasks, []);
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
  var worker = {
    localId: 99,
    storageId: "worker-stable",
    isProcessing: true,
    history: [],
  };
  var parent = {
    localId: 17,
    storageId: "parent-stable",
    history: [],
    orchestrationTasks: [{
      taskId: "task-existing",
      title: "Existing task",
      status: "running",
      workerSessionId: 2,
      workerStorageId: "worker-stable",
    }],
  };
  sessions.set(parent.localId, parent);
  sessions.set(worker.localId, worker);

  testContext(sessions);

  assert.equal(typeof worker._subscriber, "function");
  assert.equal(parent.orchestrationTasks[0].workerSessionId, 99);
  assert.equal(worker.orchestrationParent.sessionId, 17);
  assert.equal(worker.orchestrationParent.sessionStorageId, "parent-stable");
});

test("keeps a restart-interrupted worker running until automatic resume completes", function () {
  var sessions = new Map();
  var worker = {
    localId: 22,
    storageId: "worker-restart",
    isProcessing: false,
    interruptedByRestart: true,
    restartResumeEligible: true,
    history: [
      { type: "delta", text: "Partial work" },
      { type: "done", code: 1 },
    ],
  };
  var parent = {
    localId: 11,
    storageId: "parent-restart",
    history: [],
    orchestrationTasks: [{
      taskId: "task-restart",
      title: "Interrupted task",
      status: "running",
      workerSessionId: 4,
      workerStorageId: "worker-restart",
    }],
  };
  sessions.set(parent.localId, parent);
  sessions.set(worker.localId, worker);

  testContext(sessions);

  assert.equal(parent.orchestrationTasks[0].status, "running");
  assert.equal(typeof worker._subscriber, "function");
});

test("does not deliver restored results before the parent restart turn resumes", function () {
  var sessions = new Map();
  var parent = {
    localId: 31,
    storageId: "parent-pending",
    history: [],
    isProcessing: false,
    restartResumeEligible: true,
    coordinationMode: true,
    orchestrationTasks: [],
    pendingCoordinatorUpdates: [{ text: "Worker finished", queuedAt: 1 }],
  };
  sessions.set(parent.localId, parent);

  var ctx = testContext(sessions);

  assert.equal(ctx.starts.length, 0);
  assert.equal(parent.pendingCoordinatorUpdates.length, 1);
});

test("reports a non-resumable interrupted worker as needing input", function () {
  var sessions = new Map();
  var worker = {
    localId: 44,
    storageId: "worker-stale",
    isProcessing: false,
    interruptedByRestart: true,
    history: [{ type: "done", code: 1 }],
  };
  var parent = {
    localId: 43,
    storageId: "parent-stale",
    history: [],
    isProcessing: false,
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-stale",
      title: "Stale interrupted task",
      status: "running",
      workerStorageId: "worker-stale",
    }],
  };
  sessions.set(parent.localId, parent);
  sessions.set(worker.localId, worker);

  var ctx = testContext(sessions);

  assert.equal(parent.orchestrationTasks[0].status, "needs_input");
  assert.equal(ctx.starts.length, 1);
  assert.equal(ctx.starts[0].session, parent);
  assert.match(ctx.starts[0].prompt, /not eligible for automatic resume/);
});
