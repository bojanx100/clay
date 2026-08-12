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

// --- one canonical coordinator per (TopicRef, ProjectRef) ---------------------
//
// The binding store already guarantees one active binding per portfolio TASK.
// That is the wrong unit for the owner: they ask about a TOPIC, and a follow-up
// under a NEW portfolio task id could previously staff a second coordinator in
// the same project for the same topic. The owner-request ledger owns that
// cardinality; this is the staffing path enforcing it.

function cardinalityRouter(dir, ownerRequests, created) {
  var projectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    ownerRequests: ownerRequests,
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () {
      created.push("coordinator-" + (created.length + 1));
      return { ok: true, created: true,
        sessionRef: { projectId: projectId, sessionStorageId: created[created.length - 1] } };
    },
  });
  return { router: router, projectId: projectId };
}

function staffTopic(harness, taskId, topicId) {
  return harness.router.createProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: "coop" },
    portfolioTaskId: taskId, bindingRevision: 1, idempotencyKey: taskId + "-r1",
    mode: "project_coordinator", targetProject: { projectId: harness.projectId },
    coopTopicRef: topicId ? { topicId: topicId } : undefined,
    objective: "Do the bounded work.",
  });
}

function ledgerIn(dir) {
  return require("../lib/coop-owner-requests")
    .attachCoopOwnerRequests({ file: path.join(dir, "owner-requests.json") });
}

test("a second coordinator for the same topic and project is refused at the staffing path", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card-"));
  var created = [];
  var harness = cardinalityRouter(dir, ledgerIn(dir), created);

  var first = staffTopic(harness, "portfolio-topic-first", "auto-a7daa4cc660639337d144d93");
  assert.equal(first.ok, true, "the first coordinator for a topic is allowed");

  // A DIFFERENT portfolio task, same topic, same project: the binding store has
  // no objection, and that is exactly the hole this closes.
  var second = staffTopic(harness, "portfolio-topic-second", "auto-a7daa4cc660639337d144d93");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "coordinator_exists");
  assert.equal(second.coordinator.sessionStorageId, created[0],
    "the refusal names the canonical coordinator so the caller reuses it");
  assert.equal(created.length, 1, "no rival coordinator session was created");
});

test("staffing a different topic in the same project is still allowed", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card2-"));
  var created = [];
  var harness = cardinalityRouter(dir, ledgerIn(dir), created);

  assert.equal(staffTopic(harness, "portfolio-a", "auto-aaaaaaaaaaaaaaaaaaaaaaaa").ok, true);
  assert.equal(staffTopic(harness, "portfolio-b", "auto-bbbbbbbbbbbbbbbbbbbbbbbb").ok, true);
  assert.equal(created.length, 2, "cardinality is per topic AND project, not per project");
});

test("execution carrying no TopicRef is unaffected by topic cardinality", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card3-"));
  var created = [];
  var harness = cardinalityRouter(dir, ledgerIn(dir), created);

  assert.equal(staffTopic(harness, "portfolio-no-topic-a", null).ok, true);
  assert.equal(staffTopic(harness, "portfolio-no-topic-b", null).ok, true);
  assert.equal(created.length, 2);
});

test("without an injected ledger the staffing path behaves exactly as before", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card4-"));
  var created = [];
  var harness = cardinalityRouter(dir, null, created);

  assert.equal(staffTopic(harness, "portfolio-x", "auto-a7daa4cc660639337d144d93").ok, true);
  assert.equal(staffTopic(harness, "portfolio-y", "auto-a7daa4cc660639337d144d93").ok, true);
  assert.equal(created.length, 2);
});

// --- cardinality guard must not misfire on legitimate reuse -------------------
//
// Review audit: the guard sits before the scope-promotion branch, so it must be
// able to tell "a rival is staffing my topic" from "this is the same work
// continuing". Blocking the latter would wedge every revision after the first.

test("a scope expansion of the same task and topic is not treated as a rival", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card5-"));
  var created = [];
  var harness = cardinalityRouter(dir, ledgerIn(dir), created);
  var topicId = "auto-a7daa4cc660639337d144d93";

  var first = harness.router.createProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: "coop" },
    portfolioTaskId: "portfolio-expand", bindingRevision: 1, idempotencyKey: "portfolio-expand-r1",
    mode: "project_coordinator", targetProject: { projectId: harness.projectId },
    coopTopicRef: { topicId: topicId }, objective: "Do the bounded work.",
  });
  assert.equal(first.ok, true);

  // Same portfolio task, same topic, next revision: this is the SAME work
  // widening its scope, not a second coordinator competing for the topic.
  var expanded = harness.router.createProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: "coop" },
    portfolioTaskId: "portfolio-expand", bindingRevision: 2, idempotencyKey: "portfolio-expand-r2",
    mode: "project_coordinator", targetProject: { projectId: harness.projectId },
    coopTopicRef: { topicId: topicId }, reason: "scope_expansion",
    objective: "Do the widened work.",
  });
  assert.notEqual(expanded.reason, "coordinator_exists",
    "the same task continuing on its own topic must not be refused as a rival");
});

test("an idempotent replay of a committed binding is never refused as a rival", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card6-"));
  var created = [];
  var harness = cardinalityRouter(dir, ledgerIn(dir), created);

  var first = staffTopic(harness, "portfolio-replay", "auto-a7daa4cc660639337d144d93");
  assert.equal(first.ok, true);
  var replay = staffTopic(harness, "portfolio-replay", "auto-a7daa4cc660639337d144d93");
  assert.equal(replay.ok, true, "the same binding replayed is the same work, not a rival");
  assert.equal(created.length, 1);
});

test("a refused staffing leaves no coordinator claim behind", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card7-"));
  var ledger = ledgerIn(dir);
  var created = [];
  var harness = cardinalityRouter(dir, ledger, created);
  var topicId = "auto-a7daa4cc660639337d144d93";

  staffTopic(harness, "portfolio-first", topicId);
  var refused = staffTopic(harness, "portfolio-rival", topicId);

  assert.equal(refused.ok, false);
  // Exactly one claim: the refusal must not have recorded the rival on its way out.
  assert.equal(ledger.coordinatorsForTopic({ topicId: topicId }).length, 1);
  assert.equal(harness.router.getExecutionBindings().filter(function (b) {
    return b.portfolioTaskId === "portfolio-rival";
  }).length, 0, "a refused staffing leaves no binding either");
});

test("a coordinator lost to a rival between precheck and claim does not commit", function () {
  // The cardinality precheck runs before delivery, so a rival can take the pair
  // in between. Treating only persistence_failed as fatal left the loser's
  // binding active and reported ok:true -- two coordinators for one line of work.
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-race-"));
  var ledger = ledgerIn(dir);
  var created = [];
  var harness = cardinalityRouter(dir, ledger, created);
  var topicId = "auto-a7daa4cc660639337d144d93";

  var realClaim = ledger.claimCoordinator;
  var prechecked = false;
  ledger.canonicalCoordinator = function () { prechecked = true; return null; };
  ledger.claimCoordinator = function (input) {
    // By the time the real claim runs, a rival owns the pair.
    if (prechecked) return { ok: false, reason: "coordinator_exists",
      coordinator: { projectId: harness.projectId, sessionStorageId: "rival-session" } };
    return realClaim(input);
  };

  var result = staffTopic(harness, "portfolio-raced", topicId);
  assert.equal(result.ok, false, "an execution must not commit on a lost claim");
  assert.equal(result.reason, "coordinator_exists");

  var binding = harness.router.getExecutionBindings().filter(function (b) {
    return b.portfolioTaskId === "portfolio-raced";
  })[0];
  assert.ok(binding, "the binding record survives for diagnosis");
  assert.notEqual(binding.status, "active", "the losing binding must not stay active");
});

test("a replay after a failed claim re-claims instead of reusing the loser", function () {
  // Review finding: matchingCommittedBinding ignored status and attention, so
  // after a rival claim (or a cleanup that could not persist) an identical
  // retry returned ok:true, made no second claim, and reused the losing
  // coordinator -- two coordinators for one line of work, via the retry path.
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-replay-"));
  var ledger = ledgerIn(dir);
  var created = [];
  var harness = cardinalityRouter(dir, ledger, created);
  var topicId = "auto-a7daa4cc660639337d144d93";

  var claims = 0;
  ledger.canonicalCoordinator = function () { return null; };
  ledger.claimCoordinator = function () {
    claims += 1;
    return { ok: false, reason: "coordinator_exists",
      coordinator: { projectId: harness.projectId, sessionStorageId: "rival-session" } };
  };

  var first = staffTopic(harness, "portfolio-replay-loser", topicId);
  assert.equal(first.ok, false);
  assert.equal(claims, 1);

  var retry = staffTopic(harness, "portfolio-replay-loser", topicId);
  assert.equal(retry.ok, false, "a retry must not report success on an unclaimed binding");
  assert.equal(claims, 2, "the retry must actually re-attempt the claim");

  var binding = harness.router.getExecutionBindings().filter(function (b) {
    return b.portfolioTaskId === "portfolio-replay-loser";
  })[0];
  assert.notEqual(binding && binding.status, "active",
    "no apparently-active losing binding may remain");
});
