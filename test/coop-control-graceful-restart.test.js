var test = require("node:test");
var assert = require("node:assert");
var crypto = require("crypto");
var childProcess = require("child_process");
var fs = require("fs");
var net = require("net");
var os = require("os");
var path = require("path");

var compaction = require("../lib/project-session-compaction");
var executionFence = require("../lib/coop-control-fence");
var executions = require("../lib/coop-control-executions");
var handoffs = require("../lib/coop-control-handoff");
var startupModule = require("../lib/coop-control-startup");
var storeModule = require("../lib/coop-control-store");
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;

var NO_EXACT_TARGET = "An active controlled execution has no exact checkpointable target session.";
var DRAIN_BEFORE_STARTUP =
  "Controlled execution ingress cannot drain before startup recovery completes.";

var SOURCE = { projectId: "system-lead", sessionStorageId: "coop-home" };
var PROJECT_A = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var PROJECT_B = "ad8c7932-da3c-4d0b-879b-eb7c847cb64d";

function availableTest(name, fn) {
  test(name, { skip: !storeModule.isControlStoreAvailable() }, fn);
}

function harness(options) {
  var opts = options || {};
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-graceful-control-restart-"));
  var dbPath = path.join(dir, "control.sqlite");
  var bindingFile = path.join(dir, "bindings.json");
  var store = storeModule.openControlStore({ dbPath: dbPath, faults: opts.faults });
  var control = executions.createExecutionControl({ enabled: true, store: store });
  var managers = Object.create(null);
  var startupGate = { enabled: true, assertReady: function () { return true; } };
  var router = createCrossProjectRouter({
    bindingFile: bindingFile,
    coopExecutionControl: control,
    coopStartupRecovery: startupGate,
  });

  function manager(projectId) {
    if (!managers[projectId]) {
      var nextLocalId = 1000;
      var sm = { sessions: new Map(), saves: 0, recorded: [],
        saveSessionFile: function () { sm.saves += 1; },
        broadcastSessionList: function () {},
        // Enough of the real SessionManager surface for the compaction module.
        createSessionRaw: function (created) {
          var session = Object.assign({ localId: nextLocalId++, history: [] }, created);
          sm.sessions.set(session.localId, session);
          return session;
        },
        sendAndRecord: function (session, event) {
          sm.recorded.push({ localId: session.localId, event: event });
          if (Array.isArray(session.history)) session.history.push(event);
        },
        switchSession: function () {},
      };
      managers[projectId] = sm;
      router.registerProjectResolver({
        getProjectId: function () { return projectId; },
        getSessionManager: function () { return sm; },
        deliverCrossProjectEnvelope: function () { return { ok: true }; },
      });
    }
    return managers[projectId];
  }

  function addExecution(input) {
    var spec = input || {};
    var taskId = spec.taskId;
    var revision = spec.revision || 1;
    var projectId = spec.projectId;
    var mode = spec.mode || "project_coordinator";
    var ref = { projectId: projectId, sessionStorageId: spec.sessionStorageId };
    var request = {
      source: SOURCE,
      portfolioTaskId: taskId,
      bindingRevision: revision,
      idempotencyKey: taskId + "-r" + revision,
      mode: mode,
      targetProject: { projectId: projectId },
    };
    assert.equal(router.bindingStore.reserve(request).ok, true);
    assert.equal(router.bindingStore.commit(taskId, revision, ref).ok, true);
    var token = control.reserveStart(request);
    control.bindStart(token, ref);
    control.openStartBarrier(token);
    control.markProviderStarted(token);
    var fence = control.createFence(token);
    var session = {
      localId: spec.localId || manager(projectId).sessions.size + 1,
      storageId: ref.sessionStorageId,
      title: spec.title || "Controlled " + taskId,
      history: [],
      isProcessing: true,
      orchestrationPolicy: { portfolioExecution: Object.assign({}, request, {
        status: "running",
        source: SOURCE,
        control: executionFence.metadataForFence(fence),
      }) },
    };
    executionFence.attachFence(session, fence);
    manager(projectId).sessions.set(session.localId, session);
    return { ref: ref, request: request, session: session, token: token };
  }

  function cleanup() {
    try { control.close(); } catch (error) {}
    try { store.close(); } catch (error) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { addExecution: addExecution, bindingFile: bindingFile, cleanup: cleanup,
    control: control, dbPath: dbPath, dir: dir, manager: manager, managers: managers,
    router: router, store: store };
}

function recoveryHandlers(control, sessions, activation) {
  return {
    rehydrate: function (record, checkpoint) {
      assert.equal(checkpoint.exam.passed, true);
      return true;
    },
    activate: function (record, token, recovery) {
      if (activation && activation(record, token, recovery) === false) return false;
      var ref = recovery && recovery.target || record.to;
      var session = sessions[ref.projectId + "\u0000" + ref.sessionStorageId];
      assert.ok(session, "recovery must reuse the exact persisted session");
      control.markProviderStarted(token);
      var fence = control.createFence(token);
      executionFence.attachFence(session, fence);
      session.orchestrationPolicy.portfolioExecution.control = executionFence.metadataForFence(fence);
      session.orchestrationPolicy.portfolioExecution.status = "running";
      return true;
    },
  };
}

function sessionIndex(values) {
  var result = Object.create(null);
  for (var i = 0; i < values.length; i++) {
    result[values[i].ref.projectId + "\u0000" + values[i].ref.sessionStorageId] = values[i].session;
  }
  return result;
}

availableTest("graceful shutdown drains ingress and checkpoints every active controlled execution once", function () {
  var h = harness();
  try {
    var first = h.addExecution({ taskId: "ordinary-project-coordinator", projectId: PROJECT_A,
      sessionStorageId: "coordinator-a", mode: "project_coordinator" });
    var second = h.addExecution({ taskId: "ordinary-direct-leaf", projectId: PROJECT_B,
      sessionStorageId: "worker-b", mode: "direct_leaf" });
    h.router.completeControlledStartup();

    var prepared = h.router.prepareControlledRestart();
    var replay = h.router.prepareControlledRestart();

    assert.equal(prepared.preparedHandoffs, 2);
    assert.equal(replay.preparedHandoffs, 2);
    assert.equal(h.router.controlledIngressState(), "draining");
    assert.equal(h.store.listHandoffs().length, 2);
    assert.equal(h.store.listHandoffs().every(function (row) { return row.state === "prepared"; }), true);
    assert.equal(h.store.listHandoffs().every(function (row) {
      return h.store.getCheckpoint(row.handoff_id).exam.passed === true;
    }), true);
    assert.equal(h.control.inspect(first.token.executionId).execution.status, "running");
    assert.equal(h.control.inspect(second.token.executionId).execution.status, "running");
    var blocked = h.router.createProjectExecution(first.request);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "controlled_execution_shutdown");
  } finally {
    h.cleanup();
  }
});

availableTest("graceful shutdown checkpoints a coordinator waiting for owner input", function () {
  var h = harness();
  try {
    var active = h.addExecution({ taskId: "owner-input-coordinator", projectId: PROJECT_A,
      sessionStorageId: "owner-input-coordinator" });
    active.session.orchestrationPolicy.portfolioExecution.status = "needs_input";
    active.session.orchestrationPolicy.portfolioExecution.reason = "owner_decision_required";
    h.router.completeControlledStartup();

    var prepared = h.router.prepareControlledRestart();

    assert.equal(prepared.preparedHandoffs, 1);
    assert.equal(h.store.listHandoffs().length, 1);
    assert.equal(h.store.listHandoffs()[0].from_session_id, "owner-input-coordinator");
  } finally {
    h.cleanup();
  }
});

availableTest("graceful shutdown still rejects a direct leaf in terminal needs_input", function () {
  var h = harness();
  try {
    var active = h.addExecution({ taskId: "owner-input-direct-leaf", projectId: PROJECT_A,
      sessionStorageId: "owner-input-direct-leaf", mode: "direct_leaf" });
    active.session.orchestrationPolicy.portfolioExecution.status = "needs_input";
    h.router.completeControlledStartup();

    assert.throws(function () { h.router.prepareControlledRestart(); }, function (error) {
      return error && error.code === "COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED" &&
        error.message === NO_EXACT_TARGET;
    });
    assert.equal(h.store.listHandoffs().length, 0);
  } finally {
    h.cleanup();
  }
});

availableTest("multi-project preparation is a barrier and refuses partial checkpoint coverage", function () {
  var h = harness();
  try {
    h.addExecution({ taskId: "checkpointable-a", projectId: PROJECT_A,
      sessionStorageId: "checkpointable-a" });
    var missing = h.addExecution({ taskId: "missing-fence-b", projectId: PROJECT_B,
      sessionStorageId: "missing-fence-b" });
    delete missing.session._coopExecutionFence;
    h.router.completeControlledStartup();

    assert.throws(function () { h.router.prepareControlledRestart(); }, function (error) {
      return error && error.code === "COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED";
    });
    // Read-only refusal: nothing durable was written, so ingress must return to
    // exactly where it was rather than latching recovery_required.
    assert.equal(h.router.controlledIngressState(), "open");
    assert.equal(h.store.listHandoffs().length, 0,
      "preflight must reject before persisting any project handoff");
  } finally {
    h.cleanup();
  }
});

// DEFECT A. Compaction mints a fresh sessionStorageId and moves
// orchestrationPolicy -- control metadata included -- onto it, while nothing
// repoints coop_control_incarnations. Live state proved the consequence: the
// control plane kept reporting the execution running while zero turns ran, and
// the next graceful restart could no longer resolve an exact checkpointable
// target. Compaction of a control-plane-bound session is refused outright, so
// the execution keeps the exact session identity the control plane pins.
availableTest("compaction cannot re-home a control-plane-bound execution's session", function () {
  var h = harness();
  try {
    var active = h.addExecution({ taskId: "compaction-orphan-coordinator", projectId: PROJECT_A,
      sessionStorageId: "compaction-orphan-coordinator" });
    active.session.vendor = "codex";
    active.session.history.push({ type: "user_message", text: "Do the controlled work", _ts: 1 });
    h.router.completeControlledStartup();
    var sm = h.manager(PROJECT_A);
    var started = [];
    var api = compaction.attachSessionCompaction({
      cwd: h.dir,
      sm: sm,
      sdk: { startQuery: function (session) { started.push(session); } },
      sendToSession: function () {},
    });

    var continuation = api.compactAndContinue(active.session, { reason: "empty_turn" });

    assert.equal(continuation, null, "a controlled execution's session must not compact");
    assert.equal(started.length, 0, "no successor provider turn may start");
    assert.equal(sm.sessions.size, 1, "no successor session may be created");
    assert.equal(active.session.hidden, undefined, "the bound session stays live");
    assert.equal(active.session.orchestrationPolicy.portfolioExecution.control.executionId,
      active.token.executionId, "control metadata stays on the pinned session");
    assert.ok(sm.recorded.some(function (item) {
      return item.event.type === "error" &&
        String(item.event.text).indexOf(active.token.executionId) !== -1;
    }), "the refusal must be recorded on the session, not silent");

    // The point of the refusal: the control plane still resolves an exact
    // checkpointable target, so graceful restart still works.
    var prepared = h.router.prepareControlledRestart();
    assert.equal(prepared.preparedHandoffs, 1);
    assert.equal(h.store.listHandoffs().length, 1);
    assert.equal(h.store.listHandoffs()[0].state, "prepared");
    assert.equal(h.store.listHandoffs()[0].from_session_id, "compaction-orphan-coordinator");
  } finally {
    h.cleanup();
  }
});

// DEFECT B, read-only direction, plus the truthfulness of the reported reason.
// A session already re-homed on disk by an older build is the exact live shape:
// the successor carries the control metadata, the incarnation row still pins the
// predecessor. Preflight must refuse -- it is fail-closed on purpose -- but it
// must refuse the SAME way every time and must not close ingress behind it.
availableTest("a re-homed controlled session refuses restart truthfully and repeatably", function () {
  var h = harness();
  try {
    var active = h.addExecution({ taskId: "rehomed-coordinator", projectId: PROJECT_A,
      sessionStorageId: "rehomed-coordinator" });
    h.router.completeControlledStartup();
    var sm = h.manager(PROJECT_A);
    // Replay what compaction used to leave behind: metadata moved to a fresh
    // storageId, predecessor hidden, runtime fence left behind with it.
    var successor = { localId: 2, storageId: "rehomed-coordinator-successor", history: [],
      compactedFromStorageId: active.ref.sessionStorageId,
      orchestrationPolicy: active.session.orchestrationPolicy };
    delete active.session.orchestrationPolicy;
    active.session.hidden = true;
    sm.sessions.set(successor.localId, successor);

    var messages = [];
    for (var attempt = 0; attempt < 3; attempt++) {
      try { h.router.prepareControlledRestart(); messages.push("prepared"); }
      catch (error) {
        messages.push(error.message);
        assert.equal(error.code, "COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED");
      }
      assert.equal(h.router.controlledIngressState(), "open",
        "a read-only preflight refusal must leave ingress recoverable");
    }
    assert.deepEqual(messages, [NO_EXACT_TARGET, NO_EXACT_TARGET, NO_EXACT_TARGET],
      "the true cause must not be masked by the startup-drain guard");
    assert.equal(h.store.listHandoffs().length, 0);

    // The sanctioned in-process repair stays reachable: it now answers with its
    // own domain refusal instead of the ingress gate's recovery_required.
    var migrated = h.router.migrateControlPlaneBinding({});
    assert.notEqual(migrated.reason, "controlled_execution_recovery_required");
    assert.notEqual(h.router.dismissProjectExecution({}).reason,
      "controlled_execution_recovery_required");
  } finally {
    h.cleanup();
  }
});

// DEFECT B, durable direction. The latch is right when it is earned: once one
// prepareRestartHandoff has committed a handoff, a checkpoint and a successor
// epoch, a later failure leaves partial durable restart state behind and ingress
// must stay closed until explicit recovery. The startup-drain message the next
// attempt reports is then TRUE.
availableTest("a partial prepareRestartHandoff failure still latches ingress", function () {
  var commits = 0;
  var h = harness({ faults: { beforeExecutionCommit: function (event) {
    if (event.operation !== "prepare_restart_handoff") return;
    commits += 1;
    if (commits === 2) throw new Error("simulated durable handoff failure");
  } } });
  try {
    h.addExecution({ taskId: "partial-handoff-a", projectId: PROJECT_A,
      sessionStorageId: "partial-handoff-a" });
    h.addExecution({ taskId: "partial-handoff-b", projectId: PROJECT_B,
      sessionStorageId: "partial-handoff-b" });
    h.router.completeControlledStartup();

    assert.throws(function () { h.router.prepareControlledRestart(); }, function (error) {
      return error && error.code === "COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED";
    });
    assert.equal(commits, 2);
    assert.equal(h.store.listHandoffs().length, 1,
      "the first handoff really did commit, so durable partial state exists");
    assert.equal(h.router.controlledIngressState(), "recovery_required");
    assert.equal(h.router.createProjectExecution({}).reason,
      "controlled_execution_recovery_required");

    assert.throws(function () { h.router.prepareControlledRestart(); }, function (error) {
      return error.message === DRAIN_BEFORE_STARTUP;
    }, "once latched, the startup-drain refusal is the true one");
  } finally {
    h.cleanup();
  }
});

test("restart CLI reports a typed IPC checkpoint refusal as failure", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-restart-ipc-refusal-"));
  var socket = path.join(dir, "daemon-dev.sock");
  var server = net.createServer(function (connection) {
    var buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", function (chunk) {
      buffer += chunk;
      if (buffer.indexOf("\n") === -1) return;
      connection.write(JSON.stringify({ ok: false,
        code: "COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
        error: "Controlled execution checkpoint is unavailable." }) + "\n");
    });
  });
  try {
    fs.writeFileSync(path.join(dir, "daemon-dev.json"),
      JSON.stringify({ pid: process.pid, projects: [] }));
    await new Promise(function (resolve, reject) {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    var result = await new Promise(function (resolve, reject) {
      var child = childProcess.spawn(process.execPath,
        [path.join(__dirname, "..", "bin", "cli.js"), "--dev", "--restart"], {
          cwd: path.join(__dirname, ".."),
          env: Object.assign({}, process.env, { CLAY_DEV: "1", CLAY_HOME: dir }),
          stdio: ["ignore", "pipe", "pipe"],
        });
      var stdout = "";
      var stderr = "";
      child.stdout.on("data", function (chunk) { stdout += chunk.toString(); });
      child.stderr.on("data", function (chunk) { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("exit", function (code) {
        resolve({ code: code, stderr: stderr, stdout: stdout });
      });
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Restart failed: Controlled execution checkpoint is unavailable\./);
    assert.doesNotMatch(result.stdout, /Server restarted\./);
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

availableTest("abrupt restart without a complete checkpoint stays explicit and fail-closed", function () {
  var h = harness();
  try {
    var active = h.addExecution({ taskId: "abrupt-coordinator", projectId: PROJECT_A,
      sessionStorageId: "abrupt-coordinator" });
    var handoff = handoffs.createHandoffControl({ enabled: true, store: h.store,
      executionControl: h.control });
    var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
      executionControl: h.control, handoffControl: handoff });

    assert.throws(function () { startup.recover({}); }, function (error) {
      return error && error.code === "COOP_CONTROL_RESTART_RECOVERY_REQUIRED";
    });
    assert.equal(startup.state(), "recovery_required");
    assert.equal(h.control.inspect(active.token.executionId).execution.status, "running");
    assert.equal(h.control.inspect(active.token.executionId).current.failureCode, null);
    assert.equal(h.control.inspect(active.token.executionId).leases.length, 1);
    startup.close();
  } finally {
    h.cleanup();
  }
});

availableTest("a terminal failed execution safely reconciles its prepared restart handoff once", function () {
  var h = harness();
  var storeTwo = null;
  var controlTwo = null;
  var handoffTwo = null;
  var startupTwo = null;
  try {
    var active = h.addExecution({ taskId: "terminal-before-restart-recovery",
      projectId: PROJECT_A, sessionStorageId: "terminal-before-restart-recovery" });
    h.router.completeControlledStartup();
    assert.equal(h.router.prepareControlledRestart().preparedHandoffs, 1);
    var prepared = h.store.listHandoffs()[0];

    active.session._coopExecutionFence.abandon("provider_start_failed");
    var terminal = h.control.inspect(active.token.executionId);
    assert.equal(terminal.execution.status, "failed");
    assert.equal(terminal.current.failureCode, "provider_start_failed");
    assert.equal(terminal.leases.length, 0);
    assert.equal(h.store.listHandoffs()[0].state, "prepared");
    assert.equal(h.router.bindingStore.list().length, 1);
    assert.equal(h.manager(PROJECT_A).sessions.size, 1);

    h.control.close();
    h.store.close();
    storeTwo = storeModule.openControlStore({ dbPath: h.dbPath });
    controlTwo = executions.createExecutionControl({ enabled: true, store: storeTwo });
    handoffTwo = handoffs.createHandoffControl({ enabled: true, store: storeTwo,
      executionControl: controlTwo });
    startupTwo = startupModule.createStartupRecovery({ enabled: true, store: storeTwo,
      executionControl: controlTwo, handoffControl: handoffTwo });

    var recovered = startupTwo.recover({});
    assert.equal(recovered.abortedHandoffs, 1);
    assert.equal(startupTwo.isReady(), true);
    assert.equal(handoffTwo.inspect(prepared.handoff_id).state, "aborted");
    assert.equal(handoffTwo.inspect(prepared.handoff_id).failureCode,
      "terminal_execution_reconciled");
    assert.equal(controlTwo.inspect(active.token.executionId).execution.status, "failed");
    assert.equal(controlTwo.inspect(active.token.executionId).leases.length, 0);
    assert.equal(startupTwo.recover({}).abortedHandoffs, 1,
      "repeated recovery returns the completed fixed point");

    var routerTwo = createCrossProjectRouter({ bindingFile: h.bindingFile,
      coopExecutionControl: controlTwo, coopStartupRecovery: startupTwo });
    routerTwo.registerProjectResolver({
      getProjectId: function () { return PROJECT_A; },
      getSessionManager: function () { return h.manager(PROJECT_A); },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    });
    routerTwo.completeControlledStartup();
    assert.equal(routerTwo.controlledIngressState(), "open");
    assert.equal(routerTwo.prepareControlledRestart().preparedHandoffs, 0);
    assert.equal(storeTwo.listHandoffs().length, 1);
    assert.equal(routerTwo.bindingStore.list().length, 1);
    assert.equal(h.manager(PROJECT_A).sessions.size, 1);
  } finally {
    try { if (startupTwo) startupTwo.close(); } catch (error) {}
    try { if (handoffTwo) handoffTwo.close(); } catch (error) {}
    try { if (controlTwo) controlTwo.close(); } catch (error) {}
    try { if (storeTwo) storeTwo.close(); } catch (error) {}
    h.cleanup();
  }
});

availableTest("prepared recovery survives activation failure and a second restart without duplicates", function () {
  var h = harness();
  var active;
  try {
    active = h.addExecution({ taskId: "double-restart-coordinator", projectId: PROJECT_A,
      sessionStorageId: "double-restart-coordinator" });
    h.router.completeControlledStartup();
    h.router.prepareControlledRestart();
    h.control.close();
    h.store.close();

    var storeOne = storeModule.openControlStore({ dbPath: h.dbPath });
    var controlOne = executions.createExecutionControl({ enabled: true, store: storeOne });
    var handoffOne = handoffs.createHandoffControl({ enabled: true, store: storeOne,
      executionControl: controlOne });
    var startupOne = startupModule.createStartupRecovery({ enabled: true, store: storeOne,
      executionControl: controlOne, handoffControl: handoffOne });
    assert.throws(function () {
      startupOne.recover(recoveryHandlers(controlOne, sessionIndex([active]),
        function () { return false; }));
    }, function (error) {
      return error && error.code === "COOP_CONTROL_RECOVERY_ACTIVATION_REQUIRED";
    });
    assert.equal(startupOne.state(), "failed");
    assert.equal(storeOne.listHandoffs()[0].state, "prepared");
    assert.equal(controlOne.inspect(active.token.executionId).leases.length, 1);
    startupOne.close();
    handoffOne.close();
    controlOne.close();
    storeOne.close();

    var storeTwo = storeModule.openControlStore({ dbPath: h.dbPath });
    var controlTwo = executions.createExecutionControl({ enabled: true, store: storeTwo });
    var handoffTwo = handoffs.createHandoffControl({ enabled: true, store: storeTwo,
      executionControl: controlTwo });
    var startupTwo = startupModule.createStartupRecovery({ enabled: true, store: storeTwo,
      executionControl: controlTwo, handoffControl: handoffTwo });
    var recovered = startupTwo.recover(recoveryHandlers(controlTwo, sessionIndex([active])));
    assert.equal(recovered.abortedHandoffs, 1);
    assert.equal(startupTwo.isReady(), true);
    assert.equal(storeTwo.listHandoffs()[0].state, "aborted");
    assert.equal(controlTwo.inspect(active.token.executionId).execution.status, "running");
    assert.equal(controlTwo.inspect(active.token.executionId).leases.length, 1);
    assert.equal(h.manager(PROJECT_A).sessions.size, 1);

    var routerTwo = createCrossProjectRouter({ bindingFile: h.bindingFile,
      coopExecutionControl: controlTwo, coopStartupRecovery: startupTwo });
    routerTwo.registerProjectResolver({
      getProjectId: function () { return PROJECT_A; },
      getSessionManager: function () { return h.manager(PROJECT_A); },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    });
    routerTwo.completeControlledStartup();
    assert.equal(routerTwo.prepareControlledRestart().preparedHandoffs, 1);
    assert.equal(storeTwo.listHandoffs().length, 2);
    assert.equal(storeTwo.listHandoffs().filter(function (row) {
      return row.state === "prepared";
    }).length, 1);
    startupTwo.close();
    handoffTwo.close();
    controlTwo.close();
    storeTwo.close();

    var storeThree = storeModule.openControlStore({ dbPath: h.dbPath });
    var controlThree = executions.createExecutionControl({ enabled: true, store: storeThree });
    var handoffThree = handoffs.createHandoffControl({ enabled: true, store: storeThree,
      executionControl: controlThree });
    var startupThree = startupModule.createStartupRecovery({ enabled: true, store: storeThree,
      executionControl: controlThree, handoffControl: handoffThree });
    var recoveredAgain = startupThree.recover(recoveryHandlers(controlThree, sessionIndex([active])));
    assert.equal(recoveredAgain.abortedHandoffs, 1);
    assert.equal(storeThree.listHandoffs().filter(function (row) {
      return row.state === "aborted";
    }).length, 2);
    assert.equal(controlThree.inspect(active.token.executionId).execution.status, "running");
    assert.equal(controlThree.inspect(active.token.executionId).leases.length, 1);
    assert.equal(h.manager(PROJECT_A).sessions.size, 1);
    startupThree.close();
    handoffThree.close();
    controlThree.close();
    storeThree.close();
  } finally {
    h.cleanup();
  }
});

availableTest("restart checkpoint corruption fails before provider activation", function () {
  var h = harness();
  try {
    h.addExecution({ taskId: "corrupt-restart-checkpoint", projectId: PROJECT_A,
      sessionStorageId: "corrupt-restart-checkpoint" });
    h.router.completeControlledStartup();
    h.router.prepareControlledRestart();
    var handoffId = h.store.listHandoffs()[0].handoff_id;
    h.control.close();
    h.store.close();
    var sqlite = require("node:sqlite");
    var db = new sqlite.DatabaseSync(h.dbPath);
    db.prepare("UPDATE coop_control_checkpoints SET packet_digest = ? WHERE handoff_id = ?")
      .run(crypto.createHash("sha256").update("corrupt").digest("hex"), handoffId);
    db.close();

    assert.throws(function () { storeModule.openControlStore({ dbPath: h.dbPath }); }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION";
    });
  } finally {
    h.cleanup();
  }
});
