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
    hideSession: function (id) {
      sessions.get(id).hidden = true;
    },
    subscribeSession: function (id, cb) {
      sessions.get(id)._subscriber = cb;
    },
  };
  var api = attachTaskOrchestrator({
    sm: sm,
    sdk: {
      startQuery: function (session, prompt, images) {
        starts.push({ session: session, prompt: prompt, images: images || null });
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
    loadImagesForSdk: function (refs) {
      return refs.map(function (ref) {
        return { mediaType: ref.mediaType, data: "loaded-" + ref.file };
      });
    },
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

test("coordinates a queued request in a new owned worker without interrupting the parent", function () {
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
  assert.equal(task.status, "running");
  assert.equal(ctx.starts.length, 1);
  assert.notEqual(ctx.starts[0].session, parent);
  assert.match(ctx.starts[0].prompt, /Add a regression test for background coordination/);
  assert.match(ctx.starts[0].prompt, /We are fixing the queue behavior/);
  assert.match(ctx.starts[0].prompt, /I am working on the active task/);
  var launchNotice = ctx.events.find(function (entry) {
    return entry.id === parent.localId && entry.event.type === "system_info";
  });
  assert.ok(launchNotice);
  assert.match(launchNotice.event.text, /Started worker 2/);
  assert.equal(launchNotice.event.orchestrationTaskId, task.taskId);
  assert.equal(launchNotice.event.workerSessionId, 2);
  assert.equal(parent.history[parent.history.length - 1].type, "system_info");
});

test("external coordinator tasks load persisted screenshot references for workers", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  var result = ctx.api.coordinateExternalTask({
    coordinatorSessionId: parent.storageId,
    title: "Live UI issue",
    objective: "Fix the selected control.",
    context: "Masked evidence is attached.",
    acceptanceCriteria: "Verify the fix.",
    ownedPaths: "Selected control.",
    clientRef: "live-ui-report-1",
    imageRefs: [{ mediaType: "image/png", file: "shot.png" }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(ctx.starts[0].images, [{
    mediaType: "image/png",
    data: "loaded-shot.png",
  }]);
});

test("plans independent work in parallel and releases a dependent task", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  var result = ctx.api.planFromTool({
    coordinatorSessionId: parent.storageId,
    tasks: [{
      ref: "a", title: "Implement A", objective: "Implement A", ownedPaths: "lib/a.js",
    }, {
      ref: "b", title: "Test B", objective: "Test B", ownedPaths: "test/b.test.js",
    }, {
      ref: "c", title: "Integrate C", objective: "Integrate A and B",
      dependencies: ["a", "b"], ownedPaths: "lib/integration.js",
    }],
  });

  assert.equal(result.isError, undefined);
  assert.equal(ctx.starts.length, 2);
  assert.equal(parent.orchestrationTasks[2].status, "queued");
  var workerA = ctx.starts[0].session;
  var workerB = ctx.starts[1].session;
  workerA.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: A done.\nVERIFICATION: A acceptance criteria passed.\nESCALATION_REQUIRED: no",
  });
  workerB.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: B done.\nVERIFICATION: B acceptance criteria passed.\nESCALATION_REQUIRED: no",
  });
  workerA.isProcessing = false;
  workerB.isProcessing = false;
  parent.isProcessing = true;
  workerA._subscriber({ type: "done" });
  assert.equal(ctx.starts.length, 2);
  workerB._subscriber({ type: "done" });
  assert.equal(ctx.starts.length, 3);
  assert.equal(ctx.starts[2].session.orchestrationParent.taskId, parent.orchestrationTasks[2].taskId);
  assert.equal(parent.orchestrationTasks[2].status, "running");
});

test("records worker progress on the stable parent task", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var worker = ctx.starts[0].session;
  var result = ctx.api.reportFromTool({
    workerSessionId: worker.storageId,
    taskId: task.taskId,
    activity: "Running reconnect regression tests",
    progress: 60,
  });
  assert.equal(result.isError, undefined);
  assert.equal(task.currentActivity, "Running reconnect regression tests");
  assert.equal(task.progress, 60);
  assert.ok(parent.orchestrationEvents.length >= 3);
});

test("offers an existing session to the coordinator and adopts it as a worker", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  parent.isProcessing = true;
  var source = {
    localId: 9,
    storageId: "existing-session",
    title: "Existing investigation",
    vendor: "codex",
    history: [
      { type: "user_message", text: "Investigate the flaky reconnect test." },
      { type: "delta", text: "The race is in resume handling." },
    ],
    isProcessing: false,
  };
  ctx.sessions.set(source.localId, source);

  var candidates = ctx.api.listAdoptionCoordinators(source);
  assert.equal(candidates[0].id, parent.localId);
  assert.equal(candidates[0].recommended, true);
  assert.equal(ctx.api.proposeSessionAdoption(source, parent), true);
  assert.equal(source.orchestrationAdoption.status, "proposed");
  assert.match(parent.pendingCoordinatorUpdates[0].text, /existing-session/);
  assert.match(parent.pendingCoordinatorUpdates[0].text, /race is in resume handling/);

  parent.isProcessing = false;
  var result = ctx.api.adoptFromTool({
    coordinatorSessionId: parent.storageId,
    sourceSessionId: source.storageId,
    action: "new_task",
    title: "Fix reconnect race",
    objective: "Fix the resume race.",
    acceptanceCriteria: "The flaky test passes.",
    ownedPaths: "lib/resume.js",
    message: "Implement the identified fix and verify the flaky test.",
  });

  assert.equal(result.isError, undefined);
  assert.equal(parent.orchestrationTasks.length, 1);
  assert.equal(parent.orchestrationTasks[0].workerStorageId, source.storageId);
  assert.equal(source.orchestrationParent.taskId, parent.orchestrationTasks[0].taskId);
  assert.equal(source.orchestrationAdoption.status, "adopted");
  assert.equal(ctx.starts[0].session, source);
  assert.match(ctx.starts[0].prompt, /Implement the identified fix/);
});

test("first visible worker delegation promotes an ordinary top-level session", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  parent.coordinationMode = false;

  var result = ctx.api.delegateFromTool(brief(parent));

  assert.equal(result.isError, undefined);
  assert.equal(parent.coordinationMode, true);
  assert.equal(parent.orchestrationTasks.length, 1);
  assert.equal(ctx.starts.length, 1);
  var promotion = ctx.events.find(function (entry) {
    return entry.id === parent.localId && entry.event.type === "coordinator_status";
  });
  assert.ok(promotion);
  assert.equal(promotion.event.coordinationMode, true);
});

test("worker sessions cannot promote themselves and delegate more workers", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  parent.coordinationMode = false;
  parent.orchestrationParent = {
    taskId: "owned-task",
    sessionId: 9,
    sessionStorageId: "owner",
  };

  var result = ctx.api.delegateFromTool(brief(parent));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /worker sessions cannot delegate/);
  assert.equal(parent.coordinationMode, false);
  assert.equal(ctx.starts.length, 0);
});

test("invalid worker briefs do not promote ordinary conversations", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  parent.coordinationMode = false;
  var input = brief(parent);
  input.acceptanceCriteria = "";

  var result = ctx.api.delegateFromTool(input);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /acceptanceCriteria is required/);
  assert.equal(parent.coordinationMode, false);
  assert.equal(ctx.starts.length, 0);
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
    text: "WORKER_STATUS: completed\nSUMMARY: Fixed resume handling.\nVERIFICATION: tests pass\nESCALATION_REQUIRED: no",
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

test("read-only reviewer workers receive an explicit no-mutation boundary", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  var input = brief(parent);
  input.provider = "codex";
  input.title = "Independent Codex review";
  input.objective = "Review the current diff and report only actionable findings.";
  input.ownedPaths = "read-only: current repository diff";

  var result = ctx.api.delegateFromTool(input);

  assert.equal(result.isError, undefined);
  assert.equal(ctx.starts[0].session.vendor, "codex");
  assert.match(ctx.starts[0].prompt, /read-only: current repository diff/);
  assert.match(ctx.starts[0].prompt, /do not modify files or external state/);
});

test("adaptively routes unpinned coordinator work and records the rationale", function () {
  var ctx = testContext();
  ctx.sm.providerRoutes = [{
    id: "claude-anthropic",
    vendor: "claude",
    label: "Claude",
    enabled: true,
    health: "healthy",
  }, {
    id: "codex-openai",
    vendor: "codex",
    label: "Codex",
    enabled: true,
    health: "healthy",
  }];
  ctx.sm.modelsByVendor = {
    claude: ["claude-sonnet-4-6", "claude-opus-4-8"],
    codex: ["gpt-5.6-sol", "gpt-5.6-terra"],
  };
  var parent = coordinator(ctx);
  parent.model = "gpt-5.6-sol";
  var input = brief(parent);
  input.title = "Review reconnect architecture";
  input.objective = "Root cause a cross-cutting reconnect race condition.";

  ctx.api.delegateFromTool(input);

  var task = parent.orchestrationTasks[0];
  assert.equal(task.routingTier, "strong");
  assert.equal(task.provider, "codex");
  assert.equal(task.model, "gpt-5.6-sol");
  assert.equal(task.providerRouteId, "codex-openai");
  assert.match(task.routingRationale, /difficult reasoning/);
  assert.equal(ctx.starts[0].session.providerRouteId, "codex-openai");
});

test("explicit coordinator route pins bypass adaptive routing", function () {
  var ctx = testContext();
  ctx.sm.providerRoutes = [{
    id: "codex-openai",
    vendor: "codex",
    label: "Codex",
    enabled: true,
    health: "healthy",
  }];
  ctx.sm.modelsByVendor = { codex: ["gpt-5.6-sol", "gpt-5.6-terra"] };
  var parent = coordinator(ctx);
  var input = brief(parent);
  input.provider = "codex";
  input.model = "gpt-5.6-terra";

  ctx.api.delegateFromTool(input);

  var task = parent.orchestrationTasks[0];
  assert.equal(task.routingTier, "pinned");
  assert.equal(task.model, "gpt-5.6-terra");
  assert.match(task.routingRationale, /pin constrained routing/);
});

test("does not complete a worker task when the worker only ends with commentary", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var worker = ctx.starts[0].session;
  worker.history.push({
    type: "delta",
    text: "This is a great plan. I can implement it when you are ready.",
  });
  worker.isProcessing = false;

  worker._subscriber({ type: "done" });

  assert.equal(parent.orchestrationTasks[0].status, "needs_input");
  assert.match(parent.orchestrationTasks[0].currentActivity, /Needs coordinator attention/);
  assert.equal(ctx.starts.length, 2);
  assert.match(ctx.starts[1].prompt, /Status: needs_input/);
  assert.match(ctx.starts[1].prompt, /clay-orchestration\/resolve_task/);
});

test("marks verified worker escalation for coordinator review", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var worker = ctx.starts[0].session;
  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Coverage audit finished.\n" +
      "VERIFICATION: 6/14 paths covered\nESCALATION_REQUIRED: yes",
  });
  worker.isProcessing = false;

  worker._subscriber({ type: "done" });

  assert.equal(parent.orchestrationTasks[0].status, "reviewing");
  assert.match(parent.orchestrationTasks[0].currentActivity, /coordinator action required/);
  assert.match(ctx.starts[1].prompt, /Status: reviewing/);
});

test("owning coordinator resolves a needs-input task after independent verification", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var worker = ctx.starts[0].session;
  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: needs_input\nSUMMARY: Partial fix only.\nVERIFICATION: not run\nESCALATION_REQUIRED: yes",
  });
  worker.isProcessing = false;
  worker._subscriber({ type: "done" });
  assert.equal(task.status, "needs_input");

  var result = ctx.api.resolveFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
    summary: "Coordinator finished the reconnect fix and integration.",
    verification: "node --test test/reconnect.test.js passed",
    escalationRequired: "no",
  });

  assert.equal(result.isError, undefined);
  assert.equal(task.status, "completed");
  assert.equal(task.currentActivity, "Completed and verified by coordinator");
  assert.equal(task.progress, 100);
  assert.equal(task.resolvedByCoordinator, true);
  assert.match(task.verification, /reconnect\.test\.js passed/);
});

test("task resolution rejects unverified outcomes and non-owning sessions", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  task.status = "needs_input";

  var unverified = ctx.api.resolveFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
    summary: "Probably done.",
    verification: "not tested",
    escalationRequired: "no",
  });
  assert.equal(unverified.isError, true);
  assert.equal(task.status, "needs_input");

  parent.coordinationMode = false;
  var notOwner = ctx.api.resolveFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
    summary: "Finished.",
    verification: "Regression test passed",
    escalationRequired: "no",
  });
  assert.equal(notOwner.isError, true);
  assert.equal(task.status, "needs_input");
});

test("task resolution refuses to override a running worker", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];

  var result = ctx.api.resolveFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
    summary: "Coordinator says done.",
    verification: "Regression test passed",
    escalationRequired: "no",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /still running/);
  assert.equal(task.status, "running");
});

test("delivers only one terminal update when a worker emits done again", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var worker = ctx.starts[0].session;
  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Finished once.\nVERIFICATION: regression test passed\nESCALATION_REQUIRED: no",
  });
  worker.isProcessing = false;

  worker._subscriber({ type: "done" });
  worker._subscriber({ type: "done" });

  assert.equal(parent.orchestrationTasks[0].status, "completed");
  assert.equal(ctx.starts.length, 2);
  assert.equal(ctx.starts[1].session, parent);
});

test("direct worker follow-up marks its completed parent task running again", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var worker = ctx.starts[0].session;
  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: First pass.\nVERIFICATION: first-pass test passed\nESCALATION_REQUIRED: no",
  });
  worker.isProcessing = false;
  worker._subscriber({ type: "done" });
  assert.equal(parent.orchestrationTasks[0].status, "completed");

  ctx.api.resumeOwnedWorker(worker);

  assert.equal(parent.orchestrationTasks[0].status, "running");
  assert.equal(parent.orchestrationTasks[0].resultSummary, "");
  assert.equal(worker._orchestrationWatcherAttached, true);
});

test("send task message does not restart a completed worker", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var worker = ctx.starts[0].session;
  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Finished once.\n" +
      "VERIFICATION: regression test passed\nESCALATION_REQUIRED: no",
  });
  worker.isProcessing = false;
  worker._subscriber({ type: "done" });

  var result = ctx.api.messageFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
    message: "Please finalize now.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already completed/);
  assert.equal(task.status, "completed");
  assert.equal(ctx.starts.length, 2);
});

test("retrying a completed task reuses its idle worker conversation", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var worker = ctx.starts[0].session;
  var workerId = worker.localId;
  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: First pass.\n" +
      "VERIFICATION: first-pass tests passed\nESCALATION_REQUIRED: no",
  });
  worker.isProcessing = false;
  worker._subscriber({ type: "done" });
  var sessionCount = ctx.sessions.size;

  var result = ctx.api.retryFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
  });

  assert.match(result.content[0].text, /existing worker session/);
  assert.equal(ctx.sessions.size, sessionCount);
  assert.equal(task.workerSessionId, workerId);
  assert.equal(task.attempt, 2);
  assert.equal(task.status, "running");
  assert.equal(task.resultSummary, "");
  assert.equal(task.verification, "");
  assert.equal(worker.orchestrationParent.taskId, task.taskId);
  assert.equal(worker._orchestrationTaskClosed, undefined);
  assert.equal(worker._orchestrationWatcherAttached, true);
  assert.equal(ctx.starts.at(-1).session, worker);
  assert.match(worker.history.at(-1).text, /Retry this task in the same worker conversation/);
  var retryEvent = parent.orchestrationEvents.findLast(function (event) {
    return event.type === "task_retry_requested";
  });
  assert.equal(retryEvent.data.reusedWorkerSessionId, workerId);

  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Second pass.\n" +
      "VERIFICATION: second-pass tests passed\nESCALATION_REQUIRED: no",
  });
  worker.isProcessing = false;
  worker._subscriber({ type: "done" });
  assert.equal(task.status, "completed");

  ctx.api.retryFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
  });

  assert.equal(ctx.sessions.size, sessionCount);
  assert.equal(task.workerSessionId, workerId);
  assert.equal(task.attempt, 3);
  assert.equal(ctx.starts.at(-1).session, worker);
  var retryPrompts = worker.history.filter(function (item) {
    return item.type === "user_message" &&
      String(item.text || "").indexOf("Retry this task in the same worker conversation") !== -1;
  });
  assert.equal(retryPrompts.length, 2);
});

test("retrying a failed task starts a fresh worker conversation", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var failedWorker = ctx.starts[0].session;
  failedWorker.history.push({
    type: "delta",
    text: "WORKER_STATUS: failed\nSUMMARY: Provider failed.\n" +
      "VERIFICATION: retry required\nESCALATION_REQUIRED: no",
  });
  failedWorker.isProcessing = false;
  failedWorker._subscriber({ type: "done" });
  assert.equal(task.status, "failed");

  var result = ctx.api.retryFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
  });

  var freshWorker = ctx.starts.at(-1).session;
  assert.match(result.content[0].text, /Retry scheduled/);
  assert.notEqual(freshWorker, failedWorker);
  assert.notEqual(task.workerSessionId, failedWorker.localId);
  assert.equal(task.workerSessionId, freshWorker.localId);
  assert.equal(task.attempt, 2);
  assert.equal(task.status, "running");
  assert.equal(failedWorker.orchestrationParent, null);
  assert.equal(failedWorker._orchestrationTaskClosed, true);
});

test("retrying a completed task can explicitly request an independent worker", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var firstWorker = ctx.starts[0].session;
  firstWorker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: First opinion.\n" +
      "VERIFICATION: review completed\nESCALATION_REQUIRED: no",
  });
  firstWorker.isProcessing = false;
  firstWorker._subscriber({ type: "done" });

  ctx.api.retryFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
    freshSession: true,
  });

  var independentWorker = ctx.starts.at(-1).session;
  assert.notEqual(independentWorker, firstWorker);
  assert.equal(task.workerSessionId, independentWorker.localId);
  assert.equal(firstWorker.orchestrationParent, null);
  assert.equal(firstWorker._orchestrationTaskClosed, true);
});

test("closing a coordinated task stops and archives its worker conversation", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var workerId = task.workerSessionId;

  var closed = ctx.api.closeTask(parent, task.taskId, null);

  assert.equal(closed, true);
  assert.equal(parent.orchestrationTasks.length, 0);
  assert.equal(parent.coordinationMode, false);
  assert.equal(ctx.sessions.has(workerId), true);
  assert.equal(ctx.sessions.get(workerId).hidden, true);
  assert.equal(ctx.sessions.get(workerId).taskStopRequested, true);
  var taskStateEvent = ctx.events.findLast(function (entry) {
    return entry.event && entry.event.type === "orchestration_tasks_state";
  });
  assert.deepEqual(taskStateEvent.event.tasks, []);
});

test("holds worker results while the coordinator is busy", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var worker = ctx.starts[0].session;
  parent.isProcessing = true;
  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Done.\nVERIFICATION: task checks passed\nESCALATION_REQUIRED: no",
  });
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

test("restores completed worker ownership for sidebar nesting", function () {
  var sessions = new Map();
  var worker = {
    localId: 88,
    storageId: "worker-completed",
    isProcessing: false,
    history: [],
    orchestrationParent: {
      taskId: "task-completed",
      sessionId: 2,
      sessionStorageId: "parent-completed",
    },
  };
  var parent = {
    localId: 19,
    storageId: "parent-completed",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-completed",
      title: "Completed task",
      status: "completed",
      workerSessionId: 2,
      workerStorageId: "worker-completed",
    }],
  };
  sessions.set(parent.localId, parent);
  sessions.set(worker.localId, worker);

  testContext(sessions);

  assert.equal(parent.orchestrationTasks[0].workerSessionId, 88);
  assert.equal(worker.orchestrationParent.sessionId, 19);
  assert.equal(worker.orchestrationParent.sessionStorageId, "parent-completed");
  assert.equal(worker._subscriber, undefined);
});

test("repairs a persisted needs-input task from a verified split worker result", function () {
  var sessions = new Map();
  var worker = {
    localId: 91,
    storageId: "worker-split-result",
    isProcessing: false,
    history: [
      { type: "user_message", text: "Finish the task." },
      { type: "delta", text: "I am confirming the branch before handoff." },
      { type: "tool_start", id: "tool-1", name: "Bash" },
      { type: "tool_result", id: "tool-1", content: "clean" },
      { type: "delta", text: "WORKER_STATUS: completed\n" },
      { type: "delta", text: "SUMMARY: The fix is pushed.\n" },
      { type: "delta", text: "VERIFICATION: focused tests and build passed\n" },
      { type: "delta", text: "ESCALATION_REQUIRED: no" },
      { type: "done", code: 0 },
    ],
  };
  var parent = {
    localId: 92,
    storageId: "parent-split-result",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-split-result",
      title: "Persist annotation tags on first save",
      status: "needs_input",
      workerStorageId: "worker-split-result",
      resultSummary: "handoff.WORKER_STATUS: completed",
    }],
  };
  sessions.set(parent.localId, parent);
  sessions.set(worker.localId, worker);

  testContext(sessions);

  assert.equal(parent.orchestrationTasks[0].status, "completed");
  assert.match(parent.orchestrationTasks[0].resultSummary, /handoff\.\nWORKER_STATUS: completed/);
  assert.equal(parent.orchestrationTasks[0].verification, "focused tests and build passed");
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
