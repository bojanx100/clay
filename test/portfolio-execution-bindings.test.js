var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createBindings =
  require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;
var readBindings =
  require("../lib/portfolio-execution-bindings").readPortfolioExecutionBindings;
var automationAuthorization =
  require("../lib/project-automation-execution-authorization");
var sessionLifecycle = require("../lib/coop-session-lifecycle");

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

function autoLaunchReviewRequest(revision) {
  var value = request(revision, "project_coordinator", "auto-pr-command-" + revision);
  value.portfolioTaskId = "auto-pr-review";
  value.automationAuthorization = automationAuthorization.createAuthorization({
    projectRef: value.targetProject,
    candidateKey: "launch:trialview/v2#17",
    digest: "candidate-digest",
    itemKey: "trialview/v2#17",
    itemClass: "pr_review",
    policyDigest: "policy-digest",
    eligibilityPass: "eligibility-pass",
    eligibility: {
      assignedToOwner: true,
      recipeAllowsUnassigned: false,
      reason: "pr_author",
    },
    recipeId: "pr-reviews",
    intent: { autoKind: "pr-review" },
  }, value, { kind: automationAuthorization.PRIMITIVE_KIND });
  assert.ok(value.automationAuthorization, "fixture must carry typed primitive authority");
  return value;
}

function readOnlyReviewRequest(taskId) {
  var value = request(1, "project_coordinator", taskId + "-r1");
  value.portfolioTaskId = taskId;
  value.controlRole = "triage";
  value.reviewOnly = true;
  return value;
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

test("an atomic binding rewrite preserves explicit false completion delivery flags", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-false-flags-"));
  var file = path.join(dir, "bindings.json");
  fs.writeFileSync(file, JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 2,
    bindings: [{
      portfolioTaskId: "completed-task",
      mode: "direct_leaf",
      targetProject: { projectId: PROJECT_ID },
      bindingRevision: 1,
      idempotencyKey: "completed-task-r1",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
      worker: { projectId: PROJECT_ID, sessionStorageId: "completed-worker" },
      completedAt: 2,
      completionEventId: "direct-terminal-v2-completed-task",
      resultEventId: "direct-result-completed-task",
      completionOwnerNotification: false,
      completionOwnerDelivered: false,
    }],
  }, null, 2) + "\n");
  var store = createBindings({ file: file, now: function () { return 3; },
    reconcileOnLoad: false });

  assert.equal(store.reserve({
    portfolioTaskId: "new-task",
    mode: "direct_leaf",
    targetProject: { projectId: PROJECT_ID },
    bindingRevision: 1,
    idempotencyKey: "new-task-r1",
  }).ok, true);

  var rewritten = JSON.parse(fs.readFileSync(file, "utf8"));
  var completed = rewritten.bindings.filter(function (binding) {
    return binding.portfolioTaskId === "completed-task";
  })[0];
  assert.equal(completed.completionOwnerNotification, false);
  assert.equal(completed.completionOwnerDelivered, false);
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

test("auto-launched PR review completion is terminal without owner acceptance", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-auto-pr-completion-"));
  var store = createBindings({ file: path.join(dir, "bindings.json"), now: function () { return 300; } });
  var input = autoLaunchReviewRequest(1);
  assert.equal(store.reserve(input).ok, true);
  assert.equal(store.commit(input.portfolioTaskId, input.bindingRevision, {
    projectId: PROJECT_ID,
    sessionStorageId: "auto-pr-session",
  }).ok, true);

  var completed = store.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "auto-pr-completed",
    completedAt: 325,
    terminalStatus: "completed",
    executionMode: "project_coordinator",
    ownerAcceptanceRequired: true,
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.binding.status, "completed");
  assert.equal(completed.binding.ownerAcceptanceRequired, undefined,
    "project-local Done rules cannot add a second owner gate to a typed PR primitive");
  assert.equal(completed.binding.ownerAcceptance, undefined);
  var session = { orchestrationPolicy: { portfolioExecution: {
    portfolioTaskId: input.portfolioTaskId,
    bindingRevision: input.bindingRevision,
    status: "running",
  } } };
  var lifecycle = sessionLifecycle.lifecycleState(session, completed.binding, null,
    "task_coordinator", [], [session]);
  assert.equal(lifecycle, "completed");
  assert.deepEqual(sessionLifecycle.terminalOutcome(lifecycle, "task_coordinator", {
    binding: completed.binding,
    execution: session.orchestrationPolicy.portfolioExecution,
  }), { status: "completed", at: 325, summary: "" });
  assert.equal(store.requireOwnerAcceptance(input.portfolioTaskId, input.bindingRevision, {
    correctionEventId: "not-applicable-to-pr-primitive",
    completionEventId: "auto-pr-completed",
  }).reason, "owner_acceptance_not_applicable",
  "a later repair must not reintroduce the gate on the exempt workflow");
});

test("explicit owner acceptance remains sticky for unrelated project work", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-owner-gated-completion-"));
  var store = createBindings({ file: path.join(dir, "bindings.json"), now: function () { return 400; } });
  var input = request(1, "project_coordinator", "owner-gated-command");
  assert.equal(store.reserve(input).ok, true);
  assert.equal(store.commit(input.portfolioTaskId, input.bindingRevision, {
    projectId: PROJECT_ID,
    sessionStorageId: "owner-gated-session",
  }).ok, true);

  var completed = store.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "owner-gated-completed",
    completedAt: 425,
    terminalStatus: "completed",
    executionMode: "project_coordinator",
    ownerAcceptanceRequired: true,
  });

  assert.equal(completed.binding.ownerAcceptanceRequired, true);
  assert.equal(completed.binding.ownerAcceptance.status, "pending");
  assert.equal(sessionLifecycle.lifecycleState(null, completed.binding, null,
    "task_coordinator", [], []), "needs_input");
  assert.equal(sessionLifecycle.terminalOutcome("needs_input", "task_coordinator", {
    binding: completed.binding,
    execution: {},
  }), null);
});

test("a coordinator-verified read-only review clears only its local pending owner gate", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-read-only-review-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 450; } });
  var input = readOnlyReviewRequest("triage-read-only-review");
  assert.equal(store.reserve(input).ok, true);
  assert.equal(store.commit(input.portfolioTaskId, input.bindingRevision, {
    projectId: PROJECT_ID,
    sessionStorageId: "triage-review-session",
  }).ok, true);

  var attention = store.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "triage-review-attention",
    terminalStatus: "needs_input",
    executionMode: "project_coordinator",
    ownerNotification: true,
    controlRole: "triage",
    reviewOnly: true,
    ownerAcceptanceRequired: true,
    ownerAcceptance: { status: "pending", source: "project_local_instructions" },
  });
  assert.equal(attention.ok, true);
  assert.equal(attention.binding.status, "needs_input");

  var wrongRole = store.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "triage-review-wrong-role",
    terminalStatus: "completed",
    executionMode: "project_coordinator",
    ownerNotification: false,
    controlRole: "council",
    reviewOnly: true,
  });
  assert.equal(wrongRole.reason, "completion_conflict");
  assert.equal(store.get(input.portfolioTaskId, input.bindingRevision).status, "needs_input");

  var completed = store.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "triage-review-completed",
    terminalStatus: "completed",
    executionMode: "project_coordinator",
    ownerNotification: false,
    controlRole: "triage",
    reviewOnly: true,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.binding.status, "completed");
  assert.equal(completed.binding.ownerAcceptanceRequired, undefined);
  assert.equal(completed.binding.ownerAcceptance, undefined);
  assert.equal(completed.binding.ownerAcceptanceEvents, undefined);
  assert.equal(completed.binding.ownerAcceptanceDecisionEventId, undefined);
  assert.deepEqual(completed.binding.targetProject, { projectId: PROJECT_ID });
  assert.equal(completed.binding.bindingRevision, input.bindingRevision);
  assert.deepEqual(store.listCurrent(), []);

  var persisted = fs.readFileSync(file, "utf8");
  var replay = store.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "triage-review-completed",
    terminalStatus: "completed",
    executionMode: "project_coordinator",
    ownerNotification: false,
    controlRole: "triage",
    reviewOnly: true,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(fs.readFileSync(file, "utf8"), persisted,
    "the exact terminal review correction is idempotent");
});

test("a read-only review with an owner decision cannot use the delivery correction", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-reviewed-owner-decision-"));
  var store = createBindings({ file: path.join(dir, "bindings.json"), now: function () { return 475; } });
  var input = readOnlyReviewRequest("triage-owner-decision");
  assert.equal(store.reserve(input).ok, true);
  assert.equal(store.commit(input.portfolioTaskId, input.bindingRevision, {
    projectId: PROJECT_ID,
    sessionStorageId: "triage-owner-decision-session",
  }).ok, true);
  assert.equal(store.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "triage-owner-decision-attention",
    terminalStatus: "needs_input",
    executionMode: "project_coordinator",
    ownerNotification: true,
    controlRole: "triage",
    reviewOnly: true,
    ownerAcceptanceRequired: true,
    ownerAcceptance: { status: "pending", source: "project_local_instructions" },
  }).ok, true);
  assert.equal(store.recordOwnerVerdict(input.portfolioTaskId, input.bindingRevision, {
    decisionEventId: "owner-review-decision",
    status: "pending",
  }).ok, true);

  var refused = store.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "triage-owner-decision-completed",
    terminalStatus: "completed",
    executionMode: "project_coordinator",
    ownerNotification: false,
    controlRole: "triage",
    reviewOnly: true,
  });
  assert.equal(refused.reason, "completion_conflict");
  var binding = store.get(input.portfolioTaskId, input.bindingRevision);
  assert.equal(binding.status, "needs_input");
  assert.equal(binding.ownerAcceptanceDecisionEventId, "owner-review-decision");
  assert.equal(binding.ownerAcceptance.status, "pending");
});

test("same-event replay removes a stale owner gate from a completed PR primitive", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-auto-pr-replay-"));
  var file = path.join(dir, "bindings.json");
  var input = autoLaunchReviewRequest(1);
  var first = createBindings({ file: file, now: function () { return 500; } });
  assert.equal(first.reserve(input).ok, true);
  assert.equal(first.commit(input.portfolioTaskId, input.bindingRevision, {
    projectId: PROJECT_ID,
    sessionStorageId: "auto-pr-replay-session",
  }).ok, true);
  assert.equal(first.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "auto-pr-replay-completed",
    completedAt: 525,
    terminalStatus: "completed",
    executionMode: "project_coordinator",
  }).ok, true);
  var persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.bindings[0].ownerAcceptanceRequired = true;
  persisted.bindings[0].ownerAcceptance = {
    status: "pending",
    source: "project_local_instructions",
  };
  fs.writeFileSync(file, JSON.stringify(persisted, null, 2) + "\n");

  var restarted = createBindings({ file: file, now: function () { return 550; },
    reconcileOnLoad: false });
  var replay = restarted.complete(input.portfolioTaskId, input.bindingRevision, {
    eventId: "auto-pr-replay-completed",
    completedAt: 525,
    terminalStatus: "completed",
    executionMode: "project_coordinator",
  });

  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.binding.ownerAcceptanceRequired, undefined);
  assert.equal(replay.binding.ownerAcceptance, undefined);
  assert.equal(createBindings({ file: file, reconcileOnLoad: false })
    .get(input.portfolioTaskId, input.bindingRevision).ownerAcceptanceRequired, undefined,
  "the correction must be durable across another restart");
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

test("legacy auto and project aliases preserve a verified completion over later unrouted retries", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-legacy-alias-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 100; } });

  function binding(taskId, revision, extra) {
    return Object.assign({
      portfolioTaskId: taskId,
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT_ID },
      bindingRevision: revision,
      idempotencyKey: taskId + "-r" + revision,
    }, extra || {});
  }

  var completed = store.reserve(binding("auto:recipe:trialview-v2-2677", 2, {
    candidateKey: "auto:recipe:trialview-v2-2677",
  }));
  assert.equal(completed.binding.workIdentity, "github:trialview/v2#2677");
  assert.equal(store.commit(completed.binding.portfolioTaskId, 2, {
    projectId: PROJECT_ID, sessionStorageId: "verified-2677",
  }).ok, true);
  assert.equal(store.complete(completed.binding.portfolioTaskId, 2, {
    eventId: "verified-2677", terminalStatus: "completed",
    ownerAcceptanceRequired: true, ownerAcceptance: { status: "pending" },
    implementationCompletedAt: 101,
  }).ok, true);
  var rediscovered = store.reserve(binding("portfolio-webapp-2677", 3));
  assert.equal(rediscovered.reason, "duplicate_work_identity");
  assert.equal(rediscovered.binding.portfolioTaskId, "auto:recipe:trialview-v2-2677");

  var historicalFile = path.join(dir, "historical-bindings.json");
  fs.writeFileSync(historicalFile, JSON.stringify({
    schema: "clay.portfolio_execution_bindings", version: 2, bindings: [{
      portfolioTaskId: "portfolio-webapp-2725", mode: "project_coordinator",
      targetProject: { projectId: PROJECT_ID }, bindingRevision: 1,
      idempotencyKey: "portfolio-webapp-2725-r1", status: "superseded",
      createdAt: 1, updatedAt: 102, completedAt: 102,
      ownerAcceptanceRequired: true, ownerAcceptance: { status: "pending" },
      implementationCompletedAt: 102,
    }, {
      portfolioTaskId: "portfolio-webapp-2725", mode: "project_coordinator",
      targetProject: { projectId: PROJECT_ID }, bindingRevision: 2,
      idempotencyKey: "portfolio-webapp-2725-r2", status: "unrouted",
      createdAt: 103, updatedAt: 104, unroutedAt: 104,
    }],
  }, null, 2));
  var historical = createBindings({ file: historicalFile, now: function () { return 105; } });
  assert.equal(historical.get("portfolio-webapp-2725", 1).workIdentity, "github:trialview/v2#2725");
  var retry = historical.reserve(binding("portfolio-webapp-2725", 2));
  assert.equal(retry.reason, "duplicate_work_identity",
    "an unrouted successor cannot supersede verified owner-acceptance work");
  assert.equal(retry.binding.bindingRevision, 1);
});

// The whole acceptance lifecycle, driven only through the store's own API and
// re-read from disk at every step. Rejection previously had NO binding-level
// path at all: complete() refuses one as a completion_conflict, and
// normalizeOwnerAcceptance kept only "accepted" and "pending", so a rejection
// was dropped on the next whole-file save and the work reverted to reading as
// never-decided.
test("verified -> pending -> rejected -> pending -> accepted, with a durable audit trail",
  function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-reject-"));
    var file = path.join(dir, "bindings.json");
    var clock = 1000;
    var store = createBindings({ file: file, now: function () { return clock++; } });

    function reload() {
      return readBindings({ file: file }).bindings.filter(function (entry) {
        return entry.portfolioTaskId === "portfolio-task" && entry.bindingRevision === 1;
      })[0];
    }
    function trail() {
      return (reload().ownerAcceptanceEvents || []).map(function (event) {
        return event.type;
      });
    }

    assert.equal(store.reserve(request(1, "project_coordinator")).ok, true);
    assert.equal(store.commit("portfolio-task", 1, {
      projectId: PROJECT_ID, sessionStorageId: "worker-1",
    }).ok, true);

    // 1. Implementation verified. Acceptance is required, so the binding parks
    //    at needs_input rather than reporting itself done.
    assert.equal(store.complete("portfolio-task", 1, {
      eventId: "impl-1", terminalStatus: "needs_input", ownerAcceptanceRequired: true,
      implementationCompletedAt: 1500, implementationCompletionRevision: 1,
      ownerAcceptanceEvents: [{
        schema: "clay.owner_acceptance_event", version: 1,
        type: "owner_acceptance_pending", at: 1500,
      }],
    }).ok, true);
    assert.equal(reload().status, "needs_input");
    assert.equal(reload().ownerAcceptance.status, "pending");

    // 2. The owner rejects. The binding must NOT terminalize -- rework is owed.
    assert.equal(store.recordOwnerVerdict("portfolio-task", 1, {
      status: "rejected", at: 1600, by: "owner-1", note: "The rollup is still wrong.",
      decisionEventId: "decision-1",
    }).ok, true);
    var rejected = reload();
    assert.equal(rejected.ownerAcceptance.status, "rejected",
      "the rejection must not be downgraded to never-decided on persist");
    assert.equal(rejected.ownerAcceptance.note, "The rollup is still wrong.");
    assert.equal(rejected.status, "needs_input", "rejecting is not un-completing");
    var rows = require("../lib/coop-owner-work-rows");
    assert.equal(rows.isAwaitingOwnerAcceptance(rejected), false,
      "a decided rejection must stop reading as awaiting the owner");

    // 3. The same owner click replayed must not append a second event.
    var replay = store.recordOwnerVerdict("portfolio-task", 1, {
      status: "rejected", at: 1650, decisionEventId: "decision-1",
    });
    assert.equal(replay.duplicate, true);
    assert.deepEqual(trail(), ["owner_acceptance_pending", "owner_acceptance_rejected"]);

    // 4. Coordinator reworks; the item goes back to awaiting the owner.
    assert.equal(store.recordOwnerVerdict("portfolio-task", 1, {
      status: "pending", at: 1700, decisionEventId: "decision-2",
    }).ok, true);
    assert.equal(rows.isAwaitingOwnerAcceptance(Object.assign(reload(), {
      status: "completed",
    })), true, "reworked work awaits the owner again");

    // 5. The owner accepts, which is the only thing that terminalizes it.
    assert.equal(store.complete("portfolio-task", 1, {
      eventId: "impl-2", terminalStatus: "completed", ownerAcceptanceRequired: true,
      implementationCompletedAt: 1500, implementationCompletionRevision: 1,
      ownerAcceptance: { status: "accepted", at: 1800, by: "owner-1", withdrawnAt: null },
      ownerAcceptanceEvents: [{
        schema: "clay.owner_acceptance_event", version: 1,
        type: "owner_acceptance_accepted", at: 1800,
      }],
    }).ok, true);
    assert.equal(reload().status, "completed");
    assert.equal(reload().ownerAcceptance.status, "accepted");

    // The earlier rejection must still be visible. ownerAcceptance alone is
    // last-write-wins and would claim the owner had only ever accepted.
    assert.deepEqual(trail(), [
      "owner_acceptance_pending", "owner_acceptance_rejected",
      "owner_acceptance_pending", "owner_acceptance_accepted",
    ]);
  });

test("an owner verdict is refused unless the binding is genuinely awaiting one", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-verdict-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 500; } });
  assert.equal(store.reserve(request(1, "project_coordinator")).ok, true);
  assert.equal(store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID, sessionStorageId: "worker-1",
  }).ok, true);

  // Still active: nothing has been verified, so there is nothing to reject.
  assert.equal(store.recordOwnerVerdict("portfolio-task", 1, {
    status: "rejected", at: 501, decisionEventId: "d-1",
  }).reason, "owner_verdict_mismatch");

  assert.equal(store.complete("portfolio-task", 1, {
    eventId: "impl-1", terminalStatus: "needs_input", ownerAcceptanceRequired: true,
  }).ok, true);
  // A verdict the module does not model must not be coerced into one it does.
  assert.equal(store.recordOwnerVerdict("portfolio-task", 1, {
    status: "accepted", at: 502, decisionEventId: "d-2",
  }).reason, "owner_verdict_mismatch",
  "accepting terminalizes and must go through complete(), not this path");
  assert.equal(store.recordOwnerVerdict("portfolio-task", 1, {
    status: "rejected", at: 503,
  }).reason, "owner_verdict_mismatch", "an unidentified decision is refused");
});

test("a malformed or unbounded acceptance event list cannot reach the store", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-events-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 600; } });
  assert.equal(store.reserve(request(1, "project_coordinator")).ok, true);
  assert.equal(store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID, sessionStorageId: "worker-1",
  }).ok, true);

  var oversized = [];
  for (var i = 0; i < 120; i++) {
    oversized.push({
      schema: "clay.owner_acceptance_event", version: 1,
      type: "owner_acceptance_pending", at: 100 + i,
    });
  }
  // Interleaved junk the normalizer must discard rather than persist.
  oversized.push({ schema: "clay.owner_acceptance_event", version: 1, type: "nonsense", at: 1 });
  oversized.push({ schema: "wrong.schema", version: 1, type: "owner_acceptance_accepted", at: 1 });

  assert.equal(store.complete("portfolio-task", 1, {
    eventId: "done-1", terminalStatus: "completed",
    ownerAcceptanceRequired: true, ownerAcceptance: { status: "pending" },
    ownerAcceptanceEvents: oversized,
  }).ok, true);

  var reloaded = readBindings({ file: file }).bindings.filter(function (entry) {
    return entry.portfolioTaskId === "portfolio-task" && entry.bindingRevision === 1;
  })[0];
  assert.equal(reloaded.ownerAcceptanceEvents.length, 50, "the list must stay bounded");
  reloaded.ownerAcceptanceEvents.forEach(function (event) {
    assert.equal(event.schema, "clay.owner_acceptance_event");
    assert.equal(event.type, "owner_acceptance_pending");
  });
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

test("an ordinary coordinator owner question remains resumable needs-input work", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-needs-input-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 10; } });

  store.reserve(request(1, "project_coordinator"));
  store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID, sessionStorageId: "ordinary-needs-input",
  });
  var waiting = store.complete("portfolio-task", 1, {
    eventId: "owner-question-1",
    executionMode: "project_coordinator",
    terminalStatus: "needs_input",
    ownerNotification: true,
  });

  assert.equal(waiting.ok, true);
  assert.equal(waiting.binding.status, "needs_input");
  assert.equal(waiting.binding.completionOwnerNotification, true);
  assert.equal(waiting.binding.failureCode, "unspecified");
  assert.equal(store.get("portfolio-task", 1).status, "needs_input",
    "the owner reply must still be able to address the waiting binding");
  assert.equal(store.markProjectCoordinatorAvailable("portfolio-task", 1, {
    projectId: PROJECT_ID, sessionStorageId: "wrong-coordinator",
  }).reason, "invalid_project_coordinator_reactivation");
  var resumed = store.markProjectCoordinatorAvailable("portfolio-task", 1, {
    projectId: PROJECT_ID, sessionStorageId: "ordinary-needs-input",
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.binding.status, "active");
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

test("hidden superseded review execution releases its needs-input binding", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-review-supersession-"));
  var file = path.join(dir, "bindings.json");
  var clock = 100;
  var store = createBindings({ file: file, now: function () { return clock++; } });
  var coordinator = { projectId: PROJECT_ID, sessionStorageId: "review-coordinator" };
  var root = { projectId: "system-lead", sessionStorageId: "coop-root" };
  var reservation = Object.assign(request(1, "project_coordinator"), { reviewOnly: true });
  assert.equal(store.reserve(reservation).ok, true);
  assert.equal(store.commit("portfolio-task", 1, coordinator, {
    projectCoordinatorRef: root,
  }).ok, true);
  assert.equal(store.complete("portfolio-task", 1, {
    eventId: "review-needs-input",
    executionMode: "project_coordinator",
    terminalStatus: "needs_input",
    reviewOnly: true,
    completedAt: 200,
  }).binding.status, "needs_input");

  var session = {
    hidden: true,
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "portfolio-task",
      bindingRevision: 1,
      idempotencyKey: "command-1",
      mode: "project_coordinator",
      status: "superseded",
      terminalAt: 300,
      reason: "Obsolete duplicate execution",
    } },
  };
  var reconciled = store.reconcileStrandedCompletions({
    sessionForBinding: function () { return session; },
    saveSession: function () {},
  });

  assert.equal(reconciled.reconciled.length, 1);
  assert.equal(reconciled.reconciled[0].status, "superseded");
  assert.equal(reconciled.reconciled[0].statusReason, "Obsolete duplicate execution");
  assert.equal(store.listCurrent().length, 0);
  assert.equal(store.reconcileStrandedCompletions({
    sessionForBinding: function () { return session; },
    saveSession: function () {},
  }).reconciled.length, 0, "reconciliation must be idempotent");
});

test("visible superseded review execution does not release its needs-input binding", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-review-visible-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 100; } });
  var reservation = Object.assign(request(1, "project_coordinator"), { reviewOnly: true });
  store.reserve(reservation);
  store.commit("portfolio-task", 1,
    { projectId: PROJECT_ID, sessionStorageId: "visible-review" }, {
      projectCoordinatorRef: { projectId: "system-lead", sessionStorageId: "coop-root" },
    });
  store.complete("portfolio-task", 1, {
    eventId: "visible-review-needs-input",
    executionMode: "project_coordinator",
    terminalStatus: "needs_input",
    reviewOnly: true,
  });

  var reconciled = store.reconcileStrandedCompletions({
    sessionForBinding: function () { return { hidden: false, orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "portfolio-task", bindingRevision: 1,
        idempotencyKey: "command-1",
        mode: "project_coordinator", status: "superseded", terminalAt: 300,
      },
    } }; },
    saveSession: function () {},
  });

  assert.equal(reconciled.reconciled.length, 0);
  assert.equal(store.get("portfolio-task", 1).status, "needs_input");
});
