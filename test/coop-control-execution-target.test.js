var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var controlStore = require("../lib/coop-control-store");
var executions = require("../lib/coop-control-executions");
var external = require("../lib/project-task-orchestrator-external");
var attachCompletionGate =
  require("../lib/project-task-orchestrator-completion").attachCompletionGate;
var finishControlledExecution =
  require("../lib/coop-control-execution-completion").finishControlledExecution;

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
    coopExecutionControl: control,
    crossProject: {
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

availableTest("reused project coordinators receive a durable incarnation before provider start", function () {
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
    assert.equal(result.ok, true);
    assert.equal(result.reused, true);
    assert.equal(result.localSessionId, session.localId);
    assert.equal(timeline.indexOf("session"), -1);
    assert.ok(session.orchestrationPolicy.portfolioExecution.control);
    var metadata = session.orchestrationPolicy.portfolioExecution.control;
    var durable = control.inspect(metadata.executionId);
    assert.equal(durable.current.sessionRef.sessionStorageId, session.storageId);
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

availableTest("provider-start failure settles a reused coordinator without touching a successor", async function () {
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
    var metadata = session.orchestrationPolicy.portfolioExecution.control;
    await new Promise(function (resolve) { setImmediate(resolve); });

    assert.equal(runtime.sessions.has(session.localId), true);
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

availableTest("every injected pre-start crash point yields zero provider starts and converges", function () {
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
