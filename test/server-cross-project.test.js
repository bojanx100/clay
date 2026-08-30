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

test("session ledger keeps temporary worktree sessions under the parent ProjectRef", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-worktree-ledger-"));
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var worktreeSession = {
    storageId: "temporary-worktree-session",
    title: "Temporary worktree session",
    createdAt: 10,
    lastActivity: 20,
  };
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    getProjectContext: function () { return null; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    getSessionManager: function () { return { sessions: new Map() }; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    getSessionManager: function () { return { sessions: new Map([[1, worktreeSession]]) }; },
  });

  var result = router.queryCoopSessions({
    projectRefs: [{ projectId: projectId }],
    topicLinks: [{
      topicRef: { topicId: "temporary-worktree-topic" },
      sessionRef: { projectId: projectId, sessionStorageId: worktreeSession.storageId },
    }],
  });

  assert.equal(result.sessions.length, 1);
  assert.deepStrictEqual(result.sessions[0].sessionRef, {
    projectId: projectId,
    sessionStorageId: worktreeSession.storageId,
  });
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

test("project registration supersedes and hides only an evidence-bound restart failure", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-restart-supersession-"));
  var bindingFile = path.join(dir, "bindings.json");
  var failedRef = { projectId: projectId, sessionStorageId: "failed-restart" };
  var successorRef = { projectId: projectId, sessionStorageId: "verified-successor" };
  var rootRef = { projectId: projectId, sessionStorageId: "project-root" };
  fs.writeFileSync(bindingFile, JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 2,
    bindings: [{
      portfolioTaskId: "failed-restart-task", bindingRevision: 1,
      idempotencyKey: "failed-restart-r1", mode: "project_coordinator",
      targetProject: { projectId: projectId }, status: "failed",
      coordinator: failedRef, projectCoordinator: rootRef,
      createdAt: 10, updatedAt: 20, completedAt: 20,
    }, {
      portfolioTaskId: "verified-successor-task", bindingRevision: 5,
      idempotencyKey: "verified-successor-r5", mode: "project_coordinator",
      targetProject: { projectId: projectId }, status: "completed",
      coordinator: successorRef, projectCoordinator: rootRef,
      createdAt: 30, updatedAt: 40, completedAt: 40,
    }],
  }, null, 2));
  var failed = {
    localId: 1, storageId: failedRef.sessionStorageId,
    coordinationRole: "task_coordinator", orchestrationTasks: [],
    coopControlledBy: { coopSessionStorageId: "old-coop", since: 1 },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "failed-restart-task", bindingRevision: 1,
      status: "failed", reason: "restart_recovery", terminalAt: 20,
    } },
  };
  var successor = {
    localId: 2, storageId: successorRef.sessionStorageId,
    coordinationRole: "task_coordinator",
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "verified-successor-task", bindingRevision: 5,
      status: "completed", completedAt: 40,
    } },
    orchestrationProjectCompletion: {
      status: "completed", portfolioTaskId: "verified-successor-task", bindingRevision: 5,
      completedAt: 40, summary: "Verified restart.", verification: "Focused suite passed.",
      integrationVerification: "yes", escalationRequired: "no",
    },
  };
  var saves = 0;
  var sessions = new Map([[1, failed], [2, successor]]);
  var manager = {
    sessions: sessions,
    getActiveSession: function () { return null; },
    saveSessionFile: function () { saves++; },
    hideSession: function (localId) {
      sessions.get(localId).hidden = true;
      saves++;
    },
  };
  var router = createCrossProjectRouter({
    bindingFile: bindingFile,
    deliveryFile: path.join(dir, "delivery.json"),
    restartSupersessionRules: [{
      ruleId: "registration_restart_cleanup",
      targetProject: { projectId: projectId },
      controllerSessionStorageId: "old-coop",
      failed: {
        portfolioTaskId: "failed-restart-task", bindingRevision: 1, coordinator: failedRef,
      },
      successors: [{
        portfolioTaskId: "verified-successor-task", bindingRevision: 5,
        coordinator: successorRef, projectCoordinator: rootRef,
      }],
      verifiedCommits: ["c24865ed8a394e90158540c40ba4222778a0f8e6"],
    }],
  });

  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    getSessionManager: function () { return manager; },
  });

  assert.equal(router.getExecutionBinding("failed-restart-task", 1).status, "superseded");
  assert.equal(failed.orchestrationPolicy.portfolioExecution.status, "superseded");
  assert.equal(failed.hidden, true);
  assert.equal(saves, 1);
  assert.equal(router.reconcileRestartSupersessions().reconciled[0].outcome,
    "already_reconciled");
  assert.equal(saves, 1, "replay does not rewrite the durable cleanup");
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
  assert.equal(source.hidden, true,
    "compaction retains its separate archive of the superseded source session");
  assert.equal(continuation.hidden, undefined);
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

// --- authorization is explicit in both directions ----------------------------
//
// An absent `canCreateExecution` used to fall through to `return true`, so a
// router constructed without an ACL was silently wide open and no construction
// site said so. Openness is now a named option a caller has to ask for.

function authorizationHarness(dir, routerOptions) {
  var projectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var deliveries = 0;
  var router = createCrossProjectRouter(Object.assign({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  }, routerOptions || {}));
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () {
      deliveries++;
      return { ok: true, created: true,
        sessionRef: { projectId: projectId, sessionStorageId: "worker-1" } };
    },
  });
  return {
    router: router,
    projectId: projectId,
    deliveries: function () { return deliveries; },
    create: function () {
      return router.createProjectExecution({
        source: { projectId: "system-lead", sessionStorageId: "coop" },
        portfolioTaskId: "portfolio-authorization",
        bindingRevision: 1,
        idempotencyKey: "create-authorization",
        mode: "direct_leaf",
        targetProject: { projectId: projectId },
        objective: "Do the bounded work.",
      });
    },
  };
}

test("a router built with neither authorization option refuses Lead-sourced execution", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-authz-default-"));
  var harness = authorizationHarness(dir, {});

  var result = harness.create();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "access_denied",
    "absent authorization must deny, not fall through to allow");
  assert.equal(harness.deliveries(), 0);
  assert.equal(harness.router.getExecutionBindings().length, 0);
});

test("allowLeadSourcedExecution admits Lead-sourced execution without an ACL", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-authz-allow-"));
  var harness = authorizationHarness(dir, { allowLeadSourcedExecution: true });

  var result = harness.create();
  assert.equal(result.ok, true);
  assert.equal(harness.deliveries(), 1);
  assert.equal(harness.router.getExecutionBindings().length, 1);
});

test("allowLeadSourcedExecution never weakens the structural execution preconditions", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-authz-precondition-"));
  var harness = authorizationHarness(dir, { allowLeadSourcedExecution: true });

  // The source must be Lead...
  var notLeadSourced = harness.router.createProjectExecution({
    source: { projectId: harness.projectId, sessionStorageId: "local-session" },
    portfolioTaskId: "portfolio-not-lead-sourced",
    bindingRevision: 1,
    idempotencyKey: "create-not-lead-sourced",
    mode: "direct_leaf",
    targetProject: { projectId: harness.projectId },
    objective: "Do the bounded work.",
  });
  assert.equal(notLeadSourced.reason, "access_denied");
  // The reason code stays stable for cross-project delivery, which treats it as
  // non-retryable, but it must also SAY why: a bare "access_denied" reaching an
  // MCP caller in a project session reads as broken dispatch rather than a
  // refusal working as designed.
  assert.match(notLeadSourced.error, /must be staffed from a Coop\/Lead session/);
  assert.match(notLeadSourced.error, new RegExp(harness.projectId));
  assert.match(notLeadSourced.error, /omit the project-execution fields/);

  // ...and the target must not be Lead.
  var leadTargeted = harness.router.createProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: "coop" },
    portfolioTaskId: "portfolio-lead-targeted",
    bindingRevision: 1,
    idempotencyKey: "create-lead-targeted",
    mode: "direct_leaf",
    targetProject: { projectId: "system-lead" },
    objective: "Do the bounded work.",
  });
  assert.notEqual(leadTargeted.ok, true);

  assert.equal(harness.deliveries(), 0);
});

test("canCreateExecution stays authoritative even when Lead-sourced execution is allowed", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-authz-acl-wins-"));
  var denied = authorizationHarness(dir, {
    allowLeadSourcedExecution: true,
    canCreateExecution: function () { return false; },
  });
  assert.equal(denied.create().reason, "access_denied",
    "an injected ACL decides regardless of the default");
  assert.equal(denied.deliveries(), 0);

  var throwing = authorizationHarness(
    fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-authz-acl-throws-")), {
      allowLeadSourcedExecution: true,
      canCreateExecution: function () { throw new Error("acl unavailable"); },
    });
  assert.equal(throwing.create().reason, "access_denied",
    "an ACL that throws fails closed rather than reverting to the default");
  assert.equal(throwing.deliveries(), 0);
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
    allowLeadSourcedExecution: true,
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
    allowLeadSourcedExecution: true,
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
    allowLeadSourcedExecution: true,
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
  var projectCoordinatorRef = null;
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    ownerRequests: ownerRequests,
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function (envelope) {
      created.push("task-coordinator-" + (created.length + 1));
      projectCoordinatorRef = envelope.payload.targetProjectCoordinator ||
        projectCoordinatorRef || { projectId: projectId, sessionStorageId: "project-coordinator" };
      return { ok: true, created: true,
        sessionRef: { projectId: projectId, sessionStorageId: created[created.length - 1] },
        projectCoordinatorRef: projectCoordinatorRef };
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

test("the same topic can run multiple task coordinators under one project coordinator", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card-"));
  var created = [];
  var harness = cardinalityRouter(dir, ledgerIn(dir), created);

  var first = staffTopic(harness, "portfolio-topic-first", "auto-a7daa4cc660639337d144d93");
  assert.equal(first.ok, true, "the first coordinator for a topic is allowed");

  // A DIFFERENT portfolio task, same topic, same project gets its own bounded
  // task coordinator while reusing the durable project root.
  var second = staffTopic(harness, "portfolio-topic-second", "auto-a7daa4cc660639337d144d93");
  assert.equal(second.ok, true);
  assert.notDeepEqual(second.sessionRef, first.sessionRef);
  assert.deepEqual(second.projectCoordinatorRef, first.projectCoordinatorRef);
  assert.equal(created.length, 2);
});

test("staffing a different topic in the same project is still allowed", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card2-"));
  var created = [];
  var harness = cardinalityRouter(dir, ledgerIn(dir), created);

  assert.equal(staffTopic(harness, "portfolio-a", "auto-aaaaaaaaaaaaaaaaaaaaaaaa").ok, true);
  assert.equal(staffTopic(harness, "portfolio-b", "auto-bbbbbbbbbbbbbbbbbbbbbbbb").ok, true);
  assert.equal(created.length, 2);
  var bindings = harness.router.getExecutionBindings();
  assert.deepEqual(bindings[0].projectCoordinator, bindings[1].projectCoordinator,
    "both topics reuse one durable coordinator for the ProjectRef");
});

test("execution carrying no TopicRef is unaffected by topic cardinality", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card3-"));
  var created = [];
  var harness = cardinalityRouter(dir, ledgerIn(dir), created);

  assert.equal(staffTopic(harness, "portfolio-no-topic-a", null).ok, true);
  assert.equal(staffTopic(harness, "portfolio-no-topic-b", null).ok, true);
  assert.equal(created.length, 2);
});

test("topic-bound coordinator staffing fails closed without the claim ledger", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card4-"));
  var created = [];
  var harness = cardinalityRouter(dir, null, created);

  var first = staffTopic(harness, "portfolio-x", "auto-a7daa4cc660639337d144d93");
  var second = staffTopic(harness, "portfolio-y", "auto-a7daa4cc660639337d144d93");
  assert.equal(first.ok, false);
  assert.equal(first.reason, "coordinator_claim_unavailable");
  assert.equal(second.ok, false);
  assert.equal(created.length, 0,
    "a topic-bound coordinator must not start when cardinality cannot be proven");
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

test("concurrent staffing keeps one coordinator claim and two task bindings", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-card7-"));
  var ledger = ledgerIn(dir);
  var created = [];
  var harness = cardinalityRouter(dir, ledger, created);
  var topicId = "auto-a7daa4cc660639337d144d93";

  staffTopic(harness, "portfolio-first", topicId);
  var concurrent = staffTopic(harness, "portfolio-rival", topicId);

  assert.equal(concurrent.ok, true);
  // Exactly one canonical project coordinator, with distinct task bindings.
  assert.equal(ledger.coordinatorsForTopic({ topicId: topicId }).length, 1);
  assert.equal(harness.router.getExecutionBindings().filter(function (b) {
    return b.portfolioTaskId === "portfolio-rival";
  }).length, 1);
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
  ledger.canonicalProjectCoordinator = function () { prechecked = true; return null; };
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

test("a failed cleanup leaves an active binding recoverable only by re-claiming", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-cleanup-retry-"));
  var realStore = require("../lib/portfolio-execution-bindings")
    .createPortfolioExecutionBindings({ file: path.join(dir, "bindings.json") });
  var bindingStore = Object.create(realStore);
  var cleanupCalls = 0;
  bindingStore.markUnavailable = function () {
    cleanupCalls += 1;
    return { ok: false, reason: "persistence_failed" };
  };
  var claimedCoordinator = null;
  var claims = 0;
  var ownerLedger = {
    canonicalCoordinator: function () { return claimedCoordinator; },
    claimCoordinator: function (input) {
      claims += 1;
      if (claims === 1) return { ok: false, reason: "persistence_failed" };
      claimedCoordinator = input.coordinator;
      return { ok: true, created: true, coordinator: input.coordinator };
    },
  };
  var created = [];
  var projectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var router = createCrossProjectRouter({ allowLeadSourcedExecution: true, bindingStore: bindingStore, ownerRequests: ownerLedger });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () {
      created.push("coordinator-" + (created.length + 1));
      return { ok: true, created: true,
        sessionRef: { projectId: projectId, sessionStorageId: created[created.length - 1] } };
    },
  });
  var harness = { router: router, projectId: projectId };
  var topicId = "auto-a7daa4cc660639337d144d93";

  var first = staffTopic(harness, "portfolio-cleanup-retry", topicId);
  assert.equal(first.ok, false);
  assert.equal(cleanupCalls, 1);
  assert.equal(router.getExecutionBinding("portfolio-cleanup-retry").status, "active",
    "fault injection leaves the committed binding active on disk");

  var retry = staffTopic(harness, "portfolio-cleanup-retry", topicId);
  assert.equal(retry.ok, true);
  assert.equal(retry.reused, true);
  assert.equal(claims, 2, "retry must claim the existing coordinator before success");
  assert.equal(created.length, 1, "claim recovery must not start a rival session");
  assert.deepEqual(claimedCoordinator, retry.coordinatorRef);
});

test("coordinator replay fails closed when canonical claim lookup is missing", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-claim-missing-"));
  var ledger = ledgerIn(dir);
  var created = [];
  var harness = cardinalityRouter(dir, ledger, created);
  var topicId = "auto-a7daa4cc660639337d144d93";
  assert.equal(staffTopic(harness, "portfolio-claim-missing", topicId).ok, true);

  delete ledger.canonicalCoordinator;
  var replay = staffTopic(harness, "portfolio-claim-missing", topicId);
  assert.equal(replay.ok, false,
    "an unverifiable claim cannot be treated as a committed replay");
  assert.notEqual(harness.router.getExecutionBinding("portfolio-claim-missing").status, "active");
});

test("coordinator replay fails closed when canonical claim lookup throws", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-claim-throws-"));
  var ledger = ledgerIn(dir);
  var created = [];
  var harness = cardinalityRouter(dir, ledger, created);
  var topicId = "auto-a7daa4cc660639337d144d93";
  assert.equal(staffTopic(harness, "portfolio-claim-throws", topicId).ok, true);

  ledger.canonicalCoordinator = function () { throw new Error("ledger unavailable"); };
  var replay = staffTopic(harness, "portfolio-claim-throws", topicId);
  assert.equal(replay.ok, false,
    "a throwing lookup cannot prove that the binding still holds its claim");
  assert.notEqual(harness.router.getExecutionBinding("portfolio-claim-throws").status, "active");
});

test("resident coordinator dismissal supersedes the exact active project execution", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-dismiss-execution-"));
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var source = { projectId: "system-lead", sessionStorageId: "clay-root" };
  var delivered = [];
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function (envelope) {
      delivered.push(envelope);
      return { ok: true, terminal: true };
    },
  });
  var request = {
    portfolioTaskId: "obsolete-verifier", bindingRevision: 11,
    idempotencyKey: "obsolete-verifier-r11", mode: "project_coordinator",
    targetProject: { projectId: projectId }, source: source,
  };
  assert.equal(router.bindingStore.reserve(request).ok, true);
  assert.equal(router.bindingStore.commit(request.portfolioTaskId, request.bindingRevision,
    { projectId: projectId, sessionStorageId: "verifier-session" },
    { projectCoordinatorRef: source }).ok, true);

  var result = router.dismissProjectExecution({
    source: source, targetProject: { projectId: projectId },
    portfolioTaskId: request.portfolioTaskId, bindingRevision: request.bindingRevision,
    idempotencyKey: "dismiss-obsolete-verifier", reason: "source_task_dismissed",
  });

  assert.equal(result.ok, true);
  assert.equal(router.getExecutionBinding(request.portfolioTaskId, request.bindingRevision).status,
    "superseded");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.type, "portfolio_execution_stop");
  assert.deepEqual(delivered[0].destination,
    { projectId: projectId, sessionStorageId: "verifier-session" });
});

test("migrated coordinator retry re-claims after claim and cleanup failures", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-migrated-claim-retry-"));
  var realStore = require("../lib/portfolio-execution-bindings")
    .createPortfolioExecutionBindings({ file: path.join(dir, "bindings.json") });
  var bindingStore = Object.create(realStore);
  var cleanupCalls = 0;
  bindingStore.markUnavailable = function () {
    cleanupCalls += 1;
    return { ok: false, reason: "persistence_failed" };
  };
  var claimedCoordinator = null;
  var claims = 0;
  var ownerLedger = {
    canonicalCoordinator: function () { return claimedCoordinator; },
    claimCoordinator: function (input) {
      claims += 1;
      if (claims === 1) return { ok: false, reason: "persistence_failed" };
      claimedCoordinator = input.coordinator;
      return { ok: true, created: true, coordinator: input.coordinator };
    },
  };
  var lead = leadCutoverHarness("running", true);
  var starts = 0;
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingStore: bindingStore,
    deliveryFile: path.join(dir, "delivery.json"),
    getProjectContext: function (slug) { return slug === "lead" ? lead.project : null; },
    ownerRequests: ownerLedger,
  });
  router.registerProjectResolver({
    getProjectId: function () { return CUTOVER_TARGET_ID; },
    deliverCrossProjectEnvelope: function () {
      starts += 1;
      return { ok: true, created: true,
        sessionRef: { projectId: CUTOVER_TARGET_ID, sessionStorageId: "target-coordinator" } };
    },
  });
  var input = migrationInput(1, true);
  input.mode = "project_coordinator";
  input.coopTopicRef = { topicId: "auto-a7daa4cc660639337d144d93" };

  var first = router.migrateLegacyExecution(input);
  assert.equal(first.ok, false);
  assert.equal(cleanupCalls, 1, "migration must attempt the same unavailable cleanup as creation");
  assert.equal(router.getExecutionBinding(input.portfolioTaskId).status, "active");

  var retry = router.migrateLegacyExecution(input);
  assert.equal(retry.ok, true);
  assert.equal(retry.migrated, true);
  assert.equal(retry.reused, true);
  assert.equal(claims, 2, "migrated replay must claim and verify before success");
  assert.equal(starts, 1, "claim recovery reuses the committed migrated coordinator");
});

// --- Duplicated-invariant guards -------------------------------------------
//
// `sameSessionRef` was declared twice inside the router closure: a normalized
// version that validated both refs through projectIdentity, and a later raw
// field-comparison version. Function-declaration hoisting made the RAW one win
// for the whole closure, so the validated predicate was dead code and nothing
// in the suite noticed. These two tests close that class of defect: one proves
// the shared predicate refuses malformed refs, the other proves no module in
// the family can silently shadow a helper with a second declaration again.

var CROSS_PROJECT_MODULE_FILES = fs.readdirSync(path.join(__dirname, "..", "lib"))
  .filter(function (name) {
    return name === "server-cross-project.js" ||
      name.indexOf("server-cross-project-") === 0 && /\.js$/.test(name);
  });

function duplicateFunctionDeclarations(source) {
  var seen = Object.create(null);
  var duplicates = [];
  var pattern = /^[ \t]*function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(/gm;
  var match = pattern.exec(source);
  while (match) {
    if (seen[match[1]]) duplicates.push(match[1]);
    seen[match[1]] = true;
    match = pattern.exec(source);
  }
  return duplicates;
}

test("no cross-project router module declares the same function name twice", function () {
  assert.ok(CROSS_PROJECT_MODULE_FILES.length > 0, "the module family must be discoverable");
  for (var i = 0; i < CROSS_PROJECT_MODULE_FILES.length; i++) {
    var file = CROSS_PROJECT_MODULE_FILES[i];
    var source = fs.readFileSync(path.join(__dirname, "..", "lib", file), "utf8");
    assert.deepEqual(duplicateFunctionDeclarations(source), [],
      file + " declares a function name twice; hoisting makes the LAST one win silently");
  }
});

test("the shared session-ref predicate refuses malformed refs instead of comparing raw fields", function () {
  var sameSessionRef = require("../lib/server-cross-project-shared").sameSessionRef;
  var validProjectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";

  assert.equal(sameSessionRef(
    { projectId: validProjectId, sessionStorageId: "coordinator-1" },
    { projectId: validProjectId, sessionStorageId: "coordinator-1" }), true,
    "two identical well-formed refs still match");
  assert.equal(sameSessionRef(
    { projectId: validProjectId, sessionStorageId: "coordinator-1" },
    { projectId: validProjectId, sessionStorageId: "coordinator-2" }), false);

  // The raw predicate returned TRUE for both of these: it compared fields
  // without ever asking whether the fields were a legal identity.
  assert.equal(sameSessionRef(
    { projectId: "not-a-project-id", sessionStorageId: "coordinator-1" },
    { projectId: "not-a-project-id", sessionStorageId: "coordinator-1" }), false,
    "an invalid projectId must never produce a match");
  assert.equal(sameSessionRef(
    { projectId: validProjectId },
    { projectId: validProjectId }), false,
    "two refs that both lack a sessionStorageId must never match");

  assert.equal(sameSessionRef(null, null), false);
  assert.equal(sameSessionRef(undefined,
    { projectId: validProjectId, sessionStorageId: "coordinator-1" }), false);
});

test("a missing ThreadRef is not blamed when no owner decision exists", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-threadref-reason-"));
  var projectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  // The three real shapes from live state: a bug report, a follow-up question
  // and an approval, all classified conversational with no implementation
  // decision. Each was reported as thread_ref_required, which sent an operator
  // hunting a Thread-creation gap that was never the blocker.
  var conversational = {
    ingressId: "coop:coop:455",
    expectsExecution: false,
    implementationDecision: null,
    projectRefs: [],
  };
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    allowLeadSourcedExecution: true,
    requireOwnerImplementationDecision: true,
    ownerRequests: {
      get: function () { return conversational; },
      forTopic: function () { return [conversational]; },
    },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });

  function dispatch() {
    return router.createProjectExecution({
      source: { projectId: "system-lead", sessionStorageId: "coop" },
      coopIngressId: "coop:coop:455",
      portfolioTaskId: "portfolio-threadref-reason",
      bindingRevision: 1,
      idempotencyKey: "threadref-reason-r1",
      mode: "project_coordinator",
      targetProject: { projectId: projectId },
      objective: "Do the bounded work.",
    });
  }

  var noDecision = dispatch();
  assert.equal(noDecision.ok, false);
  assert.equal(noDecision.reason, "owner_implementation_decision_required",
    "the real blocker is the missing decision, not the missing ThreadRef");
  assert.match(noDecision.error, /A missing ThreadRef is not the blocker here/);

  // With a real decision on the ingress, a missing ThreadRef IS the blocker and
  // the original reason is still reported, because now it is true.
  conversational.implementationDecision = { intent: "implement", projectName: "" };
  conversational.expectsExecution = true;
  assert.equal(dispatch().reason, "thread_ref_required");
});

test("no owner turn at all is not reported as a missing ThreadRef", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-no-ingress-"));
  var projectId = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
  // The live shape behind the standing blocker measured on 2026-08-19. The
  // router used to hand this dispatch an unrelated owner ingress, so the gate
  // found a real implementation decision on it and answered thread_ref_required
  // -- true of that ingress, and completely misleading about this dispatch.
  // With the hijack narrowed the route arrives empty, and an empty route means
  // no owner turn authorizes this work at all. Saying "thread_ref_required" here
  // would just relocate the same misdiagnosis: there is nothing yet for a Thread
  // to be bound to.
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    allowLeadSourcedExecution: true,
    requireOwnerImplementationDecision: true,
    ownerRequests: {
      get: function () { return null; },
      forTopic: function () { return []; },
    },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });

  var result = router.createProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: "coop" },
    portfolioTaskId: "webapp-automation-policy-board-exclusions",
    bindingRevision: 2,
    idempotencyKey: "webapp-automation-policy-board-exclusions-r2",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
    objective: "Exclude the configured boards from automation policy.",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_decision_required",
    "an empty route means no owner decision, not a missing Thread");
  assert.match(result.error, /A missing ThreadRef is not the blocker here/);

  // A cited ingress that DOES carry a decision still reports the ThreadRef as
  // the blocker, because for that dispatch it genuinely is.
  var decided = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings-2.json"),
    deliveryFile: path.join(dir, "delivery-2.json"),
    allowLeadSourcedExecution: true,
    requireOwnerImplementationDecision: true,
    ownerRequests: {
      get: function () {
        return { ingressId: "coop:coop:459", expectsExecution: true,
          implementationDecision: { intent: "implement" }, projectRefs: [] };
      },
      forTopic: function () { return []; },
    },
  });
  decided.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });
  assert.equal(decided.createProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: "coop" },
    coopIngressId: "coop:coop:459",
    portfolioTaskId: "webapp-automation-policy-board-exclusions",
    bindingRevision: 1,
    idempotencyKey: "webapp-automation-policy-board-exclusions-r1",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
    objective: "Exclude the configured boards from automation policy.",
  }).reason, "thread_ref_required");
});

// The gate half of the unscoped-Main minting fix. admitUnscopedMainImplementation
// has always existed to admit an owner implementation command typed in Main, but
// the owner's own Main turn cannot supply the TopicRef it requires, so it was
// only ever reachable by a caller that already had a Thread in hand. Now the
// route mints one against that turn, and this is what the gate does with it.
test("an unscoped Main implementation decision admits once its Thread exists", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-unscoped-main-"));
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var ingressId = "coop:coop-home:612";
  var ownerEvent = {
    type: "user_message",
    text: "implement the ThreadRef minting fix in clay",
    coopIngressId: ingressId,
    coopComposerScope: "main",
  };
  var entry = {
    ingressId: ingressId,
    expectsExecution: true,
    implementationDecision: { intent: "implement", projectName: "clay" },
    topicRef: null,
    projectRefs: [],
    requestRef: { projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: 0 },
    sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" },
  };
  var scoped = [];
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    allowLeadSourcedExecution: true,
    requireOwnerImplementationDecision: true,
    getProjectContext: function () { return null; },
    ownerRequests: {
      get: function () { return entry; },
      // Mirrors the real store: a record joins a Thread only once its
      // implementation is scoped, so before that the freshly minted Thread has
      // nothing bound to it and the unscoped-Main branch is what decides. After
      // it, the record is on the Thread and a retry is the main loop's business.
      forTopic: function (topicRef) {
        return entry.topicRef && topicRef &&
          entry.topicRef.topicId === topicRef.topicId ? [entry] : [];
      },
      scopeImplementation: function (id, scope) {
        scoped.push({ id: id, scope: scope });
        // The durable writes coop-owner-requests.scopeImplementation performs.
        entry.topicRef = scope.topicRef;
        entry.implementationScope = scope;
        entry.classification = { kind: "existing_topic", source: "owner_directed_execution" };
        return { ok: true, request: entry };
      },
    },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
    getSessionManager: function () {
      return { sessions: { forEach: function (fn) {
        fn({ coopHome: true, storageId: "coop-home", history: [ownerEvent] });
      } } };
    },
  });

  function dispatch(topicRef) {
    return router.createProjectExecution({
      source: { projectId: "system-lead", sessionStorageId: "coop-home" },
      coopIngressId: ingressId,
      coopTopicRef: topicRef,
      portfolioTaskId: "clay-threadref-minting-fix",
      bindingRevision: 1,
      idempotencyKey: "threadref-r1",
      mode: "project_coordinator",
      targetProject: { projectId: projectId },
      objective: "Do the bounded work.",
    });
  }

  // Reproduces the standing blocker exactly: a real owner decision, no Thread.
  assert.equal(dispatch(undefined).reason, "thread_ref_required");
  assert.equal(scoped.length, 0, "nothing may be scoped while the gate refuses");

  // With the Thread the route now mints, the owner decision is admitted and
  // bound to the exact task, revision and project the dispatch named.
  var admitted = dispatch({ topicId: "owner-612abc" });
  assert.notEqual(admitted.reason, "thread_ref_required");
  assert.notEqual(admitted.reason, "owner_implementation_decision_required");
  assert.equal(scoped.length, 1, "the owner decision is scoped exactly once");
  assert.equal(scoped[0].id, ingressId);
  assert.deepEqual(scoped[0].scope.topicRef, { topicId: "owner-612abc" });
  assert.equal(scoped[0].scope.portfolioTaskId, "clay-threadref-minting-fix");
  assert.equal(scoped[0].scope.bindingRevision, 1);
  assert.equal(scoped[0].scope.projectRef.projectId, projectId);

  // The main loop re-asserts the scope on every admitted dispatch, which the real
  // store answers with reused:true for a byte-equal scope. What must hold is that
  // the retry asks for exactly the same scope -- no widened project, task or
  // revision -- and never regresses to a missing-Thread or missing-decision refusal.
  var retried = dispatch({ topicId: "owner-612abc" });
  assert.notEqual(retried.reason, "thread_ref_required");
  assert.notEqual(retried.reason, "owner_implementation_decision_required");
  assert.equal(scoped.length, 2);
  assert.deepEqual(scoped[1].scope, scoped[0].scope,
    "a retry must re-assert the identical scope, never a widened one");

  fs.rmSync(dir, { recursive: true, force: true });
});

// The unscoped-Main branch used to skip the project refusal its sibling branches
// all apply. Nothing populated projectRefs on a Thread-less record, so it was
// unreachable rather than wrong -- but this branch is now the ordinary path for
// owner-directed Main execution, so it fails closed on its own.
test("an unscoped Main decision is refused for a project the owner did not name", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-unscoped-project-"));
  var namedProject = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var otherProject = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
  var ingressId = "coop:coop-home:612";
  var ownerEvent = {
    type: "user_message",
    text: "implement the ThreadRef minting fix in clay",
    coopIngressId: ingressId,
    coopComposerScope: "main",
  };
  var entry = {
    ingressId: ingressId,
    expectsExecution: true,
    implementationDecision: { intent: "implement", projectName: "clay" },
    topicRef: null,
    projectRefs: [{ projectId: namedProject }],
    requestRef: { projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: 0 },
    sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" },
  };
  var scoped = 0;
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    allowLeadSourcedExecution: true,
    requireOwnerImplementationDecision: true,
    getProjectContext: function () { return null; },
    ownerRequests: {
      get: function () { return entry; },
      forTopic: function () { return []; },
      scopeImplementation: function () { scoped++; return { ok: true, request: entry }; },
    },
  });
  [namedProject, otherProject].forEach(function (id) {
    router.registerProjectResolver({
      getProjectId: function () { return id; },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    });
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
    getSessionManager: function () {
      return { sessions: { forEach: function (fn) {
        fn({ coopHome: true, storageId: "coop-home", history: [ownerEvent] });
      } } };
    },
  });

  var refused = router.createProjectExecution({
    source: { projectId: "system-lead", sessionStorageId: "coop-home" },
    coopIngressId: ingressId,
    coopTopicRef: { topicId: "owner-612abc" },
    portfolioTaskId: "clay-threadref-minting-fix",
    bindingRevision: 1,
    idempotencyKey: "threadref-elsewhere",
    mode: "project_coordinator",
    targetProject: { projectId: otherProject },
    objective: "Do the bounded work.",
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "owner_implementation_project_mismatch");
  assert.equal(scoped, 0, "a mismatched project must never be scoped");

  fs.rmSync(dir, { recursive: true, force: true });
});

// Transcript delta coalescing rewrote the canonical transcript without repointing
// the stored requestRef.eventIndex values. Measured on live state: of 503 owner
// requests exactly ONE index still landed on its own ingress, 55 landed on an
// unrelated event and 447 pointed past the end of the 37 831-item transcript.
// Because implementationAuthorized requires the canonical event whenever a
// requestRef exists -- and every entry has one -- no owner decision anywhere in
// live state could be admitted. Resolving by the immutable coopIngressId instead
// of the drifted index is what makes an owner-approved dispatch possible again.
test("a stale requestRef index still resolves the owner turn by its ingress", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-stale-ref-"));
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var ingressId = "coop:coop-home:459";
  var topicRef = { topicId: "owner-65d0dc78" };
  var ownerEvent = {
    type: "user_message",
    text: "implement the board exclusions in clay",
    coopIngressId: ingressId,
    coopTopicRef: topicRef,
  };
  // The transcript as it exists now: the owner turn sits at index 2, while the
  // record still points at the pre-coalescing position.
  var history = [
    { type: "tool_result" },
    { type: "thinking_stop" },
    ownerEvent,
    { type: "tool_executing" },
  ];
  var entry = {
    ingressId: ingressId,
    expectsExecution: true,
    implementationDecision: { intent: "implement", projectName: "clay" },
    topicRef: topicRef,
    projectRefs: [{ projectId: projectId }],
    requestRef: { projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: 200452 },
    sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" },
  };
  var scoped = [];
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    allowLeadSourcedExecution: true,
    requireOwnerImplementationDecision: true,
    getProjectContext: function () { return null; },
    ownerRequests: {
      get: function () { return entry; },
      forTopic: function (requested) {
        return requested && requested.topicId === topicRef.topicId ? [entry] : [];
      },
      scopeImplementation: function (id, scope) {
        scoped.push({ id: id, scope: scope });
        return { ok: true, request: entry };
      },
    },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
    getSessionManager: function () {
      return { sessions: { forEach: function (fn) {
        fn({ coopHome: true, storageId: "coop-home", history: history });
      } } };
    },
  });

  function dispatch() {
    return router.createProjectExecution({
      source: { projectId: "system-lead", sessionStorageId: "coop-home" },
      coopIngressId: ingressId,
      coopTopicRef: topicRef,
      portfolioTaskId: "webapp-automation-policy-board-exclusions",
      bindingRevision: 1,
      idempotencyKey: "board-exclusions-r1",
      mode: "project_coordinator",
      targetProject: { projectId: projectId },
      objective: "Exclude the configured boards from automation policy.",
    });
  }

  var result = dispatch();
  // Authorization passes: the owner decision is found and scoped even though the
  // recorded index points 200 000 events past the end of the transcript.
  assert.notEqual(result.reason, "owner_implementation_decision_required");
  assert.equal(scoped.length, 1, "the owner decision is admitted and scoped");
  assert.deepEqual(scoped[0].scope.topicRef, topicRef);

  // A duplicated ingress is ambiguous, and guessing which turn the owner meant
  // would be the fail-open move. It fails closed instead.
  history.push({ type: "user_message", text: "something else", coopIngressId: ingressId });
  scoped.length = 0;
  assert.equal(dispatch().reason, "owner_implementation_decision_required");
  assert.equal(scoped.length, 0, "an ambiguous ingress must never be scoped");

  fs.rmSync(dir, { recursive: true, force: true });
});

// A closed or already-occupied owner Thread is a specific, actionable blocker,
// and it used to be reported as the generic thread_ref_required -- "a Thread is
// required" when the truth was "the Thread cannot be created, and here is why".
// That is the same misdiagnosis shape that sent an operator hunting a
// Thread-minting gap for two days, so the cause is now named.
test("a refused Thread mint is reported as its own cause, not a missing ThreadRef", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-mint-refusal-"));
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var ingressId = "coop:coop-home:612";
  var ownerEvent = {
    type: "user_message",
    text: "implement the ThreadRef minting fix in clay",
    coopIngressId: ingressId,
    coopComposerScope: "main",
  };
  var entry = {
    ingressId: ingressId,
    expectsExecution: true,
    implementationDecision: { intent: "implement", projectName: "clay" },
    topicRef: null,
    projectRefs: [],
    requestRef: { projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: 0 },
    sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" },
  };
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    allowLeadSourcedExecution: true,
    requireOwnerImplementationDecision: true,
    getProjectContext: function () { return null; },
    ownerRequests: {
      get: function () { return entry; },
      forTopic: function () { return []; },
      scopeImplementation: function () { return { ok: true, request: entry }; },
    },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
    getSessionManager: function () {
      return { sessions: { forEach: function (fn) {
        fn({ coopHome: true, storageId: "coop-home", history: [ownerEvent] });
      } } };
    },
  });

  function dispatch(refusal) {
    return router.createProjectExecution({
      source: { projectId: "system-lead", sessionStorageId: "coop-home" },
      coopIngressId: ingressId,
      coopThreadMintRefusal: refusal,
      portfolioTaskId: "clay-threadref-minting-fix",
      bindingRevision: 1,
      idempotencyKey: "threadref-refusal-r1",
      mode: "project_coordinator",
      targetProject: { projectId: projectId },
      objective: "Do the bounded work.",
    });
  }

  // With no refusal recorded, the Thread simply has not been minted yet and the
  // original reason is still the truthful one.
  assert.equal(dispatch(undefined).reason, "thread_ref_required");

  var closed = dispatch("owner_thread_closed");
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, "owner_thread_unavailable");
  assert.match(closed.error, /owner_thread_closed/);
  assert.match(closed.error, /symptom, not the blocker/);

  var conflict = dispatch("owner_thread_identity_conflict");
  assert.equal(conflict.reason, "owner_thread_unavailable");
  assert.match(conflict.error, /owner_thread_identity_conflict/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// The route sets coopThreadMintRefusal, but it arrives merged into caller-supplied
// input, so it is untrusted text on its way to an operator-facing message.
test("a malformed mint refusal is dropped rather than rendered to an operator", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-refusal-sanitize-"));
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var ingressId = "coop:coop-home:612";
  var entry = {
    ingressId: ingressId,
    expectsExecution: true,
    implementationDecision: { intent: "implement", projectName: "clay" },
    topicRef: null,
    projectRefs: [],
    requestRef: { projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: 0 },
    sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" },
  };
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    allowLeadSourcedExecution: true,
    requireOwnerImplementationDecision: true,
    getProjectContext: function () { return null; },
    ownerRequests: {
      get: function () { return entry; },
      forTopic: function () { return []; },
      scopeImplementation: function () { return { ok: true, request: entry }; },
    },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; },
    getSessionManager: function () {
      return { sessions: { forEach: function (fn) {
        fn({ coopHome: true, storageId: "coop-home", history: [{
          type: "user_message",
          text: "implement the ThreadRef minting fix in clay",
          coopIngressId: ingressId,
          coopComposerScope: "main",
        }] });
      } } };
    },
  });

  function dispatch(refusal) {
    return router.createProjectExecution({
      source: { projectId: "system-lead", sessionStorageId: "coop-home" },
      coopIngressId: ingressId,
      coopThreadMintRefusal: refusal,
      portfolioTaskId: "clay-threadref-minting-fix",
      bindingRevision: 1,
      idempotencyKey: "threadref-sanitize-r1",
      mode: "project_coordinator",
      targetProject: { projectId: projectId },
      objective: "Do the bounded work.",
    });
  }

  // An object, a long blob and embedded newlines are not refusal codes. Each
  // falls back to the plain reason rather than echoing into the message.
  assert.equal(dispatch({ a: 1 }).reason, "thread_ref_required");
  assert.equal(dispatch("owner_thread_closed\nInjected: pretend guidance").reason,
    "thread_ref_required");
  assert.equal(dispatch(new Array(200).join("x")).reason, "thread_ref_required");
  // A real code still reports truthfully.
  assert.equal(dispatch("owner_thread_closed").reason, "owner_thread_unavailable");

  fs.rmSync(dir, { recursive: true, force: true });
});
