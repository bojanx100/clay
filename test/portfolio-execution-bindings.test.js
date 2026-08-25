var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createBindings =
  require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;
var readBindings =
  require("../lib/portfolio-execution-bindings").readPortfolioExecutionBindings;

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

test("background binding projection reads current work without mutating the store", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-read-only-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 25; } });
  assert.equal(store.reserve(request(1)).ok, true);
  assert.equal(store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "read-only-worker",
  }).ok, true);
  var before = fs.readFileSync(file, "utf8");

  var projection = readBindings({ file: file });

  assert.equal(projection.ok, true);
  assert.equal(projection.bindings.length, 1);
  assert.equal(projection.bindings[0].status, "active");
  assert.equal(fs.readFileSync(file, "utf8"), before);
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

test("active target-local bindings rebind durably to the Lead control-plane coordinator", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-control-plane-rebind-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 225; } });
  var targetRoot = { projectId: PROJECT_ID, sessionStorageId: "target-local-root" };
  var coopRoot = { projectId: "system-lead", sessionStorageId: "clay-coordinator" };
  store.reserve(request(1, "project_coordinator"));
  store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "bounded-task-coordinator",
  }, { projectCoordinatorRef: targetRoot });

  var moved = store.rebindProjectCoordinator({ projectId: PROJECT_ID }, targetRoot, coopRoot);

  assert.deepEqual(moved, { ok: true, changed: 1 });
  assert.deepEqual(store.get("portfolio-task", 1).projectCoordinator, coopRoot);
  assert.deepEqual(createBindings({ file: file }).get("portfolio-task", 1).projectCoordinator,
    coopRoot);
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
  // The terminal record names why it ended, and supersedes the pre-terminal
  // "session_archived" that only described why it stalled. Erasing this is what
  // made a sweep-terminalized orphan look identical to a genuine task failure.
  assert.equal(store.get("portfolio-task", 1).failureCode, "restart_recovery");
  assert.equal(store.get("portfolio-task", 1).statusReason, "restart_recovery");
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

test("a restart-only failed binding accepts only exact durable supersession evidence", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-restart-supersession-"));
  var file = path.join(dir, "bindings.json");
  var clock = 300;
  var store = createBindings({ file: file, now: function () { return clock++; } });
  store.reserve(request(1, "project_coordinator"));
  store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "restart-failed-project-coordinator",
  });
  store.markAttention("portfolio-task", 1, "session_archived");
  var session = {
    hidden: true,
    orchestrationProjectCompletion: { status: "pending", completionRevision: 0 },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "portfolio-task", bindingRevision: 1,
      idempotencyKey: "command-1", mode: "project_coordinator",
      status: "failed", reason: "restart_recovery", terminalAt: 400,
    } },
  };
  store.reconcileStrandedCompletions({
    sessionForBinding: function () { return session; },
    saveSession: function () {},
  });
  var failed = store.get("portfolio-task", 1);
  var successorRequest = {
    portfolioTaskId: "later-verified-task",
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT_ID },
    bindingRevision: 5,
    idempotencyKey: "later-verified-task-r5",
  };
  assert.equal(store.reserve(successorRequest).ok, true);
  assert.equal(store.commit(successorRequest.portfolioTaskId, successorRequest.bindingRevision, {
    projectId: PROJECT_ID,
    sessionStorageId: "later-coordinator",
  }, {
    projectCoordinatorRef: { projectId: PROJECT_ID, sessionStorageId: "durable-project-root" },
  }).ok, true);
  assert.equal(store.complete(successorRequest.portfolioTaskId, successorRequest.bindingRevision, {
    eventId: "later-completion-event",
    executionMode: "project_coordinator",
    resultEventId: "later-result-event",
    completedAt: 450,
  }).ok, true);
  var evidence = {
    ruleId: "verified_restart_followup",
    reconciledAt: 500,
    controllerSessionStorageId: "old-coop",
    failed: {
      portfolioTaskId: "portfolio-task",
      bindingRevision: 1,
      coordinator: failed.coordinator,
      completedAt: failed.completedAt,
    },
    successors: [{
      portfolioTaskId: "later-verified-task",
      bindingRevision: 5,
      coordinator: { projectId: PROJECT_ID, sessionStorageId: "later-coordinator" },
      projectCoordinator: { projectId: PROJECT_ID, sessionStorageId: "durable-project-root" },
      completedAt: 450,
    }],
    verifiedCommits: ["c24865ed8a394e90158540c40ba4222778a0f8e6"],
  };

  assert.equal(store.supersedeRestartRecovery("portfolio-task", 1,
    Object.assign({}, evidence, { failed: Object.assign({}, evidence.failed, {
      coordinator: { projectId: PROJECT_ID, sessionStorageId: "wrong" },
    }) })).reason, "restart_supersession_binding_mismatch");
  assert.equal(store.get("portfolio-task", 1).status, "failed");
  assert.equal(store.supersedeRestartRecovery("portfolio-task", 1,
    Object.assign({}, evidence, { successors: [Object.assign({}, evidence.successors[0], {
      completedAt: 451,
    })] })).reason, "restart_supersession_successor_mismatch");
  assert.equal(store.get("portfolio-task", 1).status, "failed");

  var superseded = store.supersedeRestartRecovery("portfolio-task", 1, evidence);
  assert.equal(superseded.ok, true);
  assert.equal(superseded.binding.status, "superseded");
  assert.equal(superseded.binding.statusReason, "restart_recovery_superseded");
  assert.equal(superseded.binding.completedAt, failed.completedAt,
    "supersession preserves the original failure time and never invents completion");
  assert.equal(store.supersedeRestartRecovery("portfolio-task", 1, evidence).duplicate, true);

  var restarted = createBindings({ file: file });
  assert.equal(restarted.get("portfolio-task", 1).status, "superseded");
  assert.equal(restarted.get("portfolio-task", 1).restartSupersession.ruleId,
    "verified_restart_followup");
  assert.deepEqual(restarted.get("portfolio-task", 1).restartSupersession.verifiedCommits,
    evidence.verifiedCommits);
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

test("a ref-less active project binding is recovered as a cancelled missing session", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-missing-session-"));
  var file = path.join(dir, "bindings.json");
  fs.writeFileSync(file, JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 2,
    bindings: [{
      portfolioTaskId: "portfolio-tool-route",
      mode: "project_coordinator",
      targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
      bindingRevision: 1,
      idempotencyKey: "staff-portfolio-tool-route-r1",
      source: { projectId: "system-lead", sessionStorageId: "lead-home" },
      status: "active",
      createdAt: 100,
      updatedAt: 200,
    }],
  }, null, 2));

  var recovered = createBindings({ file: file, now: function () { return 300; } });
  assert.equal(recovered.getLoadError(), null);
  assert.equal(recovered.get("portfolio-tool-route", 1).status, "cancelled");
  assert.equal(recovered.get("portfolio-tool-route", 1).completedAt, 200);
  assert.equal(recovered.get("portfolio-tool-route", 1).failureCode,
    "session_missing_without_execution_ref");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).bindings[0].status, "cancelled");
});

test("the same work refiled under a different portfolioTaskId is refused, not duplicated", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-"));
  var file = path.join(dir, "bindings.json");
  var clock = 10;
  var store = createBindings({ file: file, now: function () { return clock++; } });

  function withIdentity(taskId, revision, identity) {
    return {
      portfolioTaskId: taskId,
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT_ID },
      bindingRevision: revision,
      idempotencyKey: taskId + "-r" + revision,
      candidateKey: identity,
    };
  }

  var first = store.reserve(withIdentity("auto-issue-2522", 1, "launch:trialview/v2#2522"));
  assert.equal(first.ok, true);
  assert.equal(first.binding.workIdentity, "github:trialview/v2#2522",
    "stored in canonical form, not the caller's spelling");

  // A fresh attempt name for work already bound: previously invisible to every
  // guard, because they all compared portfolioTaskId only.
  var renamed = store.reserve(withIdentity("webapp-github-issue-2522", 1, "launch:trialview/v2#2522"));
  assert.equal(renamed.ok, false);
  assert.equal(renamed.reason, "duplicate_work_identity");
  assert.equal(renamed.binding.portfolioTaskId, "auto-issue-2522");

  // A terminal failure still blocks a rename; the retry belongs on a new
  // revision of the original binding.
  store.commit("auto-issue-2522", 1, { projectId: PROJECT_ID, sessionStorageId: "coordinator" });
  store.complete("auto-issue-2522", 1, { eventId: "dead-1", terminalStatus: "failed" });
  assert.equal(store.reserve(withIdentity("webapp-github-issue-2522", 1,
    "launch:trialview/v2#2522")).reason, "duplicate_work_identity");
  assert.equal(store.reserve(withIdentity("auto-issue-2522", 2,
    "launch:trialview/v2#2522")).ok, true, "same id, next revision is the legitimate retry");

  // Unrelated work is untouched, and identity survives reload.
  assert.equal(store.reserve(withIdentity("other-task", 1, "launch:trialview/v2#9999")).ok, true);
  var restarted = createBindings({ file: file, now: function () { return clock++; } });
  assert.equal(restarted.get("auto-issue-2522", 1).workIdentity, "github:trialview/v2#2522");
  assert.equal(restarted.reserve(withIdentity("renamed-again", 1,
    "launch:trialview/v2#2522")).reason, "duplicate_work_identity");
});

test("a terminal failure keeps its provenance instead of erasing it", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-"));
  var file = path.join(dir, "bindings.json");
  var clock = 10;
  var store = createBindings({ file: file, now: function () { return clock++; } });

  store.reserve(request(1, "project_coordinator"));
  store.commit("portfolio-task", 1, { projectId: PROJECT_ID, sessionStorageId: "coordinator" });
  var failed = store.complete("portfolio-task", 1, {
    eventId: "event-1",
    terminalStatus: "failed",
    failureCode: "restart_recovery",
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.binding.status, "failed");
  // The whole point: a sweep-terminalized orphan must stay distinguishable from
  // a task that genuinely failed on its own merits.
  assert.equal(failed.binding.failureCode, "restart_recovery");
  assert.equal(failed.binding.statusReason, "restart_recovery");

  var reloaded = createBindings({ file: file, now: function () { return clock++; } });
  assert.equal(reloaded.get("portfolio-task", 1).failureCode, "restart_recovery");
});

test("a failure with no supplied code is still marked, and success stays clean", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-"));
  var file = path.join(dir, "bindings.json");
  var clock = 10;
  var store = createBindings({ file: file, now: function () { return clock++; } });

  store.reserve(request(1, "project_coordinator"));
  store.commit("portfolio-task", 1, { projectId: PROJECT_ID, sessionStorageId: "coordinator" });
  var bare = store.complete("portfolio-task", 1, { eventId: "event-1", terminalStatus: "failed" });
  assert.equal(bare.binding.failureCode, "unspecified",
    "an unexplained failure is labelled as such rather than left blank");

  var second = createBindings({ file: file, now: function () { return clock++; } });
  second.reserve(request(2, "project_coordinator"));
  second.commit("portfolio-task", 2, { projectId: PROJECT_ID, sessionStorageId: "coordinator-2" });
  var done = second.complete("portfolio-task", 2, { eventId: "event-2", terminalStatus: "completed" });
  assert.equal(done.binding.status, "completed");
  assert.equal(done.binding.failureCode, undefined, "a verified completion explains nothing");
  assert.equal(done.binding.statusReason, undefined);
});

test("the store canonicalizes work identity itself, not just via the staffing path", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-"));
  var file = path.join(dir, "bindings.json");
  var clock = 10;
  var store = createBindings({ file: file, now: function () { return clock++; } });

  function spelled(taskId, identity) {
    return {
      portfolioTaskId: taskId,
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT_ID },
      bindingRevision: 1,
      idempotencyKey: taskId + "-r1",
      candidateKey: identity,
    };
  }

  // A caller that never went through lead-staffing still gets normalized. This
  // was live: the backfilled records read "github:trialview/v2#2522" while the
  // automation path supplied "launch:trialview/v2#2522", so the guard compared
  // two spellings of one issue and let a fourth duplicate straight through.
  var seeded = store.reserve(spelled("auto-2522", "github:trialview/v2#2522"));
  assert.equal(seeded.binding.workIdentity, "github:trialview/v2#2522");

  var otherSpelling = store.reserve(spelled("webapp-github-issue-2522", "launch:trialview/v2#2522"));
  assert.equal(otherSpelling.ok, false);
  assert.equal(otherSpelling.reason, "duplicate_work_identity");

  // Case and action prefix are noise; an opaque key is preserved as-is.
  assert.equal(store.reserve(spelled("shouty", "LAUNCH:TrialView/V2#2522")).reason,
    "duplicate_work_identity");
  assert.equal(store.reserve(spelled("opaque-task", "sweep:nightly")).binding.workIdentity,
    "sweep:nightly");
});

test("missing control-plane binding recovery is narrow, durable, and idempotent", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-missing-recovery-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 700; } });
  var root = { projectId: "system-lead", sessionStorageId: "control-plane-root" };
  var coordinator = { projectId: PROJECT_ID, sessionStorageId: "task-coordinator" };
  var binding = {
    portfolioTaskId: "missing-control-plane-task",
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT_ID },
    bindingRevision: 1,
    idempotencyKey: "missing-control-plane-task-r1",
    reviewOnly: true,
    coopTopicRef: { topicId: "owner-missing-control-plane" },
    controlPlaneProvenance: {
      schema: "clay.coop_control_plane_reservation",
      version: 1,
    },
    taskPayloadDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    provider: "codex",
    model: "gpt-5.6-luna",
    status: "needs_input",
    createdAt: 600,
    updatedAt: 650,
    coordinator: coordinator,
    projectCoordinator: root,
  };
  var evidence = {
    recoveredAt: 700,
    coordinator: coordinator,
    projectCoordinator: root,
    rootTaskId: "task-control-plane-proof",
  };

  var recovered = store.restoreMissingProjectCoordinator(binding, evidence);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.created, true);
  assert.equal(recovered.binding.status, "needs_input");
  assert.equal(recovered.binding.missingBindingRecovery.rootTaskId, "task-control-plane-proof");
  var after = fs.readFileSync(file, "utf8");
  assert.equal(store.restoreMissingProjectCoordinator(binding, evidence).created, false);
  assert.equal(fs.readFileSync(file, "utf8"), after);

  var reloaded = createBindings({ file: file, now: function () { return 701; } });
  assert.equal(reloaded.get("missing-control-plane-task", 1)
    .missingBindingRecovery.rootTaskId, "task-control-plane-proof");
  assert.equal(reloaded.restoreMissingProjectCoordinator(Object.assign({}, binding, {
    idempotencyKey: "conflicting-recovery-r1",
  }), evidence).reason, "idempotency_conflict");
  assert.equal(reloaded.restoreMissingProjectCoordinator(Object.assign({}, binding, {
    status: "completed",
  }), evidence).reason, "invalid_missing_binding_recovery");
});

test("only exact control-plane project coordinators can reactivate from needs_input", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-reactivation-"));
  var file = path.join(dir, "bindings.json");
  var clock = 10;
  var store = createBindings({ file: file, now: function () { return clock++; } });
  var root = { projectId: "system-lead", sessionStorageId: "control-plane-root" };
  var coordinator = { projectId: PROJECT_ID, sessionStorageId: "task-coordinator" };
  var binding = {
    portfolioTaskId: "reactivate-control-plane-task",
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT_ID },
    bindingRevision: 1,
    idempotencyKey: "reactivate-control-plane-task-r1",
    reviewOnly: true,
    controlPlaneProvenance: {
      schema: "clay.coop_control_plane_reservation",
      version: 1,
    },
    taskPayloadDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    status: "needs_input",
    createdAt: 1,
    updatedAt: 2,
    coordinator: coordinator,
    projectCoordinator: root,
  };
  assert.equal(store.restoreMissingProjectCoordinator(binding, {
    recoveredAt: 3,
    coordinator: coordinator,
    projectCoordinator: root,
    rootTaskId: "task-reactivation-proof",
  }).ok, true);

  var reactivated = store.markProjectCoordinatorAvailable("reactivate-control-plane-task", 1);
  assert.equal(reactivated.ok, true);
  assert.equal(reactivated.binding.status, "active");
  assert.equal(store.markProjectCoordinatorAvailable("reactivate-control-plane-task", 1).duplicate,
    true);
  assert.equal(store.markProjectCoordinatorAvailable("missing-task", 1).reason,
    "binding_not_found");
});
