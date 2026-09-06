var taskGraph = require("../lib/orchestration-task-graph");
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var controlStore = require("../lib/coop-control-store");
var executions = require("../lib/coop-control-executions");
var deliveryModule = require("../lib/coop-control-delivery");
var executionFence = require("../lib/coop-control-fence");
var external = require("../lib/project-task-orchestrator-external");
var createBindings =
  require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;
var attachCompletionGate =
  require("../lib/project-task-orchestrator-completion").attachCompletionGate;
var finishControlledExecution =
  require("../lib/coop-control-execution-completion").finishControlledExecution;
var createCodexQueryHandle =
  require("../lib/yoke/adapters/codex").contractTestKit.createQueryHandle;

var PROJECT_A = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var COOP_SESSION = "871a194b-8879-40f7-a1fe-656e48e722af";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-target-"));
  return {
    dbPath: path.join(dir, "coop-control.sqlite"),
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function availableTest(name, fn) {
  test(name, { skip: !controlStore.isControlStoreAvailable() }, fn);
}

function enableExecutionFlags() {
  var oldStore = process.env.CLAY_COOP_CONTROL_STORE;
  var oldExecutions = process.env.CLAY_COOP_CONTROL_EXECUTIONS;
  process.env.CLAY_COOP_CONTROL_STORE = "1";
  process.env.CLAY_COOP_CONTROL_EXECUTIONS = "1";
  return function () {
    if (oldStore === undefined) delete process.env.CLAY_COOP_CONTROL_STORE;
    else process.env.CLAY_COOP_CONTROL_STORE = oldStore;
    if (oldExecutions === undefined) delete process.env.CLAY_COOP_CONTROL_EXECUTIONS;
    else process.env.CLAY_COOP_CONTROL_EXECUTIONS = oldExecutions;
  };
}

function envelope(sequence) {
  return {
    schema: external.COMMAND_SCHEMA,
    schemaVersion: external.COMMAND_VERSION,
    eventId: "event-" + sequence,
    source: { projectId: "system-lead", sessionStorageId: COOP_SESSION },
    destination: { projectId: PROJECT_A, sessionStorageId: "project-router" },
    payload: {
      type: "portfolio_execution_create",
      portfolioTaskId: "portfolio-controlled-task",
      bindingRevision: 1,
      idempotencyKey: "portfolio-controlled-task-r1",
      mode: "direct_leaf",
      targetProject: { projectId: PROJECT_A },
      title: "Controlled task",
      objective: "Verify durable execution control.",
    },
  };
}

function coordinatorEnvelope(sequence, storageId) {
  var value = envelope(sequence);
  value.payload.mode = "project_coordinator";
  value.payload.targetCoordinator = { projectId: PROJECT_A, sessionStorageId: storageId };
  return value;
}

function messageEnvelope(sequence, text) {
  var value = envelope(sequence);
  value.payload = {
    type: "portfolio_execution_message",
    portfolioTaskId: "portfolio-controlled-task",
    bindingRevision: 1,
    text: text,
  };
  return value;
}

function stopEnvelope(sequence) {
  var value = envelope(sequence);
  value.payload = {
    type: "portfolio_execution_stop",
    portfolioTaskId: "portfolio-controlled-task",
    bindingRevision: 1,
  };
  return value;
}

function target(control, timeline, options) {
  var opts = options || {};
  var sessions = opts.sessions || new Map();
  var nextId = 1;
  var sm = {
    sessions: sessions,
    defaultVendor: "codex",
    currentModel: "gpt-5.6-sol",
    currentPermissionMode: "bypassPermissions",
    permissionRequestIndex: {},
    getProjectId: function () { return PROJECT_A; },
    createSessionRaw: function (options) {
      if (opts.createSessionError) throw new Error(opts.createSessionError);
      var localId = nextId++;
      var session = Object.assign({
        localId: localId,
        storageId: "controlled-session-" + localId,
        history: [],
        pendingPermissions: {},
        pendingAskUser: {},
        allowedTools: {},
        orchestrationPolicy: {},
      }, options);
      sessions.set(localId, session);
      timeline.push("session");
      return session;
    },
    appendToSessionFile: function () { timeline.push("append"); },
    saveSessionFile: function () { timeline.push("save"); },
    broadcastSessionList: function () {},
    subscribeSession: function (id, callback) {
      sessions.get(id)._subscriber = callback;
      return function () {};
    },
    hideSession: function (id) { sessions.get(id).hidden = true; },
    deleteSessionQuiet: function (id) { sessions.delete(id); },
  };
  var sdk = {
    startQuery: function (session) {
      if (opts.startError) throw new Error(opts.startError);
      if (session._coopExecutionFence) {
        session._coopExecutionFence.assert("provider_start");
        session._coopExecutionFence.markProviderStarted();
      }
      timeline.push("provider");
      if (typeof opts.startQuery === "function") return opts.startQuery(session);
      if (opts.abandonOnStartFailure && opts.startResult && opts.startResult.ok === false) {
        session._coopExecutionFence.abandon("provider_start_failed");
      }
      return Promise.resolve(opts.startResult);
    },
  };
  var attached = external.attachPortfolioExecutionTarget({
    coopDeliveryControl: opts.deliveryControl,
    coopExecutionControl: control,
    coopStartupRecovery: opts.startupRecovery,
    reconcileSettledReview: opts.reconcileSettledReview,
    crossProject: opts.crossProject || {
      getExecutionBinding: function () {
        var session = Array.from(sessions.values())[0];
        return { worker: { projectId: PROJECT_A, sessionStorageId: session.storageId } };
      },
      createEnvelope: function (value) { return value; },
      deliverEnvelope: function () { timeline.push("delivery"); return { ok: true }; },
    },
    ensureProjectAccessForSession: function () {},
    onProcessingChanged: function () {},
    sdk: sdk,
    sm: sm,
    slug: "target",
  });
  return { attached: attached, sessions: sessions, sm: sm };
}

function controlledSession(runtime) {
  return Array.from(runtime.sessions.values()).find(function (session) {
    return !!(session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution);
  });
}

function flushTurns() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function fakeCodexAppServer() {
  var handlers = [];
  return {
    started: true,
    handlers: handlers,
    emit: function (event) {
      handlers.slice().forEach(function (handler) { handler(event); });
    },
    send: function (method, params) {
      if (method === "thread/resume") return Promise.resolve({ thread: { id: params.threadId } });
      return Promise.resolve({});
    },
    subscribe: function (handler) {
      handlers.push(handler);
      return function () {
        var index = handlers.indexOf(handler);
        if (index !== -1) handlers.splice(index, 1);
      };
    },
  };
}

availableTest("the real target starts only after durable bind and barrier, then completes under the same fence", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var result = runtime.attached.handleEnvelope(envelope(1));
    assert.equal(result.ok, true);
    assert.deepEqual(timeline.slice(0, 4), ["session", "append", "save", "provider"]);
    var session = runtime.sessions.get(result.localSessionId);
    var metadata = session.orchestrationPolicy.portfolioExecution.control;
    assert.ok(metadata.executionId);
    assert.equal(session.orchestrationPolicy.portfolioExecution.infrastructureRecovery.input.portfolioTaskId,
      "portfolio-controlled-task");
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, "capability"), false);
    var durable = control.inspect(metadata.executionId);
    assert.equal(durable.current.sessionRef.sessionStorageId, session.storageId);
    assert.equal(durable.current.startState, "started");
    assert.equal(durable.leases.length, 1);

    session.history.push({
      type: "delta",
      text: "WORKER_STATUS: completed\nSUMMARY: Complete.\nVERIFICATION: target test passed\nESCALATION_REQUIRED: no",
    });
    session._subscriber({ type: "done", code: 0 });
    durable = control.inspect(metadata.executionId);
    assert.equal(durable.execution.status, "completed");
    assert.equal(durable.current.startState, "completed");
    assert.equal(durable.leases.length, 0);
    assert.equal(timeline.indexOf("delivery") > timeline.indexOf("provider"), true);
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("a controlled provider turn leaves no 16-stream resume fanout", async function () {
  var h = harness();
  var control = null;
  try {
    var timeline = [];
    control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var created = runtime.attached.handleEnvelope(envelope(101));
    var session = runtime.sessions.get(created.localSessionId);
    var server = fakeCodexAppServer();

    for (var i = 0; i < 16; i++) {
      var stale = createCodexQueryHandle(server, {
        cwd: process.cwd(), model: "gpt-5.6-terra", resumeSessionId: "r6-thread",
      });
      stale.pushMessage("legal typed steer " + i);
      if (session.singleTurn) stale.endInput();
      await flushTurns();
      server.emit({ method: "turn/started", params: {
        threadId: "r6-thread", turn: { id: "stale-turn-" + i },
      } });
      server.emit({ method: "turn/completed", params: {
        threadId: "r6-thread", turn: { id: "stale-turn-" + i, status: "completed" },
      } });
      await flushTurns();
    }

    assert.equal(server.handlers.length, 0,
      "each completed controlled turn must unsubscribe before the next typed command");

    var results = 0;
    var done = 0;
    var current = createCodexQueryHandle(server, {
      cwd: process.cwd(), model: "gpt-5.6-terra", resumeSessionId: "r6-thread",
    });
    (async function () {
      for await (var event of current) {
        if (event.yokeType === "result") results++;
      }
      done++;
    })();
    current.pushMessage("one legal typed steer");
    if (session.singleTurn) current.endInput();
    await flushTurns();
    server.emit({ method: "turn/started", params: {
      threadId: "r6-thread", turn: { id: "current-turn" },
    } });
    server.emit({ method: "turn/completed", params: {
      threadId: "r6-thread", turn: { id: "current-turn", status: "completed" },
    } });
    await flushTurns();

    assert.equal(results, 1);
    assert.equal(done, 1);
    assert.equal(server.handlers.length, 0);
  } finally {
    if (control) control.close();
    h.cleanup();
  }
});

availableTest("execution modes reject inherited object names", function () {
  var h = harness();
  try {
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    assert.throws(function () {
      control.reserveStart({
        portfolioTaskId: "portfolio-controlled-task",
        bindingRevision: 1,
        idempotencyKey: "portfolio-controlled-task-r1",
        mode: "constructor",
        targetProject: { projectId: PROJECT_A },
        source: { projectId: "system-lead", sessionStorageId: COOP_SESSION },
      });
    }, function (error) { return error && error.code === "COOP_CONTROL_AUTHORITY_INVALID"; });
    var token = control.reserveStart({ portfolioTaskId: "portfolio-action-task", bindingRevision: 1,
      idempotencyKey: "portfolio-action-task-r1", mode: "direct_leaf",
      targetProject: { projectId: PROJECT_A },
      source: { projectId: "system-lead", sessionStorageId: COOP_SESSION } });
    control.bindStart(token, { projectId: PROJECT_A, sessionStorageId: "action-session" });
    control.openStartBarrier(token);
    control.markProviderStarted(token);
    ["constructor", "toString"].forEach(function (action) {
      assert.throws(function () { control.assertCapability(token, action); },
        function (error) { return error && error.code === "COOP_CONTROL_AUTHORITY_DENIED"; });
    });
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("a reusable project coordinator starts a separately fenced task coordinator", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var session = {
      localId: 99,
      storageId: "existing-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(session.localId, session);
    var result = runtime.attached.handleEnvelope(coordinatorEnvelope(2, session.storageId));
    var taskCoordinator = controlledSession(runtime);
    assert.equal(result.ok, true);
    assert.equal(result.reused, false);
    assert.notEqual(result.localSessionId, session.localId);
    assert.ok(timeline.indexOf("session") !== -1);
    assert.equal(taskCoordinator.orchestrationParent.sessionStorageId, session.storageId);
    assert.ok(taskCoordinator.orchestrationPolicy.portfolioExecution.control);
    var metadata = taskCoordinator.orchestrationPolicy.portfolioExecution.control;
    var durable = control.inspect(metadata.executionId);
    assert.equal(durable.current.sessionRef.sessionStorageId, taskCoordinator.storageId);
    assert.equal(durable.current.startState, "started");
    assert.equal(durable.leases.length, 1);
    assert.ok(timeline.indexOf("provider") > timeline.indexOf("save"));
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("verified project-coordinator completion durably completes and releases its lease", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var session = {
      localId: 99,
      storageId: "completing-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      orchestrationTasks: [],
      orchestrationEvents: [],
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(session.localId, session);
    runtime.attached.handleEnvelope(coordinatorEnvelope(62, session.storageId));
    session = controlledSession(runtime);
    var metadata = session.orchestrationPolicy.portfolioExecution.control;
    session.history.push({ type: "delta", text: "PROJECT_COMPLETED: yes\n" +
      "SUMMARY: Integrated.\nVERIFICATION: suite passed\n" +
      "INTEGRATION_VERIFIED: yes\nESCALATION_REQUIRED: no" });
    var gate = attachCompletionGate({
      sm: runtime.sm,
      flushCoordinatorUpdates: function () { return false; },
      queueCoordinatorUpdate: function () {},
      sendState: function () {},
      finishControlledExecution: function (targetSession, status) {
        return finishControlledExecution(targetSession, status, { control: control });
      },
    });

    gate.handleTurnDone(session);

    var durable = control.inspect(metadata.executionId);
    assert.equal(durable.execution.status, "completed");
    assert.equal(durable.current.startState, "completed");
    assert.equal(durable.leases.length, 0);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "completed");
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("owner-acceptance wait stays needs-input across restart recovery", function () {
  var h = harness();
  var restoreFlags = enableExecutionFlags();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var root = {
      localId: 99,
      storageId: "owner-acceptance-restart-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      orchestrationTasks: [],
      orchestrationEvents: [],
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(root.localId, root);
    runtime.attached.handleEnvelope(coordinatorEnvelope(620, root.storageId));
    var session = controlledSession(runtime);
    var execution = session.orchestrationPolicy.portfolioExecution;
    execution.ownerAcceptanceRequired = true;
    execution.ownerAcceptance = {
      status: "pending",
      source: "project_local_instructions",
    };
    var executionId = execution.control.executionId;
    session.isProcessing = false;
    session.history.push({ type: "delta", text: "PROJECT_COMPLETED: yes\n" +
      "SUMMARY: Implementation verified.\nVERIFICATION: suite passed\n" +
      "INTEGRATION_VERIFIED: yes\nESCALATION_REQUIRED: no" });
    var gate = attachCompletionGate({
      sm: runtime.sm,
      flushCoordinatorUpdates: function () { return false; },
      queueCoordinatorUpdate: function () {},
      sendState: function () {},
      finishControlledExecution: function (targetSession, status) {
        return finishControlledExecution(targetSession, status, { control: control });
      },
    });

    gate.handleTurnDone(session);

    assert.equal(execution.status, "needs_input");
    var durable = control.inspect(executionId);
    assert.equal(durable.execution.status, "failed",
      "waiting for owner acceptance must not leave a running lease for restart recovery to kill");
    assert.equal(durable.current.failureCode, "needs_input");
    assert.equal(durable.leases.length, 0);
    control.close();

    delete session._coopExecutionFence;
    var recoveredControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    assert.equal(recoveredControl.recoverIncomplete([]), 0,
      "a settled owner wait is not an incomplete execution");
    var recoveredTarget = require("../lib/coop-control-execution-target").createTargetExecutionControl({
      coopExecutionControl: recoveredControl,
      projectId: function () { return PROJECT_A; },
    });
    assert.equal(recoveredTarget.reconcileSession(session, execution), false);
    assert.equal(execution.status, "needs_input");
    assert.equal(execution.reason, "awaiting_owner_acceptance");
    var delivery = deliveryModule.createDeliveryControl({
      enabled: true,
      store: recoveredControl.getStore(),
    });
    var recoveredRuntime = target(recoveredControl, [], {
      deliveryControl: delivery,
      sessions: runtime.sessions,
      startupRecovery: { assertReady: function () { return true; } },
    });
    var resumed = recoveredRuntime.attached.handleEnvelope(
      messageEnvelope(621, "The owner accepted this exact completed implementation."));
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "running");
    durable = recoveredControl.inspect(executionId);
    assert.equal(durable.execution.currentEpoch, 2,
      "the settled wait renews one incarnation when the owner decision arrives");
    assert.equal(durable.current.startState, "started");
    delivery.close();
    recoveredControl.close();
  } finally {
    restoreFlags();
    h.cleanup();
  }
});

availableTest("restart reconciliation repairs a legacy owner-acceptance wait", function () {
  var h = harness();
  var restoreFlags = enableExecutionFlags();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var root = {
      localId: 99,
      storageId: "legacy-owner-acceptance-restart-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      orchestrationTasks: [],
      orchestrationEvents: [],
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(root.localId, root);
    runtime.attached.handleEnvelope(coordinatorEnvelope(622, root.storageId));
    var session = controlledSession(runtime);
    var execution = session.orchestrationPolicy.portfolioExecution;
    var completedAt = 1788544355336;
    session.orchestrationProjectCompletion = {
      status: "completed",
      completionRevision: 1,
      graphDigest: "#events:0::",
      integrationVerification: "yes",
      escalationRequired: "no",
      portfolioTaskId: execution.portfolioTaskId,
      bindingRevision: execution.bindingRevision,
      completedAt: completedAt,
    };
    execution.ownerAcceptanceRequired = true;
    execution.ownerAcceptance = {
      status: "pending",
      source: "project_local_instructions",
    };
    execution.implementationCompletedAt = completedAt;
    execution.implementationCompletionRevision = 1;
    execution.implementationGraphDigest = "#events:0::";
    var executionId = execution.control.executionId;
    control.close();

    delete session._coopExecutionFence;
    var recoveredControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    assert.equal(recoveredControl.recoverIncomplete([]), 1);
    var durable = recoveredControl.inspect(executionId);
    assert.equal(durable.current.failureCode, "restart_recovery");
    execution.status = "failed";
    execution.reason = "restart_recovery";
    execution.terminalAt = durable.execution.finishedAt;
    var recoveredTarget = require("../lib/coop-control-execution-target").createTargetExecutionControl({
      coopExecutionControl: recoveredControl,
      projectId: function () { return PROJECT_A; },
    });
    var nearMiss = JSON.parse(JSON.stringify(session));
    nearMiss.orchestrationPolicy.portfolioExecution.implementationGraphDigest = "different";
    assert.equal(recoveredTarget.reconcileSession(nearMiss,
      nearMiss.orchestrationPolicy.portfolioExecution), false,
    "mismatched completion evidence must stay failed");
    assert.equal(nearMiss.orchestrationPolicy.portfolioExecution.status, "failed");

    assert.equal(recoveredTarget.reconcileSession(session, execution), true);
    assert.equal(execution.status, "needs_input");
    assert.equal(execution.reason, "awaiting_owner_acceptance");
    assert.equal(execution.terminalAt, undefined);
    assert.equal(execution.failureCode, undefined);
    var delivery = deliveryModule.createDeliveryControl({
      enabled: true,
      store: recoveredControl.getStore(),
    });
    var recoveredRuntime = target(recoveredControl, [], {
      deliveryControl: delivery,
      sessions: runtime.sessions,
      startupRecovery: { assertReady: function () { return true; } },
    });
    var resumed = recoveredRuntime.attached.handleEnvelope(
      messageEnvelope(623, "Reconcile this exact owner-acceptance wait."));
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "running");
    durable = recoveredControl.inspect(executionId);
    assert.equal(durable.execution.currentEpoch, 2);
    assert.equal(durable.current.startState, "started");
    delivery.close();
    recoveredControl.close();
  } finally {
    restoreFlags();
    h.cleanup();
  }
});

availableTest("startup reconciles one settled verified read-only review without recreating its failed incarnation", function () {
  var h = harness();
  var restoreFlags = enableExecutionFlags();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var root = {
      localId: 99,
      storageId: "settled-read-only-review-root",
      coordinationMode: true,
      orchestrationPolicy: {},
      orchestrationTasks: [],
      orchestrationEvents: [],
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(root.localId, root);
    var request = coordinatorEnvelope(624, root.storageId);
    request.payload.controlRole = "triage";
    request.payload.reviewOnly = true;
    runtime.attached.handleEnvelope(request);
    var session = controlledSession(runtime);
    var execution = session.orchestrationPolicy.portfolioExecution;
    var executionId = execution.control.executionId;
    var completion = {
      status: "completed",
      completionRevision: 1,
      graphDigest: "#events:0::",
      summary: "The independently verified read-only review is complete.",
      verification: "The stored review evidence is complete and exact.",
      integrationVerification: "yes",
      escalationRequired: "no",
      portfolioTaskId: execution.portfolioTaskId,
      bindingRevision: execution.bindingRevision,
      completedAt: 1788656959403,
    };
    session.orchestrationProjectCompletion = completion;
    execution.ownerAcceptanceRequired = true;
    execution.ownerAcceptance = {
      status: "pending",
      source: "project_local_instructions",
    };
    finishControlledExecution(session, "needs_input", { control: control });
    var durable = control.inspect(executionId);
    execution.status = "failed";
    execution.reason = "needs_input";
    execution.terminalAt = durable.execution.finishedAt;
    session.isProcessing = false;
    control.close();

    delete session._coopExecutionFence;
    var recoveredControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var deliveries = [];
    var completions = [];
    var crossProject = {
      createEnvelope: function (value) { return value; },
      completeProjectCoordinatorExecution: function (value) {
        completions.push(value);
        return { ok: true };
      },
      deliverEnvelope: function (value) {
        deliveries.push(value);
        return { ok: true };
      },
    };
    var gate = attachCompletionGate({
      sm: runtime.sm,
      flushCoordinatorUpdates: function () { return false; },
      queueCoordinatorUpdate: function () {},
      sendState: function () {},
      crossProject: crossProject,
      finishControlledExecution: function (targetSession, status) {
        return finishControlledExecution(targetSession, status, { control: recoveredControl });
      },
    });

    gate.restore(session);
    assert.equal(execution.status, "failed",
      "the completion gate runs before durable target reconciliation and must not invent a fence");
    var reconciled = 0;
    var delivery = deliveryModule.createDeliveryControl({
      enabled: true,
      store: recoveredControl.getStore(),
    });
    var recoveredRuntime = target(recoveredControl, [], {
      deliveryControl: delivery,
      sessions: runtime.sessions,
      reconcileSettledReview: function (targetSession) {
        reconciled++;
        gate.restore(targetSession);
      },
    });
    assert.equal(recoveredRuntime.attached.reconcilePersistedSessions(), true);
    assert.equal(reconciled, 1,
      "the post-control startup pass retries only the settled review completion");
    assert.equal(execution.status, "completed");
    assert.equal(completions.length, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(session.orchestrationProjectCompletion, completion,
      "the existing authenticated completion is replayed rather than recreated");
    assert.equal(recoveredRuntime.attached.reconcilePersistedSessions(), false,
      "a replay leaves the original failed execution terminal and adds no lease");
    durable = recoveredControl.inspect(executionId);
    assert.equal(durable.execution.status, "failed");
    assert.equal(durable.current.failureCode, "needs_input");
    assert.equal(durable.leases.length, 0);
    assert.equal(completions.length, 1,
      "a repeated typed reconciliation does not create another completion");
    assert.equal(deliveries.length, 1,
      "a repeated typed reconciliation does not send another delivery");
    delivery.close();
    recoveredControl.close();
  } finally {
    restoreFlags();
    h.cleanup();
  }
});

availableTest("terminal review attention durably releases its controlled execution lease", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var root = {
      localId: 99,
      storageId: "review-attention-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      orchestrationTasks: [],
      orchestrationEvents: [],
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(root.localId, root);
    var request = coordinatorEnvelope(621, root.storageId);
    request.payload.reviewOnly = true;
    runtime.attached.handleEnvelope(request);
    var session = controlledSession(runtime);
    var metadata = session.orchestrationPolicy.portfolioExecution.control;
    session.history.push({ type: "delta", text: "WORKER_STATUS: needs_input\n" +
      "REASON: owner_decision_required\nSUMMARY: Review found a decision for the owner.\n" +
      "VERIFICATION: read-only review complete\nESCALATION_REQUIRED: yes" });
    var gate = attachCompletionGate({
      sm: runtime.sm,
      flushCoordinatorUpdates: function () { return false; },
      queueCoordinatorUpdate: function () {},
      sendState: function () {},
      finishControlledExecution: function (targetSession, status) {
        return finishControlledExecution(targetSession, status, { control: control });
      },
    });

    gate.handleTurnDone(session);

    var durable = control.inspect(metadata.executionId);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "needs_input");
    assert.equal(durable.execution.status, "failed");
    assert.equal(durable.current.startState, "failed");
    assert.equal(durable.current.failureCode, "needs_input");
    assert.equal(durable.leases.length, 0);
    control.close();

    delete session._coopExecutionFence;
    var recoveredControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var recoveredTarget = require("../lib/coop-control-execution-target").createTargetExecutionControl({
      coopExecutionControl: recoveredControl,
      projectId: function () { return PROJECT_A; },
    });
    assert.equal(recoveredTarget.reconcileSession(session,
      session.orchestrationPolicy.portfolioExecution), false);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "needs_input");
    recoveredControl.close();
  } finally {
    h.cleanup();
  }
});

availableTest("ordinary coordinator needs-input reaches the owner attention transport", function () {
  var h = harness();
  try {
    var timeline = [];
    var deliveries = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline, { crossProject: {
      createEnvelope: function (value) { return value; },
      deliverEnvelope: function (value) {
        deliveries.push(value);
        return { ok: true, delivered: true, acknowledged: true };
      },
      getExecutionBinding: function () { return null; },
    } });
    var root = {
      localId: 98,
      storageId: "ordinary-needs-input-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      orchestrationTasks: [],
      orchestrationEvents: [],
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(root.localId, root);
    runtime.attached.handleEnvelope(coordinatorEnvelope(622, root.storageId));
    var session = controlledSession(runtime);
    var metadata = session.orchestrationPolicy.portfolioExecution;
    session.isProcessing = false;
    session.history.push({ type: "delta", text: "WORKER_STATUS: needs_input\n" +
      "REASON: one_owner_decision\nSUMMARY: The owner must choose one option.\n" +
      "VERIFICATION: diagnosis complete\nESCALATION_REQUIRED: no" });
    var gate = attachCompletionGate({
      crossProject: {
        createEnvelope: function (value) { return value; },
        deliverEnvelope: function (value) {
          deliveries.push(value);
          return { ok: true, delivered: true, acknowledged: true };
        },
      },
      sm: runtime.sm,
      flushCoordinatorUpdates: function () { return false; },
      queueCoordinatorUpdate: function () {},
      sendState: function () {},
      finishControlledExecution: function (targetSession, status) {
        return finishControlledExecution(targetSession, status, { control: control });
      },
    });

    gate.handleTurnDone(session);

    assert.equal(metadata.status, "needs_input");
    assert.equal(deliveries.length, 1, "every needs-input result must reach the owner transport");
    assert.equal(deliveries[0].payload.terminalStatus, "needs_input");
    assert.equal(deliveries[0].payload.ownerNotification, true);
    assert.equal(typeof metadata.attentionDeliveredAt, "number");
    var durable = control.inspect(metadata.control.executionId);
    assert.equal(durable.execution.status, "running",
      "an ordinary waiting coordinator retains its reusable control lease");
    assert.equal(durable.current.startState, "started");

    delete metadata.attentionDeliveredAt;
    delete metadata.ownerAcceptanceAttentionResultEventId;
    delete metadata.ownerAcceptanceAttentionDeliveryEventId;
    session.history = [];
    deliveries.length = 0;
    gate.handleTurnDone(session);
    assert.equal(deliveries.length, 1,
      "persisted needs-input metadata must surface even when its report is empty");
    assert.equal(deliveries[0].payload.resultSummary,
      "Read-only verification returned actionable attention.");
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("a restarted needs-input coordinator accepts steering on its active incarnation", function () {
  var h = harness();
  try {
    var firstTimeline = [];
    var firstControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var firstRuntime = target(firstControl, firstTimeline);
    var root = {
      localId: 97,
      storageId: "restart-needs-input-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      orchestrationTasks: [],
      orchestrationEvents: [],
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    firstRuntime.sessions.set(root.localId, root);
    var create = coordinatorEnvelope(623, root.storageId);
    create.payload.ownerAcceptanceRequired = true;
    firstRuntime.attached.handleEnvelope(create);
    var session = controlledSession(firstRuntime);
    var metadata = session.orchestrationPolicy.portfolioExecution;
    var executionId = metadata.control.executionId;
    firstControl.close();

    delete session._coopExecutionFence;
    var recoveredControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var recoveredToken = recoveredControl.recoverTarget({
      projectId: PROJECT_A,
      sessionStorageId: session.storageId,
    });
    metadata.control = executionFence.attachFence(session,
      recoveredControl.createFence(recoveredToken));
    session._coopExecutionFence.markProviderStarted();
    session.isProcessing = false;
    metadata.status = "needs_input";
    metadata.reason = "awaiting_owner_acceptance";

    var delivery = deliveryModule.createDeliveryControl({
      enabled: true,
      store: recoveredControl.getStore(),
    });
    var recoveredTimeline = [];
    var recoveredRuntime = target(recoveredControl, recoveredTimeline, {
      deliveryControl: delivery,
      sessions: firstRuntime.sessions,
      startupRecovery: { assertReady: function () { return true; } },
    });
    var historyLength = session.history.length;
    var result = recoveredRuntime.attached.handleEnvelope(
      messageEnvelope(624, "Record the verified result and close the owned task."));

    assert.equal(result.ok, true);
    assert.equal(result.localSessionId, session.localId);
    assert.equal(session.history.length, historyLength + 1);
    assert.equal(session.history[session.history.length - 1].text,
      "Record the verified result and close the owned task.");
    assert.equal(metadata.status, "running");
    var durable = recoveredControl.inspect(executionId);
    assert.equal(durable.execution.currentEpoch, 2,
      "steering must reuse the restart incarnation instead of minting epoch 3");
    assert.equal(durable.execution.status, "running");
    assert.equal(durable.current.startState, "started");
    assert.equal(delivery.inspectOutbox("event-624").state, "acked");
    assert.equal(delivery.listPendingEffects().length, 0);
    delivery.close();
    recoveredControl.close();
  } finally {
    h.cleanup();
  }
});

availableTest("restart hydrates a coordinator projection after durable completion commits", function () {
  var h = harness();
  var restoreFlags = enableExecutionFlags();
  try {
    var timeline = [];
    var firstControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(firstControl, timeline);
    var session = {
      localId: 99,
      storageId: "restart-completing-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      orchestrationTasks: [],
      orchestrationEvents: [],
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(session.localId, session);
    runtime.attached.handleEnvelope(coordinatorEnvelope(63, session.storageId));
    session = controlledSession(runtime);
    var metadata = session.orchestrationPolicy.portfolioExecution.control;
    session.history.push({ type: "delta", text: "PROJECT_COMPLETED: yes\n" +
      "SUMMARY: Integrated.\nVERIFICATION: suite passed\n" +
      "INTEGRATION_VERIFIED: yes\nESCALATION_REQUIRED: no" });
    session._coopExecutionFence.complete();
    delete session._coopExecutionFence;
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "running");
    firstControl.close();

    var recoveredControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var gate = attachCompletionGate({
      sm: runtime.sm,
      flushCoordinatorUpdates: function () { return false; },
      queueCoordinatorUpdate: function () {},
      sendState: function () {},
      finishControlledExecution: function (targetSession, status) {
        return finishControlledExecution(targetSession, status, { control: recoveredControl });
      },
    });

    assert.doesNotThrow(function () { gate.restore(session); });
    var durable = recoveredControl.inspect(metadata.executionId);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "completed");
    assert.equal(durable.execution.status, "completed");
    assert.equal(durable.current.startState, "completed");
    assert.equal(durable.leases.length, 0);
    recoveredControl.close();
  } finally {
    restoreFlags();
    h.cleanup();
  }
});

[true, false].forEach(function (persisted) {
availableTest("restart defers " + (persisted ? "a saved" : "a transcript") +
  " completion while its controlled execution awaits recovery", function () {
  var h = harness();
  var restoreFlags = enableExecutionFlags();
  try {
    var timeline = [];
    var firstControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(firstControl, timeline);
    var session = {
      localId: 99,
      storageId: "restart-completing-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      orchestrationTasks: [],
      orchestrationEvents: [],
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(session.localId, session);
    runtime.attached.handleEnvelope(coordinatorEnvelope(63, session.storageId));
    session = controlledSession(runtime);
    var metadata = session.orchestrationPolicy.portfolioExecution.control;
    session.history.push({ type: "delta", text: "PROJECT_COMPLETED: yes\n" +
      "SUMMARY: Integrated.\nVERIFICATION: suite passed\n" +
      "INTEGRATION_VERIFIED: yes\nESCALATION_REQUIRED: no" });
    if (persisted) taskGraph.completeProject(session, {
      summary: "Integrated.", verification: "suite passed",
      integrationVerification: "yes", escalationRequired: "no",
      integrationVerified: true, escalationVerified: true,
    });
    if (persisted) assert.equal(session.orchestrationProjectCompletion.status, "completed");
    delete session._coopExecutionFence;
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "running");
    firstControl.close();

    var recoveredControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var gate = attachCompletionGate({
      sm: runtime.sm,
      flushCoordinatorUpdates: function () { return false; },
      queueCoordinatorUpdate: function () {},
      sendState: function () {},
      finishControlledExecution: function (targetSession, status) {
        return finishControlledExecution(targetSession, status, { control: recoveredControl });
      },
    });

    assert.doesNotThrow(function () { gate.restore(session); });
    var durable = recoveredControl.inspect(metadata.executionId);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "running");
    assert.equal(durable.execution.status, "running");
    assert.equal(durable.leases.length, 1);
    assert.throws(function () { gate.handleTurnDone(session); },
      function (cause) { return cause.code === "COOP_CONTROL_FENCE_MISSING"; });
    var token = recoveredControl.recoverTarget({
      projectId: PROJECT_A, sessionStorageId: session.storageId,
    });
    session.orchestrationPolicy.portfolioExecution.control =
      executionFence.attachFence(session, recoveredControl.createFence(token));
    session._coopExecutionFence.markProviderStarted();
    var currentIncarnation = session.orchestrationPolicy.portfolioExecution.control.incarnationId;
    session.orchestrationPolicy.portfolioExecution.control.incarnationId = "inc:stale";
    assert.throws(function () { gate.restore(session); },
      function (cause) { return cause.code === "COOP_CONTROL_FENCE_MISSING"; });
    session.orchestrationPolicy.portfolioExecution.control.incarnationId = currentIncarnation;
    assert.doesNotThrow(function () { gate.restore(session); });
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "completed");
    assert.equal(recoveredControl.inspect(metadata.executionId).execution.status, "completed");
    recoveredControl.close();
  } finally {
    restoreFlags();
    h.cleanup();
  }
});
});

availableTest("restart completion replay rejects mismatched durable metadata", function () {
  var h = harness();
  var restoreFlags = enableExecutionFlags();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var session = {
      localId: 99,
      storageId: "mismatched-restart-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(session.localId, session);
    runtime.attached.handleEnvelope(coordinatorEnvelope(64, session.storageId));
    session = controlledSession(runtime);
    session._coopExecutionFence.complete();
    delete session._coopExecutionFence;
    session.orchestrationPolicy.portfolioExecution.control.incarnationId = "inc:stale";

    assert.throws(function () {
      finishControlledExecution(session, "completed", { control: control });
    }, function (cause) { return cause && cause.code === "COOP_CONTROL_FENCE_MISSING"; });
    control.close();
  } finally {
    restoreFlags();
    h.cleanup();
  }
});

availableTest("a failed reused coordinator retries at a new epoch and resets visible status", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var session = {
      localId: 99,
      storageId: "retry-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(session.localId, session);
    runtime.attached.handleEnvelope(coordinatorEnvelope(3, session.storageId));
    session = controlledSession(runtime);
    session._coopExecutionFence.abandon("retry");
    session.isProcessing = false;
    var metadata = session.orchestrationPolicy.portfolioExecution;
    metadata.status = "failed";
    metadata.reason = "provider_failed";
    metadata.terminalAt = Date.now();
    var result = runtime.attached.handleEnvelope(coordinatorEnvelope(4, session.storageId));
    metadata = session.orchestrationPolicy.portfolioExecution;
    assert.equal(result.ok, true);
    assert.equal(result.reused, true);
    assert.equal(metadata.status, "running");
    assert.equal(metadata.reason, undefined);
    assert.equal(metadata.terminalAt, undefined);
    var durable = control.inspect(metadata.control.executionId);
    assert.equal(durable.execution.currentEpoch, 2);
    assert.equal(durable.current.startState, "started");
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("a stale provider-start promise cannot fail a newer coordinator incarnation", async function () {
  var h = harness();
  try {
    var timeline = [];
    var firstResolve;
    var starts = 0;
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline, {
      startQuery: function () {
        starts++;
        if (starts === 1) {
          return new Promise(function (resolve) { firstResolve = resolve; });
        }
        return Promise.resolve();
      },
    });
    var session = {
      localId: 99,
      storageId: "stale-start-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(session.localId, session);
    runtime.attached.handleEnvelope(coordinatorEnvelope(60, session.storageId));
    session = controlledSession(runtime);
    session._coopExecutionFence.abandon("retry");
    session.isProcessing = false;
    session.orchestrationPolicy.portfolioExecution.status = "failed";

    runtime.attached.handleEnvelope(coordinatorEnvelope(61, session.storageId));
    var current = session.orchestrationPolicy.portfolioExecution.control;
    assert.equal(current.epoch, 2);
    firstResolve({ ok: false, reason: "late_provider_failure" });
    await new Promise(function (resolve) { setImmediate(resolve); });

    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "running");
    assert.equal(control.inspect(current.executionId).execution.status, "running");
    assert.equal(control.inspect(current.executionId).current.epoch, 2);
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("a stopped direct leaf ignores its late provider-start failure", async function () {
  var h = harness();
  try {
    var timeline = [];
    var resolveStart;
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline, {
      startQuery: function () {
        return new Promise(function (resolve) { resolveStart = resolve; });
      },
    });
    var result = runtime.attached.handleEnvelope(envelope(66));
    var session = runtime.sessions.get(result.localSessionId);
    var metadata = session.orchestrationPolicy.portfolioExecution.control;

    var stopped = runtime.attached.handleEnvelope(stopEnvelope(67));
    assert.equal(stopped.ok, true);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "superseded");
    resolveStart({ ok: false, reason: "late_provider_failure" });
    await new Promise(function (resolve) { setImmediate(resolve); });

    assert.equal(runtime.sessions.has(session.localId), true);
    assert.equal(session.isProcessing, false);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "superseded");
    assert.equal(session.orchestrationPolicy.portfolioExecution.reason, "scope_expansion");
    var durable = control.inspect(metadata.executionId);
    assert.equal(durable.execution.status, "failed");
    assert.equal(durable.current.failureCode, "scope_expansion");
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("session creation failure terminalizes the reserved attempt before retry", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline, { createSessionError: "injected session creation" });
    assert.throws(function () {
      runtime.attached.handleEnvelope(envelope(5));
    }, /injected session creation/);
    var retry = control.reserveStart({
      portfolioTaskId: "portfolio-controlled-task",
      bindingRevision: 1,
      idempotencyKey: "portfolio-controlled-task-r1",
      mode: "direct_leaf",
      targetProject: { projectId: PROJECT_A },
      source: { projectId: "system-lead", sessionStorageId: COOP_SESSION },
    });
    assert.equal(retry.epoch, 2);
    var durable = control.inspect(retry.executionId);
    assert.equal(durable.incarnations[0].startState, "failed");
    assert.equal(runtime.sessions.size, 0);
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("an asynchronously reported provider-start failure removes the new controlled session", async function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline, {
      abandonOnStartFailure: true,
      startResult: { ok: false, reason: "provider_unavailable" },
    });
    var result = runtime.attached.handleEnvelope(envelope(6));
    assert.equal(result.ok, true);
    var session = runtime.sessions.get(result.localSessionId);
    var metadata = session.orchestrationPolicy.portfolioExecution.control;
    await new Promise(function (resolve) { setImmediate(resolve); });
    assert.equal(runtime.sessions.size, 0);
    var durable = control.inspect(metadata.executionId);
    assert.equal(durable.execution.status, "failed");
    assert.equal(durable.current.startState, "failed");
    assert.equal(durable.leases.length, 0);
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("controlled infrastructure start failures restaff from persisted bindings before discard", async function () {
  var failures = ["provider_start_failed", "App-server not started", "watchdog:provider_start"];
  for (var i = 0; i < failures.length; i++) {
    var h = harness();
    try {
      var timeline = [];
      var bindings = createBindings({ file: path.join(path.dirname(h.dbPath), "bindings.json") });
      var request = envelope(67);
      request.payload.portfolioTaskId += "-infrastructure-" + i;
      request.payload.idempotencyKey = request.payload.portfolioTaskId + "-r1";
      request.payload.coopTopicRef = { topicId: "owner-approved-provider-recovery" };
      request.payload.coopApprovalIngressId = "coop:canonical-coop:410";
      request.payload.coopIngressId = "coop:canonical-coop:410";
      var first = Object.assign({}, request.payload, { source: request.source });
      assert.equal(bindings.reserve(first).ok, true);
      assert.equal(bindings.commit(first.portfolioTaskId, first.bindingRevision, {
        projectId: PROJECT_A, sessionStorageId: "controlled-session-1",
      }).ok, true);
      var dispatched = [];
      var sessions = new Map();
      var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
      var runtime = target(control, timeline, {
        abandonOnStartFailure: true,
        startResult: { ok: false, reason: failures[i] },
        sessions: sessions,
        crossProject: {
          reconcileStrandedCompletions: function () {
            return bindings.reconcileStrandedCompletions({
              sessionForBinding: function () {
                return Array.from(sessions.values())[0] || null;
              },
              saveSession: function () {},
            });
          },
          getExecutionBinding: bindings.get,
          createProjectExecution: function (input) {
            assert.equal(bindings.get(first.portfolioTaskId, 1).status, "failed",
              "the original binding must be durably failed before successor dispatch");
            assert.equal(input.portfolioTaskId, first.portfolioTaskId);
            assert.equal(input.bindingRevision, 2);
            assert.equal(input.coopApprovalIngressId, first.coopApprovalIngressId);
            assert.deepEqual(input.coopTopicRef, first.coopTopicRef);
            dispatched.push(input);
            assert.equal(bindings.reserve(input).ok, true);
            assert.equal(bindings.commit(input.portfolioTaskId, input.bindingRevision, {
              projectId: PROJECT_A, sessionStorageId: "successor-controlled-session",
            }).ok, true);
            return { ok: true, binding: bindings.get(input.portfolioTaskId, input.bindingRevision) };
          },
        },
      });

      assert.equal(runtime.attached.handleEnvelope(request).ok, true);
      await new Promise(function (resolve) { setImmediate(resolve); });
      assert.equal(runtime.sessions.size, 0);
      assert.equal(dispatched.length, 1);
      assert.equal(bindings.get(first.portfolioTaskId, 1).status, "failed");
      assert.equal(bindings.get(first.portfolioTaskId, 1).failureCode, failures[i]);
      assert.equal(bindings.get(first.portfolioTaskId, 2).status, "active");
      control.close();
    } finally {
      h.cleanup();
    }
  }
});

test("target replay equivalence includes provider, model, and normalized task payload", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, env: {} });
    var runtime = target(control, timeline);
    var first = envelope(70);
    first.payload.provider = " codex ";
    first.payload.model = " gpt-5.6-sol ";
    first.payload.context = "  Exact context.  ";
    var created = runtime.attached.handleEnvelope(first);
    assert.equal(created.ok, true);
    assert.equal(runtime.sessions.size, 1);

    var exact = envelope(71);
    exact.payload.provider = "codex";
    exact.payload.model = "gpt-5.6-sol";
    exact.payload.context = "Exact context.";
    var replay = runtime.attached.handleEnvelope(exact);
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(runtime.sessions.size, 1, "exact retry cannot duplicate the session");

    [
      { provider: "claude", model: "gpt-5.6-sol", context: "Exact context." },
      { provider: "codex", model: "gpt-5.6-terra", context: "Exact context." },
      { provider: "codex", model: "gpt-5.6-sol", context: "Changed context." },
    ].forEach(function (change, index) {
      var changed = envelope(72 + index);
      changed.payload.provider = change.provider;
      changed.payload.model = change.model;
      changed.payload.context = change.context;
      var conflict = runtime.attached.handleEnvelope(changed);
      assert.equal(conflict.ok, false);
      assert.equal(conflict.reason, "idempotency_conflict");
      assert.equal(runtime.sessions.size, 1);
    });

    var metadata = controlledSession(runtime).orchestrationPolicy.portfolioExecution;
    assert.equal(metadata.provider, "codex");
    assert.equal(metadata.model, "gpt-5.6-sol");
    assert.match(metadata.taskPayloadDigest, /^[a-f0-9]{64}$/);
    assert.equal(metadata.controlPlaneProvenance.version, 1);
  } finally {
    h.cleanup();
  }
});

test("structured provider-start failure code and details survive on execution metadata", async function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, env: {} });
    var runtime = target(control, timeline, {
      startResult: {
        ok: false,
        reason: "provider_unavailable",
        code: "provider_route_unavailable",
        details: { provider: "codex", model: "gpt-5.6-sol", retryable: true },
      },
    });
    var result = runtime.attached.handleEnvelope(envelope(76));
    var session = runtime.sessions.get(result.localSessionId);
    await new Promise(function (resolve) { setImmediate(resolve); });

    var metadata = session.orchestrationPolicy.portfolioExecution;
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.reason, "provider_unavailable");
    assert.equal(metadata.failureCode, "provider_route_unavailable");
    assert.deepEqual(metadata.failureDetails,
      { provider: "codex", model: "gpt-5.6-sol", retryable: true });
  } finally {
    h.cleanup();
  }
});

availableTest("provider-start failure removes only the new task coordinator and preserves the project root", async function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline, {
      abandonOnStartFailure: true,
      startResult: { ok: false, reason: "provider_unavailable" },
    });
    var session = {
      localId: 99,
      storageId: "failed-start-coordinator",
      coordinationMode: true,
      orchestrationPolicy: {},
      history: [],
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
    };
    runtime.sessions.set(session.localId, session);

    runtime.attached.handleEnvelope(coordinatorEnvelope(65, session.storageId));
    session = controlledSession(runtime);
    var metadata = session.orchestrationPolicy.portfolioExecution.control;
    await new Promise(function (resolve) { setImmediate(resolve); });

    assert.equal(runtime.sessions.has(session.localId), false);
    assert.equal(runtime.sessions.has(99), true);
    assert.equal(runtime.sessions.get(99).orchestrationTasks.length, 0);
    assert.equal(session.isProcessing, false);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "failed");
    var durable = control.inspect(metadata.executionId);
    assert.equal(durable.execution.status, "failed");
    assert.equal(durable.current.startState, "failed");
    assert.equal(durable.leases.length, 0);
    control.close();
  } finally {
    h.cleanup();
  }
});

test("provider-start failure retains the historical flag-off session behavior", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, env: {} });
    var runtime = target(control, timeline, { startError: "ordinary provider failure" });
    var result = runtime.attached.handleEnvelope(envelope(8));
    assert.equal(result.ok, true);
    assert.equal(runtime.sessions.size, 1);
    var session = runtime.sessions.get(result.localSessionId);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "failed");
    assert.equal(fs.existsSync(h.dbPath), false);
  } finally {
    h.cleanup();
  }
});

availableTest("restart reconciliation preserves a durable completion committed before session metadata", function () {
  var h = harness();
  try {
    var initialTimeline = [];
    var firstControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var initial = target(firstControl, initialTimeline);
    var result = initial.attached.handleEnvelope(envelope(7));
    var session = initial.sessions.get(result.localSessionId);
    var controlMetadata = session.orchestrationPolicy.portfolioExecution.control;
    session._coopExecutionFence.complete();
    delete session._coopExecutionFence;
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "running");
    assert.equal(firstControl.inspect(controlMetadata.executionId).execution.status, "completed");
    firstControl.close();

    var recoveryTimeline = [];
    var recoveredControl = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    assert.equal(recoveredControl.recoverIncomplete(), 0);
    target(recoveredControl, recoveryTimeline, { sessions: initial.sessions });
    var metadata = session.orchestrationPolicy.portfolioExecution;
    assert.equal(metadata.status, "completed");
    assert.equal(metadata.reason, undefined);
    assert.ok(metadata.completedAt);
    assert.ok(recoveryTimeline.indexOf("delivery") !== -1);
    recoveredControl.close();
  } finally {
    h.cleanup();
  }
});

availableTest("every injected pre-start crash point yields zero provider starts and converges", async function () {
  var phases = ["afterReserve", "afterBind", "afterBarrier", "beforeProviderStart"];
  for (var i = 0; i < phases.length; i++) {
    var h = harness();
    try {
      var phase = phases[i];
      var timeline = [];
      var captured = null;
      var faults = {};
      faults[phase] = function (token) {
        captured = token;
        throw new Error("injected " + phase);
      };
      var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true, faults: faults });
      var runtime = target(control, timeline);
      if (phase === "beforeProviderStart") {
        assert.equal(runtime.attached.handleEnvelope(envelope(i + 10)).ok, true);
      } else {
        assert.throws(function () {
          runtime.attached.handleEnvelope(envelope(i + 10));
        }, new RegExp("injected " + phase), phase);
      }
      if (phase === "beforeProviderStart") {
        await new Promise(function (resolve) { setImmediate(resolve); });
      }
      assert.equal(timeline.indexOf("provider"), -1, phase);
      if (phase === "afterReserve") assert.equal(control.recoverIncomplete(), 1);
      if (phase !== "afterReserve") assert.equal(runtime.sessions.size, 0, phase);
      var durable = control.inspect(captured.executionId);
      assert.equal(durable.execution.status, "failed", phase);
      assert.equal(durable.leases.length, 0, phase);
      control.close();
    } finally {
      h.cleanup();
    }
  }
});

availableTest("an injected execution commit failure is atomic and retries at epoch one", function () {
  var h = harness();
  try {
    var fail = false;
    var control = executions.createExecutionControl({
      dbPath: h.dbPath,
      enabled: true,
      storeFaults: {
        beforeExecutionCommit: function () { if (fail) throw new Error("injected execution commit"); },
      },
    });
    var timeline = [];
    var runtime = target(control, timeline);
    fail = true;
    assert.throws(function () {
      runtime.attached.handleEnvelope(envelope(30));
    }, /injected execution commit/);
    assert.deepEqual(timeline, []);
    fail = false;
    var result = runtime.attached.handleEnvelope(envelope(31));
    var session = runtime.sessions.get(result.localSessionId);
    var durable = control.inspect(session.orchestrationPolicy.portfolioExecution.control.executionId);
    assert.equal(durable.execution.currentEpoch, 1);
    assert.equal(durable.incarnations.length, 1);
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("stale progress and completion cannot mutate an older target session", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var result = runtime.attached.handleEnvelope(envelope(40));
    var session = runtime.sessions.get(result.localSessionId);
    session._coopExecutionFence.abandon("retry");
    var successor = control.reserveStart({
      portfolioTaskId: "portfolio-controlled-task",
      bindingRevision: 1,
      idempotencyKey: "portfolio-controlled-task-r1",
      mode: "direct_leaf",
      targetProject: { projectId: PROJECT_A },
      source: { projectId: "system-lead", sessionStorageId: COOP_SESSION },
    });
    assert.equal(successor.epoch, 2);

    var report = runtime.attached.wrapReport(function () { throw new Error("unexpected fallback"); });
    assert.throws(function () {
      report({
        taskId: "portfolio-controlled-task",
        workerSessionId: session.storageId,
        activity: "stale progress",
        progress: 90,
      });
    }, function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; });
    assert.equal(session.orchestrationPolicy.portfolioExecution.currentActivity, undefined);

    session.history.push({
      type: "delta",
      text: "WORKER_STATUS: completed\nSUMMARY: stale\nVERIFICATION: none\nESCALATION_REQUIRED: no",
    });
    assert.throws(function () {
      session._subscriber({ type: "done", code: 0 });
    }, function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; });
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "running");
    assert.equal(timeline.indexOf("delivery"), -1);
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("messages route to the active incarnation after a controlled retry", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var runtime = target(control, timeline);
    var firstResult = runtime.attached.handleEnvelope(envelope(50));
    var first = runtime.sessions.get(firstResult.localSessionId);
    first._coopExecutionFence.abandon("retry");
    first.orchestrationPolicy.portfolioExecution.status = "failed";
    var secondResult = runtime.attached.handleEnvelope(envelope(51));
    var second = runtime.sessions.get(secondResult.localSessionId);
    assert.notEqual(second.localId, first.localId);
    var before = second.history.length;
    var messageResult = runtime.attached.handleEnvelope(messageEnvelope(52, "continue active attempt"));
    assert.equal(messageResult.ok, true);
    assert.equal(messageResult.localSessionId, second.localId);
    assert.equal(second.history.length, before + 1);
    assert.equal(first.history.some(function (item) {
      return item && item.text === "continue active attempt";
    }), false);
    control.close();
  } finally {
    h.cleanup();
  }
});

availableTest("enabled target delivery remains logically exactly once after more than 64 commands", function () {
  var h = harness();
  try {
    var timeline = [];
    var control = executions.createExecutionControl({ dbPath: h.dbPath, enabled: true });
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: control.getStore() });
    var runtime = target(control, timeline, { deliveryControl: delivery,
      startupRecovery: { assertReady: function () { return true; } } });
    var result = runtime.attached.handleEnvelope(envelope(70));
    var session = runtime.sessions.get(result.localSessionId);
    var initialLength = session.history.length;
    for (var i = 0; i < 70; i++) {
      assert.equal(runtime.attached.handleEnvelope(messageEnvelope(100 + i, "command " + i)).ok, true);
    }
    assert.equal(session.history.length, initialLength + 70);
    assert.equal(delivery.listInbox().length, 70);
    assert.equal(session.orchestrationPolicy.portfolioExecution.appliedCommandIds, undefined);
    assert.equal(runtime.attached.handleEnvelope(messageEnvelope(100, "command 0")).ok, true);
    assert.equal(session.history.length, initialLength + 70);
    assert.equal(delivery.listInbox().length, 70);
    delivery.close();
    control.close();
  } finally {
    h.cleanup();
  }
});
