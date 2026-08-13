var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createBindings =
  require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;

var PROJECT_ID = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";

function request(revision, mode, key) {
  return {
    portfolioTaskId: "portfolio-task",
    mode: mode || "direct_leaf",
    targetProject: { projectId: PROJECT_ID },
    bindingRevision: revision,
    idempotencyKey: key || "command-" + revision,
  };
}

test("portfolio execution bindings persist one idempotent canonical SessionRef", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-"));
  var file = path.join(dir, "bindings.json");
  var clock = 10;
  var store = createBindings({ file: file, now: function () { return clock++; } });

  var reserved = store.reserve(request(1));
  assert.equal(reserved.ok, true);
  assert.equal(reserved.created, true);
  assert.equal(store.reserve(request(1)).created, false);
  var committed = store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "canonical-worker",
  });
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.binding.worker, {
    projectId: PROJECT_ID,
    sessionStorageId: "canonical-worker",
  });

  var restarted = createBindings({ file: file, now: function () { return clock++; } });
  assert.deepEqual(restarted.get("portfolio-task", 1).worker, committed.binding.worker);
  assert.equal(restarted.reserve(request(1)).created, false);
  assert.equal(restarted.reserve(request(1, "direct_leaf", "different-command")).reason,
    "idempotency_conflict");
  assert.equal(restarted.reserve(request(2)).reason, "active_binding_exists");
});

test("scope promotion and unavailable/deleted tombstones survive restart", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-promotion-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 50; } });
  store.reserve(request(1));
  store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "leaf",
  });
  assert.equal(store.supersede("portfolio-task", 1, "scope_expansion").ok, true);
  assert.equal(store.reserve(request(2, "project_coordinator")).ok, true);
  store.commit("portfolio-task", 2, {
    projectId: PROJECT_ID,
    sessionStorageId: "coordinator",
  });
  assert.equal(store.markUnavailable("portfolio-task", 2, "project_restart").ok, true);
  assert.equal(store.get("portfolio-task").status, "unavailable");
  assert.equal(store.markDeleted("portfolio-task", 2, "session_deleted").ok, true);

  var restarted = createBindings({ file: file });
  assert.equal(restarted.get("portfolio-task").status, "deleted");
  assert.equal(restarted.list().length, 2);
  assert.equal(restarted.list()[0].status, "superseded");
});

test("typed direct-leaf completion is idempotent and removes closed work from current bindings", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-completion-"));
  var file = path.join(dir, "bindings.json");
  var clock = 100;
  var store = createBindings({ file: file, now: function () { return clock++; } });
  store.reserve(request(1));
  store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "canonical-direct-leaf",
  });

  var completed = store.complete("portfolio-task", 1, {
    eventId: "direct-completion-1",
    completedAt: 123,
    ownerNotification: true,
    resultEventId: "direct-result-1",
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.binding.status, "completed");
  assert.equal(completed.binding.completedAt, 123);
  assert.deepEqual(completed.binding.worker, {
    projectId: PROJECT_ID,
    sessionStorageId: "canonical-direct-leaf",
  });
  assert.deepEqual(store.listCurrent(), []);
  assert.equal(store.markDeleted("portfolio-task", 1, "late_cleanup").reason, "binding_terminal");
  assert.equal(store.complete("portfolio-task", 1, {
    eventId: "direct-completion-1",
  }).duplicate, true);
  assert.equal(store.acknowledgeCompletion("portfolio-task", 1, "direct-completion-1").ok, true);

  var restarted = createBindings({ file: file, now: function () { return clock++; } });
  assert.equal(restarted.get("portfolio-task", 1).status, "completed");
  assert.equal(restarted.listCurrent().length, 0);
  assert.equal(restarted.reserve(request(2)).ok, true);
});

test("stranded direct leaves reconcile every terminal worker outcome", function () {
  var outcomes = [
    { workerStatus: "completed", bindingStatus: "completed" },
    { workerStatus: "failed", bindingStatus: "failed" },
    // A direct leaf that reached an owner decision is terminal for its slot,
    // so its binding must no longer be treated as active work.
    { workerStatus: "needs_input", bindingStatus: "failed" },
  ];

  for (var i = 0; i < outcomes.length; i++) {
    var outcome = outcomes[i];
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-reconcile-leaf-"));
    var store = createBindings({ file: path.join(dir, "bindings.json"), now: function () { return 250; } });
    store.reserve(request(1));
    store.commit("portfolio-task", 1, {
      projectId: PROJECT_ID,
      sessionStorageId: "terminal-direct-leaf-" + outcome.workerStatus,
    });
    var session = {
      orchestrationPolicy: {
        portfolioExecution: {
          portfolioTaskId: "portfolio-task",
          bindingRevision: 1,
          idempotencyKey: "command-1",
          mode: "direct_leaf",
          status: outcome.workerStatus,
        },
      },
    };

    var reconciled = store.reconcileStrandedCompletions({
      sessionForBinding: function () { return session; },
      saveSession: function () {},
    });

    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.reconciled.length, 1, outcome.workerStatus);
    assert.equal(reconciled.reconciled[0].status, outcome.bindingStatus);
    assert.deepEqual(store.listCurrent(), []);
    assert.equal(session.orchestrationPolicy.portfolioExecution.status, outcome.workerStatus);
  }
});

test("typed task-coordinator completion preserves its child and durable project-root refs", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-coordinator-completion-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 200; } });
  store.reserve(request(1, "project_coordinator"));
  store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "bounded-task-coordinator",
  }, {
    projectCoordinatorRef: {
      projectId: PROJECT_ID,
      sessionStorageId: "durable-project-coordinator",
    },
  });

  var completed = store.complete("portfolio-task", 1, {
    eventId: "project-completion-1",
    executionMode: "project_coordinator",
    resultEventId: "project-result-1",
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.binding.status, "completed");
  assert.deepEqual(completed.binding.coordinator, {
    projectId: PROJECT_ID,
    sessionStorageId: "bounded-task-coordinator",
  });
  assert.deepEqual(completed.binding.projectCoordinator, {
    projectId: PROJECT_ID,
    sessionStorageId: "durable-project-coordinator",
  });
  assert.deepEqual(store.listCurrent(), []);
  assert.equal(store.complete("portfolio-task", 1, {
    eventId: "project-completion-1",
    executionMode: "project_coordinator",
  }).duplicate, true);

  var restarted = createBindings({ file: file });
  assert.deepEqual(restarted.get("portfolio-task", 1).projectCoordinator,
    completed.binding.projectCoordinator);
});

test("stranded project-coordinator bindings reconcile from durable completed session evidence", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-reconcile-project-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 250; } });
  store.reserve(request(1, "project_coordinator"));
  store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "project-coordinator",
  });
  assert.equal(store.markDeleted("portfolio-task", 1, "session_deleted").ok, true);

  var session = {
    orchestrationProjectCompletion: {
      status: "completed",
      completionRevision: 1,
      summary: "Integrated outcome.",
      verification: "project suite passed",
      integrationVerification: "yes",
      escalationRequired: "no",
      completedAt: 1234,
    },
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "portfolio-task",
        bindingRevision: 1,
        idempotencyKey: "command-1",
        mode: "project_coordinator",
        status: "completed",
      },
    },
  };
  var saves = 0;

  var reconciled = store.reconcileStrandedCompletions({
    sessionForBinding: function () { return session; },
    saveSession: function () { saves++; },
  });

  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled.length, 1);
  assert.equal(reconciled.reconciled[0].status, "completed");
  assert.equal(reconciled.reconciled[0].completedAt, 1234);
  assert.equal(saves, 1);
  assert.equal(store.get("portfolio-task", 1).status, "completed");
});

test("restart-failed project coordinators terminalize ghost bindings without false completion", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-reconcile-archived-project-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 250; } });
  store.reserve(request(1, "project_coordinator"));
  store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "restart-failed-project-coordinator",
  });
  store.markAttention("portfolio-task", 1, "session_archived");

  var session = {
    hidden: true,
    orchestrationProjectCompletion: {
      status: "pending",
      completionRevision: 0,
    },
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "portfolio-task",
        bindingRevision: 1,
        idempotencyKey: "command-1",
        mode: "project_coordinator",
        status: "failed",
        reason: "restart_recovery",
        terminalAt: 1234,
      },
    },
  };

  var reconciled = store.reconcileStrandedCompletions({
    sessionForBinding: function () { return session; },
    saveSession: function () {},
  });

  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled.length, 1);
  assert.equal(reconciled.reconciled[0].status, "failed");
  assert.equal(reconciled.reconciled[0].completedAt, 1234);
  assert.equal(store.get("portfolio-task", 1).status, "failed");
  assert.equal(store.get("portfolio-task", 1).statusReason, undefined);
  assert.equal(store.get("portfolio-task", 1).attentionAt, undefined);
  assert.equal(session.orchestrationProjectCompletion.status, "pending",
    "restart recovery must not invent verified project completion");
  assert.deepEqual(store.listCurrent(), []);
  assert.equal(store.reconcileStrandedCompletions({
    sessionForBinding: function () { return session; },
    saveSession: function () {},
  }).reconciled.length, 0, "repeated recovery must not rewrite a terminal binding");
  assert.equal(store.reserve(request(2, "project_coordinator")).ok, true,
    "the terminal recovery outcome must release the portfolio slot");
});

test("version-one binding files migrate without changing canonical references", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-migration-"));
  var file = path.join(dir, "bindings.json");
  fs.writeFileSync(file, JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 1,
    bindings: [{
      portfolioTaskId: "portfolio-task",
      mode: "direct_leaf",
      targetProject: { projectId: PROJECT_ID },
      bindingRevision: 1,
      idempotencyKey: "legacy-command",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      worker: { projectId: PROJECT_ID, sessionStorageId: "preserved-worker" },
    }],
  }, null, 2));

  var migrated = createBindings({ file: file });
  assert.deepEqual(migrated.get("portfolio-task", 1).worker, {
    projectId: PROJECT_ID,
    sessionStorageId: "preserved-worker",
  });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2);
});

test("interrupted version-three rollout migrates to canonical version two", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-v3-recovery-"));
  var file = path.join(dir, "bindings.json");
  fs.writeFileSync(file, JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 3,
    bindings: [{
      portfolioTaskId: "portfolio-task",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT_ID },
      bindingRevision: 1,
      idempotencyKey: "interrupted-v3-command",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      coordinator: { projectId: PROJECT_ID, sessionStorageId: "task-coordinator" },
      projectCoordinator: { projectId: PROJECT_ID, sessionStorageId: "project-coordinator" },
    }],
  }, null, 2));

  var migrated = createBindings({ file: file });
  assert.equal(migrated.getLoadError(), null);
  assert.deepEqual(migrated.get("portfolio-task", 1).projectCoordinator, {
    projectId: PROJECT_ID,
    sessionStorageId: "project-coordinator",
  });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2);
});

test("malformed binding state fails closed without overwriting it", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-corrupt-"));
  var file = path.join(dir, "bindings.json");
  fs.writeFileSync(file, "{not-json");
  var store = createBindings({ file: file });

  assert.equal(store.getLoadError(), "malformed_state");
  assert.deepEqual(store.reserve(request(1)), { ok: false, reason: "malformed_state" });
  assert.equal(fs.readFileSync(file, "utf8"), "{not-json");
});
