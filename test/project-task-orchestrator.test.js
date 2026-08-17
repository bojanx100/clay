var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
require("./helpers/isolated-clay-home");
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
  if (options.smState) Object.assign(sm, options.smState);
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

function portfolioSession(ctx, portfolioTaskId) {
  var matches = Array.from(ctx.sessions.values()).filter(function (session) {
    var execution = session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
    return execution && execution.portfolioTaskId === portfolioTaskId;
  });
  matches.sort(function (left, right) {
    return right.orchestrationPolicy.portfolioExecution.bindingRevision -
      left.orchestrationPolicy.portfolioExecution.bindingRevision;
  });
  return matches[0];
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

test("resident project tasks continue exact cross-project coordinators without a local worker", function () {
  var calls = [];
  var dismissals = [];
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var rootId = "lead-clay-root";
  var liveBinding = {
    portfolioTaskId: "watchdog-task", bindingRevision: 1,
    mode: "project_coordinator", targetProject: { projectId: projectId },
    projectCoordinator: { projectId: "system-lead", sessionStorageId: rootId },
    coordinator: { projectId: projectId, sessionStorageId: "watchdog-session" },
  };
  var ctx = testContext(new Map(), {
    projectId: "system-lead",
    slug: "lead",
    crossProject: {
      getExecutionBinding: function () {
        return liveBinding;
      },
      messageProjectExecution: function (input) {
        calls.push(input);
        return { ok: true };
      },
      dismissProjectExecution: function (input) {
        dismissals.push(input);
        return { ok: true };
      },
      registerProjectResolver: function () { return function () {}; },
      reconcileStrandedCompletions: function () {},
    },
  });
  var root = coordinator(ctx);
  root.storageId = rootId;
  root.orchestrationTasks.push({
    taskId: "task-watchdog", clientRef: "portfolio:watchdog-task:1",
    externalTaskCoordinator: true, status: "needs_input",
    coopProjectRef: { projectId: projectId },
    workerSessionRef: { projectId: projectId, sessionStorageId: "watchdog-session" },
    workerStorageId: "watchdog-session",
  });

  liveBinding.coordinator.sessionStorageId = "different-session";
  var refused = ctx.api.messageFromTool({
    coordinatorSessionId: rootId,
    taskId: "task-watchdog",
    message: "This must not route through a mismatched worker reference.",
  });
  assert.equal(refused.isError, true);
  assert.equal(calls.length, 0);
  liveBinding.coordinator.sessionStorageId = "watchdog-session";

  var sent = ctx.api.messageFromTool({
    coordinatorSessionId: rootId,
    taskId: "task-watchdog",
    message: "Poll and reconcile the exact five sessions.",
  });

  assert.equal(sent.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].targetCoordinator,
    { projectId: "system-lead", sessionStorageId: rootId });
  assert.equal(calls[0].portfolioTaskId, "watchdog-task");
  assert.equal(root.orchestrationTasks[0].status, "running");
  assert.equal(root.orchestrationTasks[0].currentActivity,
    "Project task coordinator is continuing");

  var dismissed = ctx.api.dismissFromTool({
    coordinatorSessionId: rootId,
    taskId: "task-watchdog",
    reason: "The watchdog was replaced by the permanent invariant.",
  });
  assert.equal(dismissed.isError, undefined);
  assert.equal(dismissals.length, 1);
  assert.equal(dismissals[0].portfolioTaskId, "watchdog-task");
  assert.equal(root.orchestrationTasks[0].status, "dismissed");
});

test("canonical Coop controls resident project tasks through exact provenance", function () {
  var calls = [];
  var dismissals = [];
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var canonicalId = "871a194b-8879-40f7-a1fe-656e48e722af";
  var residentId = "457f9fa1-7024-40cc-acee-2cef6b2b8445";
  var bindings = {
    "canonical-control": {
      portfolioTaskId: "canonical-control", bindingRevision: 1,
      mode: "project_coordinator", targetProject: { projectId: projectId },
      projectCoordinator: { projectId: "system-lead", sessionStorageId: residentId },
      coordinator: { projectId: projectId, sessionStorageId: "target-control" },
    },
    "canonical-dismiss": {
      portfolioTaskId: "canonical-dismiss", bindingRevision: 1,
      mode: "project_coordinator", targetProject: { projectId: projectId },
      projectCoordinator: { projectId: "system-lead", sessionStorageId: residentId },
      coordinator: { projectId: projectId, sessionStorageId: "target-dismiss" },
    },
    "canonical-mismatch": {
      portfolioTaskId: "canonical-mismatch", bindingRevision: 1,
      mode: "project_coordinator", targetProject: { projectId: "other-project" },
      projectCoordinator: { projectId: "system-lead", sessionStorageId: residentId },
      coordinator: { projectId: projectId, sessionStorageId: "target-mismatch" },
    },
  };
  var ctx = testContext(new Map(), {
    projectId: "system-lead",
    slug: "lead",
    crossProject: {
      getExecutionBinding: function (portfolioTaskId) {
        return bindings[portfolioTaskId] || null;
      },
      messageProjectExecution: function (input) {
        calls.push(input);
        return { ok: true };
      },
      dismissProjectExecution: function (input) {
        dismissals.push(input);
        return { ok: true };
      },
      registerProjectResolver: function () { return function () {}; },
      reconcileStrandedCompletions: function () {},
    },
  });
  var canonical = coordinator(ctx);
  canonical.storageId = canonicalId;
  canonical.coopHome = true;
  var resident = {
    localId: 2,
    storageId: residentId,
    title: "Clay coordinator",
    history: [],
    isProcessing: false,
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: canonicalId, since: 1 },
    orchestrationPolicy: { coopControlPlane: {
      version: 1,
      role: "project_coordinator",
      projectRef: { projectId: projectId },
      createdAt: 1,
    } },
    orchestrationTasks: [{
      taskId: "task-canonical-control",
      clientRef: "portfolio:canonical-control:1",
      externalTaskCoordinator: true,
      status: "needs_input",
      coopProjectRef: { projectId: projectId },
      workerSessionRef: { projectId: projectId, sessionStorageId: "target-control" },
      workerStorageId: "target-control",
    }, {
      taskId: "task-canonical-dismiss",
      clientRef: "portfolio:canonical-dismiss:1",
      externalTaskCoordinator: true,
      status: "needs_input",
      coopProjectRef: { projectId: projectId },
      workerSessionRef: { projectId: projectId, sessionStorageId: "target-dismiss" },
      workerStorageId: "target-dismiss",
    }, {
      taskId: "task-canonical-mismatch",
      clientRef: "portfolio:canonical-mismatch:1",
      externalTaskCoordinator: true,
      status: "needs_input",
      coopProjectRef: { projectId: projectId },
      workerSessionRef: { projectId: projectId, sessionStorageId: "target-mismatch" },
      workerStorageId: "target-mismatch",
    }],
    orchestrationEvents: [],
  };
  var unrelated = {
    localId: 3,
    storageId: "unrelated-coordinator",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [],
  };
  ctx.sessions.set(resident.localId, resident);
  ctx.sessions.set(unrelated.localId, unrelated);

  var sent = ctx.api.messageFromTool({
    coordinatorSessionId: canonicalId,
    taskId: "task-canonical-control",
    message: "Continue the exact resident-owned task.",
  });
  assert.equal(sent.isError, undefined);
  assert.equal(resident.orchestrationTasks[0].status, "running");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].source,
    { projectId: "system-lead", sessionStorageId: residentId });
  assert.deepEqual(calls[0].targetProject, { projectId: projectId });
  assert.deepEqual(calls[0].targetCoordinator,
    { projectId: "system-lead", sessionStorageId: residentId });

  resident.orchestrationTasks[0].status = "completed";
  var retried = ctx.api.retryFromTool({
    coordinatorSessionId: canonicalId,
    taskId: "task-canonical-control",
  });
  assert.equal(retried.isError, undefined);
  assert.equal(resident.orchestrationTasks[0].status, "running");
  assert.equal(calls.length, 2);

  resident.orchestrationTasks[0].status = "needs_input";
  var requested = ctx.api.requestInputFromTool({
    coordinatorSessionId: canonicalId,
    taskIds: ["task-canonical-control"],
    question: "Should the exact project task continue?",
    reason: "The owner must choose between two product outcomes.",
  });
  assert.equal(requested.isError, undefined);
  assert.equal(resident.orchestrationTasks[0].status, "waiting_user");

  var resolved = ctx.api.resolveFromTool({
    coordinatorSessionId: canonicalId,
    taskId: "task-canonical-control",
    summary: "The resident-owned project task was integrated.",
    verification: "Focused control-plane tests passed.",
    escalationRequired: "no",
  });
  assert.equal(resolved.isError, undefined);
  assert.equal(resident.orchestrationTasks[0].status, "completed");

  var dismissed = ctx.api.dismissFromTool({
    coordinatorSessionId: canonicalId,
    taskId: "task-canonical-dismiss",
    reason: "A newer exact project execution superseded this task.",
  });
  assert.equal(dismissed.isError, undefined);
  assert.equal(resident.orchestrationTasks[1].status, "dismissed");
  assert.equal(dismissals.length, 1);
  assert.deepEqual(dismissals[0].source,
    { projectId: "system-lead", sessionStorageId: residentId });

  var mismatched = ctx.api.messageFromTool({
    coordinatorSessionId: canonicalId,
    taskId: "task-canonical-mismatch",
    message: "This mismatched ProjectRef must fail closed.",
  });
  assert.equal(mismatched.isError, true);
  assert.equal(calls.length, 2);

  var stale = ctx.api.messageFromTool({
    coordinatorSessionId: "stale-canonical-session",
    taskId: "task-canonical-control",
    message: "A stale identity must not control the task.",
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /invalid or non-coordinator session id/);

  var unauthorized = ctx.api.messageFromTool({
    coordinatorSessionId: unrelated.storageId,
    taskId: "task-canonical-control",
    message: "An unrelated coordinator must not control the task.",
  });
  assert.equal(unauthorized.isError, true);
  assert.match(unauthorized.content[0].text, /task not found/);
  assert.equal(ctx.sessions.size, 3, "task controls never create a Lead-local worker");
  assert.equal(ctx.starts.length, 0, "task controls route to the exact target project only");
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
    allowLeadSourcedExecution: true,
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
  assert.equal(router.getExecutionBinding("portfolio-slice-7", 1).status, "failed");
  assert.deepEqual(router.bindingStore.listCurrent(), []);
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
  assert.equal(target.sessions.size, 3);
  var projectCoordinator = portfolioSession(target, "portfolio-slice-7");
  assert.ok(projectCoordinator);
  assert.equal(projectCoordinator.orchestrationPolicy.portfolioExecution.status, "running");
  assert.equal(router.getExecutionBinding("portfolio-slice-7").mode, "project_coordinator");
  assert.equal(lead.sessions.size, 1);
  projectCoordinator.isProcessing = false;
  var steer = lead.api.steerProjectCoordinatorFromTool({
    coordinatorSessionId: coop.storageId,
    targetProject: { projectId: targetProjectId },
    targetCoordinator: { projectId: targetProjectId, sessionStorageId: projectCoordinator.storageId },
    portfolioTaskId: "portfolio-slice-7",
    bindingRevision: 2,
    idempotencyKey: "coop-steer-project-coordinator-1",
    message: "Prioritize the restart regression before expanding scope.",
  });
  assert.equal(steer.isError, undefined);
  assert.equal(target.starts.at(-1).session, projectCoordinator);
  var duplicateSteer = lead.api.steerProjectCoordinatorFromTool({
    coordinatorSessionId: coop.storageId,
    targetProject: { projectId: targetProjectId },
    targetCoordinator: { projectId: targetProjectId, sessionStorageId: projectCoordinator.storageId },
    portfolioTaskId: "portfolio-slice-7",
    bindingRevision: 2,
    idempotencyKey: "coop-steer-project-coordinator-1",
    message: "Prioritize the restart regression before expanding scope.",
  });
  assert.equal(duplicateSteer.isError, undefined);
  assert.equal(target.starts.filter(function (entry) { return entry.session === projectCoordinator; }).length, 2);
  var rejectedSteer = lead.api.steerProjectCoordinatorFromTool({
    coordinatorSessionId: coop.storageId,
    targetProject: { projectId: targetProjectId },
    targetCoordinator: { projectId: targetProjectId, sessionStorageId: "wrong-coordinator" },
    portfolioTaskId: "portfolio-slice-7",
    bindingRevision: 2,
    idempotencyKey: "coop-steer-project-coordinator-2",
    message: "This must not reach the wrong coordinator.",
  });
  assert.equal(rejectedSteer.isError, true);
  assert.match(rejectedSteer.content[0].text, /requires attention: coordinator_ref_mismatch/);
  assert.equal(router.getExecutionBinding("portfolio-slice-7", 2).attentionAt > 0, true);
  var recoveredSteer = lead.api.steerProjectCoordinatorFromTool({
    coordinatorSessionId: coop.storageId,
    targetProject: { projectId: targetProjectId },
    targetCoordinator: { projectId: targetProjectId, sessionStorageId: projectCoordinator.storageId },
    portfolioTaskId: "portfolio-slice-7",
    bindingRevision: 2,
    idempotencyKey: "coop-steer-project-coordinator-3",
    message: "Continue after rejecting the stale coordinator reference.",
  });
  assert.equal(recoveredSteer.isError, undefined);
  assert.equal(router.getExecutionBinding("portfolio-slice-7", 2).status, "active");
  assert.equal(router.getExecutionBinding("portfolio-slice-7", 2).attentionAt, undefined,
    "accepted steering clears obsolete attention so running state is truthful");
  target.sm.availableVendors = ["codex"];
  target.sm.installedVendors = [];
  target.sm.providerRoutes = [{
    id: "codex-openai",
    vendor: "codex",
    label: "Codex",
    enabled: false,
    health: "healthy",
    catalogVerified: true,
    catalogSource: "live",
  }];
  target.sm.modelsByVendor = { codex: ["gpt-5.6-sol", "gpt-5.6-terra"] };
  var localDelegation = target.api.delegateFromTool(Object.assign(brief(projectCoordinator), {
    coordinatorSessionId: projectCoordinator.storageId,
    targetProject: { projectId: targetProjectId },
    portfolioTaskId: "portfolio-slice-7",
    bindingRevision: 2,
    idempotencyKey: "project-review-one",
    provider: "codex",
    difficulty: "strong",
    title: "Independent Codex project review",
    objective: "Review the target project and report only actionable findings.",
    ownedPaths: "read-only: current target project",
  }));
  assert.equal(localDelegation.isError, undefined);
  var localWorker = Array.from(target.sessions.values()).find(function (session) {
    return session.orchestrationParent &&
      session.orchestrationParent.sessionStorageId === projectCoordinator.storageId;
  });
  assert.ok(localWorker);
  assert.equal(target.sessions.size, 4);
  assert.equal(lead.sessions.size, 1);
  var localTask = projectCoordinator.orchestrationTasks.find(function (task) {
    return task.clientRef === "project-review-one";
  });
  assert.ok(localTask);
  assert.equal(localTask.routingTier, "pinned");
  assert.equal(localTask.routingCapabilityFloor, 3);
  assert.equal(localTask.provider, "codex");
  assert.equal(localTask.model, "gpt-5.6-terra");
  var reviewStart = target.starts.find(function (entry) {
    return entry.session === localWorker;
  });
  assert.match(reviewStart.prompt, /read-only: current target project/);
  assert.match(reviewStart.prompt, /do not modify files or external state/);

  var parallelPlan = target.api.planFromTool({
    coordinatorSessionId: projectCoordinator.storageId,
    maxParallel: 3,
    tasks: [{
      ref: "parallel-review-a",
      title: "Review bootstrap persistence architecture",
      objective: "Review the bootstrap persistence architecture and report findings only.",
      ownedPaths: "read-only: bootstrap persistence",
      provider: "codex",
      difficulty: "strong",
    }, {
      ref: "parallel-review-b",
      title: "Review typed routing architecture",
      objective: "Review the typed routing architecture and report findings only.",
      ownedPaths: "read-only: typed routing",
      provider: "codex",
      difficulty: "strong",
    }],
  });
  assert.equal(parallelPlan.isError, undefined);
  var parallelTasks = projectCoordinator.orchestrationTasks.filter(function (task) {
    return task.clientRef === "parallel-review-a" || task.clientRef === "parallel-review-b";
  });
  assert.equal(parallelTasks.length, 2);
  assert.deepEqual(parallelTasks.map(function (task) { return task.status; }), ["running", "running"]);
  assert.deepEqual(parallelTasks.map(function (task) { return task.routingCapabilityFloor; }), [4, 4]);
  assert.deepEqual(parallelTasks.map(function (task) { return task.model; }),
    ["gpt-5.6-sol", "gpt-5.6-sol"]);
  var parallelStarts = target.starts.filter(function (entry) {
    return entry.session.orchestrationParent &&
      parallelTasks.some(function (task) {
        return task.taskId === entry.session.orchestrationParent.taskId;
      });
  });
  assert.equal(parallelStarts.length, 2);
  assert.match(parallelStarts[0].prompt, /do not modify files or external state/);
  assert.match(parallelStarts[1].prompt, /do not modify files or external state/);

  var afterRestart = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
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
    title: "Target project coordinator",
    objective: "Coordinate the expanded target-project effort.",
    context: "The work has no local dependencies.",
    acceptanceCriteria: "The focused test passes.",
    ownedPaths: "lib/target.js",
  });
  assert.equal(restartedReplay.ok, true);
  assert.equal(restartedReplay.reused, true);
  assert.equal(target.sessions.size, 6);
});

test("direct-leaf delegation routes advertised Fable aliases and leaves future versions unrouted", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-fable-direct-leaf-"));
  var targetProjectId = "ad8c7932-da3c-4d0b-879b-eb7c847cb64d";
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var target = testContext(undefined, {
    projectId: targetProjectId,
    crossProject: router,
    smState: {
      availableVendors: ["claude"],
      installedVendors: ["claude"],
      providerRoutes: [{
        id: "claude-anthropic",
        vendor: "claude",
        provider: "anthropic",
        modelFamily: "claude",
        label: "Claude",
        enabled: true,
        catalogVerified: true,
        catalogSource: "live",
      }],
      verifiedModelsByRoute: {
        "claude-anthropic": [{
          value: "claude-fable-5[1m]",
          resolvedModel: "claude-fable-5",
        }],
      },
    },
  });
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

  var aliases = ["fable", "claude-fable-5"];
  for (var i = 0; i < aliases.length; i++) {
    var taskId = "fable-alias-" + i;
    var routed = lead.api.coordinateExternalTask({
      coordinatorSessionId: coop.storageId,
      portfolioTaskId: taskId,
      bindingRevision: 1,
      idempotencyKey: "create-" + taskId,
      mode: "direct_leaf",
      targetProject: { projectId: targetProjectId },
      title: "Fable direct leaf",
      objective: "Run the bounded implementation task.",
      context: "The advertised catalog token is authoritative.",
      acceptanceCriteria: "The worker starts on Fable.",
      ownedPaths: "lib/provider-routes.js",
      provider: "claude",
      model: aliases[i],
    });
    assert.equal(routed.ok, true, aliases[i] + " should route");
    assert.equal(target.sessions.get(routed.localSessionId).model, "claude-fable-5[1m]");
  }

  var invalid = lead.api.coordinateExternalTask({
    coordinatorSessionId: coop.storageId,
    portfolioTaskId: "fable-future-version",
    bindingRevision: 1,
    idempotencyKey: "create-fable-future-version",
    mode: "direct_leaf",
    targetProject: { projectId: targetProjectId },
    title: "Future Fable direct leaf",
    objective: "Run on an unadvertised future model.",
    context: "No matching catalog entry exists.",
    acceptanceCriteria: "The attempt fails closed.",
    ownedPaths: "lib/provider-routes.js",
    provider: "claude",
    model: "claude-fable-6",
  });
  assert.equal(invalid.ok, false);
  assert.equal(target.sessions.size, aliases.length);
  var binding = router.getExecutionBinding("fable-future-version", 1);
  assert.equal(binding.status, "unrouted");
});

test("project-coordinator completion closes its source binding through typed delivery", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-coordinator-closure-"));
  var targetProjectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var target = testContext(undefined, { projectId: targetProjectId, crossProject: router });
  var lead = testContext(undefined, { projectId: "system-lead", crossProject: router });
  var coop = coordinator(lead);
  coop.coopHome = true;
  router.registerProjectResolver({
    getProjectId: function () { return targetProjectId; },
    deliverCrossProjectEnvelope: target.api.deliverCrossProjectEnvelope,
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: lead.api.deliverCrossProjectEnvelope,
  });
  var created = lead.api.coordinateExternalTask({
    coordinatorSessionId: coop.storageId,
    portfolioTaskId: "portfolio-project-closure",
    bindingRevision: 1,
    idempotencyKey: "project-closure-r1",
    mode: "project_coordinator",
    targetProject: { projectId: targetProjectId },
    title: "Target project coordinator",
    objective: "Complete the target project through the canonical coordinator.",
    context: "The coordinator has no child tasks.",
    acceptanceCriteria: "Emit verified project completion.",
    ownedPaths: "lib/target.js",
  });
  assert.equal(created.ok, true);
  var projectCoordinator = portfolioSession(target, "portfolio-project-closure");
  projectCoordinator.history.push({
    type: "delta",
    text: "PROJECT_COMPLETED: yes\nSUMMARY: Target integration verified.\n" +
      "VERIFICATION: target suite passed\nINTEGRATION_VERIFIED: yes\nESCALATION_REQUIRED: no",
  });
  projectCoordinator.isProcessing = false;

  target.api.handleCoordinatorTurnDone(projectCoordinator);

  var binding = router.getExecutionBinding("portfolio-project-closure", 1);
  assert.equal(projectCoordinator.orchestrationPolicy.portfolioExecution.status, "completed");
  assert.equal(binding.status, "completed");
  assert.deepEqual(router.bindingStore.listCurrent(), []);
  assert.equal(lead.starts.length, 0, "completion closure does not create an owner-facing replay");
  target.api.handleCoordinatorTurnDone(projectCoordinator);
  assert.equal(router.getExecutionBinding("portfolio-project-closure", 1).status, "completed");
});

test("project-coordinator needs-input turns stay active and resume through typed steering", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-coordinator-needs-input-"));
  var targetProjectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var target = testContext(undefined, { projectId: targetProjectId, crossProject: router });
  var lead = testContext(undefined, { projectId: "system-lead", crossProject: router });
  var coop = coordinator(lead);
  coop.coopHome = true;
  router.registerProjectResolver({
    getProjectId: function () { return targetProjectId; },
    getSessionManager: function () { return target.sm; },
    deliverCrossProjectEnvelope: target.api.deliverCrossProjectEnvelope,
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    getSessionManager: function () { return lead.sm; },
    deliverCrossProjectEnvelope: lead.api.deliverCrossProjectEnvelope,
  });
  lead.api.coordinateExternalTask({
    coordinatorSessionId: coop.storageId,
    portfolioTaskId: "portfolio-needs-input-coordinator",
    bindingRevision: 1,
    idempotencyKey: "needs-input-coordinator-r1",
    mode: "project_coordinator",
    targetProject: { projectId: targetProjectId },
    title: "Needs-input target coordinator",
    objective: "Coordinate the target work until an independent route is available.",
    acceptanceCriteria: "Stay resumable while verification needs input.",
    ownedPaths: "lib/target.js",
  });
  var projectCoordinator = portfolioSession(target, "portfolio-needs-input-coordinator");

  function finishNeedsInputTurn() {
    projectCoordinator.history.push({
      type: "delta",
      text: "WORKER_STATUS: needs_input\nREASON: verification_route_unavailable\n" +
        "SUMMARY: Implementation is ready but independent review is unavailable.\n" +
        "CHANGES: none\nCOMMITS: none\nVERIFICATION: focused suite passed\n" +
        "ESCALATION_REQUIRED: yes",
    });
    projectCoordinator.history.push({ type: "result" });
    projectCoordinator.history.push({ type: "done", code: 0 });
    projectCoordinator.isProcessing = false;
    target.api.handleCoordinatorTurnDone(projectCoordinator);
  }

  finishNeedsInputTurn();

  var metadata = projectCoordinator.orchestrationPolicy.portfolioExecution;
  var binding = router.getExecutionBinding("portfolio-needs-input-coordinator", 1);
  var projected = router.queryCoopSessions({
    projectRefs: [{ projectId: targetProjectId }],
    topLevelOnly: false,
  }).sessions.find(function (entry) {
    return entry.sessionStorageId === projectCoordinator.storageId;
  });
  var projectRollup = router.queryCoopSessions({
    projectRefs: [{ projectId: targetProjectId }],
  }).sessions.find(function (entry) {
    return entry.sessionStorageId === binding.projectCoordinator.sessionStorageId;
  });
  assert.equal(metadata.status, "needs_input");
  assert.equal(metadata.reason, "verification_route_unavailable");
  assert.equal(binding.status, "active");
  assert.equal(projectCoordinator.hidden, undefined);
  assert.equal(projectCoordinator.orchestrationProjectCompletion.status, "pending");
  assert.equal(projectCoordinator.orchestrationEvents.some(function (event) {
    return event.type === "project_completed";
  }), false);
  assert.equal(projected.lifecycleState, "needs_input");
  assert.equal(projected.workState, "needs_input");
  assert.equal(projectRollup.lifecycleState, "needs_input");
  assert.equal(projectRollup.workState, "needs_input");

  var steer = lead.api.steerProjectCoordinatorFromTool({
    coordinatorSessionId: coop.storageId,
    targetProject: { projectId: targetProjectId },
    targetCoordinator: {
      projectId: targetProjectId,
      sessionStorageId: projectCoordinator.storageId,
    },
    portfolioTaskId: "portfolio-needs-input-coordinator",
    bindingRevision: 1,
    idempotencyKey: "needs-input-coordinator-steer-1",
    message: "A verified reviewer route is available. Continue the review gate.",
  });
  assert.equal(steer.isError, undefined);
  assert.equal(metadata.status, "running");
  assert.equal(Object.hasOwn(metadata, "reason"), false);
  projected = router.queryCoopSessions({
    projectRefs: [{ projectId: targetProjectId }],
    topLevelOnly: false,
  }).sessions.find(function (entry) {
    return entry.sessionStorageId === projectCoordinator.storageId;
  });
  assert.equal(projected.lifecycleState, "running");
  assert.equal(projected.workState, "working");
  projectRollup = router.queryCoopSessions({
    projectRefs: [{ projectId: targetProjectId }],
  }).sessions.find(function (entry) {
    return entry.sessionStorageId === binding.projectCoordinator.sessionStorageId;
  });
  assert.equal(projectRollup.lifecycleState, "running");
  assert.equal(projectRollup.workState, "working");

  finishNeedsInputTurn();
  projected = router.queryCoopSessions({
    projectRefs: [{ projectId: targetProjectId }],
    topLevelOnly: false,
  }).sessions.find(function (entry) {
    return entry.sessionStorageId === projectCoordinator.storageId;
  });
  assert.equal(metadata.status, "needs_input");
  assert.equal(router.getExecutionBinding("portfolio-needs-input-coordinator", 1).status, "active");
  assert.equal(projectCoordinator.hidden, undefined);
  assert.equal(projected.lifecycleState, "needs_input");
  assert.equal(projected.workState, "needs_input");
  projectRollup = router.queryCoopSessions({
    projectRefs: [{ projectId: targetProjectId }],
  }).sessions.find(function (entry) {
    return entry.sessionStorageId === binding.projectCoordinator.sessionStorageId;
  });
  assert.equal(projectRollup.lifecycleState, "needs_input");
  assert.equal(projectRollup.workState, "needs_input");
});

test("steering an idle project coordinator starts a new turn even with a stale query instance", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-coordinator-steer-"));
  var targetProjectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var target = testContext(undefined, { projectId: targetProjectId, crossProject: router });
  var lead = testContext(undefined, { projectId: "system-lead", crossProject: router });
  var coop = coordinator(lead);
  coop.coopHome = true;
  router.registerProjectResolver({
    getProjectId: function () { return targetProjectId; },
    deliverCrossProjectEnvelope: target.api.deliverCrossProjectEnvelope,
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: lead.api.deliverCrossProjectEnvelope,
  });
  lead.api.coordinateExternalTask({
    coordinatorSessionId: coop.storageId,
    portfolioTaskId: "portfolio-idle-steer",
    bindingRevision: 1,
    idempotencyKey: "idle-steer-r1",
    mode: "project_coordinator",
    targetProject: { projectId: targetProjectId },
    title: "Idle target coordinator",
    objective: "Coordinate the target work.",
    acceptanceCriteria: "Wake on typed steering.",
    ownedPaths: "lib/idle.js",
  });
  var projectCoordinator = portfolioSession(target, "portfolio-idle-steer");
  projectCoordinator.isProcessing = false;
  projectCoordinator.queryInstance = {};
  var startsBefore = target.starts.length;
  var pushesBefore = target.pushes.length;

  var steer = lead.api.steerProjectCoordinatorFromTool({
    coordinatorSessionId: coop.storageId,
    targetProject: { projectId: targetProjectId },
    targetCoordinator: { projectId: targetProjectId, sessionStorageId: projectCoordinator.storageId },
    portfolioTaskId: "portfolio-idle-steer",
    bindingRevision: 1,
    idempotencyKey: "idle-steer-message",
    message: "Re-run the idle coordinator on the restart path.",
  });

  assert.equal(steer.isError, undefined);
  assert.equal(target.starts.length, startsBefore + 1);
  assert.equal(target.starts.at(-1).session, projectCoordinator);
  assert.equal(target.pushes.length, pushesBefore);
});

test("restored completed project coordinators redeliver binding closure for active source bindings", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-coordinator-restore-"));
  var targetProjectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var lead = testContext(undefined, { projectId: "system-lead", crossProject: router });
  var coop = coordinator(lead);
  coop.coopHome = true;
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: lead.api.deliverCrossProjectEnvelope,
  });
  assert.equal(router.bindingStore.reserve({
    source: { projectId: "system-lead", sessionStorageId: coop.storageId },
    portfolioTaskId: "portfolio-restored-project",
    bindingRevision: 1,
    idempotencyKey: "restored-project-r1",
    mode: "project_coordinator",
    targetProject: { projectId: targetProjectId },
  }).ok, true);
  assert.equal(router.bindingStore.commit("portfolio-restored-project", 1, {
    projectId: targetProjectId,
    sessionStorageId: "restored-project-coordinator",
  }).ok, true);

  var restored = {
    localId: 7,
    storageId: "restored-project-coordinator",
    title: "Restored project coordinator",
    history: [],
    isProcessing: false,
    coordinationMode: true,
    orchestrationTasks: [],
    orchestrationEvents: [],
    coopControlledBy: { coopSessionStorageId: coop.storageId, since: 1 },
    orchestrationProjectCompletion: {
      status: "completed",
      completionRevision: 1,
      summary: "Restored project outcome.",
      verification: "target suite passed",
      integrationVerification: "yes",
      escalationRequired: "no",
      completedAt: 25,
    },
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "portfolio-restored-project",
        bindingRevision: 1,
        idempotencyKey: "restored-project-r1",
        mode: "project_coordinator",
        status: "completed",
        completedAt: 25,
        source: { projectId: "system-lead", sessionStorageId: coop.storageId },
        projectCompletionResultEventId: "project-coordinator-restored",
        projectCompletionDeliveryEventId: "project-terminal-v1-project-coordinator-restored",
      },
    },
  };
  var target = testContext(new Map([[restored.localId, restored]]), {
    projectId: targetProjectId,
    crossProject: router,
  });
  router.registerProjectResolver({
    getProjectId: function () { return targetProjectId; },
    deliverCrossProjectEnvelope: target.api.deliverCrossProjectEnvelope,
  });

  assert.equal(router.getExecutionBinding("portfolio-restored-project", 1).status, "active");
  target.api.handleCoordinatorTurnDone(restored);
  assert.equal(router.getExecutionBinding("portfolio-restored-project", 1).status, "completed");
});

test("direct-leaf completion closes its source binding and suppresses late delivery replay", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-direct-leaf-closure-"));
  var targetProjectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
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
  var created = lead.api.coordinateExternalTask({
    coordinatorSessionId: coop.storageId,
    portfolioTaskId: "portfolio-terminal-leaf",
    bindingRevision: 1,
    idempotencyKey: "terminal-leaf-create",
    mode: "direct_leaf",
    targetProject: { projectId: targetProjectId },
    title: "Terminal direct leaf",
    objective: "Finish the bounded task.",
    acceptanceCriteria: "Report verified completion.",
    ownedPaths: "lib/terminal.js",
  });
  var leaf = Array.from(target.sessions.values())[0];
  leaf.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Finished once.\n" +
      "VERIFICATION: focused regression passed\nESCALATION_REQUIRED: no",
  });
  leaf.isProcessing = false;
  leaf._subscriber({ type: "done" });

  var binding = router.getExecutionBinding("portfolio-terminal-leaf", 1);
  assert.equal(binding.status, "completed");
  assert.equal(binding.completedAt > 0, true);
  assert.deepEqual(binding.worker, created.workerRef);
  assert.deepEqual(router.bindingStore.listCurrent(), []);
  assert.equal(lead.starts.length, 1, "the first completion can notify Coop once");

  var duplicate = lead.api.deliverCrossProjectEnvelope(router.createEnvelope({
    eventId: leaf.orchestrationPolicy.portfolioExecution.completionDeliveryEventId,
  }));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(lead.starts.length, 1, "duplicate completion is acknowledged without replay");

  var lateProgress = lead.api.deliverCrossProjectEnvelope({
    eventId: "late-direct-progress",
    source: created.workerRef,
    destination: { projectId: "system-lead", sessionStorageId: coop.storageId },
    bindingRevision: 1,
    payload: { type: "coordinator_update", text: "old progress" },
  });
  assert.equal(lateProgress.ok, true);
  assert.equal(lateProgress.suppressed, true);
  assert.equal(lead.starts.length, 1, "old progress cannot reopen the owner-facing lane");
});

test("owner tools can resolve and request input for descendant coordinator task graphs", function () {
  var ctx = testContext();
  var root = coordinator(ctx);
  root.coopHome = true;
  var descendant = {
    localId: 2,
    storageId: "descendant-coordinator",
    title: "Descendant coordinator",
    history: [],
    isProcessing: false,
    coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: root.storageId, since: 1 },
    orchestrationTasks: [{
      taskId: "descendant-resolve",
      title: "Resolve descendant task",
      status: "needs_input",
      updatedAt: 1,
    }, {
      taskId: "descendant-question",
      title: "Question descendant task",
      status: "needs_input",
      updatedAt: 2,
    }],
    orchestrationEvents: [],
  };
  ctx.sessions.set(descendant.localId, descendant);

  var input = ctx.api.requestInputFromTool({
    coordinatorSessionId: root.storageId,
    taskIds: ["descendant-question"],
    question: "Ship the descendant change now?",
    reason: "A product decision is still required.",
  });
  assert.equal(input.isError, undefined);
  assert.equal(descendant.orchestrationTasks[1].status, "waiting_user");
  assert.equal(descendant.orchestrationTasks[1].userQuestion,
    "Ship the descendant change now?");
  assert.equal(root.orchestrationTasks.length, 0);

  var resolved = ctx.api.resolveFromTool({
    coordinatorSessionId: root.storageId,
    taskId: "descendant-resolve",
    summary: "The descendant coordinator verified the change.",
    verification: "node --test test/descendant.test.js passed",
    escalationRequired: "no",
  });
  assert.equal(resolved.isError, undefined);
  assert.equal(descendant.orchestrationTasks[0].status, "completed");
  assert.equal(descendant.orchestrationTasks[0].resolvedByCoordinator, true);
  assert.equal(root.orchestrationTasks.length, 0);
});

test("terminal direct leaves reconcile old active bindings through typed completion without replay", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-direct-leaf-recovery-"));
  var targetProjectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var lead = testContext(undefined, { projectId: "system-lead", crossProject: router });
  var coop = coordinator(lead);
  coop.coopHome = true;
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: lead.api.deliverCrossProjectEnvelope,
  });
  router.bindingStore.reserve({
    source: { projectId: "system-lead", sessionStorageId: coop.storageId },
    portfolioTaskId: "portfolio-recovered-leaf",
    bindingRevision: 1,
    idempotencyKey: "recovered-leaf-create",
    mode: "direct_leaf",
    targetProject: { projectId: targetProjectId },
  });
  router.bindingStore.commit("portfolio-recovered-leaf", 1, {
    projectId: targetProjectId,
    sessionStorageId: "recovered-direct-leaf",
  });
  var recoveredLeaf = {
    localId: 9,
    storageId: "recovered-direct-leaf",
    history: [{ type: "delta", text: "WORKER_STATUS: completed\nSUMMARY: Old result." }],
    isProcessing: false,
    coopControlledBy: { coopSessionStorageId: coop.storageId, since: 1 },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "portfolio-recovered-leaf",
      bindingRevision: 1,
      idempotencyKey: "recovered-leaf-create",
      mode: "direct_leaf",
      status: "completed",
      completedAt: 88,
      resultEventId: "old-direct-result",
      source: { projectId: "system-lead", sessionStorageId: coop.storageId },
    } },
  };
  var target = testContext(new Map([[recoveredLeaf.localId, recoveredLeaf]]), {
    projectId: targetProjectId,
    crossProject: router,
  });
  router.registerProjectResolver({
    getProjectId: function () { return targetProjectId; },
    deliverCrossProjectEnvelope: target.api.deliverCrossProjectEnvelope,
  });

  assert.equal(router.getExecutionBinding("portfolio-recovered-leaf", 1).status, "completed");
  assert.equal(recoveredLeaf.hidden, true);
  assert.equal(lead.starts.length, 0, "historical completion is a control repair, not a replay");
  assert.deepEqual(router.bindingStore.listCurrent(), []);
});

test("adapter shutdown closes a direct-leaf binding without retrying orphaned active work", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-direct-leaf-adapter-stop-"));
  var targetProjectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
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
  lead.api.coordinateExternalTask({
    coordinatorSessionId: coop.storageId,
    portfolioTaskId: "portfolio-adapter-stop",
    bindingRevision: 1,
    idempotencyKey: "adapter-stop-create",
    mode: "direct_leaf",
    targetProject: { projectId: targetProjectId },
    title: "Adapter stop leaf",
    objective: "Finish without retrying a stopped adapter.",
    acceptanceCriteria: "Close the direct binding.",
    ownedPaths: "lib/adapter-stop.js",
  });
  var leaf = Array.from(target.sessions.values())[0];
  leaf.isProcessing = false;
  leaf._subscriber({ type: "done", code: 1 });

  var binding = router.getExecutionBinding("portfolio-adapter-stop", 1);
  assert.equal(leaf.orchestrationPolicy.portfolioExecution.status, "failed");
  assert.equal(leaf.orchestrationPolicy.portfolioExecution.reason, "adapter_shutdown");
  assert.equal(binding.status, "failed");
  assert.deepEqual(router.bindingStore.listCurrent(), []);
  assert.equal(leaf._portfolioExecutionWatcher, null);
  assert.equal(target.pushes.length, 0);
  assert.equal(router.messageProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: coop.storageId },
    portfolioTaskId: "portfolio-adapter-stop",
    bindingRevision: 1,
    idempotencyKey: "must-not-retry-adapter-stop",
    text: "Retry the stopped adapter.",
  }).ok, false);
  assert.equal(target.pushes.length, 0, "a closed direct leaf cannot be restarted by delivery retry");
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
    allowLeadSourcedExecution: true,
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
  assert.equal(target.sessions.size, 2);
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
    allowLeadSourcedExecution: true,
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
  assert.equal(result.created, true);
  assert.deepEqual(result.projectCoordinatorRef, {
    projectId: projectId,
    sessionStorageId: existing.storageId,
  });
  assert.notEqual(result.sessionStorageId, existing.storageId);
  assert.equal(sessions.size, 3);
  assert.equal(target.starts[0].session.coordinationRole, "task_coordinator");
  assert.equal(target.starts[0].session.orchestrationParent.sessionStorageId, existing.storageId);
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
  assert.equal(task.archivedAt, undefined);
  assert.equal(worker.hidden, undefined);
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

test("Live UI follow-up resumes the completed task in its existing worker", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var worker = ctx.starts[0].session;
  worker.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: First pass.\n" +
      "VERIFICATION: regression test passed\nESCALATION_REQUIRED: no",
  });
  worker.isProcessing = false;
  worker._subscriber({ type: "done" });
  worker.hidden = true;
  worker._orchestrationTaskClosed = true;
  task.archivedAt = Date.now();

  var result = ctx.api.messageFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
    message: "The mobile spacing still needs adjustment.",
    imageRefs: [{ mediaType: "image/png", file: "followup.png" }],
    _liveUiFollowup: true,
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /existing worker/);
  assert.equal(task.status, "running");
  assert.equal(task.archivedAt, undefined);
  assert.equal(worker.hidden, undefined);
  assert.equal(worker._orchestrationTaskClosed, false);
  assert.equal(ctx.starts[2].session, worker);
  assert.match(ctx.starts[2].prompt, /mobile spacing still needs adjustment/);
  assert.deepEqual(ctx.starts[2].images, [{
    mediaType: "image/png",
    data: "loaded-followup.png",
  }]);
});

test("Live UI feedback queues on the active worker with its screenshot", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var worker = ctx.starts[0].session;

  var result = ctx.api.messageFromTool({
    coordinatorSessionId: parent.storageId,
    taskId: task.taskId,
    message: "Also tighten the tablet breakpoint.",
    imageRefs: [{ mediaType: "image/png", file: "tablet.png" }],
    _liveUiFollowup: true,
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /existing worker/);
  assert.equal(worker.pendingCoordinatorMessages.length, 1);
  worker.isProcessing = false;
  worker._subscriber({ type: "done" });
  assert.equal(task.status, "running");
  assert.match(ctx.starts[1].prompt, /tighten the tablet breakpoint/);
  assert.deepEqual(ctx.starts[1].images, [{
    mediaType: "image/png",
    data: "loaded-tablet.png",
  }]);
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
  assert.equal(failedWorker.orchestrationParent.taskId, task.taskId);
  assert.equal(failedWorker._orchestrationTaskClosed, true);
  assert.ok(failedWorker.orchestrationDetachedAt);
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
  assert.equal(firstWorker.orchestrationParent.taskId, task.taskId);
  assert.equal(firstWorker._orchestrationTaskClosed, true);
  assert.ok(firstWorker.orchestrationDetachedAt);
  assert.equal(firstWorker.hidden, true);
});

test("closing a coordinated task stops and archives its worker conversation", function () {
  var ctx = testContext();
  var parent = coordinator(ctx);
  ctx.api.delegateFromTool(brief(parent));
  var task = parent.orchestrationTasks[0];
  var workerId = task.workerSessionId;
  var worker = ctx.sessions.get(workerId);
  worker.storageId = "worker-close-stable";
  task.workerSessionId = 999;
  task.workerStorageId = worker.storageId;

  var closed = ctx.api.closeTask(parent, task.taskId, null);

  assert.equal(closed, true);
  assert.equal(parent.orchestrationTasks.length, 1);
  assert.equal(parent.orchestrationTasks[0].status, "dismissed");
  assert.equal(parent.orchestrationTasks[0].resolutionReason, "Dismissed by user");
  assert.equal(parent.coordinationMode, true);
  assert.equal(ctx.sessions.has(workerId), true);
  assert.equal(ctx.sessions.get(workerId).hidden, true);
  assert.equal(ctx.sessions.get(workerId).taskStopRequested, true);
  assert.equal(ctx.sessions.get(workerId).orchestrationParent.taskId, task.taskId);
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

test("startup contains unavailable worker routing without crashing the daemon", function () {
  var parent = {
    localId: 1,
    storageId: "parent-route-blocked",
    history: [],
    coordinationMode: true,
    orchestrationEvents: [],
    orchestrationTasks: [{
      taskId: "task-route-blocked",
      title: "Review security architecture",
      objective: "Review the cross-cutting authorization boundary.",
      status: "ready",
      dependencies: [],
      provider: "codex",
      providerPinned: true,
    }],
  };
  var ctx = testContext(new Map([[parent.localId, parent]]), {
    smState: {
      availableVendors: ["codex"],
      installedVendors: ["codex"],
      providerRoutes: [{
        id: "codex-openai", vendor: "codex", provider: "openai",
        modelFamily: "gpt", label: "Codex", enabled: true,
        catalogVerified: true, catalogSource: "live",
      }],
      modelsByVendor: { codex: [] },
    },
  });

  var task = parent.orchestrationTasks[0];
  assert.equal(ctx.sessions.size, 1, "no unroutable worker session is created");
  assert.equal(ctx.starts.length, 1, "the coordinator receives the attention update");
  assert.equal(ctx.starts[0].session, parent);
  assert.equal(task.status, "needs_input");
  assert.equal(task.routingBlocked, true);
  assert.equal(task.routingBlockedReason, "catalog_unverified");
  assert.equal(task.routingDiagnostics.catalogVerification, "unverified");
  assert.match(task.currentActivity, /healthy verified worker route/);
  assert.match(task.resultSummary, /verified model catalog/);
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
  assert.equal(worker.hidden, undefined);
  assert.equal(parent.orchestrationTasks[0].archivedAt, undefined);
});

test("startup restores workers hidden by premature terminal auto-archive", function () {
  var task = {
    taskId: "task-premature-archive",
    title: "Completed task",
    status: "completed",
    archivedAt: 50,
    workerStorageId: "worker-premature-archive",
  };
  var worker = {
    localId: 90,
    storageId: "worker-premature-archive",
    hidden: true,
    isProcessing: false,
    history: [],
    orchestrationParent: {
      taskId: task.taskId,
      sessionId: 89,
      sessionStorageId: "parent-premature-archive",
    },
  };
  var parent = {
    localId: 89,
    storageId: "parent-premature-archive",
    history: [],
    coordinationMode: true,
    orchestrationTasks: [task],
    orchestrationEvents: [{
      eventId: "event-premature-archive",
      graphId: "graph-premature-archive",
      taskId: task.taskId,
      type: "task_worker_archived",
      at: 50,
      data: { reason: "Recovered terminal task worker" },
    }],
  };
  var sessions = new Map([[parent.localId, parent], [worker.localId, worker]]);

  testContext(sessions);

  assert.equal(worker.hidden, undefined);
  assert.equal(task.archivedAt, undefined);
  assert.equal(parent.orchestrationEvents.at(-1).type, "task_worker_restored");

  worker.hidden = true;
  task.archivedAt = 75;
  parent.orchestrationEvents.push({
    eventId: "event-explicit-archive",
    graphId: "graph-premature-archive",
    taskId: task.taskId,
    type: "task_worker_archived",
    at: 75,
    data: { reason: "Dismissed by user" },
  });

  testContext(sessions);

  assert.equal(worker.hidden, true);
  assert.equal(task.archivedAt, 75);
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
    history: [{ type: "delta", text: "orphan transcript" }, { type: "done" }],
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
    interruptedByRestart: true,
    history: [{ type: "delta", text: "The worker was interrupted." }, { type: "done" }],
    orchestrationParent: { taskId: "task-interrupted-orphan", sessionStorageId: "missing-parent" },
  };
  var failedOrphan = {
    localId: 20,
    storageId: "worker-failed-orphan",
    isProcessing: false,
    history: [
      { type: "delta", text: "WORKER_STATUS: failed\nSUMMARY: Provider failed." },
      { type: "done" },
    ],
    orchestrationParent: { taskId: "task-failed-orphan", sessionStorageId: "missing-parent" },
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
  sessions.set(failedOrphan.localId, failedOrphan);
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
  assert.equal(failedOrphan.hidden, undefined);
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
