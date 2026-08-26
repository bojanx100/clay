var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var attachCoopSessionLedger =
  require("../lib/coop-session-ledger").attachCoopSessionLedger;
var topicLinksFromIndex = require("../lib/coop-session-ledger").topicLinksFromIndex;
var coopTopicState = require("../lib/coop-topic-state").coopTopicState;

var CLAY_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP_ID = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

function execution(taskId, mode, status, extra) {
  return Object.assign({
    portfolioTaskId: taskId,
    bindingRevision: 1,
    idempotencyKey: taskId + "-r1",
    mode: mode,
    status: status,
    source: { projectId: "system-lead", sessionStorageId: "coop-home" },
    createdAt: 100,
    updatedAt: 200,
  }, extra || {});
}

function binding(taskId, projectId, storageId, mode, status, topicId) {
  var record = {
    portfolioTaskId: taskId,
    bindingRevision: 1,
    idempotencyKey: taskId + "-r1",
    mode: mode,
    status: status,
    targetProject: { projectId: projectId },
    source: { projectId: "system-lead", sessionStorageId: "coop-home" },
    createdAt: 100,
    updatedAt: 200,
  };
  record[mode === "project_coordinator" ? "coordinator" : "worker"] = {
    projectId: projectId,
    sessionStorageId: storageId,
  };
  if (topicId) record.coopTopicRef = { topicId: topicId };
  return record;
}

function project(projectId, sessions) {
  return { projectRef: { projectId: projectId }, sessions: sessions };
}

test("the Coop session ledger reconciles bindings and live session truth idempotently", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-session-ledger-"));
  var file = path.join(dir, "ledger.json");
  var hiddenCoordinator = {
    storageId: "hidden-coordinator",
    title: "Hidden completed coordinator",
    hidden: true,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    createdAt: 110,
    lastActivity: 900,
    closedAt: 850,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationPolicy: { portfolioExecution: execution(
      "hidden-project", "project_coordinator", "completed", { completedAt: 800 }
    ) },
    orchestrationProjectCompletion: {
      status: "completed",
      completedAt: 800,
      summary: "Hidden coordinator integrated its result.",
      verification: "focused suite passed",
      escalationRequired: "no",
    },
    orchestrationTasks: [],
  };
  var needsInputLeaf = {
    storageId: "needs-input-leaf",
    title: "Direct leaf needs input",
    vendor: "claude",
    createdAt: 120,
    lastActivity: 700,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 120 },
    orchestrationPolicy: { portfolioExecution: execution(
      "direct-needs-input", "direct_leaf", "needs_input", {
        updatedAt: 700,
        statusReason: "Owner must choose a migration target.",
      }
    ) },
  };
  var activeCoordinator = {
    storageId: "active-coordinator",
    title: "Active project coordinator",
    vendor: "codex",
    createdAt: 130,
    lastActivity: 650,
    coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 130 },
    orchestrationPolicy: { portfolioExecution: execution(
      "active-project", "project_coordinator", "running", { updatedAt: 650 }
    ) },
    orchestrationTasks: [{
      taskId: "child-task",
      workerStorageId: "child-worker",
      status: "running",
      title: "Verify the implementation",
      currentActivity: "Running focused tests",
      coopTopicRef: { topicId: "topic-active" },
      createdAt: 140,
      updatedAt: 640,
    }],
  };
  var compactedCoordinator = {
    storageId: "compacted-coordinator",
    title: "Compacted coordinator",
    coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 141 },
    orchestrationPolicy: { portfolioExecution: execution(
      "compacted-project", "project_coordinator", "running", {
        bindingRevision: 3, idempotencyKey: "compacted-project-r3", updatedAt: 660,
      }
    ) },
  };
  var childWorker = {
    storageId: "child-worker",
    title: "Visible child worker",
    vendor: "codex",
    createdAt: 140,
    lastActivity: 640,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 140 },
    orchestrationParent: {
      taskId: "child-task",
      sessionStorageId: "active-coordinator",
    },
  };
  var completedLeaf = {
    storageId: "completed-visible-leaf",
    title: "Completed visible direct leaf",
    vendor: "codex",
    createdAt: 150,
    lastActivity: 600,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 150 },
    orchestrationPolicy: { portfolioExecution: execution(
      "completed-visible", "direct_leaf", "running", { completedAt: 600 }
    ) },
  };
  var ownerDirect = {
    storageId: "owner-direct",
    title: "Owner direct session Coop reviewed",
    vendor: "claude",
    createdAt: 160,
    lastActivity: 500,
    orchestrationAdoption: {
      status: "context_only",
      coordinatorStorageId: "active-coordinator",
      decidedAt: 500,
    },
  };
  var ownerDirectChild = {
    storageId: "owner-direct-child",
    title: "Owner-created child session",
    vendor: "claude",
    createdAt: 170,
    lastActivity: 510,
    orchestrationParent: {
      taskId: "owner-created-task",
      sessionStorageId: "owner-direct",
    },
  };
  var bindings = [
    binding("hidden-project", CLAY_ID, "hidden-coordinator",
      "project_coordinator", "active", "topic-hidden-completed"),
    binding("direct-needs-input", WEBAPP_ID, "needs-input-leaf",
      "direct_leaf", "active", "topic-needs-input"),
    binding("active-project", CLAY_ID, "active-coordinator",
      "project_coordinator", "active", "topic-active"),
    binding("completed-visible", WEBAPP_ID, "completed-visible-leaf",
      "direct_leaf", "completed", "topic-visible-completed"),
    binding("historical-missing", CLAY_ID, "missing-historical-session",
      "project_coordinator", "completed", "topic-historical"),
  ];
  var previousBinding = binding("previous-project", CLAY_ID, "active-coordinator",
    "project_coordinator", "completed", "topic-previous");
  previousBinding.updatedAt = 150;
  previousBinding.completedAt = 150;
  bindings.push(previousBinding);
  var ledger = attachCoopSessionLedger({ file: file, now: function () { return 1000; } });
  var input = {
    bindings: bindings,
    projects: [
      project(CLAY_ID, [hiddenCoordinator, activeCoordinator, compactedCoordinator, childWorker,
        ownerDirect, ownerDirectChild]),
      project(WEBAPP_ID, [needsInputLeaf, completedLeaf]),
    ],
    topicLinks: [{
      topicRef: { topicId: "topic-owner-direct" },
      sessionRef: { projectId: CLAY_ID, sessionStorageId: "owner-direct" },
    }],
  };

  var first = ledger.reconcile(input);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  var firstText = fs.readFileSync(file, "utf8");
  var second = ledger.reconcile(input);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(file, "utf8"), firstText);

  var all = ledger.list({
    projectRefs: [{ projectId: CLAY_ID }, { projectId: WEBAPP_ID }],
    includeHidden: true,
    includeMissing: true,
    topLevelOnly: false,
  });
  assert.equal(all.length, 9);

  var hidden = ledger.get({ projectId: CLAY_ID, sessionStorageId: "hidden-coordinator" });
  assert.equal(hidden.lifecycleState, "completed");
  assert.equal(hidden.workState, "done");
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.closedAt, 850);
  assert.equal(hidden.terminalOutcome.summary, "Hidden coordinator integrated its result.");
  assert.deepEqual(hidden.provider, {
    vendor: "codex", routeId: "codex-openai", model: "gpt-5.6-sol",
  });

  var leaf = ledger.get({ projectId: WEBAPP_ID, sessionStorageId: "needs-input-leaf" });
  assert.equal(leaf.role, "direct_leaf");
  assert.equal(leaf.lifecycleState, "needs_input");
  assert.equal(leaf.workState, "needs_input");
  assert.equal(leaf.terminalOutcome.status, "needs_input");
  assert.equal(leaf.lastCoopAction.report, "Owner must choose a migration target.");

  var worker = ledger.get({ projectId: CLAY_ID, sessionStorageId: "child-worker" });
  assert.equal(worker.role, "worker");
  assert.equal(worker.topLevel, false);
  assert.deepEqual(worker.parentSessionRef, {
    projectId: CLAY_ID, sessionStorageId: "active-coordinator",
  });
  assert.equal(worker.parentTaskId, "child-task");
  assert.equal(worker.lifecycleState, "running");
  assert.deepEqual(worker.coopTopicRef, { topicId: "topic-active" });
  assert.equal(worker.parentPortfolioBinding.portfolioTaskId, "active-project");
  assert.equal(worker.parentPortfolioBinding.mode, "project_coordinator");
  assert.deepEqual(worker.parentPortfolioBinding.coopTopicRef, { topicId: "topic-active" });

  var compacted = ledger.get({
    projectId: CLAY_ID, sessionStorageId: "compacted-coordinator",
  });
  assert.equal(compacted.portfolioBinding.portfolioTaskId, "compacted-project");
  assert.equal(compacted.portfolioBinding.bindingRevision, 3);
  assert.equal(compacted.portfolioBinding.status, "running",
    "a compacted continuation retains its transferred typed portfolio execution");

  var missing = ledger.get({ projectId: CLAY_ID, sessionStorageId: "missing-historical-session" });
  assert.equal(missing.sessionPresent, false);
  assert.equal(missing.lifecycleState, "completed");
  assert.equal(missing.terminalOutcome.status, "completed");

  var direct = ledger.get({ projectId: CLAY_ID, sessionStorageId: "owner-direct" });
  assert.equal(direct.coopCreated, false);
  assert.equal(direct.coopTouched, true);
  assert.equal(direct.topLevel, true);
  assert.deepEqual(direct.coopTopicRef, { topicId: "topic-owner-direct" });
  var directChild = ledger.get({
    projectId: CLAY_ID, sessionStorageId: "owner-direct-child",
  });
  assert.equal(directChild.coopCreated, false);
  assert.equal(directChild.coopTouched, true);
  assert.equal(directChild.role, "worker");

  var visibleTopLevel = ledger.list({
    projectRefs: [{ projectId: WEBAPP_ID }, { projectId: CLAY_ID }],
  });
  assert.deepEqual(visibleTopLevel.map(function (entry) {
    return entry.projectRef.projectId + ":" + entry.sessionStorageId + ":" + entry.lifecycleState;
  }), [
    CLAY_ID + ":active-coordinator:running",
    CLAY_ID + ":compacted-coordinator:running",
    CLAY_ID + ":owner-direct:idle",
    WEBAPP_ID + ":completed-visible-leaf:completed",
    WEBAPP_ID + ":needs-input-leaf:needs_input",
  ]);

  assert.equal(ledger.topicEvidence({ topicId: "topic-hidden-completed" })[0].workState,
    "done", "hidden completed sessions remain terminal topic evidence, never active work");
  assert.equal(ledger.topicEvidence({ topicId: "topic-needs-input" })[0].workState,
    "needs_input");
  var previousEvidence = ledger.topicEvidence({ topicId: "topic-previous" });
  assert.equal(previousEvidence[0].workState, "done",
    "a later turn in the same coordinator cannot make an older completed topic Working");
  assert.deepEqual(previousEvidence[0].coopTopicRef, { topicId: "topic-previous" },
    "topic evidence always carries the exact queried TopicRef, not another session link");
  assert.equal(coopTopicState({ topicId: "topic-previous" }, {
    bindings: previousEvidence.map(function (entry) {
      return { coopTopicRef: entry.coopTopicRef, status: "completed" };
    }),
  }).state, "done", "the exact historical topic projects Done through the shared state rule");
  assert.equal(ledger.topicEvidence({ topicId: "topic-active" })[0].workState, "working");
  var hiddenTopicBindings = ledger.topicEvidence({
    topicId: "topic-hidden-completed",
  }).map(function (entry) {
    return { coopTopicRef: entry.coopTopicRef, status: "completed" };
  });
  assert.equal(coopTopicState({ topicId: "topic-hidden-completed" }, {
    bindings: hiddenTopicBindings,
  }).state, "done", "a hidden completed execution projects Done rather than Working");
  assert.deepEqual(ledger.cleanupCandidates({ topicId: "topic-owner-direct" }), [],
    "topic cleanup never targets an owner-direct session Coop merely touched");
  assert.deepEqual(ledger.cleanupCandidates({ topicId: "topic-visible-completed" }).map(function (entry) {
    return entry.sessionStorageId;
  }), ["completed-visible-leaf"]);
});

test("topic index links retain exact top-level and descendant SessionRefs", function () {
  var links = topicLinksFromIndex({
    topics: {
      "topic-a": {
        topicRef: { topicId: "topic-a" },
        relatedExecutions: [{
          sessionRef: { projectId: CLAY_ID, sessionStorageId: "coordinator" },
          children: [{
            sessionRef: { projectId: CLAY_ID, sessionStorageId: "worker" },
          }],
        }],
      },
    },
  });

  assert.deepEqual(links, [{
    topicRef: { topicId: "topic-a" },
    sessionRef: { projectId: CLAY_ID, sessionStorageId: "coordinator" },
  }, {
    topicRef: { topicId: "topic-a" },
    sessionRef: { projectId: CLAY_ID, sessionStorageId: "worker" },
  }]);
});

test("project-coordinator needs-input execution outranks retained active tasks", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-needs-input-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var coordinator = {
    storageId: "needs-input-coordinator",
    title: "Coordinator awaiting verification",
    coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationPolicy: { portfolioExecution: execution(
      "needs-input-project", "project_coordinator", "needs_input", {
        reason: "verification_route_unavailable",
      }
    ) },
    orchestrationTasks: [{
      taskId: "retained-active-task",
      status: "running",
      updatedAt: 190,
    }],
  };
  ledger.reconcile({
    bindings: [binding("needs-input-project", CLAY_ID, coordinator.storageId,
      "project_coordinator", "active")],
    projects: [project(CLAY_ID, [coordinator])],
  });

  var projected = ledger.get({
    projectId: CLAY_ID,
    sessionStorageId: coordinator.storageId,
  });
  assert.equal(projected.portfolioBinding.status, "active");
  assert.equal(projected.lifecycleState, "needs_input");
  assert.equal(projected.workState, "needs_input");
  assert.equal(projected.hidden, false);
  assert.equal(projected.terminalOutcome, null);
});

test("terminal child bindings outrank stale task-coordinator runtime state", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-terminal-child-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var taskId = "orphan-coordinator-lifecycle";
  var rootId = "585c5ab9-8526-498a-8a88-7fc105a290ac";
  var revisions = [{
    revision: 3,
    storageId: "70ee959b-9b4c-4ae6-a65e-1982195d0e6e",
    status: "failed",
  }, {
    revision: 5,
    storageId: "30086b0e-6440-4b07-ad62-53a6ca9b3ac8",
    status: "failed",
  }, {
    revision: 6,
    storageId: "completed-r6",
    status: "completed",
  }];
  var root = {
    storageId: rootId,
    title: "Project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationTasks: [],
  };
  var sessions = [root];
  var bindings = [];
  for (var i = 0; i < revisions.length; i++) {
    var item = revisions[i];
    var taskKey = "task-r" + item.revision;
    root.orchestrationTasks.push({
      taskId: taskKey,
      clientRef: "portfolio:" + taskId + ":" + item.revision,
      externalTaskCoordinator: true,
      workerStorageId: item.storageId,
      status: item.revision === 6 ? "completed" : "running",
      currentActivity: item.revision === 6 ? "Task coordinator completed" :
        "Task coordinator is running",
      updatedAt: 100 + item.revision,
    });
    sessions.push({
      storageId: item.storageId,
      title: "Task coordinator r" + item.revision,
      hidden: item.revision === 6,
      coordinationMode: true,
      coordinationRole: "task_coordinator",
      orchestrationParent: { taskId: taskKey, sessionStorageId: rootId },
      orchestrationPolicy: { portfolioExecution: execution(
        taskId, "project_coordinator", item.revision === 6 ? "completed" : "running", {
          bindingRevision: item.revision,
          idempotencyKey: taskId + "-r" + item.revision,
          updatedAt: 200 + item.revision,
        }
      ) },
    });
    var record = binding(taskId, CLAY_ID, item.storageId, "project_coordinator", item.status);
    record.bindingRevision = item.revision;
    record.idempotencyKey = taskId + "-r" + item.revision;
    record.updatedAt = 300 + item.revision;
    record.completedAt = 300 + item.revision;
    record.statusReason = item.status === "completed" ? "Later revision completed." :
      "Exact revision failed.";
    bindings.push(record);
  }
  root.orchestrationTasks.push({ taskId: "current-work", status: "running", updatedAt: 500 });

  assert.equal(ledger.reconcile({
    bindings: bindings,
    projects: [project(CLAY_ID, sessions)],
  }).ok, true);
  for (var revisionIndex = 0; revisionIndex < 2; revisionIndex++) {
    var failed = ledger.get({ projectId: CLAY_ID, sessionStorageId: revisions[revisionIndex].storageId });
    assert.equal(failed.lifecycleState, "failed");
    assert.equal(failed.workState, "needs_input");
    assert.equal(failed.closedAt, 300 + revisions[revisionIndex].revision);
    assert.equal(failed.hidden, false, "projection reconciliation must not hide prior failures");
  }
  var completed = ledger.get({ projectId: CLAY_ID, sessionStorageId: "completed-r6" });
  assert.equal(completed.lifecycleState, "completed");
  assert.equal(completed.workState, "done");
  var persistent = ledger.get({ projectId: CLAY_ID, sessionStorageId: rootId });
  assert.equal(persistent.lifecycleState, "running");
  assert.equal(persistent.workState, "working");
});

test("a ledger root ignores an orphaned running task whose worker is terminal", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-orphaned-task-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var root = {
    storageId: "orphaned-task-root",
    title: "Project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationTasks: [{
      taskId: "orphaned-restart-task",
      workerStorageId: "terminal-task-coordinator",
      status: "running",
      currentActivity: "Task coordinator is running",
      updatedAt: 300,
    }],
  };
  var worker = {
    storageId: "terminal-task-coordinator",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    hidden: true,
    closedAt: 400,
    orchestrationPolicy: { portfolioExecution: execution(
      "orphaned-restart", "project_coordinator", "failed", {
        reason: "restart_recovery", terminalAt: 400,
      }
    ) },
  };

  assert.equal(ledger.reconcile({
    bindings: [], projects: [project(CLAY_ID, [root, worker])],
  }).ok, true);
  var projected = ledger.get({
    projectId: CLAY_ID, sessionStorageId: root.storageId,
  });
  assert.equal(projected.lifecycleState, "idle");
  assert.equal(projected.workState, "idle");
  assert.equal(projected.terminalOutcome, null,
    "the reusable root remains visible without inventing a terminal outcome");
});

test("an exact completed legacy project-coordinator binding outranks stale running metadata", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-completed-root-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var session = {
    storageId: "legacy-bound-root",
    title: "Project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationPolicy: { portfolioExecution: execution(
      "legacy-bound-work", "project_coordinator", "running"
    ) },
    orchestrationTasks: [{ taskId: "done", status: "completed", updatedAt: 250 }],
  };
  var completed = binding("legacy-bound-work", CLAY_ID, session.storageId,
    "project_coordinator", "completed");
  completed.completedAt = 300;
  completed.updatedAt = 300;

  assert.equal(ledger.reconcile({
    bindings: [completed], projects: [project(CLAY_ID, [session])],
  }).ok, true);
  var projected = ledger.get({ projectId: CLAY_ID, sessionStorageId: session.storageId });
  assert.equal(projected.lifecycleState, "completed");
  assert.equal(projected.workState, "done");
  assert.equal(projected.closedAt, 300);
});

test("verified completion evidence survives supersession without rewriting lifecycle history", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-superseded-completion-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var session = {
    storageId: "superseded-completed-root",
    title: "Build Coop owner control sidebar",
    hidden: true,
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationPolicy: { portfolioExecution: execution(
      "clay-coop-owner-control-sidebar-2026-08-15", "project_coordinator", "failed"
    ) },
  };
  var superseded = binding("clay-coop-owner-control-sidebar-2026-08-15", CLAY_ID,
    session.storageId, "project_coordinator", "superseded", "session-context");
  superseded.statusReason = "Implementation is already complete, pushed as 809665952a, and independently verified twice.";
  superseded.updatedAt = 300;

  assert.equal(ledger.reconcile({
    bindings: [superseded], projects: [project(CLAY_ID, [session])],
  }).ok, true);
  var projected = ledger.get({ projectId: CLAY_ID, sessionStorageId: session.storageId });
  assert.equal(projected.lifecycleState, "superseded");
  assert.equal(projected.workState, "done");
  assert.equal(projected.terminalOutcome.status, "superseded");
  assert.equal(ledger.topicEvidence({ topicId: "session-context" })[0].workState, "done");
  var restarted = attachCoopSessionLedger({ file: ledger.file });
  assert.equal(restarted.get({ projectId: CLAY_ID, sessionStorageId: session.storageId }).workState, "done");
  assert.equal(restarted.topicEvidence({ topicId: "session-context" })[0].workState, "done");
});

test("a terminal historical child cannot reactivate a restored completed project root", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-restored-root-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var root = {
    storageId: "restored-project-root",
    title: "Project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationProjectCompletion: {
      status: "pending",
      portfolioTaskId: "initial-project-work",
      bindingRevision: 1,
    },
    orchestrationTasks: [{
      taskId: "stale-restart-task",
      clientRef: "portfolio:historical-restart-work:1",
      workerStorageId: "historical-child",
      status: "running",
      updatedAt: 350,
    }],
  };
  var completed = binding("initial-project-work", CLAY_ID, root.storageId,
    "project_coordinator", "completed");
  completed.completedAt = 300;
  completed.updatedAt = 300;
  var historical = binding("historical-restart-work", CLAY_ID, "historical-child",
    "project_coordinator", "superseded");
  historical.completedAt = 340;
  historical.updatedAt = 340;

  assert.equal(ledger.reconcile({
    bindings: [completed, historical], projects: [project(CLAY_ID, [root])],
  }).ok, true);
  var projected = ledger.get({ projectId: CLAY_ID, sessionStorageId: root.storageId });
  assert.equal(projected.lifecycleState, "completed");
  assert.equal(projected.workState, "done");
  assert.equal(projected.closedAt, 300);
  assert.equal(projected.terminalOutcome.status, "completed");
});

test("a live attention child still keeps a restored project root actionable", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-restored-attention-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var root = {
    storageId: "restored-attention-root",
    title: "Project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationTasks: [{
      taskId: "attention-task",
      clientRef: "portfolio:current-attention-work:2",
      workerStorageId: "attention-child",
      status: "running",
      updatedAt: 350,
    }],
  };
  var completed = binding("initial-project-work", CLAY_ID, root.storageId,
    "project_coordinator", "completed");
  completed.completedAt = 300;
  completed.updatedAt = 300;
  var attention = binding("current-attention-work", CLAY_ID, "attention-child",
    "project_coordinator", "active");
  attention.bindingRevision = 2;
  attention.attentionAt = 340;
  attention.updatedAt = 340;

  assert.equal(ledger.reconcile({
    bindings: [completed, attention], projects: [project(CLAY_ID, [root])],
  }).ok, true);
  var projected = ledger.get({ projectId: CLAY_ID, sessionStorageId: root.storageId });
  assert.equal(projected.lifecycleState, "needs_input");
  assert.equal(projected.workState, "needs_input");
  assert.equal(projected.terminalOutcome, null);
});

test("a compacted continuation inherits the exact source binding and topic", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-compaction-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var source = {
    storageId: "source-session",
    title: "Portfolio coordinator",
    hidden: true,
    compactedIntoLocalId: 2,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
  };
  var continuation = {
    storageId: "continuation-session",
    title: "Portfolio coordinator (compacted)",
    compactedFromStorageId: "source-session",
    coordinationMode: true,
    isProcessing: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationPolicy: { portfolioExecution: { status: "running", updatedAt: 300 } },
  };
  ledger.reconcile({
    bindings: [binding("portfolio-task", CLAY_ID, "source-session",
      "project_coordinator", "active", "topic-compacted")],
    projects: [project(CLAY_ID, [source, continuation])],
  });

  var visible = ledger.list({ projectRefs: [{ projectId: CLAY_ID }] });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].sessionStorageId, "continuation-session");
  assert.equal(visible[0].portfolioBinding.portfolioTaskId, "portfolio-task");
  assert.deepEqual(visible[0].coopTopicRef, { topicId: "topic-compacted" });
  assert.equal(visible[0].lifecycleState, "running");
  assert.deepEqual(ledger.topicEvidence({ topicId: "topic-compacted" }).map(function (entry) {
    return entry.sessionStorageId;
  }), ["continuation-session"]);
});

// --- Fail-closed persistence -------------------------------------------------
// A ledger read that failed or did not validate must never be persisted back:
// an empty ledger written over merely unreadable content is silent data loss.

function canarySink() {
  var events = [];
  return {
    events: events,
    record: function (event) { events.push(event); },
    kinds: function () {
      return events.map(function (event) { return event.store + ":" + event.op; });
    },
  };
}

function controllableFs(state) {
  return {
    readFileSync: function (target, encoding) { return fs.readFileSync(target, encoding); },
    mkdirSync: function (target, options) { return fs.mkdirSync(target, options); },
    writeFileSync: function (target, data, options) {
      if (state.failWrites) {
        var error = new Error("simulated write failure");
        error.code = "ENOSPC";
        throw error;
      }
      return fs.writeFileSync(target, data, options);
    },
    renameSync: function (from, to) { return fs.renameSync(from, to); },
  };
}

function reconcileInput(storageId) {
  var session = {
    storageId: storageId,
    title: "Fail-closed persistence session",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
  };
  return {
    bindings: [binding("failclosed-task", CLAY_ID, storageId, "direct_leaf", "active")],
    projects: [project(CLAY_ID, [session])],
  };
}

test("a corrupt session ledger is never overwritten by an empty reconcile", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-corrupt-"));
  var file = path.join(dir, "ledger.json");
  var corrupt = '{"schema":"clay.coop_session_ledger","version":1,"entries":[{"trunc';
  fs.writeFileSync(file, corrupt);
  var sink = canarySink();
  var ledger = attachCoopSessionLedger({ file: file, recordRecoveryEvent: sink.record });

  assert.deepEqual(ledger.persistenceState(), { code: "invalid_json" });
  var result = ledger.reconcile(reconcileInput("corrupt-session"));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "persistence_unreadable");
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(file, "utf8"), corrupt);
  assert.deepEqual(sink.kinds(), ["session_ledger:parse", "session_ledger:write_refused"]);
  assert.equal(sink.events[0].kind, "coop_persistence");
  // Read-only lenses may serve an empty view, but only after the canary fired.
  assert.deepEqual(ledger.list({ projectRefs: [{ projectId: CLAY_ID }] }), []);
});

test("a schema-mismatched session ledger fails closed instead of resetting", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-schema-"));
  var file = path.join(dir, "ledger.json");
  var future = JSON.stringify({ schema: "clay.coop_session_ledger", version: 99, entries: [] });
  fs.writeFileSync(file, future);
  var sink = canarySink();
  var ledger = attachCoopSessionLedger({ file: file, recordRecoveryEvent: sink.record });

  var result = ledger.reconcile(reconcileInput("schema-session"));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "persistence_unreadable");
  assert.equal(fs.readFileSync(file, "utf8"), future);
  assert.deepEqual(sink.kinds(), ["session_ledger:validate", "session_ledger:write_refused"]);
});

test("a missing session ledger still initializes a fresh store silently", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-fresh-"));
  var file = path.join(dir, "ledger.json");
  var sink = canarySink();
  var ledger = attachCoopSessionLedger({ file: file, recordRecoveryEvent: sink.record });

  // Asserted through behaviour only, so this test also passes before the
  // fail-closed fix: fresh-install handling must not change at all.
  var result = ledger.reconcile(reconcileInput("fresh-session"));
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(sink.events, []);
  var written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.entries.length, 1);
  assert.equal(written.entries[0].sessionStorageId, "fresh-session");
});

test("a failed ledger write is retried instead of being lost to in-memory state", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-retry-"));
  var file = path.join(dir, "ledger.json");
  var control = { failWrites: true };
  var sink = canarySink();
  var ledger = attachCoopSessionLedger({
    file: file, fs: controllableFs(control), recordRecoveryEvent: sink.record,
  });

  var failed = ledger.reconcile(reconcileInput("retry-session"));
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "persistence_failed");
  assert.equal(failed.changed, false);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(sink.kinds(), ["session_ledger:write"]);
  // The in-memory state must not have advanced, otherwise the next reconcile
  // sees no change and the ledger never reaches disk again.
  assert.deepEqual(ledger.list({ projectRefs: [{ projectId: CLAY_ID }] }), []);

  control.failWrites = false;
  var retried = ledger.reconcile(reconcileInput("retry-session"));
  assert.equal(retried.ok, true);
  assert.equal(retried.changed, true);
  var written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.entries.length, 1);
  assert.equal(written.entries[0].sessionStorageId, "retry-session");
});

test("an entry that loses its last evidence cannot stay active forever", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-stranded-"));
  var file = path.join(dir, "ledger.json");
  var ledger = attachCoopSessionLedger({ file: file, now: function () { return 900; } });

  // A binding with no live session behind it: born active, sessionPresent false.
  var first = ledger.reconcile({
    bindings: [binding("portfolio-stranded", WEBAPP_ID, "stranded-coordinator",
      "project_coordinator", "active")],
    projects: [],
  });
  assert.equal(first.ok, true);
  var born = ledger.get({ projectId: WEBAPP_ID, sessionStorageId: "stranded-coordinator" });
  assert.equal(born.lifecycleState, "active");
  assert.equal(born.sessionPresent, false);

  // The binding disappears (a store recovery dropped it) and the project is not
  // registered, so nothing enumerates it. Before the fix the row was carried
  // forward verbatim on every pass and stayed active/working permanently, with
  // no code path able to terminalize it.
  var stranded = ledger.reconcile({ bindings: [], projects: [] });
  assert.equal(stranded.ok, true);
  var demoted = ledger.get({ projectId: WEBAPP_ID, sessionStorageId: "stranded-coordinator" });
  assert.equal(demoted.lifecycleState, "missing");
  assert.equal(demoted.workState, "needs_input");
  assert.equal(demoted.lastCoopAction.type, "session_missing");

  // Idempotent: a second pass must not churn the store.
  assert.equal(ledger.reconcile({ bindings: [], projects: [] }).changed, false);
});

test("an unenumerated project keeps a still-present session active", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-unenumerated-"));
  var file = path.join(dir, "ledger.json");
  var ledger = attachCoopSessionLedger({ file: file, now: function () { return 900; } });
  var live = { storageId: "live-coordinator", title: "Live coordinator", vendor: "codex" };

  var first = ledger.reconcile({
    bindings: [binding("portfolio-live", WEBAPP_ID, "live-coordinator",
      "project_coordinator", "active")],
    projects: [project(WEBAPP_ID, [live])],
  });
  assert.equal(first.ok, true);
  var present = ledger.get({ projectId: WEBAPP_ID, sessionStorageId: "live-coordinator" });
  assert.equal(present.sessionPresent, true);
  assert.equal(present.lifecycleState, "active");

  // A boot pass before the project's resolver registers enumerates neither the
  // project nor its bindings. Absence is NOT evidence that live work ended, so a
  // row that was still present must keep its state -- otherwise every restart
  // would wrongly report all in-flight project work as missing.
  var partial = ledger.reconcile({ bindings: [], projects: [] });
  assert.equal(partial.ok, true);
  var preserved = ledger.get({ projectId: WEBAPP_ID, sessionStorageId: "live-coordinator" });
  assert.equal(preserved.sessionPresent, true);
  assert.equal(preserved.lifecycleState, "active");
});

test("a visible terminal worker stays discoverable in the durable owner inventory after restart", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-ledger-terminal-visible-"));
  var file = path.join(dir, "ledger.json");
  var storageId = "visible-terminal-task-coordinator";
  var visibleTerminal = {
    storageId: storageId,
    title: "Visible terminal task coordinator",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    createdAt: 10,
    lastActivity: 30,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 10 },
    orchestrationPolicy: { portfolioExecution: execution(
      "visible-terminal-task", "project_coordinator", "completed", {
        updatedAt: 30,
        completedAt: 30,
      }
    ) },
    orchestrationProjectCompletion: {
      status: "completed",
      completedAt: 30,
      summary: "Terminal visibility regression covered.",
      escalationRequired: "no",
    },
  };
  var completedBinding = binding("visible-terminal-task", CLAY_ID, storageId,
    "project_coordinator", "completed", "visible-terminal-topic");
  completedBinding.updatedAt = 30;
  completedBinding.completedAt = 30;
  var input = {
    bindings: [completedBinding],
    projects: [project(CLAY_ID, [visibleTerminal])],
  };
  var ledger = attachCoopSessionLedger({ file: file, now: function () { return 40; } });

  assert.equal(ledger.reconcile(input).ok, true);
  var listed = ledger.list({ projectRefs: [{ projectId: CLAY_ID }] });
  assert.equal(listed.length, 1,
    "the default owner inventory excludes hidden rows but retains visible terminal rows");
  assert.equal(listed[0].sessionStorageId, storageId);
  assert.equal(listed[0].hidden, false);
  assert.equal(listed[0].lifecycleState, "completed");
  assert.equal(listed[0].workState, "done");
  assert.equal(listed[0].closedAt, 30,
    "terminal lifecycle closure remains durable without becoming a visibility mutation");

  var restarted = attachCoopSessionLedger({ file: file, now: function () { return 50; } });
  assert.equal(restarted.reconcile(input).changed, false);
  var afterRestart = restarted.list({ projectRefs: [{ projectId: CLAY_ID }] });
  assert.deepEqual(afterRestart.map(function (entry) {
    return [entry.sessionStorageId, entry.hidden, entry.lifecycleState, entry.workState];
  }), [[storageId, false, "completed", "done"]]);
});
