var test = require("node:test");
var assert = require("node:assert");
var os = require("os");
var path = require("path");
var fs = require("fs");

process.env.CLAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-"));

var config = require("../lib/config");
var { createCrossProjectRouter } = require("../lib/server-cross-project");

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
