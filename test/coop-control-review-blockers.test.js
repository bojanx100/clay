var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var crypto = require("crypto");
var os = require("os");
var path = require("path");
var continuity = require("../lib/coop-control-continuity");
var deliveryModule = require("../lib/coop-control-delivery");
var executions = require("../lib/coop-control-executions");
var handoffs = require("../lib/coop-control-handoff");
var controlRuntime = require("../lib/coop-control-runtime");
var external = require("../lib/project-task-orchestrator-external");
var handoffTarget = require("../lib/coop-control-handoff-target");
var startupModule = require("../lib/coop-control-startup");
var storeModule = require("../lib/coop-control-store");
var attachTaskOrchestrator = require("../lib/project-task-orchestrator").attachTaskOrchestrator;
var deliveryReplayModule = require("../lib/coop-control-delivery-replay");
var targetRecoveryAdapter = require("../lib/coop-control-target-recovery-adapter");
var runtimeTarget = require("../lib/coop-control-runtime-target");
var executionTarget = require("../lib/coop-control-execution-target");
var executionFence = require("../lib/coop-control-fence");
var sessionPersistence = require("../lib/sessions-persistence");

var PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var PROJECT_B = "6332aafc-31e7-5cb1-ba96-c8d90e78260e";
var SOURCE = { projectId: "system-lead", sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af" };
var OLD = { projectId: PROJECT, sessionStorageId: "coordinator-old" };
var NEW = { projectId: PROJECT, sessionStorageId: "coordinator-new" };

function packet(overrides, predecessor) {
  var executionId = predecessor && predecessor.executionId || "exec:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  var authorityId = predecessor && predecessor.authorityId || "auth:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return Object.assign({
    schemaVersion: 1,
    objectives: [{ objectiveId: "objective-main", text: "Recover the controlled execution." }],
    decisions: [{ decisionId: "decision-main", value: "Recover before intake.", acceptedAt: 1 }],
    ownerRequests: [{ requestId: "request-main", ingressId: "ingress-main", receivedAt: 1 }],
    tasks: [{ taskId: "task-main", objectiveId: "objective-main", status: "running", owner: OLD }],
    bindings: [{ portfolioTaskId: "task-main", bindingRevision: 1,
      targetProject: { projectId: PROJECT }, mode: "project_coordinator", status: "active" }],
    authorities: [{ authorityId: authorityId, source: SOURCE,
      portfolioTaskId: "task-main", bindingRevision: 1, targetProject: { projectId: PROJECT },
      role: "coordinator", actionMask: 31 }],
    executions: [{ executionId: executionId, source: SOURCE,
      authorityId: authorityId, portfolioTaskId: "task-main",
      bindingRevision: 1, targetProject: { projectId: PROJECT }, mode: "project_coordinator", role: "coordinator" }],
    learningReferences: [],
  }, overrides || {});
}

function request() {
  return { portfolioTaskId: "task-main", bindingRevision: 1, idempotencyKey: "task-main-r1",
    mode: "project_coordinator", targetProject: { projectId: PROJECT }, source: SOURCE };
}

function evidence(ref, id) {
  return { sessionRef: ref, receiptId: id || "receipt-successor" };
}

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-review-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  var store = storeModule.openControlStore({ dbPath: dbPath });
  var control = executions.createExecutionControl({ enabled: true, store: store });
  var handoff = handoffs.createHandoffControl({ enabled: true, store: store, executionControl: control });
  return { dbPath: dbPath, store: store, control: control, handoff: handoff, cleanup: function () {
    try { handoff.close(); } catch (error) {}
    try { control.close(); } catch (error) {}
    try { store.close(); } catch (error) {}
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

function started(control) {
  var token = control.reserveStart(request());
  control.bindStart(token, OLD);
  control.openStartBarrier(token);
  control.markProviderStarted(token);
  return token;
}

function availableTest(name, fn) {
  test(name, { skip: !storeModule.isControlStoreAvailable() }, fn);
}

test("the project task orchestrator exposes the production handoff call path", function () {
  var sessions = new Map();
  var sm = {
    sessions: sessions,
    createSessionRaw: function (options) {
      var session = Object.assign({ localId: sessions.size + 1, history: [] }, options);
      sessions.set(session.localId, session);
      return session;
    },
    appendToSessionFile: function () {}, saveSessionFile: function () {},
    broadcastSessionList: function () {}, subscribeSession: function () { return function () {}; },
    getProjectId: function () { return PROJECT; },
  };
  var api = attachTaskOrchestrator({ sm: sm, slug: "review-target",
    sdk: { startQuery: function () {} }, sendToSession: function () {},
    ensureProjectAccessForSession: function () {} });
  try {
    assert.equal(typeof api.handoffExecution, "function");
  } finally {
    api.stopCoopWatchdog();
  }
});

availableTest("target-session replay survives effect crashes and cleans only after durable receipt", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-delivery-replay-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  try {
    var session = { localId: 1, storageId: NEW.sessionStorageId, history: [],
      orchestrationPolicy: { portfolioExecution: { mode: "project_coordinator", status: "running" } } };
    var saves = 0;
    var sm = { sessions: new Map([[1, session]]), saveSessionFile: function () { saves += 1; } };
    function metadata(item) {
      return item && item.orchestrationPolicy && item.orchestrationPolicy.portfolioExecution;
    }
    function validEnvelope(envelope, payload) {
      return !!envelope && envelope.schema === external.COMMAND_SCHEMA &&
        envelope.schemaVersion === external.COMMAND_VERSION && payload &&
        payload.type === "portfolio_execution_message";
    }
    var replay = deliveryReplayModule.createDeliveryReplayStore({ executionMetadata: metadata,
      projectId: function () { return PROJECT; }, sm: sm, validEnvelope: validEnvelope });
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, dbPath: dbPath });
    var message = { schema: external.COMMAND_SCHEMA, schemaVersion: external.COMMAND_VERSION,
      eventId: "message-replay-crash", source: SOURCE, destination: NEW,
      payload: { type: "portfolio_execution_message", portfolioTaskId: "task-main",
        bindingRevision: 1, text: "resume exact delivery" } };
    var payloadDigest = crypto.createHash("sha256").update(JSON.stringify([
      message.payload.type, message.payload.portfolioTaskId, message.payload.bindingRevision,
      message.payload.text,
    ]), "utf8").digest("hex");
    var stableInput = { messageId: message.eventId, sender: SOURCE, recipient: NEW,
      kind: "execution_event", referenceId: message.eventId, payloadReference: message.eventId,
      payloadDigest: payloadDigest };
    var effectSpec = { kind: "execution_update", target: NEW };
    var effectId = delivery.effectIdentity(stableInput, effectSpec);
    replay.persist(session, { effectId: effectId, envelope: message, messageId: message.eventId,
      payloadDigest: payloadDigest, payloadReference: message.eventId, target: NEW });
    var stable = delivery.enqueue(stableInput);
    delivery.receive(stable, effectSpec);
    assert.equal(metadata(session).recoveryDeliveries.length, 1);
    delivery.close();

    var reopenedDelivery = deliveryModule.createDeliveryControl({ enabled: true, dbPath: dbPath });
    var applications = 0;
    var adapter = targetRecoveryAdapter.createTargetRecoveryAdapter({
      applyExecutionMessage: function (target, payload, envelope, text, currentEffectId) {
        applications += 1;
        target.history.push({ type: "user_message", text: text, controlEffectId: currentEffectId });
        sm.saveSessionFile(target);
        return { ok: true };
      }, control: {}, delivery: reopenedDelivery, executionMetadata: metadata,
      projectId: function () { return PROJECT; }, replayStore: replay, sm: sm,
      startQuery: function () {}, validEnvelope: validEnvelope,
    });
    var handlers = adapter.createHandlers();
    assert.equal(reopenedDelivery.dispatch(handlers.send), 1);
    assert.equal(reopenedDelivery.reconcile(handlers.applyEffect), 1);
    assert.equal(applications, 1);
    assert.equal(session.history.filter(function (item) {
      return item.controlEffectId === effectId;
    }).length, 1);
    assert.equal(metadata(session).recoveryDeliveries.length, 1);
    assert.equal(handlers.cleanupReceived(), 1);
    assert.equal(metadata(session).recoveryDeliveries.length, 0);
    assert.equal(reopenedDelivery.listEffects()[0].receiptId,
      "receipt:" + crypto.createHash("sha256").update(effectId, "utf8").digest("hex").slice(0, 48));
    assert.ok(saves >= 3);
    reopenedDelivery.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

availableTest("target-session replay is durable before a heavy session save may coalesce", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-replay-flush-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  var sessionPath = path.join(dir, "target.jsonl");
  try {
    var persistence = sessionPersistence.attachSessionPersistence({
      getSessionStorageId: function (session) { return session.storageId; },
      sessionFilePath: function () { return sessionPath; },
    });
    var session = { localId: 1, storageId: NEW.sessionStorageId, history: [],
      orchestrationPolicy: { portfolioExecution: { portfolioTaskId: "task-main", bindingRevision: 1,
        idempotencyKey: "task-main-r1", mode: "project_coordinator", status: "running" } } };
    persistence.saveSessionFile(session);
    session._lastSaveDurMs = 25;
    session._lastSaveBytes = 600000;
    session._lastSaveAt = Date.now();
    var sm = { sessions: new Map([[1, session]]), saveSessionFile: persistence.saveSessionFile };
    function metadata(item) {
      return item && item.orchestrationPolicy && item.orchestrationPolicy.portfolioExecution;
    }
    function validEnvelope(envelope, payload) {
      return !!envelope && envelope.schema === external.COMMAND_SCHEMA &&
        envelope.schemaVersion === external.COMMAND_VERSION && payload &&
        payload.type === "portfolio_execution_message";
    }
    var replay = deliveryReplayModule.createDeliveryReplayStore({ executionMetadata: metadata,
      projectId: function () { return PROJECT; }, sm: sm, validEnvelope: validEnvelope });
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, dbPath: dbPath });
    var message = { schema: external.COMMAND_SCHEMA, schemaVersion: external.COMMAND_VERSION,
      eventId: "message-heavy-flush", source: SOURCE, destination: NEW,
      payload: { type: "portfolio_execution_message", portfolioTaskId: "task-main",
        bindingRevision: 1, text: "persist before sqlite intent" } };
    replay.prepare(session, message, delivery);
    var persisted = JSON.parse(fs.readFileSync(sessionPath, "utf8").split("\n")[0]);
    assert.equal(persisted.orchestrationPolicy.portfolioExecution.recoveryDeliveries.length, 1);
    if (session._saveCoalesceTimer) clearTimeout(session._saveCoalesceTimer);
    delivery.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

availableTest("target-session replay refuses a ControlStore intent when durable persistence fails", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-replay-save-failure-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  try {
    var persistence = sessionPersistence.attachSessionPersistence({
      getSessionStorageId: function (session) { return session.storageId; },
      sessionFilePath: function () { return path.join(dir, "missing", "target.jsonl"); },
    });
    var session = { localId: 1, storageId: NEW.sessionStorageId, history: [],
      orchestrationPolicy: { portfolioExecution: { portfolioTaskId: "task-main", bindingRevision: 1,
        idempotencyKey: "task-main-r1", mode: "project_coordinator", status: "running" } } };
    var sm = { sessions: new Map([[1, session]]), saveSessionFile: persistence.saveSessionFile };
    function metadata(item) {
      return item && item.orchestrationPolicy && item.orchestrationPolicy.portfolioExecution;
    }
    function validEnvelope(envelope, payload) {
      return !!envelope && envelope.schema === external.COMMAND_SCHEMA &&
        envelope.schemaVersion === external.COMMAND_VERSION && payload &&
        payload.type === "portfolio_execution_message";
    }
    var replay = deliveryReplayModule.createDeliveryReplayStore({ executionMetadata: metadata,
      projectId: function () { return PROJECT; }, sm: sm, validEnvelope: validEnvelope });
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, dbPath: dbPath });
    var message = { schema: external.COMMAND_SCHEMA, schemaVersion: external.COMMAND_VERSION,
      eventId: "message-failed-flush", source: SOURCE, destination: NEW,
      payload: { type: "portfolio_execution_message", portfolioTaskId: "task-main",
        bindingRevision: 1, text: "must not create intent" } };
    assert.throws(function () { replay.prepare(session, message, delivery); });
    assert.equal(delivery.listEffects().length, 0);
    assert.equal(delivery.listOutbox().length, 0);
    delivery.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

availableTest("target-session replay retries durability after an in-memory save failure", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-replay-save-retry-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  try {
    var session = { localId: 1, storageId: NEW.sessionStorageId, history: [],
      orchestrationPolicy: { portfolioExecution: { portfolioTaskId: "task-main", bindingRevision: 1,
        idempotencyKey: "task-main-r1", mode: "project_coordinator", status: "running" } } };
    var saves = 0;
    var sm = { sessions: new Map([[1, session]]), saveSessionFile: function (target, options) {
      assert.equal(options && options.durable, true);
      saves += 1;
      if (saves === 1) throw new Error("injected durable save failure");
    } };
    function metadata(item) {
      return item && item.orchestrationPolicy && item.orchestrationPolicy.portfolioExecution;
    }
    function validEnvelope(envelope, payload) {
      return !!envelope && envelope.schema === external.COMMAND_SCHEMA &&
        envelope.schemaVersion === external.COMMAND_VERSION && payload &&
        payload.type === "portfolio_execution_message";
    }
    var replay = deliveryReplayModule.createDeliveryReplayStore({ executionMetadata: metadata,
      projectId: function () { return PROJECT; }, sm: sm, validEnvelope: validEnvelope });
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, dbPath: dbPath });
    var message = { schema: external.COMMAND_SCHEMA, schemaVersion: external.COMMAND_VERSION,
      eventId: "message-save-retry", source: SOURCE, destination: NEW,
      payload: { type: "portfolio_execution_message", portfolioTaskId: "task-main",
        bindingRevision: 1, text: "retry the durable save" } };
    assert.throws(function () { replay.prepare(session, message, delivery); }, /injected durable save failure/);
    replay.prepare(session, message, delivery);
    assert.equal(saves, 2);
    assert.equal(metadata(session).recoveryDeliveries.length, 1);
    assert.equal(delivery.listEffects().length, 0);
    delivery.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

availableTest("production startup resumes an already-appended direct message before receipting it", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-direct-replay-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  var previous = { store: process.env.CLAY_COOP_CONTROL_STORE,
    executions: process.env.CLAY_COOP_CONTROL_EXECUTIONS,
    recovery: process.env.CLAY_COOP_CONTROL_RECOVERY };
  process.env.CLAY_COOP_CONTROL_STORE = "1";
  process.env.CLAY_COOP_CONTROL_EXECUTIONS = "1";
  process.env.CLAY_COOP_CONTROL_RECOVERY = "1";
  controlRuntime.closeExecutionControl();
  try {
    var control = controlRuntime.getExecutionControl({ enabled: true, dbPath: dbPath });
    var delivery = controlRuntime.getDeliveryControl({ enabled: true, dbPath: dbPath });
    var token = started(control);
    var unrelatedRequest = { portfolioTaskId: "task-unrelated-restart", bindingRevision: 1,
      idempotencyKey: "task-unrelated-restart-r1", mode: "project_coordinator",
      targetProject: { projectId: PROJECT }, source: SOURCE };
    var unrelated = control.reserveStart(unrelatedRequest);
    control.bindStart(unrelated, { projectId: PROJECT, sessionStorageId: "coordinator-unrelated" });
    control.openStartBarrier(unrelated);
    control.markProviderStarted(unrelated);
    var session = { localId: 1, storageId: OLD.sessionStorageId, history: [], isProcessing: false,
      orchestrationPolicy: { portfolioExecution: { portfolioTaskId: "task-main", bindingRevision: 1,
        idempotencyKey: "task-main-r1", mode: "project_coordinator", source: SOURCE, status: "running" } } };
    var metadata = session.orchestrationPolicy.portfolioExecution;
    metadata.control = executionFence.attachFence(session, control.createFence(token));
    var saves = 0;
    var queryStarts = 0;
    var sm = { sessions: new Map([[1, session]]), getProjectId: function () { return PROJECT; },
      appendToSessionFile: function () {}, broadcastSessionList: function () {},
      saveSessionFile: function () { saves += 1; } };
    function validEnvelope(envelope, payload) {
      return !!envelope && envelope.schema === external.COMMAND_SCHEMA &&
        envelope.schemaVersion === external.COMMAND_VERSION && payload &&
        payload.type === "portfolio_execution_message";
    }
    var replay = deliveryReplayModule.createDeliveryReplayStore({ executionMetadata: function (item) {
      return item && item.orchestrationPolicy && item.orchestrationPolicy.portfolioExecution;
    }, projectId: function () { return PROJECT; }, sm: sm, validEnvelope: validEnvelope });
    var message = { schema: external.COMMAND_SCHEMA, schemaVersion: external.COMMAND_VERSION,
      eventId: "message-production-restart", source: SOURCE, destination: OLD,
      payload: { type: "portfolio_execution_message", portfolioTaskId: "task-main",
        bindingRevision: 1, text: "apply after the production restart" } };
    var prepared = replay.prepare(session, message, delivery);
    var stable = delivery.enqueue(prepared.stable);
    delivery.receive(stable, prepared.effect);
    session.history.push({ type: "user_message", text: message.payload.text,
      synthetic: true, origin: { kind: "portfolio_execution" },
      controlEffectId: prepared.effectId, _ts: Date.now() });
    assert.equal(delivery.listPendingEffects().length, 1);
    assert.equal(metadata.recoveryDeliveries.length, 1);

    delete session._coopExecutionFence;
    controlRuntime.closeExecutionControl();
    var reopenedControl = controlRuntime.getExecutionControl({ enabled: true, dbPath: dbPath });
    external.attachPortfolioExecutionTarget({ sm: sm, sdk: { startQuery: function (target) {
      queryStarts += 1;
      assert.equal(controlRuntime.getStartupRecovery().state(), "recovering");
      target._coopExecutionFence.assert("provider_start");
      target._coopExecutionFence.markProviderStarted();
      return { ok: true };
    } }, ensureProjectAccessForSession: function () {}, onProcessingChanged: function () {} });
    assert.equal(controlRuntime.getStartupRecovery().state(), "closed");
    var result = sm.recoverCoopControlStartup();
    assert.equal(result.recoveredExecutions, 1);
    assert.equal(result.reconciledEffects, 1);
    assert.equal(controlRuntime.getStartupRecovery().isReady(), true);
    assert.equal(queryStarts, 1);
    assert.equal(session.history.filter(function (item) {
      return item.controlEffectId === prepared.effectId;
    }).length, 1);
    assert.equal(metadata.recoveryDeliveries.length, 0);
    assert.equal(metadata.status, "running");
    var durable = reopenedControl.inspect(token.executionId);
    assert.equal(durable.execution.status, "running");
    assert.equal(durable.current.startState, "started");
    assert.equal(durable.current.epoch, token.epoch + 1);
    assert.deepEqual(durable.current.sessionRef, OLD);
    assert.equal(durable.leases.length, 1);
    ["callback", "tool", "completion"].forEach(function (action) {
      assert.equal(session._coopExecutionFence.isCurrent(action), true);
    });
    var unrelatedDurable = reopenedControl.inspect(unrelated.executionId);
    assert.equal(unrelatedDurable.execution.status, "failed");
    assert.equal(unrelatedDurable.leases.length, 0);
    ["callback", "tool"].forEach(function (action) {
      assert.throws(function () { reopenedControl.assertCapability(token, action); }, function (error) {
        return error && error.code === "COOP_CONTROL_FENCE_REJECTED";
      });
    });
    assert.throws(function () { reopenedControl.complete(token); }, function (error) {
      return error && error.code === "COOP_CONTROL_FENCE_REJECTED";
    });
    assert.equal(controlRuntime.getDeliveryControl().listPendingEffects().length, 0);
    var receivedEffect = controlRuntime.getDeliveryControl().listEffects()[0];
    assert.equal(receivedEffect.state, "received");
    assert.match(receivedEffect.receiptId, /^receipt:/);
    assert.ok(saves >= 4);
  } finally {
    controlRuntime.closeExecutionControl();
    if (previous.store === undefined) delete process.env.CLAY_COOP_CONTROL_STORE;
    else process.env.CLAY_COOP_CONTROL_STORE = previous.store;
    if (previous.executions === undefined) delete process.env.CLAY_COOP_CONTROL_EXECUTIONS;
    else process.env.CLAY_COOP_CONTROL_EXECUTIONS = previous.executions;
    if (previous.recovery === undefined) delete process.env.CLAY_COOP_CONTROL_RECOVERY;
    else process.env.CLAY_COOP_CONTROL_RECOVERY = previous.recovery;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

availableTest("direct-leaf replay cannot emit a terminal completion before startup recovery", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-direct-leaf-replay-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  var previous = { store: process.env.CLAY_COOP_CONTROL_STORE,
    executions: process.env.CLAY_COOP_CONTROL_EXECUTIONS,
    recovery: process.env.CLAY_COOP_CONTROL_RECOVERY };
  process.env.CLAY_COOP_CONTROL_STORE = "1";
  process.env.CLAY_COOP_CONTROL_EXECUTIONS = "1";
  process.env.CLAY_COOP_CONTROL_RECOVERY = "1";
  controlRuntime.closeExecutionControl();
  try {
    var control = controlRuntime.getExecutionControl({ enabled: true, dbPath: dbPath });
    var delivery = controlRuntime.getDeliveryControl({ enabled: true, dbPath: dbPath });
    var directRequest = Object.assign({}, request(), { mode: "direct_leaf" });
    var token = control.reserveStart(directRequest);
    control.bindStart(token, OLD);
    control.openStartBarrier(token);
    control.markProviderStarted(token);
    var session = { localId: 1, storageId: OLD.sessionStorageId, history: [], isProcessing: false,
      coopControlledBy: { coopSessionStorageId: SOURCE.sessionStorageId, since: Date.now() },
      orchestrationPolicy: { portfolioExecution: { portfolioTaskId: "task-main", bindingRevision: 1,
        idempotencyKey: "task-main-r1", mode: "direct_leaf", source: SOURCE, status: "running" } } };
    var metadata = session.orchestrationPolicy.portfolioExecution;
    metadata.control = executionFence.attachFence(session, control.createFence(token));
    var completions = [];
    var queryStarts = 0;
    var sm = { sessions: new Map([[1, session]]), getProjectId: function () { return PROJECT; },
      appendToSessionFile: function () {}, broadcastSessionList: function () {},
      saveSessionFile: function () {}, subscribeSession: function () { return function () {}; } };
    function validEnvelope(envelope, payload) {
      return !!envelope && envelope.schema === external.COMMAND_SCHEMA &&
        envelope.schemaVersion === external.COMMAND_VERSION && payload &&
        payload.type === "portfolio_execution_message";
    }
    var replay = deliveryReplayModule.createDeliveryReplayStore({ executionMetadata: function (item) {
      return item && item.orchestrationPolicy && item.orchestrationPolicy.portfolioExecution;
    }, projectId: function () { return PROJECT; }, sm: sm, validEnvelope: validEnvelope });
    var message = { schema: external.COMMAND_SCHEMA, schemaVersion: external.COMMAND_VERSION,
      eventId: "message-direct-leaf-restart", source: SOURCE, destination: OLD,
      payload: { type: "portfolio_execution_message", portfolioTaskId: "task-main",
        bindingRevision: 1, text: "resume the direct leaf" } };
    var prepared = replay.prepare(session, message, delivery);
    var stable = delivery.enqueue(prepared.stable);
    delivery.receive(stable, prepared.effect);
    session.history.push({ type: "user_message", text: message.payload.text,
      synthetic: true, origin: { kind: "portfolio_execution" },
      controlEffectId: prepared.effectId, _ts: Date.now() });
    delete session._coopExecutionFence;
    controlRuntime.closeExecutionControl();
    var reopenedControl = controlRuntime.getExecutionControl({ enabled: true, dbPath: dbPath });
    external.attachPortfolioExecutionTarget({ sm: sm, sdk: { startQuery: function (target) {
      queryStarts += 1;
      target._coopExecutionFence.assert("provider_start");
      target._coopExecutionFence.markProviderStarted();
      return { ok: true };
    } }, crossProject: { createEnvelope: function (spec) { return spec; },
      deliverEnvelope: function (envelope) { completions.push(envelope); return { ok: true }; } },
    ensureProjectAccessForSession: function () {}, onProcessingChanged: function () {}, slug: "target" });
    assert.equal(metadata.status, "running");
    assert.equal(completions.length, 0);
    var result = sm.recoverCoopControlStartup();
    assert.equal(result.reconciledEffects, 1);
    assert.equal(queryStarts, 1);
    assert.equal(completions.length, 0);
    assert.equal(metadata.status, "running");
    assert.equal(metadata.completionEventId, undefined);
    var durable = reopenedControl.inspect(token.executionId);
    assert.equal(durable.execution.status, "running");
    assert.equal(durable.current.startState, "started");
    assert.equal(durable.leases.length, 1);
  } finally {
    controlRuntime.closeExecutionControl();
    if (previous.store === undefined) delete process.env.CLAY_COOP_CONTROL_STORE;
    else process.env.CLAY_COOP_CONTROL_STORE = previous.store;
    if (previous.executions === undefined) delete process.env.CLAY_COOP_CONTROL_EXECUTIONS;
    else process.env.CLAY_COOP_CONTROL_EXECUTIONS = previous.executions;
    if (previous.recovery === undefined) delete process.env.CLAY_COOP_CONTROL_RECOVERY;
    else process.env.CLAY_COOP_CONTROL_RECOVERY = previous.recovery;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

availableTest("startup classifies prepared handoffs before generic cleanup", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var prepared = h.handoff.prepare({ class: "B", reason: "context_exhausted", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: packet(null, predecessor) });
    var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
      executionControl: h.control, handoffControl: h.handoff });
    var resumedRef = null;
    var result = startup.recover({ rehydrate: function (record, checkpoint, token, recovery) {
      resumedRef = recovery.target;
      return checkpoint.exam.passed === true;
    }, activate: function (record, token) {
      h.control.markProviderStarted(token);
      return true;
    } });
    assert.equal(result.abortedHandoffs, 1);
    assert.equal(h.handoff.inspect(prepared.handoffId).state, "aborted");
    assert.deepEqual(resumedRef, OLD);
    assert.throws(function () { h.control.assertCapability(predecessor, "callback"); },
      function (error) { return error && error.code === "COOP_CONTROL_FENCE_REJECTED"; });
    var durable = h.control.inspect(predecessor.executionId);
    assert.equal(durable.execution.status, "running");
    assert.deepEqual(durable.current.sessionRef, OLD);
    assert.equal(durable.current.startState, "started");
    assert.equal(durable.leases.length, 1);
  } finally { h.cleanup(); }
});

availableTest("pre-cutover restart reactivates the same predecessor and deletes only its receipted successor", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var prepared = h.handoff.prepare({ class: "B", reason: "context_exhausted",
      predecessor: predecessor, from: OLD, successor: NEW, continuity: packet(null, predecessor) });
    var receipt = "receipt:" + crypto.createHash("sha256").update(prepared.handoffId + "\u0000" +
      NEW.projectId + "\u0000" + NEW.sessionStorageId, "utf8").digest("hex").slice(0, 48);
    var source = { localId: 1, storageId: OLD.sessionStorageId, history: [], orchestrationPolicy: {
      portfolioExecution: { status: "running", control: {
        executionId: predecessor.executionId, incarnationId: predecessor.incarnationId,
        epoch: predecessor.epoch, role: predecessor.role, authorityId: predecessor.authorityId,
      } },
    } };
    var successor = { localId: 2, storageId: NEW.sessionStorageId, history: [], isProcessing: false,
      orchestrationPolicy: { portfolioExecution: { status: "pending", recoveryPreallocation: {
        handoffId: prepared.handoffId, receiptId: receipt, sessionRef: NEW,
      } } } };
    var sessions = new Map([[1, source], [2, successor]]);
    var sm = { sessions: sessions, saveSessionFile: function () {},
      deleteSessionQuiet: function (id) { sessions.delete(id); } };
    function metadata(session) {
      return session && session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
    }
    h.handoff.ensureSuccessor(prepared.handoffId, function () {
      return { receiptId: receipt, sessionRef: NEW };
    });
    var resumeInput = null;
    var handlers = runtimeTarget.createTargetRecoveryHandlers({ control: h.control,
      executionMetadata: metadata, projectId: function () { return PROJECT; }, sm: sm,
      startQuery: function (session, prompt, discard, mode) {
        resumeInput = prompt;
        assert.equal(mode, "recovery");
        session._coopExecutionFence.markProviderStarted();
        return { ok: true };
      } });
    var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
      executionControl: h.control, handoffControl: h.handoff });
    var result = startup.recover(handlers);
    assert.equal(result.abortedHandoffs, 1);
    assert.equal(sessions.size, 1);
    assert.equal(sessions.get(1), source);
    assert.equal(h.handoff.inspect(prepared.handoffId).state, "aborted");
    var durable = h.control.inspect(predecessor.executionId);
    assert.deepEqual(durable.current.sessionRef, OLD);
    assert.equal(durable.current.startState, "started");
    assert.equal(durable.leases.length, 1);
    assert.match(resumeInput, /objective-main/);
    assert.match(resumeInput, /decision-main/);
    assert.match(resumeInput, /request-main/);
    assert.match(resumeInput, /task-main/);
  } finally { h.cleanup(); }
});

availableTest("post-cutover provider-start failure preserves recovery state and reopen rolls forward", function () {
  var h = harness();
  var reopenedStore = null;
  var reopenedControl = null;
  var reopenedHandoff = null;
  try {
    var predecessor = started(h.control);
    var prepared = h.handoff.prepare({ class: "B", reason: "provider_unhealthy",
      predecessor: predecessor, from: OLD, successor: NEW, continuity: packet(null, predecessor) });
    h.handoff.ensureSuccessor(prepared.handoffId, function () { return evidence(NEW, "receipt-provider-fail"); });
    h.handoff.cutover(prepared.handoffId);
    var session = { localId: 2, storageId: NEW.sessionStorageId, history: [], orchestrationPolicy: {
      portfolioExecution: { status: "pending", control: {
        executionId: predecessor.executionId, incarnationId: predecessor.incarnationId,
        epoch: predecessor.epoch, role: predecessor.role, authorityId: predecessor.authorityId,
      } },
    } };
    var sessions = new Map([[2, session]]);
    var sm = { sessions: sessions, saveSessionFile: function () {}, broadcastSessionList: function () {} };
    function metadata(item) {
      return item && item.orchestrationPolicy && item.orchestrationPolicy.portfolioExecution;
    }
    function starterFor(control, shouldFail) {
      var targetControl = executionTarget.createTargetExecutionControl({ coopExecutionControl: control,
        projectId: function () { return PROJECT; } });
      return executionTarget.createExecutionStarter({ ensureProjectAccessForSession: function () {},
        executionControl: targetControl, onProcessingChanged: function () {}, sm: sm,
        sdk: { startQuery: function (target) {
          target._coopExecutionFence.assert("provider_start");
          if (shouldFail) {
            target._coopExecutionFence.abandon("provider_start_failed");
            return { ok: false, reason: "provider_unavailable" };
          }
          target._coopExecutionFence.markProviderStarted();
          return { ok: true };
        } }, setExecutionStatus: function (target, status, reason) {
          metadata(target).status = status;
          metadata(target).reason = reason;
          sm.saveSessionFile(target);
        } }).startQuery;
    }
    var failedHandlers = runtimeTarget.createTargetRecoveryHandlers({ control: h.control,
      executionMetadata: metadata, projectId: function () { return PROJECT; }, sm: sm,
      startQuery: starterFor(h.control, true) });
    var checkpoint = h.handoff.checkpoint(prepared.handoffId);
    var firstRecovery = h.handoff.recover(prepared.handoffId);
    assert.equal(failedHandlers.rehydrate(firstRecovery.handoff, checkpoint,
      firstRecovery.token, firstRecovery), true);
    assert.equal(failedHandlers.activate(firstRecovery.handoff, firstRecovery.token, firstRecovery), false);
    var preserved = h.control.inspect(predecessor.executionId);
    assert.equal(h.handoff.inspect(prepared.handoffId).state, "replaying");
    assert.equal(preserved.execution.status, "pending");
    assert.equal(preserved.current.startState, "ready");
    assert.equal(preserved.leases.length, 1);

    h.handoff.close();
    h.control.close();
    h.store.close();
    reopenedStore = storeModule.openControlStore({ dbPath: h.dbPath });
    reopenedControl = executions.createExecutionControl({ enabled: true, store: reopenedStore });
    reopenedHandoff = handoffs.createHandoffControl({ enabled: true, store: reopenedStore,
      executionControl: reopenedControl });
    assert.equal(reopenedHandoff.listRecoverable().length, 1);
    var recoveredHandlers = runtimeTarget.createTargetRecoveryHandlers({ control: reopenedControl,
      executionMetadata: metadata, projectId: function () { return PROJECT; }, sm: sm,
      startQuery: starterFor(reopenedControl, false) });
    var startup = startupModule.createStartupRecovery({ enabled: true, store: reopenedStore,
      executionControl: reopenedControl, handoffControl: reopenedHandoff });
    var result = startup.recover(recoveredHandlers);
    assert.equal(result.recoveredHandoffs, 1);
    assert.equal(reopenedHandoff.inspect(prepared.handoffId).state, "completed");
    var durable = reopenedControl.inspect(predecessor.executionId);
    assert.equal(durable.execution.status, "running");
    assert.equal(durable.current.startState, "started");
    assert.equal(durable.leases.length, 1);
  } finally {
    try { if (reopenedHandoff) reopenedHandoff.close(); } catch (error) {}
    try { if (reopenedControl) reopenedControl.close(); } catch (error) {}
    try { if (reopenedStore) reopenedStore.close(); } catch (error) {}
    h.cleanup();
  }
});

availableTest("startup recovery reaches a fixed point when effect work is reentrant", function () {
  var h = harness();
  try {
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: h.store });
    var first = delivery.enqueue({ messageId: "message-first", sender: SOURCE, recipient: NEW,
      kind: "rehydration", referenceId: "checkpoint-first", payloadDigest: "a".repeat(64) });
    delivery.receive(first, { kind: "rehydrate", target: NEW });
    var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
      executionControl: h.control, handoffControl: h.handoff, deliveryControl: delivery });
    var applied = [];
    var result = startup.recover({ send: function () { return { accepted: true }; }, applyEffect: function (effect) {
      applied.push(effect.effectId);
      if (applied.length === 1) {
        var second = delivery.enqueue({ messageId: "message-second", sender: SOURCE, recipient: NEW,
          kind: "rehydration", referenceId: "checkpoint-second", payloadDigest: "b".repeat(64) });
        delivery.receive(second, { kind: "rehydrate", target: NEW });
      }
      return { receiptId: "receipt-" + applied.length };
    } });
    assert.equal(result.reconciledEffects, 2);
    assert.equal(delivery.listEffects().filter(function (item) { return item.state === "intended"; }).length, 0);
    assert.equal(startup.isReady(), true);
  } finally { h.cleanup(); }
});

availableTest("recovery keeps every participating handoff execution protected until the barrier opens", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var prepared = h.handoff.prepare({ class: "B", reason: "context_exhausted", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: packet(null, predecessor) });
    h.handoff.ensureSuccessor(prepared.handoffId, function () { return evidence(NEW, "receipt-protected"); });
    h.handoff.cutover(prepared.handoffId);
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: h.store });
    var first = delivery.enqueue({ messageId: "message-protected", sender: SOURCE, recipient: NEW,
      kind: "rehydration", referenceId: "checkpoint-protected", payloadDigest: "e".repeat(64) });
    delivery.receive(first, { kind: "rehydrate", target: NEW });
    var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
      executionControl: h.control, handoffControl: h.handoff, deliveryControl: delivery });
    startup.recover({ rehydrate: function () { return true; }, activate: function (record, token) {
      h.control.markProviderStarted(token);
      return true;
    }, send: function () { return { accepted: true }; }, applyEffect: function (effect) {
      var second = delivery.enqueue({ messageId: "message-protected-second", sender: SOURCE, recipient: NEW,
        kind: "rehydration", referenceId: "checkpoint-protected-second", payloadDigest: "f".repeat(64) });
      if (effect.messageId === first.messageId) delivery.receive(second, { kind: "rehydrate", target: NEW });
      return { receiptId: "receipt-" + effect.effectId.slice(-12) };
    } });
    var durable = h.control.inspect(predecessor.executionId);
    assert.equal(startup.isReady(), true);
    assert.equal(durable.execution.status, "running");
    assert.equal(durable.current.startState, "started");
    assert.equal(durable.leases.length, 1);
  } finally { h.cleanup(); }
});

availableTest("startup reconciles hundreds of effects with one joined pending query and no inbox lookups", function () {
  var h = harness();
  try {
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: h.store });
    for (var i = 0; i < 200; i++) {
      var stable = delivery.enqueue({ messageId: "message-joined-" + i, sender: SOURCE, recipient: NEW,
        kind: "rehydration", referenceId: "checkpoint-joined-" + i, payloadDigest: "a".repeat(64) });
      delivery.receive(stable, { kind: "rehydrate", target: NEW });
    }
    var joined = 0;
    var listJoined = h.store.listEffectsWithInbox;
    h.store.getInbox = function () { throw new Error("per-effect inbox lookup"); };
    h.store.listEffects = function () { throw new Error("full effect scan"); };
    h.store.listEffectsWithInbox = function (pendingOnly) {
      joined += 1;
      return listJoined(pendingOnly);
    };
    var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
      executionControl: h.control, handoffControl: h.handoff, deliveryControl: delivery });
    var result = startup.recover({ send: function () { return { accepted: true }; }, applyEffect: function (effect) {
      return { receiptId: "receipt-" + effect.effectId.slice(-12) };
    } });
    assert.equal(result.reconciledEffects, 200);
    assert.equal(joined, 1);
  } finally { h.cleanup(); }
});

availableTest("async activation leaves the startup barrier closed until provider evidence resolves", function () {
  var h = harness();
  var predecessor = started(h.control);
  var prepared = h.handoff.prepare({ class: "B", reason: "context_exhausted", predecessor: predecessor,
    from: OLD, successor: NEW, continuity: packet(null, predecessor) });
  h.handoff.ensureSuccessor(prepared.handoffId, function () { return evidence(NEW, "receipt-async"); });
  h.handoff.cutover(prepared.handoffId);
  var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
    executionControl: h.control, handoffControl: h.handoff });
  var activate;
  var recovery = startup.recover({ rehydrate: function () { return true; }, activate: function (record, token) {
    return new Promise(function (resolve) { activate = function () {
      h.control.markProviderStarted(token);
      resolve(true);
    }; });
  }, send: function () { return { accepted: true }; }, applyEffect: function () {
    return { receiptId: "receipt-async-effect" };
  } });
  assert.equal(typeof recovery.then, "function");
  assert.equal(startup.isReady(), false);
  assert.throws(function () { startup.assertReady(); }, function (error) {
    return error && error.code === "COOP_CONTROL_RECOVERY_BARRIER_CLOSED";
  });
  activate();
  return recovery.then(function () {
    assert.equal(startup.isReady(), true);
    assert.equal(h.control.inspect(predecessor.executionId).execution.status, "running");
    h.cleanup();
  }, function (error) {
    h.cleanup();
    throw error;
  });
});

availableTest("async effect recovery keeps the startup barrier closed until its receipt is durable", function () {
  var h = harness();
  var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: h.store });
  var stable = delivery.enqueue({ messageId: "message-async-effect", sender: SOURCE, recipient: NEW,
    kind: "rehydration", referenceId: "checkpoint-async-effect", payloadDigest: "9".repeat(64) });
  delivery.receive(stable, { kind: "rehydrate", target: NEW });
  var finish;
  var startup = startupModule.createStartupRecovery({ enabled: true, store: h.store,
    executionControl: h.control, handoffControl: h.handoff, deliveryControl: delivery });
  var recovery = startup.recover({ send: function () { return { accepted: true }; },
    applyEffect: function () {
      return new Promise(function (resolve) { finish = function () {
        resolve({ receiptId: "receipt-async-effect" });
      }; });
    } });
  assert.equal(typeof recovery.then, "function");
  assert.equal(startup.isReady(), false);
  assert.equal(delivery.listPendingEffects().length, 1);
  finish();
  return recovery.then(function () {
    assert.equal(startup.isReady(), true);
    assert.equal(delivery.listPendingEffects().length, 0);
    assert.equal(delivery.listEffects()[0].receiptId, "receipt-async-effect");
    h.cleanup();
  }, function (error) {
    h.cleanup();
    throw error;
  });
});

availableTest("runtime delays persisted cutover recovery until production handlers are installed", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-runtime-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  controlRuntime.closeExecutionControl();
  try {
    var control = controlRuntime.getExecutionControl({ enabled: true, dbPath: dbPath });
    var handoff = controlRuntime.getHandoffControl({ enabled: true, dbPath: dbPath });
    var predecessor = started(control);
    var continuityPacket = packet({ learningReferences: [{ learningId: "learning-runtime", version: 2 }] },
      predecessor);
    var prepared = handoff.prepare({ class: "B", reason: "context_exhausted", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: continuityPacket });
    handoff.ensureSuccessor(prepared.handoffId, function () { return evidence(NEW, "receipt-runtime"); });
    handoff.cutover(prepared.handoffId);
    var startup = controlRuntime.getStartupRecovery({ enabled: true, dbPath: dbPath });
    assert.equal(startup.state(), "closed");
    var result = controlRuntime.recoverStartup({ enabled: true, dbPath: dbPath,
      recoveryHandlers: { activate: function (record, token) { control.markProviderStarted(token); return true; },
        rehydrate: function () { return true; }, send: function () { return { accepted: true }; },
        applyEffect: function () { return { receiptId: "receipt-runtime-effect" }; } } });
    assert.equal(result.recoveredHandoffs, 1);
    assert.equal(startup.isReady(), true);
  } finally {
    controlRuntime.closeExecutionControl();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

availableTest("process-wide startup batches target registration before one recovery pass", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-runtime-registry-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  controlRuntime.closeExecutionControl();
  try {
    var delivery = controlRuntime.getDeliveryControl({ enabled: true, dbPath: dbPath });
    var targetA = { projectId: PROJECT, sessionStorageId: "target-a" };
    var targetB = { projectId: PROJECT_B, sessionStorageId: "target-b" };
    var stableA = { messageId: "message-project-a", sender: SOURCE, recipient: targetA,
      kind: "rehydration", referenceId: "checkpoint-project-a", payloadDigest: "a".repeat(64) };
    var stableB = { messageId: "message-project-b", sender: SOURCE, recipient: targetB,
      kind: "rehydration", referenceId: "checkpoint-project-b", payloadDigest: "b".repeat(64) };
    delivery.receive(stableA, { kind: "rehydrate", target: targetA });
    delivery.receive(stableB, { kind: "rehydrate", target: targetB });
    var applied = { a: 0, b: 0 };
    function handlers(key) {
      return { applyEffect: function (effect) {
        applied[key] += 1;
        return { receiptId: "receipt-" + effect.effectId.slice(-32) };
      }, send: function () { return { accepted: true }; } };
    }
    controlRuntime.registerRecoveryTarget({ projectRef: { projectId: PROJECT },
      recoveryHandlers: handlers("a"), sessionManager: { name: "manager-a" } });
    var scheduled = controlRuntime.scheduleStartupRecovery({ enabled: true, dbPath: dbPath });
    controlRuntime.registerRecoveryTarget({ projectRef: { projectId: PROJECT_B },
      recoveryHandlers: handlers("b"), sessionManager: { name: "manager-b" } });
    return scheduled.then(function (result) {
      assert.equal(result.reconciledEffects, 2);
      assert.deepEqual(applied, { a: 1, b: 1 });
      assert.equal(controlRuntime.getStartupRecovery().isReady(), true);
      assert.equal(delivery.listPendingEffects().length, 0);
    }).finally(function () {
      controlRuntime.closeExecutionControl();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  } catch (error) {
    controlRuntime.closeExecutionControl();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
});

availableTest("target wiring installs real recovery handlers before controlled intake opens", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-target-recovery-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  var previous = { store: process.env.CLAY_COOP_CONTROL_STORE, executions: process.env.CLAY_COOP_CONTROL_EXECUTIONS,
    recovery: process.env.CLAY_COOP_CONTROL_RECOVERY };
  process.env.CLAY_COOP_CONTROL_STORE = "1";
  process.env.CLAY_COOP_CONTROL_EXECUTIONS = "1";
  process.env.CLAY_COOP_CONTROL_RECOVERY = "1";
  controlRuntime.closeExecutionControl();
  try {
    var control = controlRuntime.getExecutionControl({ enabled: true, dbPath: dbPath });
    var handoff = controlRuntime.getHandoffControl({ enabled: true, dbPath: dbPath });
    var predecessor = started(control);
    var continuityPacket = packet({ learningReferences: [{ learningId: "learning-runtime", version: 2 }] },
      predecessor);
    var prepared = handoff.prepare({ class: "B", reason: "context_exhausted", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: continuityPacket });
    handoff.ensureSuccessor(prepared.handoffId, function () { return evidence(NEW, "receipt-target"); });
    handoff.cutover(prepared.handoffId);
    var session = { localId: 1, storageId: NEW.sessionStorageId, history: [], orchestrationPolicy: {
      portfolioExecution: { portfolioTaskId: "task-main", bindingRevision: 1,
        idempotencyKey: "task-main-r1", mode: "project_coordinator", status: "running", control: {
        executionId: predecessor.executionId, incarnationId: predecessor.incarnationId, epoch: predecessor.epoch,
        role: predecessor.role, authorityId: predecessor.authorityId,
      } },
    } };
    var sm = { sessions: new Map([[1, session]]), getProjectId: function () { return PROJECT; },
      saveSessionFile: function () {}, broadcastSessionList: function () {} };
    var resumePrompt = null;
    external.attachPortfolioExecutionTarget({ sm: sm, sdk: { startQuery: function (target, prompt) {
      resumePrompt = prompt;
      target._coopExecutionFence.assert("provider_start");
      target._coopExecutionFence.markProviderStarted();
      return { ok: true };
    } }, ensureProjectAccessForSession: function () {}, onProcessingChanged: function () {} });
    assert.equal(typeof sm.recoverCoopControlStartup, "function");
    sm.recoverCoopControlStartup();
    assert.equal(controlRuntime.getStartupRecovery().isReady(), true);
    assert.equal(handoff.inspect(prepared.handoffId).state, "completed");
    assert.equal(session._coopExecutionFence.refs.epoch, predecessor.epoch + 2);
    assert.deepEqual(session.orchestrationPolicy.portfolioExecution.recoveryContinuity.objectives,
      continuityPacket.objectives);
    assert.deepEqual(session.orchestrationPolicy.portfolioExecution.recoveryContinuity.decisions,
      continuityPacket.decisions);
    assert.deepEqual(session.orchestrationPolicy.portfolioExecution.recoveryContinuity.ownerRequests,
      continuityPacket.ownerRequests);
    assert.deepEqual(session.orchestrationPolicy.portfolioExecution.recoveryContinuity.tasks,
      continuityPacket.tasks);
    assert.deepEqual(session.orchestrationPolicy.portfolioExecution.recoveryContinuity.bindings,
      continuityPacket.bindings);
    assert.deepEqual(session.orchestrationPolicy.portfolioExecution.recoveryContinuity.authorities,
      continuityPacket.authorities);
    assert.deepEqual(session.orchestrationPolicy.portfolioExecution.recoveryContinuity.executions,
      continuityPacket.executions);
    assert.deepEqual(session.orchestrationPolicy.portfolioExecution.recoveryContinuity.learningReferences,
      continuityPacket.learningReferences);
    ["objective-main", "decision-main", "request-main", "task-main", "project_coordinator",
      predecessor.authorityId, predecessor.executionId, "learning-runtime"].forEach(function (needle) {
      assert.match(resumePrompt, new RegExp(needle));
    });
    assert.doesNotMatch(resumePrompt, /provider-history-secret|reasoning-secret|runtime-context-secret/);
  } finally {
    controlRuntime.closeExecutionControl();
    if (previous.store === undefined) delete process.env.CLAY_COOP_CONTROL_STORE;
    else process.env.CLAY_COOP_CONTROL_STORE = previous.store;
    if (previous.executions === undefined) delete process.env.CLAY_COOP_CONTROL_EXECUTIONS;
    else process.env.CLAY_COOP_CONTROL_EXECUTIONS = previous.executions;
    if (previous.recovery === undefined) delete process.env.CLAY_COOP_CONTROL_RECOVERY;
    else process.env.CLAY_COOP_CONTROL_RECOVERY = previous.recovery;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("continuity preserves canonical running and unavailable records with revision identity", function () {
  var value = packet({
    bindings: [
      { portfolioTaskId: "task-main", bindingRevision: 1, targetProject: { projectId: PROJECT },
        mode: "project_coordinator", status: "unavailable" },
      { portfolioTaskId: "task-main", bindingRevision: 2, targetProject: { projectId: PROJECT },
        mode: "project_coordinator", status: "active" },
    ],
    authorities: [{ authorityId: "auth:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: SOURCE,
      portfolioTaskId: "task-main", bindingRevision: 2, targetProject: { projectId: PROJECT },
      role: "coordinator", actionMask: 31 }, { authorityId: "auth:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", source: SOURCE,
      portfolioTaskId: "task-main", bindingRevision: 1, targetProject: { projectId: PROJECT },
      role: "coordinator", actionMask: 31 }],
    executions: [{ executionId: "exec:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: SOURCE,
      authorityId: "auth:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", portfolioTaskId: "task-main",
      bindingRevision: 2, targetProject: { projectId: PROJECT }, mode: "project_coordinator", role: "coordinator" },
    { executionId: "exec:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", source: SOURCE,
      authorityId: "auth:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", portfolioTaskId: "task-main",
      bindingRevision: 1, targetProject: { projectId: PROJECT }, mode: "project_coordinator", role: "coordinator" }],
  });
  var normalized = continuity.normalizeContinuityPacket(value);
  assert.equal(normalized.tasks[0].status, "running");
  assert.deepEqual(normalized.bindings.map(function (item) { return item.bindingRevision; }), [1, 2]);
  assert.throws(function () {
    continuity.normalizeContinuityPacket(packet({ authorities: [{
      authorityId: "auth:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      source: { projectId: PROJECT, sessionStorageId: SOURCE.sessionStorageId }, portfolioTaskId: "task-main",
      bindingRevision: 1, targetProject: { projectId: PROJECT }, role: "coordinator", actionMask: 31,
    }] }));
  }, function (error) { return error && error.code === "COOP_CONTROL_CONTINUITY_INVALID"; });
});

availableTest("successor creation requires synchronous exact receipt evidence", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var prepared = h.handoff.prepare({ class: "B", reason: "context_exhausted", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: packet(null, predecessor) });
    var bad = [function () { return false; }, function () { return { sessionRef: OLD, receiptId: "receipt-wrong" }; },
      function () { return Promise.resolve(evidence(NEW)); }];
    for (var i = 0; i < bad.length; i++) {
      assert.throws(function () { h.handoff.ensureSuccessor(prepared.handoffId, bad[i]); },
        function (error) { return error && error.code === "COOP_CONTROL_HANDOFF_INVALID"; });
    }
    h.handoff.ensureSuccessor(prepared.handoffId, function () { return evidence(NEW, "receipt-stable"); });
    assert.equal(h.handoff.inspect(prepared.handoffId).successorReceiptId, "receipt-stable");
  } finally { h.cleanup(); }
});

availableTest("v4 migration preserves created Class B successor receipt evidence", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var prepared = h.handoff.prepare({ class: "B", reason: "context_exhausted",
      predecessor: predecessor, from: OLD, successor: NEW, continuity: packet(null, predecessor) });
    h.handoff.ensureSuccessor(prepared.handoffId, function () {
      return evidence(NEW, "receipt-v4-created-successor");
    });
    h.handoff.close();
    h.control.close();
    h.store.close();
    var sqlite = require("node:sqlite");
    var db = new sqlite.DatabaseSync(h.dbPath);
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE coop_control_successor_receipts");
    db.exec("DROP TABLE coop_control_delivery_payloads");
    db.prepare("DELETE FROM coop_control_migrations WHERE version = 5").run();
    db.exec("PRAGMA user_version = 4");
    db.close();
    var migrated = storeModule.openControlStore({ dbPath: h.dbPath });
    var restored = migrated.getHandoff(prepared.handoffId);
    assert.equal(restored.successor_receipt_id, "receipt-v4-created-successor");
    var verify = new sqlite.DatabaseSync(h.dbPath, { readOnly: true });
    var receipt = verify.prepare("SELECT * FROM coop_control_successor_receipts WHERE handoff_id = ?")
      .get(prepared.handoffId);
    assert.equal(receipt.receipt_id, "receipt-v4-created-successor");
    assert.equal(receipt.session_project_id, NEW.projectId);
    assert.equal(receipt.session_storage_id, NEW.sessionStorageId);
    verify.close();
    migrated.close();
  } finally { h.cleanup(); }
});

availableTest("successor receipt converges across a post-create crash and retry", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var prepared = h.handoff.prepare({ class: "B", reason: "context_exhausted", predecessor: predecessor,
      from: OLD, successor: NEW, continuity: packet(null, predecessor) });
    var armed = true;
    var faulted = handoffs.createHandoffControl({ enabled: true, store: h.store, executionControl: h.control,
      faults: { afterSuccessorCreate: function () { if (armed) throw new Error("crash after create"); } } });
    assert.throws(function () {
      faulted.ensureSuccessor(prepared.handoffId, function () { return evidence(NEW, "receipt-retry"); });
    }, /crash after create/);
    assert.equal(h.handoff.inspect(prepared.handoffId).successorState, "planned");
    armed = false;
    h.handoff.ensureSuccessor(prepared.handoffId, function () { return evidence(NEW, "receipt-retry"); });
    assert.equal(h.handoff.inspect(prepared.handoffId).successorReceiptId, "receipt-retry");
    faulted.close();
  } finally { h.cleanup(); }
});

availableTest("production Class B handoff verifies canonical truth and persists the SessionManager successor receipt", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var source = { localId: 1, storageId: OLD.sessionStorageId, orchestrationPolicy: {
      portfolioExecution: { status: "running" },
    } };
    var sessions = new Map([[source.localId, source]]);
    var saves = 0;
    var sm = { sessions: sessions, createSessionRaw: function (options) {
      var session = { localId: sessions.size + 1, storageId: options.storageId, orchestrationPolicy: {} };
      sessions.set(session.localId, session);
      return session;
    }, saveSessionFile: function (session, options) {
      assert.equal(options && options.durable, true);
      saves += 1;
    } };
    var good = packet(null, predecessor);
    var adapter = handoffTarget.createProductionHandoffAdapter({ canonicalBinding: function () {
      return good.bindings[0];
    }, executionControl: h.control, executionMetadata: function (session) {
      return session && session.orchestrationPolicy.portfolioExecution;
    }, handlers: { rehydrate: function () { return true; }, activate: function (record, token) {
      h.control.markProviderStarted(token);
      return true;
    } }, handoffControl: h.handoff, projectId: function () { return PROJECT; }, sm: sm });
    var mismatched = packet({ bindings: [{ portfolioTaskId: "task-main", bindingRevision: 1,
      targetProject: { projectId: PROJECT }, mode: "project_coordinator", status: "unavailable" }] }, predecessor);
    assert.throws(function () { adapter.handoffExecution({ class: "B", continuity: mismatched, from: OLD,
      predecessor: predecessor, reason: "context_exhausted" }); }, function (error) {
      return error && error.code === "COOP_CONTROL_CONTINUITY_MISMATCH";
    });
    var completed = adapter.handoffExecution({ class: "B", continuity: good, from: OLD,
      predecessor: predecessor, reason: "context_exhausted" });
    assert.equal(completed.state, "completed");
    assert.equal(completed.successorState, "created");
    assert.ok(completed.successorReceiptId);
    assert.ok(saves > 0);
    assert.equal(sessions.size, 2);
  } finally { h.cleanup(); }
});

availableTest("production Class B retries successor durability after an in-memory save failure", function () {
  var h = harness();
  try {
    var predecessor = started(h.control);
    var source = { localId: 1, storageId: OLD.sessionStorageId, orchestrationPolicy: {
      portfolioExecution: { status: "running" },
    } };
    var sessions = new Map([[source.localId, source]]);
    var saves = 0;
    var sm = { sessions: sessions, createSessionRaw: function (options) {
      var session = { localId: sessions.size + 1, storageId: options.storageId, orchestrationPolicy: {} };
      sessions.set(session.localId, session);
      return session;
    }, saveSessionFile: function (session, options) {
      assert.equal(options && options.durable, true);
      saves += 1;
      if (saves === 1) throw new Error("injected successor save failure");
    } };
    var state = packet(null, predecessor);
    var adapter = handoffTarget.createProductionHandoffAdapter({ canonicalBinding: function () {
      return state.bindings[0];
    }, executionControl: h.control, executionMetadata: function (session) {
      return session && session.orchestrationPolicy.portfolioExecution;
    }, handlers: { rehydrate: function () { return true; }, activate: function (record, token) {
      h.control.markProviderStarted(token);
      return true;
    } }, handoffControl: h.handoff, projectId: function () { return PROJECT; }, sm: sm });
    var input = { class: "B", continuity: state, from: OLD, successor: NEW,
      predecessor: predecessor, reason: "context_exhausted" };
    assert.throws(function () { adapter.handoffExecution(input); }, /injected successor save failure/);
    var completed = adapter.handoffExecution(input);
    assert.equal(completed.state, "completed");
    assert.equal(saves, 2);
    assert.equal(sessions.size, 2);
  } finally { h.cleanup(); }
});

availableTest("delivery rejects an unrelated effect kind or target at receipt and audit boundaries", function () {
  var h = harness();
  try {
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: h.store });
    var envelope = delivery.enqueue({ messageId: "message-map", sender: SOURCE, recipient: NEW,
      kind: "rehydration", referenceId: "checkpoint-map", payloadDigest: "c".repeat(64) });
    assert.throws(function () { delivery.receive(envelope, { kind: "execution_update", target: NEW }); },
      function (error) { return error && error.code === "COOP_CONTROL_DELIVERY_INVALID"; });
    assert.throws(function () { delivery.receive(envelope, { kind: "rehydrate", target: OLD }); },
      function (error) { return error && error.code === "COOP_CONTROL_DELIVERY_INVALID"; });
  } finally { h.cleanup(); }
});

availableTest("startup audit rejects a persisted effect whose target differs from its recipient", function () {
  var h = harness();
  try {
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: h.store });
    var envelope = delivery.enqueue({ messageId: "message-audit", sender: SOURCE, recipient: NEW,
      kind: "rehydration", referenceId: "checkpoint-audit", payloadDigest: "e".repeat(64) });
    delivery.receive(envelope, { kind: "rehydrate", target: NEW });
    delivery.close();
    h.handoff.close();
    h.control.close();
    h.store.close();
    var sqlite = require("node:sqlite");
    var db = new sqlite.DatabaseSync(h.store.dbPath);
    db.prepare("UPDATE coop_control_effects SET target_session_id = ? WHERE message_id = ?")
      .run(OLD.sessionStorageId, "message-audit");
    db.close();
    assert.throws(function () { storeModule.openControlStore({ dbPath: h.store.dbPath }); },
      function (error) { return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION"; });
  } finally { h.cleanup(); }
});

availableTest("reconcileOne uses direct effect and inbox lookups", function () {
  var h = harness();
  try {
    var delivery = deliveryModule.createDeliveryControl({ enabled: true, store: h.store });
    var accepted;
    for (var i = 0; i < 400; i++) {
      var envelope = delivery.enqueue({ messageId: "message-indexed-" + i, sender: SOURCE, recipient: NEW,
        kind: "rehydration", referenceId: "checkpoint-indexed-" + i, payloadDigest: "d".repeat(64) });
      accepted = delivery.receive(envelope, { kind: "rehydrate", target: NEW });
    }
    var direct = { effect: 0, inbox: 0 };
    var getEffect = h.store.getEffect;
    var getInbox = h.store.getInbox;
    h.store.getEffect = function (id) { direct.effect += 1; return getEffect(id); };
    h.store.getInbox = function (id) { direct.inbox += 1; return getInbox(id); };
    h.store.listEffects = function () { throw new Error("full effect scan"); };
    h.store.listInbox = function () { throw new Error("full inbox scan"); };
    assert.equal(delivery.reconcileOne(accepted.effectId, function () {
      return { receiptId: "receipt-indexed" };
    }), true);
    assert.deepEqual(direct, { effect: 0, inbox: 0 });
  } finally { h.cleanup(); }
});
