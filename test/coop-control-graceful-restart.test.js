var test = require("node:test");
var assert = require("node:assert");
var crypto = require("crypto");
var childProcess = require("child_process");
var fs = require("fs");
var net = require("net");
var os = require("os");
var path = require("path");

var executionFence = require("../lib/coop-control-fence");
var executions = require("../lib/coop-control-executions");
var handoffs = require("../lib/coop-control-handoff");
var startupModule = require("../lib/coop-control-startup");
var storeModule = require("../lib/coop-control-store");
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;

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
      var sm = { sessions: new Map(), saves: 0,
        saveSessionFile: function () { sm.saves += 1; },
        broadcastSessionList: function () {},
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
    assert.equal(h.router.controlledIngressState(), "recovery_required");
    assert.equal(h.store.listHandoffs().length, 0,
      "preflight must reject before persisting any project handoff");
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
