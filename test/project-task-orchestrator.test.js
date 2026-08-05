var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var attachTaskOrchestrator = require("../lib/project-task-orchestrator").attachTaskOrchestrator;
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;

function testContext(existingSessions, options) {
  options = options || {};
  var sessions = existingSessions || new Map();
  var nextId = 2;
  var events = [];
  var starts = [];
  var pushes = [];
  var sm = {
    sessions: sessions,
    defaultVendor: "claude",
    getProjectId: function () { return options.projectId || null; },
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
    crossProject: options.crossProject || null,
    slug: options.slug || "clay",
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
    usersModule: options.usersModule,
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
  assert.equal(ctx.api.proposeSessionAdoption(source, parent, { intent: "worker" }), true);
  assert.equal(source.orchestrationAdoption.status, "proposed");
  assert.equal(source.orchestrationAdoption.intent, "worker");
  assert.match(parent.pendingCoordinatorUpdates[0].text, /existing-session/);
  assert.match(parent.pendingCoordinatorUpdates[0].text, /race is in resume handling/);
  assert.match(parent.pendingCoordinatorUpdates[0].text, /do not classify it as context only or unrelated/);

  parent.isProcessing = false;
  var rejected = ctx.api.adoptFromTool({
    coordinatorSessionId: parent.storageId,
    sourceSessionId: source.storageId,
    action: "context_only",
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /offered this session as a worker/);
  assert.equal(source.orchestrationAdoption.status, "proposed");

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
});

test("workers spawned under Coop inherit explicit control provenance", function () {
  var ctx = testContext(undefined, {
    usersModule: {
      getLeadMode: function () { return true; },
    },
  });
  var parent = coordinator(ctx);
  parent.coopHome = true;

  ctx.api.delegateFromTool(brief(parent));

  var worker = ctx.starts[0].session;
  assert.deepEqual(worker.coopControlledBy, {
    coopSessionStorageId: parent.storageId,
    since: worker.coopControlledBy.since,
  });
  assert.equal(typeof worker.coopControlledBy.since, "number");
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

test("Coop creates one direct leaf in the target project and promotes it without overlap", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-execution-"));
  var targetProjectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var target = testContext(undefined, { projectId: targetProjectId, crossProject: router });
  router.registerProjectResolver({
    getProjectId: function () { return targetProjectId; },
    deliverCrossProjectEnvelope: target.api.deliverCrossProjectEnvelope,
  });
  var lead = testContext(undefined, { projectId: "system-lead", crossProject: router });
  var coop = coordinator(lead);
  coop.coopHome = true;
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: lead.api.deliverCrossProjectEnvelope,
  });
  var directInput = {
    coordinatorSessionId: coop.storageId,
    portfolioTaskId: "portfolio-slice-7",
    bindingRevision: 1,
    idempotencyKey: "create-direct-leaf",
    mode: "direct_leaf",
    targetProject: { projectId: targetProjectId },
    title: "Bounded target task",
    objective: "Implement the bounded target-project change.",
    context: "The work has no local dependencies.",
    acceptanceCriteria: "The focused test passes.",
    ownedPaths: "lib/target.js",
  };

  var first = lead.api.coordinateExternalTask(directInput);
  var replay = lead.api.coordinateExternalTask(directInput);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.sessionRef, first.sessionRef);
  assert.equal(target.sessions.size, 1);
  assert.equal(target.starts.length, 1);
  assert.equal(lead.sessions.size, 1);
  assert.equal(lead.starts.length, 0);
  var leaf = Array.from(target.sessions.values())[0];
  assert.equal(leaf.coordinationMode, false);
  assert.match(target.starts[0].prompt, /Do not delegate/);
  var delegate = target.api.delegateFromTool(Object.assign(brief(leaf), {
    coordinatorSessionId: leaf.storageId,
  }));
  assert.equal(delegate.isError, true);
  assert.match(delegate.content[0].text, /cannot delegate/);
  var progress = target.api.reportFromTool({
    workerSessionId: leaf.storageId,
    taskId: "portfolio-slice-7",
    activity: "Running target-project checks",
    progress: 45,
  });
  assert.equal(progress.isError, undefined);
  assert.equal(leaf.orchestrationPolicy.portfolioExecution.progress, 45);
  assert.equal(leaf.orchestrationPolicy.portfolioExecution.currentActivity,
    "Running target-project checks");
  assert.equal(lead.starts.length, 1);
  assert.match(lead.starts[0].prompt, /Clay direct-leaf progress/);

  leaf.queryInstance = {};
  var message = router.messageProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: coop.storageId },
    portfolioTaskId: "portfolio-slice-7",
    bindingRevision: 1,
    idempotencyKey: "direct-message-1",
    text: "Verify the restart case too.",
  });
  assert.equal(message.ok, true);
  assert.equal(target.pushes.length, 1);
  assert.equal(target.pushes[0].session, leaf);
  assert.equal(router.messageProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: coop.storageId },
    portfolioTaskId: "portfolio-slice-7",
    bindingRevision: 1,
    idempotencyKey: "direct-message-1",
    text: "Verify the restart case too.",
  }).ok, true);
  assert.equal(target.pushes.length, 1);
  leaf.history.push({
    type: "delta",
    text: "WORKER_STATUS: needs_input\nREASON: scope_expansion\n" +
      "SUMMARY: The task now needs coordinated integration.\n" +
      "VERIFICATION: scope boundary reviewed\nESCALATION_REQUIRED: yes",
  });
  leaf.isProcessing = false;
  leaf._subscriber({ type: "done" });
  assert.equal(leaf.orchestrationPolicy.portfolioExecution.status, "needs_input");
  assert.equal(leaf.orchestrationPolicy.portfolioExecution.reason, "scope_expansion");
  assert.equal(lead.starts.length, 1);
  assert.equal(lead.starts[0].session, coop);
  assert.match(coop.pendingCoordinatorUpdates[0].text, /Clay direct-leaf update/);

  var promoted = lead.api.coordinateExternalTask(Object.assign({}, directInput, {
    bindingRevision: 2,
    idempotencyKey: "promote-to-coordinator",
    mode: "project_coordinator",
    reason: "scope_expansion",
    title: "Target project coordinator",
    objective: "Coordinate the expanded target-project effort.",
  }));
  assert.equal(promoted.ok, true);
  assert.equal(leaf.isProcessing, false);
  assert.equal(leaf.orchestrationPolicy.portfolioExecution.status, "superseded");
  assert.equal(target.sessions.size, 2);
  var projectCoordinator = Array.from(target.sessions.values()).find(function (session) {
    return session.coordinationMode;
  });
  assert.ok(projectCoordinator);
  assert.equal(projectCoordinator.orchestrationPolicy.portfolioExecution.status, "running");
  assert.equal(router.getExecutionBinding("portfolio-slice-7").mode, "project_coordinator");
  assert.equal(lead.sessions.size, 1);
  var localDelegation = target.api.delegateFromTool(Object.assign(brief(projectCoordinator), {
    coordinatorSessionId: projectCoordinator.storageId,
  }));
  assert.equal(localDelegation.isError, undefined);
  var localWorker = Array.from(target.sessions.values()).find(function (session) {
    return session.orchestrationParent &&
      session.orchestrationParent.sessionStorageId === projectCoordinator.storageId;
  });
  assert.ok(localWorker);
  assert.equal(target.sessions.size, 3);
  assert.equal(lead.sessions.size, 1);

  var afterRestart = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  afterRestart.registerProjectResolver({
    getProjectId: function () { return targetProjectId; },
    deliverCrossProjectEnvelope: function () {
      assert.fail("a committed binding replay must not create another target session");
    },
  });
  var restartedReplay = afterRestart.createProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: coop.storageId },
    portfolioTaskId: "portfolio-slice-7",
    bindingRevision: 2,
    idempotencyKey: "promote-to-coordinator",
    mode: "project_coordinator",
    targetProject: { projectId: targetProjectId },
    objective: "Coordinate the expanded target-project effort.",
  });
  assert.equal(restartedReplay.ok, true);
  assert.equal(restartedReplay.reused, true);
  assert.equal(target.sessions.size, 3);
});

test("a reviewing target execution blocks an ordinary replacement revision", function () {
  var projectId = "55f216da-1d17-5c92-a283-11fe13c6e3f2";
  var sessions = new Map();
  var reviewingLeaf = {
    localId: 41,
    storageId: "reviewing-project-leaf",
    title: "Reviewing project leaf",
    history: [],
    isProcessing: false,
    coordinationMode: false,
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "portfolio-reviewing-leaf",
        bindingRevision: 1,
        idempotencyKey: "reviewing-original",
        mode: "direct_leaf",
        status: "reviewing",
      },
    },
  };
  sessions.set(reviewingLeaf.localId, reviewingLeaf);
  var target = testContext(sessions, { projectId: projectId });

  var result = target.api.deliverCrossProjectEnvelope({
    schema: "clay.project_execution_command",
    schemaVersion: 1,
    eventId: "replace-reviewing-execution",
    source: { projectId: "system-lead", sessionStorageId: "coop" },
    destination: { projectId: projectId, sessionStorageId: "project-execution-control" },
    bindingRevision: 2,
    createdAt: 1,
    payload: {
      type: "portfolio_execution_create",
      portfolioTaskId: "portfolio-reviewing-leaf",
      bindingRevision: 2,
      idempotencyKey: "reviewing-replacement",
      mode: "direct_leaf",
      targetProject: { projectId: projectId },
      title: "Replacement leaf",
      objective: "Replace an execution only after it reaches a terminal state.",
    },
  });

  assert.deepEqual(result, { ok: false, reason: "active_binding_exists" });
  assert.equal(sessions.size, 1);
  assert.equal(target.starts.length, 0);
  assert.equal(reviewingLeaf.orchestrationPolicy.portfolioExecution.status, "reviewing");
  assert.equal(reviewingLeaf.taskStopRequested, undefined);
});

test("target-project routing failure never falls back to a Lead-local worker", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-route-fail-"));
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var lead = testContext(undefined, { projectId: "system-lead", crossProject: router });
  var coop = coordinator(lead);
  coop.coopHome = true;
  var result = lead.api.coordinateExternalTask({
    coordinatorSessionId: coop.storageId,
    portfolioTaskId: "portfolio-no-target",
    bindingRevision: 1,
    idempotencyKey: "missing-target-command",
    mode: "direct_leaf",
    targetProject: { projectId: "ffb5f2d1-9aac-5735-ae17-42ca99de7d8f" },
    title: "Must not run in Lead",
    objective: "Run only in the unavailable target project.",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "project_unavailable");
  assert.equal(lead.sessions.size, 1);
  assert.equal(lead.starts.length, 0);
  assert.equal(router.getExecutionBindings().length, 0);
});

test("delegate tool routes a typed binding into the target project without a Lead-local worker", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-tool-route-"));
  var targetProjectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var target = testContext(undefined, { projectId: targetProjectId, crossProject: router });
  router.registerProjectResolver({
    getProjectId: function () { return targetProjectId; },
    deliverCrossProjectEnvelope: target.api.deliverCrossProjectEnvelope,
  });
  var lead = testContext(undefined, { projectId: "system-lead", crossProject: router });
  var coop = coordinator(lead);
  coop.coopHome = true;

  var result = lead.api.delegateFromTool({
    coordinatorSessionId: coop.storageId,
    portfolioTaskId: "portfolio-tool-route",
    bindingRevision: 1,
    idempotencyKey: "staff-portfolio-tool-route-r1",
    mode: "project_coordinator",
    targetProject: { projectId: targetProjectId },
    title: "Canonical project coordinator",
    objective: "Coordinate the bounded target-project implementation.",
    context: "Coop owns integration while project work stays in the target project.",
    acceptanceCriteria: "The target owns the execution and Lead owns no worker.",
    ownedPaths: "lib/target.js and focused tests",
    provider: "codex",
    model: "gpt-5.6-terra",
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Started project-owned project_coordinator/);
  assert.equal(lead.sessions.size, 1);
  assert.equal(lead.starts.length, 0);
  assert.equal(coop.orchestrationTasks.length, 0);
  assert.equal(target.sessions.size, 1);
  assert.equal(target.starts.length, 1);
  var binding = router.getExecutionBinding("portfolio-tool-route", 1);
  assert.equal(binding.targetProject.projectId, targetProjectId);
  assert.equal(binding.mode, "project_coordinator");
  assert.ok(binding.coordinator);
});

test("an explicitly selected target coordinator is bound and reused without selecting an unrelated chat", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-existing-coordinator-"));
  var projectId = "d8af2cc1-ea08-5b4c-82e6-e729d3a7dcef";
  var sessions = new Map();
  var existing = {
    localId: 9,
    storageId: "existing-project-coordinator",
    title: "Existing project coordinator",
    coordinationMode: true,
    orchestrationTasks: [],
    orchestrationEvents: [],
    orchestrationPolicy: {},
    history: [],
    isProcessing: false,
  };
  var unrelated = {
    localId: 10,
    storageId: "recent-unrelated-coordinator",
    title: "Unrelated",
    coordinationMode: true,
    orchestrationTasks: [],
    orchestrationEvents: [],
    history: [],
    lastActivity: 999,
  };
  sessions.set(existing.localId, existing);
  sessions.set(unrelated.localId, unrelated);
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var target = testContext(sessions, { projectId: projectId, crossProject: router });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: target.api.deliverCrossProjectEnvelope,
  });
  var input = {
    source: { projectId: "system-lead", sessionStorageId: "coop" },
    portfolioTaskId: "portfolio-existing-coordinator",
    bindingRevision: 1,
    idempotencyKey: "bind-existing-coordinator",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
    targetCoordinator: { projectId: projectId, sessionStorageId: existing.storageId },
    title: "Coordinate existing effort",
    objective: "Own the existing project effort.",
  };

  var result = router.createProjectExecution(input);
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.sessionStorageId, existing.storageId);
  assert.equal(sessions.size, 2);
  assert.equal(target.starts[0].session, existing);
  assert.equal(unrelated.orchestrationPolicy, undefined);
  assert.deepEqual(router.createProjectExecution(input).sessionRef, result.sessionRef);
  assert.equal(target.starts.length, 1);
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
  assert.ok(task.archivedAt);
  assert.equal(worker.hidden, true);
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

test("coordinator dismisses obsolete work with a durable reason", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var worker = ctx.starts[0].session;
  task.status = "needs_input";
  worker.isProcessing = false;

  var result = ctx.api.dismissFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
    reason: "A newer worker already covered the same implementation.",
  });

  assert.equal(result.isError, undefined);
  assert.equal(task.status, "dismissed");
  assert.equal(task.resolutionReason, "A newer worker already covered the same implementation.");
  assert.ok(task.resolvedAt);
  assert.equal(worker.hidden, true);
  assert.equal(worker.taskStopRequested, true);
  assert.equal(parent.orchestrationTasks.length, 1);
});

test("coordinator records one precise user decision and resumes it on the answer", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var worker = ctx.starts[0].session;
  task.status = "needs_input";
  worker.isProcessing = false;

  var result = ctx.api.requestInputFromTool({
    coordinatorSessionId: parent.storageId,
    taskIds: [task.taskId],
    question: "Should the compatibility shim remain enabled?",
    reason: "Both behaviors are valid product choices.",
  });

  assert.equal(result.isError, undefined);
  assert.equal(task.status, "waiting_user");
  assert.equal(task.userQuestion, "Should the compatibility shim remain enabled?");
  assert.equal(task.waitingReason, "Both behaviors are valid product choices.");

  var directive = ctx.api.resumeWaitingCoordinator(parent, "Remove the shim.");

  assert.match(directive, /compatibility shim/);
  assert.equal(task.status, "reviewing");
  assert.ok(task.userAnsweredAt);
});

test("coordinator cannot record two different pending user decisions", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.planFromTool({
    coordinatorSessionId: parent.storageId,
    tasks: [{
      ref: "first", title: "Choose storage", objective: "Choose storage", ownedPaths: "read-only: storage",
    }, {
      ref: "second", title: "Choose rollout", objective: "Choose rollout", ownedPaths: "read-only: rollout",
    }],
  });
  var first = parent.orchestrationTasks[0];
  var second = parent.orchestrationTasks[1];
  ctx.starts[0].session.isProcessing = false;
  ctx.starts[1].session.isProcessing = false;
  first.status = "needs_input";
  second.status = "needs_input";

  var firstResult = ctx.api.requestInputFromTool({
    coordinatorSessionId: parent.storageId,
    taskIds: [first.taskId],
    question: "Use local or hosted storage?",
    reason: "This changes the product boundary.",
  });
  var secondResult = ctx.api.requestInputFromTool({
    coordinatorSessionId: parent.storageId,
    taskIds: [second.taskId],
    question: "Roll out now or next week?",
    reason: "This changes the release date.",
  });

  assert.equal(firstResult.isError, undefined);
  assert.equal(secondResult.isError, true);
  assert.match(secondResult.content[0].text, /one user decision is already pending/);
  assert.equal(second.status, "needs_input");
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
  assert.equal(failedWorker.hidden, true);
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
  assert.equal(parent.orchestrationTasks.length, 1);
  assert.equal(parent.orchestrationTasks[0].status, "dismissed");
  assert.equal(parent.orchestrationTasks[0].resolutionReason, "Dismissed by user");
  assert.equal(parent.coordinationMode, true);
  assert.equal(ctx.sessions.has(workerId), true);
  assert.equal(ctx.sessions.get(workerId).hidden, true);
  assert.equal(ctx.sessions.get(workerId).taskStopRequested, true);
  var taskStateEvent = ctx.events.findLast(function (entry) {
    return entry.event && entry.event.type === "orchestration_tasks_state";
  });
  assert.equal(taskStateEvent.event.tasks.length, 1);
  assert.equal(taskStateEvent.event.tasks[0].status, "dismissed");
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
  assert.equal(worker.hidden, true);
  assert.ok(parent.orchestrationTasks[0].archivedAt);
});

test("startup archives terminal and safe orphan workers without touching active or Lead workers", function () {
  var sessions = new Map();
  var terminalWorker = {
    localId: 1,
    storageId: "worker-terminal",
    isProcessing: false,
    history: [],
    orchestrationParent: { taskId: "task-terminal", sessionStorageId: "parent-terminal" },
  };
  var terminalParent = {
    localId: 2,
    storageId: "parent-terminal",
    hidden: true,
    history: [],
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-terminal",
      status: "completed",
      workerStorageId: "worker-terminal",
    }],
  };
  var reviewingWorker = {
    localId: 3,
    storageId: "worker-reviewing",
    isProcessing: false,
    history: [],
    orchestrationParent: { taskId: "task-reviewing", sessionStorageId: "parent-reviewing" },
  };
  var reviewingParent = {
    localId: 4,
    storageId: "parent-reviewing",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-reviewing",
      status: "reviewing",
      workerStorageId: "worker-reviewing",
    }],
  };
  var waitingWorker = {
    localId: 5,
    storageId: "worker-waiting",
    isProcessing: false,
    history: [],
    orchestrationParent: { taskId: "task-waiting", sessionStorageId: "parent-waiting" },
  };
  var waitingParent = {
    localId: 6,
    storageId: "parent-waiting",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-waiting",
      status: "waiting_user",
      userQuestion: "Choose a release channel.",
      workerStorageId: "worker-waiting",
    }],
  };
  var runningWorker = {
    localId: 11,
    storageId: "worker-running",
    isProcessing: true,
    history: [],
    orchestrationParent: { taskId: "task-running", sessionStorageId: "parent-running" },
  };
  var runningParent = {
    localId: 12,
    storageId: "parent-running",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-running",
      status: "running",
      workerStorageId: "worker-running",
    }],
  };
  var needsInputWorker = {
    localId: 13,
    storageId: "worker-needs-input",
    isProcessing: false,
    history: [],
    orchestrationParent: { taskId: "task-needs-input", sessionStorageId: "parent-needs-input" },
  };
  var needsInputParent = {
    localId: 14,
    storageId: "parent-needs-input",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-needs-input",
      status: "needs_input",
      workerStorageId: "worker-needs-input",
    }],
  };
  var failedWorker = {
    localId: 15,
    storageId: "worker-failed",
    isProcessing: false,
    history: [{ type: "done" }],
    orchestrationParent: { taskId: "task-failed", sessionStorageId: "parent-failed" },
  };
  var failedParent = {
    localId: 16,
    storageId: "parent-failed",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-failed",
      status: "failed",
      workerStorageId: "worker-failed",
    }],
  };
  var orphanWorker = {
    localId: 7,
    storageId: "worker-orphan",
    isProcessing: false,
    history: [{ type: "delta", text: "orphan transcript" }],
    orchestrationParent: { taskId: "task-orphan", sessionStorageId: "missing-parent" },
  };
  var emptyHistoryOrphan = {
    localId: 17,
    storageId: "worker-empty-orphan",
    isProcessing: false,
    history: [],
    orchestrationParent: { taskId: "task-empty-orphan", sessionStorageId: "missing-parent" },
  };
  var interruptedOrphan = {
    localId: 18,
    storageId: "worker-interrupted-orphan",
    isProcessing: false,
    workerStatus: "interrupted",
    history: [{ type: "delta", text: "The worker was interrupted." }],
    orchestrationParent: { taskId: "task-interrupted-orphan", sessionStorageId: "missing-parent" },
  };
  var activeOrphan = {
    localId: 8,
    storageId: "worker-active-orphan",
    isProcessing: true,
    history: [],
    orchestrationParent: { taskId: "task-active-orphan", sessionStorageId: "missing-parent" },
  };
  var leadWorker = {
    localId: 9,
    storageId: "worker-lead-terminal",
    isProcessing: false,
    history: [],
    orchestrationParent: {
      taskId: "task-lead-terminal",
      sessionStorageId: "parent-lead",
      workerColor: "legacy-color",
    },
  };
  var leadParent = {
    localId: 10,
    storageId: "parent-lead",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-lead-terminal",
      status: "completed",
      workerStorageId: "worker-lead-terminal",
      workerColor: "new-color",
    }],
  };
  var leadDirectLeaf = {
    localId: 19,
    storageId: "lead-direct-leaf",
    history: [],
    isProcessing: false,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "portfolio-lead-direct-leaf",
        bindingRevision: 1,
        idempotencyKey: "lead-direct-leaf",
        mode: "direct_leaf",
        status: "completed",
      },
    },
  };
  sessions.set(terminalParent.localId, terminalParent);
  sessions.set(terminalWorker.localId, terminalWorker);
  sessions.set(reviewingParent.localId, reviewingParent);
  sessions.set(reviewingWorker.localId, reviewingWorker);
  sessions.set(waitingParent.localId, waitingParent);
  sessions.set(waitingWorker.localId, waitingWorker);
  sessions.set(runningParent.localId, runningParent);
  sessions.set(runningWorker.localId, runningWorker);
  sessions.set(needsInputParent.localId, needsInputParent);
  sessions.set(needsInputWorker.localId, needsInputWorker);
  sessions.set(failedParent.localId, failedParent);
  sessions.set(failedWorker.localId, failedWorker);
  sessions.set(orphanWorker.localId, orphanWorker);
  sessions.set(emptyHistoryOrphan.localId, emptyHistoryOrphan);
  sessions.set(interruptedOrphan.localId, interruptedOrphan);
  sessions.set(activeOrphan.localId, activeOrphan);

  testContext(sessions);

  assert.equal(terminalWorker.hidden, true);
  assert.ok(terminalParent.orchestrationTasks[0].archivedAt);
  assert.equal(reviewingWorker.hidden, undefined);
  assert.equal(waitingWorker.hidden, undefined);
  assert.equal(runningWorker.hidden, undefined);
  assert.equal(needsInputWorker.hidden, undefined);
  assert.equal(failedWorker.hidden, undefined);
  assert.equal(failedParent.orchestrationTasks[0].archivedAt, undefined);
  assert.equal(orphanWorker.hidden, true);
  assert.equal(emptyHistoryOrphan.hidden, undefined);
  assert.equal(interruptedOrphan.hidden, undefined);
  assert.equal(activeOrphan.hidden, undefined);

  var archiveEventCount = terminalParent.orchestrationEvents.length;
  testContext(sessions);
  assert.equal(terminalParent.orchestrationEvents.length, archiveEventCount);

  var leadSessions = new Map([
    [leadParent.localId, leadParent],
    [leadWorker.localId, leadWorker],
    [leadDirectLeaf.localId, leadDirectLeaf],
  ]);
  testContext(leadSessions, { slug: "lead" });
  assert.equal(leadWorker.hidden, undefined);
  assert.equal(leadParent.orchestrationTasks[0].archivedAt, undefined);
  assert.equal(leadWorker.orchestrationParent.workerColor, "legacy-color");
  assert.equal(leadDirectLeaf.hidden, undefined);
});

test("completed direct leaves hide live and on startup while attention states remain visible", function () {
  function directLeaf(status, localId) {
    return {
      localId: localId,
      storageId: "direct-leaf-" + status + "-" + localId,
      history: [],
      isProcessing: false,
      coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
      orchestrationPolicy: {
        portfolioExecution: {
          portfolioTaskId: "portfolio-direct-" + status + "-" + localId,
          bindingRevision: 1,
          idempotencyKey: "direct-" + status + "-" + localId,
          mode: "direct_leaf",
          status: status,
        },
      },
    };
  }
  var live = directLeaf("running", 1);
  var reviewing = directLeaf("reviewing", 2);
  testContext(new Map([[live.localId, live], [reviewing.localId, reviewing]]));

  live.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Direct leaf complete.\n" +
      "VERIFICATION: direct leaf test passed\nESCALATION_REQUIRED: no",
  });
  live._subscriber({ type: "done" });

  assert.equal(live.orchestrationPolicy.portfolioExecution.status, "completed");
  assert.equal(live.hidden, true);
  assert.equal(reviewing.hidden, undefined);

  var restartedCompleted = directLeaf("completed", 3);
  var restartedFailed = directLeaf("failed", 4);
  var restarted = testContext(new Map([
    [restartedCompleted.localId, restartedCompleted],
    [restartedFailed.localId, restartedFailed],
  ]));
  assert.equal(restartedCompleted.hidden, true);
  assert.equal(restartedFailed.hidden, undefined);
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
