var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var controlStore = require("../lib/coop-control-store");
var executions = require("../lib/coop-control-executions");
var deliveryModule = require("../lib/coop-control-delivery");
var external = require("../lib/project-task-orchestrator-external");
var leadLoop = require("../lib/lead-loop");
var attachCompletionGate =
  require("../lib/project-task-orchestrator-completion").attachCompletionGate;
var finishControlledExecution =
  require("../lib/coop-control-execution-completion").finishControlledExecution;

var CLAY_PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP_PROJECT = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var LEAD_SESSION = "457fb60d-f829-4927-98eb-e0cefb5838b0";
var RESTART_TASK = "clay-diagnose-auto-launch-runtime-restart-need-20260902";
var WEBAPP_TASK = "auto:bf517abe2dee8838832fb334:trialview-v2-2677";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-self-recovery-"));
  var timeline = [];
  var sessions = new Map();
  var nextId = 1;
  var sm = {
    sessions: sessions,
    defaultVendor: "codex",
    currentModel: "gpt-5.6-sol",
    currentPermissionMode: "bypassPermissions",
    permissionRequestIndex: {},
    getProjectId: function () { return CLAY_PROJECT; },
    createSessionRaw: function (options) {
      var localId = nextId++;
      var session = Object.assign({
        localId: localId,
        storageId: "task-coordinator-" + localId,
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
  var control = executions.createExecutionControl({
    dbPath: path.join(dir, "coop-control.sqlite"), enabled: true,
  });
  var delivery = deliveryModule.createDeliveryControl({
    enabled: true, store: control.getStore(),
  });
  var sdk = {
    startQuery: function (session) {
      session._coopExecutionFence.assert("provider_start");
      session._coopExecutionFence.markProviderStarted();
      timeline.push("provider");
      return Promise.resolve();
    },
  };
  var attached = external.attachPortfolioExecutionTarget({
    coopDeliveryControl: delivery,
    coopExecutionControl: control,
    coopStartupRecovery: { assertReady: function () { return true; } },
    crossProject: {
      getExecutionBinding: function () { return null; },
      createEnvelope: function (value) { return value; },
      deliverEnvelope: function () { return { ok: true }; },
    },
    ensureProjectAccessForSession: function () {},
    onProcessingChanged: function () {},
    sdk: sdk,
    sm: sm,
    slug: "target",
  });
  return {
    attached: attached,
    control: control,
    delivery: delivery,
    sessions: sessions,
    sm: sm,
    timeline: timeline,
    cleanup: function () {
      delivery.close();
      control.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createEnvelope(rootStorageId) {
  return {
    schema: external.COMMAND_SCHEMA,
    schemaVersion: external.COMMAND_VERSION,
    eventId: "create-restart-investigation",
    source: { projectId: "system-lead", sessionStorageId: LEAD_SESSION },
    destination: { projectId: CLAY_PROJECT, sessionStorageId: "project-router" },
    payload: {
      type: "portfolio_execution_create",
      portfolioTaskId: RESTART_TASK,
      bindingRevision: 1,
      idempotencyKey: RESTART_TASK + "-r1",
      mode: "project_coordinator",
      targetProject: { projectId: CLAY_PROJECT },
      targetCoordinator: { projectId: CLAY_PROJECT, sessionStorageId: rootStorageId },
      reviewOnly: true,
      title: "Diagnose restart need",
      objective: "Determine whether the repaired runtime needs a restart.",
    },
  };
}

function messageEnvelope(eventId) {
  return {
    schema: external.COMMAND_SCHEMA,
    schemaVersion: external.COMMAND_VERSION,
    eventId: eventId,
    source: { projectId: "system-lead", sessionStorageId: LEAD_SESSION },
    destination: { projectId: CLAY_PROJECT, sessionStorageId: "project-router" },
    payload: {
      type: "portfolio_execution_message",
      portfolioTaskId: RESTART_TASK,
      bindingRevision: 1,
      text: "Resume the existing restart investigation under its exact ProjectRef.",
    },
  };
}

function taskCoordinator(runtime) {
  return Array.from(runtime.sessions.values()).find(function (session) {
    return session.coordinationRole === "task_coordinator";
  });
}

test("steering a needs-input project coordinator renews its fence without changing binding authority", {
  skip: !controlStore.isControlStoreAvailable(),
}, function () {
  var runtime = harness();
  try {
    var root = {
      localId: 99,
      storageId: "clay-project-coordinator",
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
    var created = runtime.attached.handleEnvelope(createEnvelope(root.storageId));
    var session = taskCoordinator(runtime);
    var firstControl = session.orchestrationPolicy.portfolioExecution.control;
    var firstAuthority = runtime.control.inspect(firstControl.executionId).authority.authorityId;
    session.history.push({
      type: "delta",
      text: "WORKER_STATUS: needs_input\nREASON: strict_read_only_integrity_compromised_by_status_probe\n" +
        "SUMMARY: The status probe changed live permissions.\n" +
        "VERIFICATION: The changed mode was observed.\nESCALATION_REQUIRED: yes",
    });
    session.isProcessing = false;
    var gate = attachCompletionGate({
      sm: runtime.sm,
      flushCoordinatorUpdates: function () { return false; },
      queueCoordinatorUpdate: function () {},
      sendState: function () {},
      finishControlledExecution: function (targetSession, status) {
        return finishControlledExecution(targetSession, status, { control: runtime.control });
      },
    });
    gate.handleTurnDone(session);

    var terminal = runtime.control.inspect(firstControl.executionId);
    assert.equal(created.ok, true);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, "needs_input");
    assert.equal(terminal.execution.status, "failed");
    assert.equal(terminal.current.failureCode, "needs_input");
    assert.equal(terminal.leases.length, 0);

    var beforeHistory = session.history.length;
    var wrongAuthority = messageEnvelope("wrong-authority-restart-investigation");
    wrongAuthority.source.sessionStorageId = "unrelated-lead-session";
    var rejected = runtime.attached.handleEnvelope(wrongAuthority);
    assert.deepEqual(rejected, { ok: false, reason: "execution_authority_mismatch" });
    assert.equal(runtime.control.inspect(firstControl.executionId).execution.currentEpoch, 1);
    assert.equal(session.history.length, beforeHistory);

    var resumed = runtime.attached.handleEnvelope(messageEnvelope("resume-restart-investigation"));
    var metadata = session.orchestrationPolicy.portfolioExecution;
    var durable = runtime.control.inspect(metadata.control.executionId);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.localSessionId, session.localId);
    assert.equal(runtime.sessions.size, 2, "recovery must reuse the root and task coordinator");
    assert.equal(metadata.status, "running");
    assert.deepEqual(metadata.targetProject, { projectId: CLAY_PROJECT });
    assert.deepEqual(metadata.source,
      { projectId: "system-lead", sessionStorageId: LEAD_SESSION });
    assert.equal(metadata.portfolioTaskId, RESTART_TASK);
    assert.equal(metadata.bindingRevision, 1);
    assert.equal(metadata.control.epoch, firstControl.epoch + 1);
    assert.equal(durable.authority.authorityId, firstAuthority);
    assert.equal(durable.execution.status, "running");
    assert.equal(durable.current.startState, "started");
    assert.equal(durable.leases.length, 1);
    assert.equal(session.history.length, beforeHistory + 1);
    assert.equal(root.orchestrationTasks[0].status, "running");

    var providers = runtime.timeline.filter(function (item) { return item === "provider"; }).length;
    var replay = runtime.attached.handleEnvelope(messageEnvelope("resume-restart-investigation"));
    assert.equal(replay.ok, true);
    assert.equal(session.history.length, beforeHistory + 1, "durable replay stays exactly once");
    assert.equal(runtime.timeline.filter(function (item) {
      return item === "provider";
    }).length, providers, "durable replay cannot start another provider turn");
  } finally {
    runtime.cleanup();
  }
});

function binding(taskId, revision, projectId, status) {
  return {
    portfolioTaskId: taskId,
    bindingRevision: revision,
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
    status: status,
  };
}

function scope(taskId, revision, projectId) {
  return {
    portfolioTaskId: taskId,
    bindingRevision: revision,
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
  };
}

test("owner continuation scope returns only the two named existing bindings", function () {
  var restart = binding(RESTART_TASK, 1, CLAY_PROJECT, "needs_input");
  var webapp = binding(WEBAPP_TASK, 2, WEBAPP_PROJECT, "completed");
  var unrelated = binding("unrelated-running", 1, CLAY_PROJECT, "active");
  var decisions = leadLoop.leadTick({
    ownerContinuationScope: [
      scope(RESTART_TASK, 1, CLAY_PROJECT),
      scope(WEBAPP_TASK, 2, WEBAPP_PROJECT),
    ],
    portfolioBindings: [restart, unrelated, webapp],
    historicalLedger: {
      scanned: 1,
      counts: { active: 1, unreconciled: 1 },
      unresolved: [{
        classification: "active",
        portfolioTaskId: "unrelated-historical",
        bindingRevision: 1,
        mode: "project_coordinator",
        projectRef: { projectId: CLAY_PROJECT },
      }],
    },
    portfolio: { items: [{
      id: "unrelated-eligible",
      route: { vendor: "codex", model: "gpt-5.6-luna", tier: 2 },
      classification: { taskClass: "implementation", risk: "low" },
    }] },
    inFlight: [],
    now: 1788366014000,
    lastStandupAt: 1788366014000,
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "reconcile_scope");
  assert.deepEqual(decisions[0].bindings, [restart, webapp]);
  assert.equal(decisions.some(function (decision) { return decision.action === "staff"; }), false);
  assert.equal(decisions.some(function (decision) {
    return decision.action === "reconcile_history";
  }), false);
});

test("owner continuation scope fails closed when an exact typed binding is absent", function () {
  var restart = binding(RESTART_TASK, 1, CLAY_PROJECT, "needs_input");
  var decisions = leadLoop.leadTick({
    ownerContinuationScope: [
      scope(RESTART_TASK, 1, CLAY_PROJECT),
      scope(WEBAPP_TASK, 2, CLAY_PROJECT),
    ],
    portfolioBindings: [restart],
    portfolio: { items: [{
      id: "unrelated-eligible",
      route: { vendor: "codex", model: "gpt-5.6-luna", tier: 2 },
      classification: { taskClass: "implementation", risk: "low" },
    }] },
    inFlight: [],
    now: 1788366014000,
    lastStandupAt: 1788366014000,
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "wait");
  assert.equal(decisions[0].reason, "owner continuation scope has no exact typed binding");
  assert.equal(decisions[0].blockers[0].portfolioTaskId, WEBAPP_TASK);
  assert.equal(decisions.some(function (decision) { return decision.action === "staff"; }), false);
});
