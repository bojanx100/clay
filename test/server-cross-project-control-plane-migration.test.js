var test = require("node:test");
var assert = require("node:assert");
var os = require("os");
var path = require("path");
var fs = require("fs");

process.env.CLAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cpm-"));

var { createCrossProjectRouter } = require("../lib/server-cross-project");
var attachCoopOwnerRequests =
  require("../lib/coop-owner-requests").attachCoopOwnerRequests;

// The production incident this suite replays byte-for-byte: canonical Coop
// dispatch and steering failed with control_plane_migration_required for
// these exact persisted bindings, while no typed operation existed to repair
// them.
var TARGET_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var COOP_ID = "871a194b-8879-40f7-a1fe-656e48e722af";
var PRIOR_ROOT_ID = "457f9fa1-7024-40cc-acee-2cef6b2b8445";
var LEGACY_LOCAL_ROOT_ID = "585c5ab9-8526-498a-8a88-7fc105a290ac";
var TOPIC_ID = "auto-fb42f62b499c463e340f95b8";
var CLEANUP_TASK = "clay-project-coordinator-visibility-session-cleanup-2026-08-15";
var MIGRATION_TASK = "clay-control-plane-binding-migration-2026-08-15";
var INGRESS_ID = "coop:" + COOP_ID + ":281";
var COOP_REF = { projectId: "system-lead", sessionStorageId: COOP_ID };
var PRIOR_ROOT_REF = { projectId: "system-lead", sessionStorageId: PRIOR_ROOT_ID };

function cleanupRecord(revision, extra) {
  return Object.assign({
    portfolioTaskId: CLEANUP_TASK,
    mode: "project_coordinator",
    targetProject: { projectId: TARGET_ID },
    bindingRevision: revision,
    source: { projectId: "system-lead", sessionStorageId: COOP_ID },
    coopTopicRef: { topicId: TOPIC_ID },
  }, extra);
}

function completedCleanupRecord(revision, key, coordinatorId, createdAt, updatedAt, completedAt, suffix) {
  return cleanupRecord(revision, {
    idempotencyKey: key,
    status: "completed",
    createdAt: createdAt,
    updatedAt: updatedAt,
    coordinator: { projectId: TARGET_ID, sessionStorageId: coordinatorId },
    projectCoordinator: { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID },
    completedAt: completedAt,
    completionEventId: "project-terminal-v1-project-coordinator-" + suffix,
    resultEventId: "project-coordinator-" + suffix,
  });
}

// The exact persisted records from the live store, including the two affected
// bindings: revision 10 (pre-task unrouted, no coordinator refs at all) and
// the migration task's own stranded revision 1.
function productionBindings() {
  return [
    cleanupRecord(4, {
      idempotencyKey: "clay-project-coordinator-visibility-session-cleanup-20260815-r4",
      status: "unrouted",
      createdAt: 1786784590833,
      updatedAt: 1786784590846,
      statusReason: "pre_task_failure: delivery_error",
      unroutedAt: 1786784590846,
    }),
    completedCleanupRecord(5, "clay-project-coordinator-visibility-session-cleanup-20260815-r5",
      "d2d87200-4781-47c5-a887-e218f2407dec", 1786784611153, 1786786184456, 1786786184401,
      "3b73b8c6-7007-44c7-8ad2-b1b7318c865a"),
    completedCleanupRecord(6, "clay-coop-control-plane-hierarchy-20260815-r6",
      "714e7e7f-7879-470e-a38c-88f677d1ab01", 1786786238420, 1786789461266, 1786789461205,
      "c15dc9c6-e69f-4500-9d72-7b43e3312433"),
    completedCleanupRecord(7, "clay-thread-containers-progressive-titles-20260815-r7",
      "3455dc58-b6f3-45f1-9ca8-5075e30fdf36", 1786789535093, 1786792161181, 1786792161077,
      "cb3cd2a0-8517-476f-b7ad-6c1f38830e42"),
    completedCleanupRecord(8, "clay-lead-tick-response-linkage-capacity-20260815-r8",
      "b03c5b1a-5079-4199-8307-30456358967f", 1786792236176, 1786793992540, 1786793992429,
      "f7209995-05e3-4399-918d-a58724ed67f6"),
    cleanupRecord(9, {
      idempotencyKey: "clay-coop-nonempty-control-groups-20260815-r9",
      status: "failed",
      createdAt: 1786794544239,
      updatedAt: 1786802021450,
      coordinator: { projectId: TARGET_ID, sessionStorageId: "ee3df56a-8494-473f-9b01-0c7967759131" },
      projectCoordinator: { projectId: "system-lead", sessionStorageId: PRIOR_ROOT_ID },
      completedAt: 1786802021450,
      completionEventId: "project-terminal-v1-project-coordinator-cd094323-acbe-4900-bda7-ca9e11df5cf3",
      resultEventId: "project-coordinator-cd094323-acbe-4900-bda7-ca9e11df5cf3",
    }),
    cleanupRecord(10, {
      idempotencyKey: "clay-coop-nonempty-control-groups-activation-20260815-r10",
      status: "unrouted",
      createdAt: 1786804088786,
      updatedAt: 1786804088805,
      unroutedAt: 1786804088805,
      statusReason: "pre_task_failure: delivery_error",
    }),
    {
      portfolioTaskId: MIGRATION_TASK,
      mode: "project_coordinator",
      targetProject: { projectId: TARGET_ID },
      bindingRevision: 1,
      idempotencyKey: "clay-control-plane-binding-migration-20260815-r1",
      source: { projectId: "system-lead", sessionStorageId: COOP_ID },
      coopTopicRef: { topicId: TOPIC_ID },
      status: "unrouted",
      createdAt: 1786806109773,
      updatedAt: 1786806109790,
      unroutedAt: 1786806109790,
      statusReason: "pre_task_failure: delivery_error",
    },
  ];
}

function sessionManager(sessions) {
  var nextLocalId = 100;
  var sm = {
    sessions: sessions,
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    createSessionRaw: function (opts) {
      var session = {
        localId: nextLocalId++,
        storageId: opts.storageId,
        coordinationMode: !!opts.coordinationMode,
        coopControlledBy: opts.coopControlledBy || null,
        createdAt: 1786800000000,
        lastActivity: 1786800000000,
      };
      sessions.set(session.localId, session);
      return session;
    },
  };
  return sm;
}

function coopSession() {
  return {
    localId: 1,
    storageId: COOP_ID,
    coopHome: true,
    createdAt: 1786500000000,
    lastActivity: 1786806000000,
  };
}

// The former exact coordinator: a Lead-resident control-plane root for the
// target ProjectRef that was archived (hidden, closed) but never deleted.
function archivedControlPlaneRoot() {
  return {
    localId: 2,
    storageId: PRIOR_ROOT_ID,
    hidden: true,
    closedAt: 1786802100000,
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: COOP_ID, since: 1786794424191 },
    orchestrationTasks: [],
    orchestrationEvents: [],
    orchestrationPolicy: {
      coopControlPlane: {
        version: 1,
        role: "project_coordinator",
        projectRef: { projectId: TARGET_ID },
        createdAt: 1786794424191,
      },
    },
    createdAt: 1786794424191,
    lastActivity: 1786802100000,
  };
}

function buildHarness(options) {
  var opts = options || {};
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cpm-harness-"));
  var bindingFile = path.join(dir, "bindings.json");
  var bindings = productionBindings().concat(opts.extraBindings || []);
  fs.writeFileSync(bindingFile, JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 2,
    bindings: bindings,
  }, null, 2) + "\n");

  var ownerLedger = opts.ownerRequests === null ? null :
    attachCoopOwnerRequests({ file: path.join(dir, "coop-owner-requests.json") });
  if (ownerLedger) {
    // Production claim history: the topic claim was created by the legacy
    // project-local root and then transferred onto the Lead-resident control
    // plane -- exactly the transferReason the live ledger records.
    assert.equal(ownerLedger.claimCoordinator({
      topicRef: { topicId: TOPIC_ID },
      projectRef: { projectId: TARGET_ID },
      coordinator: { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID },
    }).ok, true);
    assert.equal(ownerLedger.transferCoordinator({
      topicRef: { topicId: TOPIC_ID },
      projectRef: { projectId: TARGET_ID },
      from: { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID },
      to: PRIOR_ROOT_REF,
      reason: "coop_control_plane_migration",
    }).ok, true);
    // The owner's admitted implementation decision for the topic, so the
    // post-migration dispatch passes the same admission gate production uses.
    assert.ok(ownerLedger.record({
      ingressId: INGRESS_ID,
      sessionRef: COOP_REF,
      topicRef: { topicId: TOPIC_ID },
    }));
    assert.ok(ownerLedger.classify(INGRESS_ID, {
      kind: "existing_topic",
      implementationDecision: { intent: "implement" },
      topicRef: { topicId: TOPIC_ID },
      projectRefs: [{ projectId: TARGET_ID }],
    }));
    if (typeof opts.seedClaims === "function") opts.seedClaims(ownerLedger);
  }

  var leadSessions = new Map([[1, coopSession()]]);
  if (opts.withArchivedRoot !== false) leadSessions.set(2, archivedControlPlaneRoot());
  var leadSm = sessionManager(leadSessions);

  var targetSessions = new Map();
  var targetList = opts.targetSessions || [];
  for (var i = 0; i < targetList.length; i++) targetSessions.set(10 + i, targetList[i]);
  var targetSm = sessionManager(targetSessions);

  var deliveries = [];
  var router = createCrossProjectRouter(Object.assign({
    allowLeadSourcedExecution: true,
    bindingFile: bindingFile,
    deliveryFile: path.join(dir, "delivery.json"),
    ownerRequests: ownerLedger,
    requireOwnerImplementationDecision: true,
    onThreadHandedOff: function () { return { ok: true }; },
  }, opts.routerOptions || {}));
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    getSessionManager: function () { return leadSm; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return TARGET_ID; },
    getSessionManager: function () { return targetSm; },
    deliverCrossProjectEnvelope: function (envelope) {
      deliveries.push(envelope);
      if (typeof opts.deliver === "function") return opts.deliver(envelope, deliveries);
      if (envelope.payload.type === "portfolio_execution_message") return { ok: true };
      return {
        ok: true,
        created: true,
        sessionRef: {
          projectId: TARGET_ID,
          sessionStorageId: "task-coordinator-r" + envelope.bindingRevision,
        },
        projectCoordinatorRef: envelope.payload.targetProjectCoordinator || null,
      };
    },
  });
  return {
    dir: dir,
    bindingFile: bindingFile,
    router: router,
    ownerLedger: ownerLedger,
    leadSm: leadSm,
    leadSessions: leadSessions,
    targetSm: targetSm,
    deliveries: deliveries,
    rootSession: function () { return leadSessions.get(2); },
  };
}

function dispatchInput(taskId, revision, key) {
  return {
    source: COOP_REF,
    targetProject: { projectId: TARGET_ID },
    portfolioTaskId: taskId,
    bindingRevision: revision,
    idempotencyKey: key,
    mode: "project_coordinator",
    coopTopicRef: { topicId: TOPIC_ID },
    coopIngressId: INGRESS_ID,
    title: "Coop control-plane repair",
    objective: "Continue the stranded portfolio work in its canonical project.",
  };
}

function migrationInput(taskId, revision, prior, key) {
  return {
    source: COOP_REF,
    targetProject: { projectId: TARGET_ID },
    portfolioTaskId: taskId,
    bindingRevision: revision,
    idempotencyKey: key,
    priorProjectCoordinator: prior,
  };
}

test("production revision 10 replay: dispatch and steering fail closed until the typed migration repairs the binding", function () {
  var h = buildHarness();
  var retryKey = "clay-coop-nonempty-control-groups-activation-20260815-r10";

  // The reported incident, byte-for-byte: the pre-task unrouted record blocks
  // its own idempotent retry behind the control-plane guard.
  var blockedDispatch = h.router.createProjectExecution(dispatchInput(CLEANUP_TASK, 10, retryKey));
  assert.equal(blockedDispatch.ok, false);
  assert.equal(blockedDispatch.reason, "control_plane_migration_required");
  assert.equal(blockedDispatch.attention, true);

  var blockedSteer = h.router.messageProjectExecution({
    source: COOP_REF,
    portfolioTaskId: CLEANUP_TASK,
    bindingRevision: 10,
    idempotencyKey: "steer-before-migration",
    text: "Continue the cleanup work.",
  });
  assert.equal(blockedSteer.ok, false);
  assert.equal(blockedSteer.reason, "control_plane_migration_required");

  // Exact refs are mandatory: the wrong prior identity, a stale revision, and
  // terminal history all fail closed without touching the store.
  var beforeBytes = fs.readFileSync(h.bindingFile, "utf8");
  assert.equal(h.router.migrateControlPlaneBinding(migrationInput(CLEANUP_TASK, 10,
    { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID },
    "cleanup-migration-wrong-prior")).reason, "prior_binding_mismatch");
  assert.equal(h.router.migrateControlPlaneBinding(migrationInput(CLEANUP_TASK, 10, null,
    "cleanup-migration-missing-prior")).reason, "prior_binding_mismatch");
  assert.equal(h.router.migrateControlPlaneBinding(migrationInput(CLEANUP_TASK, 9,
    PRIOR_ROOT_REF, "cleanup-migration-stale")).reason, "stale_binding_revision");
  assert.equal(fs.readFileSync(h.bindingFile, "utf8"), beforeBytes,
    "failed migrations must not modify persisted bindings");

  // The repair: prior identity is the former exact archived coordinator.
  var migrationKey = "clay-control-plane-binding-migration-cleanup-20260815-r10-m1";
  var migrated = h.router.migrateControlPlaneBinding(
    migrationInput(CLEANUP_TASK, 10, PRIOR_ROOT_REF, migrationKey));
  assert.equal(migrated.ok, true);
  assert.equal(migrated.migrated, true);
  assert.deepEqual(migrated.projectCoordinatorRef, PRIOR_ROOT_REF,
    "the archived Lead-resident root is reused, never duplicated");
  assert.deepEqual(migrated.priorProjectCoordinator, PRIOR_ROOT_REF);
  assert.equal(h.rootSession().hidden, false, "the archived root is reactivated");
  var repaired = h.router.getExecutionBinding(CLEANUP_TASK, 10);
  assert.deepEqual(repaired.projectCoordinator, PRIOR_ROOT_REF);
  assert.equal(repaired.controlPlaneMigration.idempotencyKey, migrationKey);
  assert.deepEqual(repaired.controlPlaneMigration.from, PRIOR_ROOT_REF);
  assert.equal(repaired.status, "unrouted", "migration repairs authority, not lifecycle");

  // A typed steer can race the first post-migration dispatch. The exact
  // control-plane root is valid authority even though the target child does
  // not exist yet, so the caller should retry instead of poisoning the
  // repaired binding with coordinator_ref_mismatch attention.
  var pendingSteer = h.router.messageProjectExecution({
    source: COOP_REF,
    targetProject: { projectId: TARGET_ID },
    targetCoordinator: PRIOR_ROOT_REF,
    portfolioTaskId: CLEANUP_TASK,
    bindingRevision: 10,
    idempotencyKey: "steer-while-child-pending",
    text: "Continue the cleanup work.",
  });
  assert.equal(pendingSteer.ok, false);
  assert.equal(pendingSteer.reason, "binding_pending");
  assert.equal(pendingSteer.retryable, true);
  var pendingBinding = h.router.getExecutionBinding(CLEANUP_TASK, 10);
  assert.equal(pendingBinding.status, "unrouted");
  assert.equal(pendingBinding.attentionAt, undefined);
  assert.equal(pendingBinding.statusReason, "pre_task_failure: delivery_error");

  // Byte-stable retry: the identical operation returns the identical result
  // and rewrites nothing; a different key for the same conversion conflicts.
  var migratedBytes = fs.readFileSync(h.bindingFile, "utf8");
  var replay = h.router.migrateControlPlaneBinding(
    migrationInput(CLEANUP_TASK, 10, PRIOR_ROOT_REF, migrationKey));
  assert.deepEqual(replay, migrated);
  assert.equal(fs.readFileSync(h.bindingFile, "utf8"), migratedBytes);
  assert.equal(h.router.migrateControlPlaneBinding(migrationInput(CLEANUP_TASK, 10,
    PRIOR_ROOT_REF, "cleanup-migration-rival-key")).reason, "idempotency_conflict");

  // Normal typed dispatch now works, reusing the same idempotent revision.
  var dispatched = h.router.createProjectExecution(dispatchInput(CLEANUP_TASK, 10, retryKey));
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.created, true);
  assert.equal(dispatched.coordinatorSessionId, "task-coordinator-r10");
  assert.deepEqual(dispatched.projectCoordinatorRef, PRIOR_ROOT_REF);
  assert.equal(h.router.getExecutionBinding(CLEANUP_TASK, 10).status, "active");
  assert.deepEqual(h.ownerLedger.canonicalCoordinator({ topicId: TOPIC_ID },
    { projectId: TARGET_ID }), PRIOR_ROOT_REF, "no rival claim is ever created");
  var rootTasks = h.rootSession().orchestrationTasks.filter(function (task) {
    return task.clientRef === "portfolio:" + CLEANUP_TASK + ":10";
  });
  assert.equal(rootTasks.length, 1, "exactly one control-plane task, never duplicated");
  assert.equal(rootTasks[0].workerStorageId, "task-coordinator-r10");

  // Steering works after migration, relayed under control-plane authority.
  var steered = h.router.messageProjectExecution({
    source: COOP_REF,
    targetProject: { projectId: TARGET_ID },
    targetCoordinator: PRIOR_ROOT_REF,
    portfolioTaskId: CLEANUP_TASK,
    bindingRevision: 10,
    idempotencyKey: "steer-after-migration",
    text: "Continue the cleanup work.",
  });
  assert.equal(steered.ok, true);
  var message = h.deliveries[h.deliveries.length - 1];
  assert.equal(message.payload.type, "portfolio_execution_message");
  assert.deepEqual(message.source, PRIOR_ROOT_REF,
    "steering is relayed by the Coop-resident control-plane coordinator");

  // Immutable terminal history: the earlier revisions are untouched.
  var expected = productionBindings();
  for (var revision = 5; revision <= 9; revision++) {
    assert.deepEqual(h.router.getExecutionBinding(CLEANUP_TASK, revision),
      expected[revision - 4]);
  }

  // The migration evidence survives a full persistence round-trip, so a
  // daemon restart cannot forget that (and by which key) the conversion ran.
  var reloaded = require("../lib/portfolio-execution-bindings")
    .createPortfolioExecutionBindings({ file: h.bindingFile, reconcileOnLoad: false });
  assert.equal(reloaded.getLoadError(), null);
  var persisted = reloaded.get(CLEANUP_TASK, 10);
  assert.deepEqual(persisted.projectCoordinator, PRIOR_ROOT_REF);
  assert.equal(persisted.controlPlaneMigration.idempotencyKey, migrationKey);
  assert.deepEqual(persisted.controlPlaneMigration.from, PRIOR_ROOT_REF);
});

test("the migration task's own stranded pre-task revision migrates with an explicit no-prior identity", function () {
  var h = buildHarness();
  var retryKey = "clay-control-plane-binding-migration-20260815-r1";

  var blocked = h.router.createProjectExecution(dispatchInput(MIGRATION_TASK, 1, retryKey));
  assert.equal(blocked.reason, "control_plane_migration_required");

  // This task never had a routed revision, so declaring ANY prior fails.
  assert.equal(h.router.migrateControlPlaneBinding(migrationInput(MIGRATION_TASK, 1,
    PRIOR_ROOT_REF, "binding-migration-r1-wrong-prior")).reason, "prior_binding_mismatch");

  var migrated = h.router.migrateControlPlaneBinding(
    migrationInput(MIGRATION_TASK, 1, null, "binding-migration-r1-m1"));
  assert.equal(migrated.ok, true);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.priorProjectCoordinator, null);
  var repaired = h.router.getExecutionBinding(MIGRATION_TASK, 1);
  assert.deepEqual(repaired.projectCoordinator, PRIOR_ROOT_REF);
  assert.equal(repaired.controlPlaneMigration.from, null);

  var replay = h.router.migrateControlPlaneBinding(
    migrationInput(MIGRATION_TASK, 1, null, "binding-migration-r1-m1"));
  assert.deepEqual(replay, migrated);

  var dispatched = h.router.createProjectExecution(dispatchInput(MIGRATION_TASK, 1, retryKey));
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.coordinatorSessionId, "task-coordinator-r1");
  assert.deepEqual(dispatched.projectCoordinatorRef, PRIOR_ROOT_REF);
});

test("current-provenance reservation retries and conflicts before the legacy migration guard", function () {
  var failDelivery = true;
  var h = buildHarness({
    deliver: function (envelope) {
      if (envelope.payload.type !== "portfolio_execution_create") return { ok: true };
      if (failDelivery) {
        return {
          ok: false,
          reason: "provider_route_unavailable",
          code: "provider_route_unavailable",
          details: { provider: "codex", model: "gpt-5.6-sol", retryable: true },
        };
      }
      return {
        ok: true,
        created: true,
        sessionRef: {
          projectId: TARGET_ID,
          sessionStorageId: "current-provenance-task-coordinator",
        },
        projectCoordinatorRef: envelope.payload.targetProjectCoordinator,
      };
    },
  });
  var taskId = "current-provenance-retry-task";
  var key = "current-provenance-retry-task-r1";
  var input = Object.assign(dispatchInput(taskId, 1, key), {
    provider: "codex",
    model: "gpt-5.6-sol",
    context: "Keep this payload stable.",
  });

  var first = h.router.createProjectExecution(input);
  assert.equal(first.ok, false);
  assert.equal(first.reason, "provider_route_unavailable");
  var reserved = h.router.getExecutionBinding(taskId, 1);
  assert.equal(reserved.status, "unrouted");
  assert.equal(reserved.controlPlaneProvenance.version, 1);
  assert.match(reserved.taskPayloadDigest, /^[a-f0-9]{64}$/);

  [
    { idempotencyKey: "current-provenance-retry-task-rival-key" },
    { provider: "claude" },
    { model: "gpt-5.6-terra" },
    { context: "Changed payload." },
  ].forEach(function (change) {
    var conflict = h.router.createProjectExecution(Object.assign({}, input, change));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, "idempotency_conflict");
    assert.equal(h.deliveries.length, 1, "a conflict must not create or deliver work");
  });

  failDelivery = false;
  var replay = h.router.createProjectExecution(input);
  assert.equal(replay.ok, true);
  assert.equal(replay.created, true);
  assert.equal(replay.sessionStorageId, "current-provenance-task-coordinator");
  assert.equal(h.deliveries.length, 2, "the exact retry performs one new delivery attempt");
  var task = h.rootSession().orchestrationTasks.filter(function (candidate) {
    return candidate.clientRef === "portfolio:" + taskId + ":1";
  });
  assert.equal(task.length, 1, "the exact retry cannot duplicate the control-plane task");
  assert.equal(reserved.failureCode, "provider_route_unavailable");
  assert.deepEqual(reserved.failureDetails,
    { provider: "codex", model: "gpt-5.6-sol", retryable: true });
});

test("migration fails closed on identity, admission, ambiguity, and infrastructure faults", function () {
  var h = buildHarness();
  var input = migrationInput(CLEANUP_TASK, 10, PRIOR_ROOT_REF, "cleanup-migration-fail-closed");

  assert.equal(h.router.migrateControlPlaneBinding(Object.assign({}, input, {
    source: { projectId: "system-lead", sessionStorageId: "not-the-canonical-coop" },
  })).reason, "canonical_coop_required");
  assert.equal(h.router.migrateControlPlaneBinding(Object.assign({}, input, {
    targetProject: { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04" },
  })).reason, "binding_target_mismatch");
  assert.equal(h.router.migrateControlPlaneBinding(Object.assign({}, input, {
    targetProject: { projectId: "system-lead" },
  })).reason, "invalid_migration");
  assert.equal(h.router.migrateControlPlaneBinding(Object.assign({}, input, {
    portfolioTaskId: "clay-unknown-portfolio-task",
  })).reason, "binding_not_found");
  assert.equal(h.router.migrateControlPlaneBinding(Object.assign({}, input, {
    idempotencyKey: "",
  })).reason, "invalid_migration");
  assert.equal(h.router.migrateControlPlaneBinding(Object.assign({}, input, {
    priorProjectCoordinator: { projectId: "system-lead" },
  })).reason, "invalid_prior_binding_identity");

  var denied = buildHarness({ routerOptions: { canCreateExecution: function () { return false; } } });
  assert.equal(denied.router.migrateControlPlaneBinding(input).reason, "access_denied");

  var unclaimed = buildHarness({ ownerRequests: null });
  assert.equal(unclaimed.router.migrateControlPlaneBinding(input).reason,
    "coordinator_claim_unavailable");

  // A rival claim that names neither the prior identity nor the control-plane
  // root proves an ambiguous active coordinator; migration must refuse.
  var ambiguous = buildHarness();
  assert.equal(ambiguous.ownerLedger.transferCoordinator({
    topicRef: { topicId: TOPIC_ID },
    projectRef: { projectId: TARGET_ID },
    from: PRIOR_ROOT_REF,
    to: { projectId: TARGET_ID, sessionStorageId: "rival-coordinator" },
    reason: "test_rival",
  }).ok, true);
  assert.equal(ambiguous.router.migrateControlPlaneBinding(input).reason,
    "ambiguous_active_coordinator");

  // A persistence failure surfaces and leaves no partial in-memory adoption.
  var flaky = buildHarness();
  var realStore = flaky.router.bindingStore;
  var wrapped = Object.create(realStore);
  wrapped.adoptControlPlaneCoordinator = function () {
    return { ok: false, reason: "persistence_failed" };
  };
  var faulty = buildHarness({ routerOptions: { bindingStore: wrapped } });
  assert.equal(faulty.router.migrateControlPlaneBinding(input).reason, "persistence_failed");
  assert.notDeepEqual(faulty.router.getExecutionBinding(CLEANUP_TASK, 10).projectCoordinator,
    PRIOR_ROOT_REF);
});

var LEGACY_ACTIVE_TASK = "clay-legacy-active-coordinator-task-2026-08-12";
var LEGACY_TERMINAL_TASK = "clay-legacy-terminal-coordinator-task-2026-08-10";
var LEGACY_TOPIC_ID = "auto-1111aaaa2222bbbb3333cccc";

function legacyActiveBinding() {
  return {
    portfolioTaskId: LEGACY_ACTIVE_TASK,
    mode: "project_coordinator",
    targetProject: { projectId: TARGET_ID },
    bindingRevision: 1,
    idempotencyKey: "clay-legacy-active-coordinator-task-20260812-r1",
    source: { projectId: "system-lead", sessionStorageId: COOP_ID },
    coopTopicRef: { topicId: LEGACY_TOPIC_ID },
    status: "active",
    createdAt: 1786600000000,
    updatedAt: 1786600000100,
    coordinator: { projectId: TARGET_ID, sessionStorageId: "legacy-task-coordinator" },
    projectCoordinator: { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID },
  };
}

function legacyTerminalBinding() {
  return {
    portfolioTaskId: LEGACY_TERMINAL_TASK,
    mode: "project_coordinator",
    targetProject: { projectId: TARGET_ID },
    bindingRevision: 1,
    idempotencyKey: "clay-legacy-terminal-coordinator-task-20260810-r1",
    source: { projectId: "system-lead", sessionStorageId: COOP_ID },
    coopTopicRef: { topicId: LEGACY_TOPIC_ID },
    status: "completed",
    createdAt: 1786500000000,
    updatedAt: 1786500000100,
    coordinator: { projectId: TARGET_ID, sessionStorageId: "legacy-terminal-coordinator" },
    projectCoordinator: { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID },
    completedAt: 1786500000100,
  };
}

function legacyCoordinatorSession(controlled) {
  return {
    storageId: "legacy-task-coordinator",
    coopControlledBy: controlled ?
      { coopSessionStorageId: COOP_ID, since: 1786600000000 } : null,
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: LEGACY_ACTIVE_TASK,
        bindingRevision: 1,
        idempotencyKey: "clay-legacy-active-coordinator-task-20260812-r1",
        mode: "project_coordinator",
        status: "running",
        source: { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID },
      },
    },
    createdAt: 1786600000000,
    lastActivity: 1786600000100,
  };
}

function legacyClaims(ownerLedger) {
  assert.equal(ownerLedger.claimCoordinator({
    topicRef: { topicId: LEGACY_TOPIC_ID },
    projectRef: { projectId: TARGET_ID },
    coordinator: { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID },
  }).ok, true);
}

test("a verified project-local coordinator binding converts to a Coop-resident control-plane binding", function () {
  var h = buildHarness({
    extraBindings: [legacyActiveBinding(), legacyTerminalBinding()],
    targetSessions: [legacyCoordinatorSession(true)],
    withArchivedRoot: false,
  });
  // This harness has no control-plane root at all: the claim history for the
  // legacy topic still names the project-local root as canonical.
  var seeded = h.ownerLedger.transferCoordinator({
    topicRef: { topicId: TOPIC_ID },
    projectRef: { projectId: TARGET_ID },
    from: PRIOR_ROOT_REF,
    to: { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID },
    reason: "test_reset",
  });
  assert.equal(seeded.ok, true);
  legacyClaims(h.ownerLedger);

  var prior = { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID };
  var migrated = h.router.migrateControlPlaneBinding(
    migrationInput(LEGACY_ACTIVE_TASK, 1, prior, "legacy-active-migration-m1"));
  assert.equal(migrated.ok, true);
  assert.equal(migrated.projectCoordinatorRef.projectId, "system-lead",
    "the converted binding is Coop-resident");
  var binding = h.router.getExecutionBinding(LEGACY_ACTIVE_TASK, 1);
  assert.deepEqual(binding.projectCoordinator, migrated.projectCoordinatorRef);
  assert.deepEqual(binding.coordinator,
    { projectId: TARGET_ID, sessionStorageId: "legacy-task-coordinator" },
    "the live task coordinator session is reused, never recreated");
  assert.equal(binding.status, "active");

  // The topic claim moved onto the new root; exactly one coordinator remains.
  assert.deepEqual(h.ownerLedger.canonicalCoordinator({ topicId: LEGACY_TOPIC_ID },
    { projectId: TARGET_ID }), migrated.projectCoordinatorRef);

  // The live child session now reports to the control plane.
  var child = null;
  h.targetSm.sessions.forEach(function (session) {
    if (session.storageId === "legacy-task-coordinator") child = session;
  });
  assert.deepEqual(child.projectCoordinatorRef, migrated.projectCoordinatorRef);
  assert.deepEqual(child.orchestrationPolicy.portfolioExecution.source,
    migrated.projectCoordinatorRef);

  // The control-plane root owns exactly one linked task bound to the existing
  // coordinator session, with no duplicate on replay.
  var root = null;
  h.leadSm.sessions.forEach(function (session) {
    if (session.storageId === migrated.projectCoordinatorRef.sessionStorageId) root = session;
  });
  var replay = h.router.migrateControlPlaneBinding(
    migrationInput(LEGACY_ACTIVE_TASK, 1, prior, "legacy-active-migration-m1"));
  assert.deepEqual(replay, migrated);
  var linked = root.orchestrationTasks.filter(function (task) {
    return task.clientRef === "portfolio:" + LEGACY_ACTIVE_TASK + ":1";
  });
  assert.equal(linked.length, 1);
  assert.equal(linked[0].workerStorageId, "legacy-task-coordinator");

  // Terminal legacy history is immutable, even when named exactly.
  var terminalBefore = h.router.getExecutionBinding(LEGACY_TERMINAL_TASK, 1);
  assert.equal(h.router.migrateControlPlaneBinding(migrationInput(LEGACY_TERMINAL_TASK, 1,
    prior, "legacy-terminal-migration-m1")).reason, "binding_terminal");
  assert.deepEqual(h.router.getExecutionBinding(LEGACY_TERMINAL_TASK, 1), terminalBefore);
});

test("owner-direct sessions are never adopted by a control-plane migration", function () {
  var h = buildHarness({
    extraBindings: [legacyActiveBinding()],
    targetSessions: [{
      storageId: "legacy-task-coordinator",
      createdAt: 1786600000000,
      lastActivity: 1786600000100,
    }],
  });
  var prior = { projectId: TARGET_ID, sessionStorageId: LEGACY_LOCAL_ROOT_ID };
  var refused = h.router.migrateControlPlaneBinding(
    migrationInput(LEGACY_ACTIVE_TASK, 1, prior, "legacy-owner-direct-m1"));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "owner_direct_session");
  assert.deepEqual(h.router.getExecutionBinding(LEGACY_ACTIVE_TASK, 1).projectCoordinator, prior);
});
