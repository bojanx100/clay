var test = require("node:test");
var assert = require("node:assert");
var os = require("os");
var path = require("path");
var fs = require("fs");

process.env.CLAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-"));

var config = require("../lib/config");
var { createCrossProjectRouter } = require("../lib/server-cross-project");
var attachCompletionGate =
  require("../lib/project-task-orchestrator-completion").attachCompletionGate;
var attachSessionCompaction =
  require("../lib/project-session-compaction").attachSessionCompaction;

function readDeadLetters() {
  var file = config.recoveryLogPath();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map(function (line) { return JSON.parse(line); })
    .filter(function (e) { return e.kind === "cross_project_dead_letter"; });
}

function createRecoveryEventSink() {
  var events = [];
  return {
    events: events,
    record: function (event) { events.push(event); },
  };
}

test("deliver routes an update into the target project context", function () {
  var delivered = [];
  var router = createCrossProjectRouter({
    getProjectContext: function (slug) {
      if (slug !== "lead") return null;
      return {
        deliverCoordinatorUpdate: function (storageId, text) {
          delivered.push({ storageId: storageId, text: text });
          return true;
        },
      };
    },
  });
  var result = router.deliver("lead", "sess-1", "[Clay worker update] hello");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.authoritative, false);
  assert.strictEqual(result.compatibility, true);
  assert.strictEqual(router.legacyTextAuthoritative, false);
  assert.strictEqual(router.getExecutionBindings().length, 0,
    "legacy text delivery cannot become execution authority");
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].storageId, "sess-1");
  assert.strictEqual(delivered[0].text, "[Clay worker update] hello");
});

test("an explicit binding file keeps its reconciled session ledger in the same isolated store", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-ledger-path-"));
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    getProjectContext: function () { return null; },
  });

  assert.strictEqual(router.sessionLedger.file, path.join(dir, "coop-session-ledger.json"));
});

test("session queries preserve the last authoritative topic links across lifecycle reconciliation", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-ledger-links-"));
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var session = {
    storageId: "owner-direct-linked-session",
    title: "Owner direct linked session",
    createdAt: 10,
    lastActivity: 20,
  };
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    getProjectContext: function () { return null; },
  });
  var unregister = router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    getSessionManager: function () { return { sessions: new Map([[1, session]]) }; },
  });

  var first = router.queryCoopSessions({
    projectRefs: [{ projectId: projectId }],
    topicLinks: [{
      topicRef: { topicId: "topic-owner-direct" },
      sessionRef: { projectId: projectId, sessionStorageId: session.storageId },
    }],
  });
  assert.strictEqual(first.sessions.length, 1);
  assert.strictEqual(first.sessions[0].coopCreated, false);

  router.reconcileSessionLedger();
  var afterLifecycleEvent = router.queryCoopSessions({
    projectRefs: [{ projectId: projectId }],
  });
  assert.strictEqual(afterLifecycleEvent.sessions.length, 1);
  assert.deepStrictEqual(afterLifecycleEvent.sessions[0].coopTopicRef, {
    topicId: "topic-owner-direct",
  });

  unregister();
  var afterRemoval = router.queryCoopSessions({
    projectRefs: [{ projectId: projectId }],
  });
  assert.strictEqual(afterRemoval.sessions.length, 0);
  assert.strictEqual(router.sessionLedger.get({
    projectId: projectId,
    sessionStorageId: session.storageId,
  }).sessionPresent, false);
});

test("unknown project slug dead-letters instead of throwing", function () {
  var before = readDeadLetters().length;
  var router = createCrossProjectRouter({
    getProjectContext: function () { return null; },
  });
  var result = router.deliver("ghost", "sess-2", "text");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "unknown-project");
  var events = readDeadLetters();
  assert.strictEqual(events.length, before + 1);
  assert.strictEqual(events[events.length - 1].targetSlug, "ghost");
  assert.strictEqual(events[events.length - 1].sessionStorageId, "sess-2");
  assert.strictEqual(events[events.length - 1].reason, "unknown-project");
});

test("missing target session dead-letters as session-not-found", function () {
  var sink = createRecoveryEventSink();
  var router = createCrossProjectRouter({
    recordRecoveryEvent: sink.record,
    getProjectContext: function () {
      return { deliverCoordinatorUpdate: function () { return false; } };
    },
  });
  var result = router.deliver("lead", "gone", "text");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "session-not-found");
  assert.deepStrictEqual(sink.events, [{
    kind: "cross_project_dead_letter",
    targetSlug: "lead",
    sessionStorageId: "gone",
    reason: "session-not-found",
  }]);
});

test("delivery exceptions are contained and dead-lettered", function () {
  var sink = createRecoveryEventSink();
  var router = createCrossProjectRouter({
    recordRecoveryEvent: sink.record,
    getProjectContext: function () {
      return { deliverCoordinatorUpdate: function () { throw new Error("boom"); } };
    },
  });
  var result = router.deliver("lead", "sess-3", "text");
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /delivery-error: boom/);
  assert.deepStrictEqual(sink.events, [{
    kind: "cross_project_dead_letter",
    targetSlug: "lead",
    sessionStorageId: "sess-3",
    reason: "delivery-error: boom",
  }]);
});

test("missing slug or session id dead-letters as missing-target", function () {
  var sink = createRecoveryEventSink();
  var router = createCrossProjectRouter({
    recordRecoveryEvent: sink.record,
    getProjectContext: function () {
      throw new Error("should not be called");
    },
  });
  assert.strictEqual(router.deliver("", "sess", "t").reason, "missing-target");
  assert.strictEqual(router.deliver("lead", "", "t").reason, "missing-target");
  assert.deepStrictEqual(sink.events, [{
    kind: "cross_project_dead_letter",
    targetSlug: null,
    sessionStorageId: "sess",
    reason: "missing-target",
  }, {
    kind: "cross_project_dead_letter",
    targetSlug: "lead",
    sessionStorageId: null,
    reason: "missing-target",
  }]);
});

test("typed delivery resolves a dynamically registered project by ProjectRef", function () {
  var delivered = [];
  var projectId = "system-target";
  var router = createCrossProjectRouter({
    getProjectContext: function () { return null; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function (envelope) {
      delivered.push(envelope.eventId);
      return { ok: true };
    },
  });
  var envelope = router.createEnvelope({
    eventId: "resolver-project-ref",
    source: { projectId: "system-source", sessionStorageId: "source" },
    destination: { projectId: "system-target", sessionStorageId: "target" },
    bindingRevision: 1,
    createdAt: 1,
    payload: { type: "coordinator_update", text: "hello" },
  });

  assert.equal(router.deliverEnvelope(envelope).acknowledged, true);
  assert.deepEqual(delivered, ["resolver-project-ref"]);
});

test("project registration reconciles a hidden completed coordinator's active binding", function () {
  var projectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-completion-reconcile-"));
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var request = {
    source: { projectId: "system-lead", sessionStorageId: "coop-home" },
    portfolioTaskId: "portfolio-hidden-completed",
    bindingRevision: 1,
    idempotencyKey: "hidden-completed-r1",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
  };
  assert.equal(router.bindingStore.reserve(request).ok, true);
  assert.equal(router.bindingStore.commit(request.portfolioTaskId, request.bindingRevision, {
    projectId: projectId,
    sessionStorageId: "hidden-completed-coordinator",
  }).ok, true);

  var coordinator = {
    localId: 1,
    storageId: "hidden-completed-coordinator",
    hidden: true,
    orchestrationProjectCompletion: {
      status: "completed", completedAt: 123,
      summary: "Integrated result.", verification: "focused suite passed",
      integrationVerification: "yes", escalationRequired: "no",
    },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: request.portfolioTaskId,
      bindingRevision: request.bindingRevision,
      idempotencyKey: request.idempotencyKey,
      mode: "project_coordinator", status: "completed",
    } },
  };
  var manager = {
    sessions: new Map([[coordinator.localId, coordinator]]),
    saveSessionFile: function () {},
  };

  var registeredProjectId = null;
  router.registerProjectResolver({
    getProjectId: function () { return registeredProjectId; },
    getSessionManager: function () { return manager; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });

  assert.equal(router.getExecutionBinding(request.portfolioTaskId, request.bindingRevision).status,
    "active", "a resolver without its durable project id cannot claim a session");
  registeredProjectId = projectId;
  router.reconcileStrandedCompletions();
  assert.equal(router.getExecutionBinding(request.portfolioTaskId, request.bindingRevision).status,
    "completed");
});

test("a compacted project coordinator completes its original canonical binding", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-compacted-completion-"));
  var source = {
    localId: 1,
    storageId: "original-project-coordinator",
    title: "Portfolio coordinator",
    vendor: "codex",
    coordinationMode: true,
    orchestrationGraphId: "compacted-project-graph",
    orchestrationTasks: [],
    orchestrationEvents: [],
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 10 },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "portfolio-compacted-completion",
      bindingRevision: 1,
      idempotencyKey: "portfolio-compacted-completion-r1",
      mode: "project_coordinator",
      status: "running",
      source: { projectId: "system-lead", sessionStorageId: "coop-home" },
    } },
    history: [{ type: "user_message", text: "Finish the portfolio project." }],
  };
  var ownerDirect = {
    localId: 2,
    storageId: "owner-direct-session",
    title: "Owner direct session",
    history: [],
  };
  var sessions = new Map([[source.localId, source], [ownerDirect.localId, ownerDirect]]);
  var nextLocalId = 3;
  var manager = {
    sessions: sessions,
    getProjectId: function () { return projectId; },
    createSessionRaw: function (options) {
      var session = Object.assign({ localId: nextLocalId++, history: [] }, options);
      sessions.set(session.localId, session);
      return session;
    },
    sendAndRecord: function (session, event) { session.history.push(event); },
    saveSessionFile: function () {},
    switchSession: function () {},
    broadcastSessionList: function () {},
    hideSession: function (localId) { sessions.get(localId).hidden = true; },
  };
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    getProjectContextById: function (candidateProjectId) {
      return candidateProjectId === projectId ? {
        getSessionManager: function () { return manager; },
      } : null;
    },
  });
  var request = Object.assign({}, source.orchestrationPolicy.portfolioExecution, {
    targetProject: { projectId: projectId },
  });
  assert.equal(router.bindingStore.reserve(request).ok, true);
  assert.equal(router.bindingStore.commit(request.portfolioTaskId, request.bindingRevision, {
    projectId: projectId,
    sessionStorageId: source.storageId,
  }).ok, true);

  var compaction = attachSessionCompaction({
    cwd: process.cwd(),
    sm: manager,
    sdk: { startQuery: function () {} },
    sendToSession: function () {},
  });
  var continuation = compaction.compactAndContinue(source, { reason: "manual" });
  continuation.history.push({
    type: "delta",
    text: "PROJECT_COMPLETED: yes\nSUMMARY: Integrated through the continuation.\n" +
      "VERIFICATION: focused completion suite passed\nINTEGRATION_VERIFIED: yes\n" +
      "ESCALATION_REQUIRED: no",
  });

  var emitted = null;
  var delivered = null;
  var gate = attachCompletionGate({
    sm: manager,
    flushCoordinatorUpdates: function () { return false; },
    queueCoordinatorUpdate: function () {},
    sendState: function () {},
    crossProject: {
      createEnvelope: router.createEnvelope,
      deliverEnvelope: function (envelope) {
        emitted = envelope;
        delivered = router.completeProjectCoordinatorExecution(envelope);
        return delivered;
      },
    },
  });
  gate.handleTurnDone(continuation);

  assert.ok(emitted);
  assert.deepEqual(emitted.source, {
    projectId: projectId,
    sessionStorageId: continuation.storageId,
  });
  assert.deepEqual(router.getExecutionBinding(request.portfolioTaskId,
    request.bindingRevision).coordinator, {
    projectId: projectId,
    sessionStorageId: source.storageId,
  });
  assert.equal(delivered && delivered.ok, true,
    "the compacted continuation must be accepted as the bound coordinator lineage");
  var completed = router.getExecutionBinding(request.portfolioTaskId, request.bindingRevision);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completionEventId, emitted.eventId);
  assert.equal(completed.resultEventId, emitted.payload.resultEventId);
  assert.equal(source.hidden, true);
  assert.equal(continuation.hidden, true);
  assert.equal(ownerDirect.hidden, undefined);
});

test("project registration repairs a completed compacted coordinator binding after restart", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-compacted-reconcile-"));
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var request = {
    source: { projectId: "system-lead", sessionStorageId: "coop-home" },
    portfolioTaskId: "portfolio-compacted-restart",
    bindingRevision: 1,
    idempotencyKey: "portfolio-compacted-restart-r1",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
  };
  assert.equal(router.bindingStore.reserve(request).ok, true);
  assert.equal(router.bindingStore.commit(request.portfolioTaskId, request.bindingRevision, {
    projectId: projectId,
    sessionStorageId: "restart-original-coordinator",
  }).ok, true);

  var original = {
    localId: 1,
    storageId: "restart-original-coordinator",
    compactedIntoLocalId: 2,
    hidden: true,
  };
  var continuation = {
    localId: 2,
    storageId: "restart-continuation-coordinator",
    compactedFromStorageId: original.storageId,
    hidden: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 10 },
    orchestrationProjectCompletion: {
      status: "completed",
      completedAt: 123,
      summary: "Integrated after compaction.",
      verification: "restart reconciliation passed",
      integrationVerification: "yes",
      escalationRequired: "no",
    },
    orchestrationPolicy: { portfolioExecution: Object.assign({}, request, {
      status: "completed",
      completedAt: 123,
    }) },
  };
  var ownerDirect = {
    localId: 3,
    storageId: "restart-owner-direct",
    orchestrationProjectCompletion: continuation.orchestrationProjectCompletion,
    orchestrationPolicy: { portfolioExecution: Object.assign({}, request, {
      status: "completed",
      completedAt: 123,
    }) },
  };
  var manager = {
    sessions: new Map([[1, original], [2, continuation], [3, ownerDirect]]),
    saveSessionFile: function () {},
  };

  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    getSessionManager: function () { return manager; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });

  var completed = router.getExecutionBinding(request.portfolioTaskId, request.bindingRevision);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completedAt, 123);
  assert.match(completed.completionEventId, /^project-terminal-v1-/);
  assert.match(completed.resultEventId, /^project-coordinator-/);
  assert.equal(original.hidden, true);
  assert.equal(continuation.hidden, true);
  assert.equal(ownerDirect.hidden, undefined,
    "an unlinked owner-direct session with copied metadata is not part of the binding lineage");
});

test("project execution ACL and target capability fail closed", function () {
  var projectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-acl-"));
  var deliveries = 0;
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    canCreateExecution: function () { return false; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () {
      deliveries++;
      return { ok: true };
    },
  });
  var input = {
    source: { projectId: "system-lead", sessionStorageId: "coop" },
    portfolioTaskId: "portfolio-acl",
    bindingRevision: 1,
    idempotencyKey: "create-acl",
    mode: "direct_leaf",
    targetProject: { projectId: projectId },
    objective: "Do the bounded work.",
  };

  assert.equal(router.createProjectExecution(input).reason, "access_denied");
  assert.equal(deliveries, 0);
  assert.equal(router.getExecutionBindings().length, 0);

  var incapable = createCrossProjectRouter({
    bindingFile: path.join(dir, "incapable-bindings.json"),
    deliveryFile: path.join(dir, "incapable-delivery.json"),
    getProjectContextById: function () { return { getProjectId: function () { return projectId; } }; },
  });
  assert.equal(incapable.createProjectExecution(input).reason, "target_not_capable");
  assert.equal(incapable.getExecutionBindings().length, 0);
});

var CUTOVER_TARGET_ID = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";

function leadCutoverHarness(status, processing) {
  var saved = [];
  var aborts = 0;
  var task = {
    taskId: "legacy-task",
    status: status,
    workerStorageId: "legacy-worker",
  };
  var coordinator = {
    localId: 1,
    storageId: "coop-home",
    coopHome: true,
    orchestrationTasks: [task],
  };
  var worker = {
    localId: 2,
    storageId: "legacy-worker",
    isProcessing: !!processing,
    queryInstance: processing ? {} : null,
    abortController: { abort: function () { aborts++; } },
    orchestrationParent: { taskId: "legacy-task", sessionStorageId: "coop-home" },
  };
  var sessions = new Map([[1, coordinator], [2, worker]]);
  var sm = {
    sessions: sessions,
    saveSessionFile: function (session) { saved.push(session.storageId); },
    broadcastSessionList: function () { saved.push("broadcast"); },
  };
  return {
    project: { getSessionManager: function () { return sm; } },
    coordinator: coordinator,
    worker: worker,
    task: task,
    saved: saved,
    aborts: function () { return aborts; },
  };
}

function migrationInput(revision, controlledCutover) {
  return {
    source: { projectId: "system-lead", sessionStorageId: "coop-home" },
    portfolioTaskId: "portfolio-legacy-cutover",
    bindingRevision: revision,
    idempotencyKey: "migrate-legacy-r" + revision,
    mode: "direct_leaf",
    targetProject: { projectId: CUTOVER_TARGET_ID },
    legacyReference: {
      coordinator: { projectId: "system-lead", sessionStorageId: "coop-home" },
      worker: { projectId: "system-lead", sessionStorageId: "legacy-worker" },
      task: {
        projectId: "system-lead",
        coordinatorSessionStorageId: "coop-home",
        taskId: "legacy-task",
      },
    },
    controlledCutover: controlledCutover,
    objective: "Continue the legacy task in its canonical project.",
  };
}

test("controlled legacy cutover persists supersession and binding before replacement starts", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-controlled-cutover-"));
  var bindingFile = path.join(dir, "bindings.json");
  var lead = leadCutoverHarness("running", true);
  var starts = 0;
  var router = createCrossProjectRouter({
    bindingFile: bindingFile,
    deliveryFile: path.join(dir, "delivery.json"),
    getProjectContext: function (slug) { return slug === "lead" ? lead.project : null; },
    now: function () { return 100; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return CUTOVER_TARGET_ID; },
    deliverCrossProjectEnvelope: function () {
      starts++;
      var persisted = JSON.parse(fs.readFileSync(bindingFile, "utf8")).bindings[0];
      assert.equal(persisted.status, "pending", "new binding exists before target creation");
      assert.equal(lead.worker.orchestrationPolicy.legacyLeadCutover.status, "superseded");
      assert.deepEqual(lead.saved, ["legacy-worker", "coop-home", "broadcast"]);
      return {
        ok: true,
        created: true,
        sessionRef: { projectId: CUTOVER_TARGET_ID, sessionStorageId: "target-worker" },
      };
    },
  });

  var input = migrationInput(1, true);
  var result = router.migrateLegacyExecution(input);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.legacySuperseded, true);
  assert.equal(lead.aborts(), 1);
  assert.equal(lead.task.status, "cancelled");
  assert.equal(router.getExecutionBinding("portfolio-legacy-cutover").status, "active");
  assert.equal(router.migrateLegacyExecution(input).reused, true);
  assert.equal(starts, 1, "idempotent replay does not start another executor");
  assert.equal(lead.aborts(), 1, "idempotent replay does not stop legacy twice");
});

test("healthy active legacy work drains unless controlled cutover is explicit", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-draining-cutover-"));
  var lead = leadCutoverHarness("running", true);
  var starts = 0;
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    getProjectContext: function (slug) { return slug === "lead" ? lead.project : null; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return CUTOVER_TARGET_ID; },
    deliverCrossProjectEnvelope: function () { starts++; return { ok: true }; },
  });

  var result = router.migrateLegacyExecution(migrationInput(1, false));
  assert.deepEqual(result, { ok: false, reason: "legacy_execution_active", draining: true });
  assert.equal(starts, 0);
  assert.equal(lead.aborts(), 0);
  assert.equal(router.getExecutionBindings().length, 0);
});

test("queued legacy binding is superseded idempotently before target execution", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-queued-cutover-"));
  var lead = leadCutoverHarness("queued", false);
  var starts = 0;
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    getProjectContext: function (slug) { return slug === "lead" ? lead.project : null; },
  });
  var old = {
    portfolioTaskId: "portfolio-legacy-cutover",
    bindingRevision: 1,
    idempotencyKey: "legacy-lead-binding",
    mode: "direct_leaf",
    targetProject: { projectId: "system-lead" },
  };
  assert.equal(router.bindingStore.reserve(old).ok, true);
  assert.equal(router.bindingStore.commit(old.portfolioTaskId, 1, {
    projectId: "system-lead", sessionStorageId: "legacy-worker",
  }).ok, true);
  router.registerProjectResolver({
    getProjectId: function () { return CUTOVER_TARGET_ID; },
    deliverCrossProjectEnvelope: function () {
      starts++;
      var records = router.getExecutionBindings();
      assert.equal(records[0].status, "superseded");
      assert.equal(records[1].status, "pending");
      return {
        ok: true,
        created: true,
        sessionRef: { projectId: CUTOVER_TARGET_ID, sessionStorageId: "queued-target-worker" },
      };
    },
  });

  var result = router.migrateLegacyLeadExecution(migrationInput(2, false));
  assert.equal(result.ok, true);
  assert.equal(lead.task.status, "cancelled");
  assert.deepEqual(router.getExecutionBindings().map(function (binding) {
    return [binding.bindingRevision, binding.status];
  }), [[1, "superseded"], [2, "active"]]);
  assert.equal(router.migrateLegacyLeadExecution(migrationInput(2, false)).reused, true);
  assert.equal(starts, 1);
});

test("migration failure leaves durable attention and never falls back to Lead", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cutover-attention-"));
  var lead = leadCutoverHarness("queued", false);
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    getProjectContext: function (slug) { return slug === "lead" ? lead.project : null; },
    now: function () { return 200; },
  });

  var result = router.migrateLegacyExecution(migrationInput(1, false));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "project_unavailable");
  assert.equal(result.attention, true);
  var binding = router.getExecutionBinding("portfolio-legacy-cutover");
  assert.equal(binding.status, "pending");
  assert.equal(binding.statusReason, "project_unavailable");
  assert.equal(binding.attentionAt, 200);
  assert.equal(lead.task.status, "queued", "failure does not stop the old queued record");
  assert.equal(lead.project.getSessionManager().sessions.size, 2);
});
