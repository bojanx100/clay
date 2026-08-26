var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var globalCoopProjection = require("../lib/global-coop-projection");
var buildGlobalCoopProjection = globalCoopProjection.buildGlobalCoopProjection;

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

function session(id, extra) {
  return Object.assign({
    localId: id,
    storageId: "session-" + id,
    title: "Session " + id,
    lastActivity: id,
  }, extra || {});
}

function project(projectId, slug, title, sessions, extra) {
  return Object.assign({
    projectId: projectId,
    slug: slug,
    title: title,
    sm: {
      sessions: new Map(sessions.map(function (item) { return [item.localId, item]; })),
    },
  }, extra || {});
}

function task(taskId, status, child) {
  return {
    taskId: taskId,
    title: child.title,
    status: status,
    externalTaskCoordinator: true,
    workerSessionId: child.localId,
    workerStorageId: child.storageId,
    updatedAt: child.lastActivity,
  };
}

function coordinatorFixture() {
  var coopHome = session(1, { storageId: "coop-home", coopHome: true });
  var lead = project("system-lead", "lead", "Coop", [coopHome], { isLead: true });

  var clayActive = session(12, {
    storageId: "clay-active-task-coordinator",
    title: "Show project coordinators in Coop sidebar",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-active", sessionStorageId: "clay-project-coordinator" },
  });
  var clayWorkerRunning = session(15, {
    storageId: "clay-worker-running",
    title: "Implement hierarchy projection",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-worker-running", sessionStorageId: clayActive.storageId },
  });
  var clayWorkerAttention = session(16, {
    storageId: "clay-worker-attention",
    title: "Review hierarchy ownership",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-worker-attention", sessionStorageId: clayActive.storageId },
  });
  var clayWorkerCompleted = session(17, {
    storageId: "clay-worker-completed",
    title: "Fulfilled QA worker",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-worker-completed", sessionStorageId: clayActive.storageId },
  });
  var clayWorkerHidden = session(18, {
    storageId: "clay-worker-hidden",
    title: "Hidden running worker",
    hidden: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-worker-hidden", sessionStorageId: clayActive.storageId },
  });
  var ownerDirectWorker = session(19, {
    storageId: "owner-direct-worker",
    title: "Owner direct worker",
    orchestrationParent: { taskId: "owner-direct-worker", sessionStorageId: clayActive.storageId },
  });
  var foreignControlledWorker = session(27, {
    storageId: "foreign-controlled-worker",
    title: "Foreign Coop worker",
    coopControlledBy: { coopSessionStorageId: "other-coop-home", since: 1 },
    orchestrationParent: { taskId: "foreign-controlled-worker", sessionStorageId: clayActive.storageId },
  });
  var staleWorker = session(23, {
    storageId: "clay-worker-stale",
    title: "Historical worker attempt",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-worker-running", sessionStorageId: clayActive.storageId },
  });
  var unrelatedWorker = session(24, {
    storageId: "unrelated-worker",
    title: "Unrelated worker",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "missing-task", sessionStorageId: clayActive.storageId },
  });
  var unboundWorker = session(28, {
    storageId: "worker-without-binding-id",
    title: "Worker without binding id",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "worker-without-binding-id", sessionStorageId: clayActive.storageId },
  });
  delete unboundWorker.localId;
  var duplicateWorker = session(25, {
    storageId: clayWorkerRunning.storageId,
    title: "Duplicate storage record",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-worker-running", sessionStorageId: clayActive.storageId },
  });
  var nestedWorker = session(26, {
    storageId: "nested-worker",
    title: "Fourth-level worker",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "nested-worker", sessionStorageId: clayWorkerRunning.storageId },
  });
  clayActive.orchestrationTasks = [
    task("clay-worker-running", "running", clayWorkerRunning),
    task("clay-worker-attention", "needs_input", clayWorkerAttention),
    task("clay-worker-completed", "completed", clayWorkerCompleted),
    task("clay-worker-hidden", "running", clayWorkerHidden),
    task("owner-direct-worker", "running", ownerDirectWorker),
    task("foreign-controlled-worker", "running", foreignControlledWorker),
    {
      taskId: "worker-without-binding-id",
      title: unboundWorker.title,
      status: "running",
      updatedAt: unboundWorker.lastActivity,
    },
  ];
  clayWorkerRunning.orchestrationTasks = [task("nested-worker", "running", nestedWorker)];
  var clayCompleted = session(13, {
    title: "Completed Clay task",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-completed", sessionStorageId: "clay-project-coordinator" },
  });
  var clayDismissed = session(31, {
    title: "Dismissed Clay task",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-dismissed", sessionStorageId: "clay-project-coordinator" },
  });
  var clayRoot = session(10, {
    storageId: "clay-project-coordinator",
    title: "Project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationTasks: [
      task("clay-active", "running", clayActive),
      task("clay-completed", "completed", clayCompleted),
      task("clay-dismissed", "dismissed", clayDismissed),
    ],
  });
  var foreignRoot = session(29, {
    storageId: "foreign-project-coordinator",
    title: "Foreign project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "other-coop-home", since: 1 },
    orchestrationTasks: [],
  });
  var groupedRoot = session(30, {
    storageId: "grouped-project-coordinator",
    title: "Grouped project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationGroupParent: { taskId: "historical-root", sessionStorageId: "old-parent" },
    orchestrationTasks: [],
  });
  var ownerDirect = session(11, {
    title: "Owner-opened direct coordinator",
    coordinationMode: true,
    orchestrationTasks: [],
  });
  var ownerTaskCoordinator = session(14, {
    title: "Owner-opened task coordinator",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    orchestrationParent: { taskId: "owner-task", sessionStorageId: "clay-project-coordinator" },
  });

  var webappAttention = session(22, {
    title: "Resolve Webapp rollout decision",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "webapp-attention", sessionStorageId: "webapp-project-coordinator" },
  });
  var webappRoot = session(20, {
    storageId: "webapp-project-coordinator",
    title: "Project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationTasks: [task("webapp-attention", "needs_input", webappAttention)],
  });

  return {
    lead: lead,
    clay: project(CLAY, "clay", "Clay", [
      foreignRoot, groupedRoot, clayRoot, ownerDirect, ownerTaskCoordinator, clayActive, clayCompleted,
      clayDismissed,
      clayWorkerRunning, clayWorkerAttention, clayWorkerCompleted, clayWorkerHidden,
      ownerDirectWorker, foreignControlledWorker, staleWorker, unrelatedWorker,
      unboundWorker, nestedWorker,
    ]),
    webapp: project(WEBAPP, "webapp", "Webapp", [webappRoot, webappAttention]),
    clayActive: clayActive,
    clayWorkerRunning: clayWorkerRunning,
    duplicateWorker: duplicateWorker,
    webappAttention: webappAttention,
  };
}

// Regression: ISSUE-COOP-SIDEBAR-001 — project coordinators rendered only in project sidebars.
// Found by /qa on 2026-08-14.
test("global Coop projection retains visible terminal task coordinators without treating them as live", function () {
  var fixture = coordinatorFixture();
  var projection = buildGlobalCoopProjection({
    projects: [fixture.lead, fixture.clay, fixture.webapp],
  });
  var projects = Object.fromEntries(projection.projects.map(function (item) {
    return [item.projectRef.projectId, item];
  }));

  assert.deepEqual(Object.keys(projects).sort(), [CLAY, WEBAPP].sort());
  assert.equal(projects[CLAY].summary.coordinatorTree.length, 1,
    "the owner-opened direct coordinator is not adopted into Coop");
  assert.equal(projects[CLAY].summary.coordinatorTree[0].role, "project_coordinator");
  assert.equal(JSON.stringify(projects[CLAY].summary.coordinatorTree).includes("Owner-opened"), false,
    "owner-opened sessions are never adopted beneath the Coop root");
  assert.equal(JSON.stringify(projects[CLAY].summary.coordinatorTree).includes("Foreign project coordinator"), false,
    "a project coordinator controlled by a different Coop cannot suppress the canonical root");
  assert.equal(JSON.stringify(projects[CLAY].summary.coordinatorTree).includes("Grouped project coordinator"), false,
    "group-parent metadata disqualifies a session from becoming a project root");
  assert.deepEqual(projects[CLAY].summary.coordinatorTree[0].children.map(function (item) {
    return item.title;
  }), ["Show project coordinators in Coop sidebar", "Dismissed Clay task", "Completed Clay task"],
  "visible completed and dismissed task coordinators remain navigable beside active work");
  assert.equal(projects[CLAY].summary.metrics.activeWorkers, 1,
    "the retained completed coordinator does not consume active capacity");
  assert.deepEqual(projects[WEBAPP].summary.coordinatorTree[0].children.map(function (item) {
    return item.status;
  }), ["needs_input"]);
  var taskCoordinator = projects[CLAY].summary.coordinatorTree[0].children[0];
  assert.deepEqual(taskCoordinator.taskRef, {
    projectId: CLAY,
    coordinatorSessionStorageId: "clay-project-coordinator",
    taskId: "clay-active",
  });
  assert.deepEqual(taskCoordinator.children.map(function (item) {
    return [item.title, item.status, item.sessionRef, item.taskRef];
  }), [
    ["Implement hierarchy projection", "running", {
      projectId: CLAY, sessionStorageId: "clay-worker-running",
    }, {
      projectId: CLAY,
      coordinatorSessionStorageId: "clay-active-task-coordinator",
      taskId: "clay-worker-running",
    }],
    ["Fulfilled QA worker", "completed", {
      projectId: CLAY, sessionStorageId: "clay-worker-completed",
    }, {
      projectId: CLAY,
      coordinatorSessionStorageId: "clay-active-task-coordinator",
      taskId: "clay-worker-completed",
    }],
    ["Review hierarchy ownership", "needs_input", {
      projectId: CLAY, sessionStorageId: "clay-worker-attention",
    }, {
      projectId: CLAY,
      coordinatorSessionStorageId: "clay-active-task-coordinator",
      taskId: "clay-worker-attention",
    }],
  ], "only exact current visible worker bindings are projected once");
  assert.equal(JSON.stringify(taskCoordinator).includes("Owner direct worker"), false);
  assert.equal(JSON.stringify(taskCoordinator).includes("Foreign Coop worker"), false);
  assert.equal(JSON.stringify(taskCoordinator).includes("Historical worker attempt"), false);
  assert.equal(JSON.stringify(taskCoordinator).includes("Unrelated worker"), false);
  assert.equal(JSON.stringify(taskCoordinator).includes("Worker without binding id"), false);
  assert.equal(JSON.stringify(taskCoordinator).includes("Fulfilled QA worker"), true);
  assert.equal(JSON.stringify(taskCoordinator).includes("Hidden running worker"), false);
  assert.equal(JSON.stringify(taskCoordinator).includes("Fourth-level worker"), false);
  assert.equal(projects[CLAY].summary.metrics.activeWorkers, 1,
    "the existing task-coordinator metric remains stable");
  assert.equal(projects[CLAY].summary.metrics.activeTaskWorkers, 2,
    "the third-level worker metric counts exact current worker sessions");

  fixture.clayActive.hidden = true;
  fixture.webappAttention.hidden = true;
  projection = buildGlobalCoopProjection({
    projects: [fixture.lead, fixture.clay, fixture.webapp],
  });
  assert.deepEqual(projection.projects.map(function (item) {
    return {
      projectId: item.projectRef.projectId,
      roots: item.summary.coordinatorTree.length,
      children: item.summary.coordinatorTree[0].children.length,
    };
  }), [
    { projectId: CLAY, roots: 1, children: 2 },
    { projectId: WEBAPP, roots: 1, children: 0 },
  ], "visible terminal rows remain while hidden active rows leave both reusable project roots");
});

test("initial Coop projection includes the production-shaped active 38ee project coordinator", function () {
  var canonicalCoopId = "871a194b-8879-40f7-a1fe-656e48e722af";
  var controlRootId = "457f9fa1-7024-40cc-acee-2cef6b2b8445";
  var activeId = "38ee2311-f5a2-4db0-90c9-ee95751d51db";
  var rootRef = { projectId: "system-lead", sessionStorageId: controlRootId };
  var activeRef = { projectId: CLAY, sessionStorageId: activeId };
  var active = session(38, {
    storageId: activeId,
    title: "Review failed Clay sessions for recovery",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: controlRootId, since: 1786875717441 },
    projectCoordinatorRef: rootRef,
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "clay-project-coordinator-visibility-session-cleanup-2026-08-15",
        bindingRevision: 12,
        mode: "project_coordinator",
        status: "running",
        source: rootRef,
      },
    },
    hidden: false,
    isProcessing: true,
    lastActivity: 1786875717441,
  });
  var terminal = session(39, {
    storageId: "terminal-project-coordinator",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: controlRootId, since: 1 },
    projectCoordinatorRef: rootRef,
    orchestrationPolicy: { portfolioExecution: { status: "completed" } },
  });
  var hidden = session(40, {
    storageId: "hidden-project-coordinator",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: controlRootId, since: 1 },
    projectCoordinatorRef: rootRef,
    orchestrationPolicy: { portfolioExecution: { status: "running" } },
    hidden: true,
  });
  var ownerDirect = session(41, {
    storageId: "owner-direct-project-coordinator",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
  });
  var root = session(7, {
    storageId: controlRootId,
    title: "clay coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: canonicalCoopId, since: 1786794424191 },
    orchestrationPolicy: {
      coopControlPlane: {
        version: 1,
        role: "project_coordinator",
        projectRef: { projectId: CLAY },
        createdAt: 1786794424191,
      },
    },
    orchestrationTasks: [
      Object.assign(task("task-6530a460-e3af-4e43-b895-b9f350681688", "running", active), {
        clientRef: "portfolio:clay-project-coordinator-visibility-session-cleanup-2026-08-15:12",
        workerSessionRef: activeRef,
      }),
      task("terminal-task", "completed", terminal),
      task("hidden-task", "running", hidden),
    ],
  });
  var coopHome = session(1, { storageId: canonicalCoopId, coopHome: true });
  var lead = project("system-lead", "lead", "Coop", [coopHome, root], { isLead: true });
  var clay = project(CLAY, "clay", "Clay", [active, terminal, hidden, ownerDirect]);

  var projection = buildGlobalCoopProjection({ projects: [lead, clay] });
  var tree = projection.projects[0].summary.coordinatorTree;
  var taskCoordinators = tree[0].children.filter(function (child) {
    return child.role === "task_coordinator";
  });
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].sessionRef, rootRef);
  assert.deepEqual(taskCoordinators.map(function (child) {
    return { sessionRef: child.sessionRef, status: child.status };
  }), [{ sessionRef: activeRef, status: "running" }, {
    sessionRef: { projectId: CLAY, sessionStorageId: "terminal-project-coordinator" },
    status: "completed",
  }]);
  assert.equal(JSON.stringify(tree).includes("terminal-project-coordinator"), true);
  assert.equal(JSON.stringify(tree).includes("hidden-project-coordinator"), false);
  assert.equal(JSON.stringify(tree).includes("owner-direct-project-coordinator"), false);
});

test("a durable task dismissal overrides its failed historical child execution", function () {
  var canonicalCoopId = "871a194b-8879-40f7-a1fe-656e48e722af";
  var controlRootId = "457f9fa1-7024-40cc-acee-2cef6b2b8445";
  var rootRef = { projectId: "system-lead", sessionStorageId: controlRootId };
  var legacy = [{
    id: "64b2e4c4-e55d-490b-b111-81dc83569079",
    title: "Recover stalled Coop sessions",
  }, {
    id: "905f2146-ee64-4f21-bc74-60b3f406404e",
    title: "Verify activated Coop sidebar cleanup",
  }, {
    id: "e43eeac8-c25f-4905-b54c-1e95718a5740",
    title: "Finalize Coop sidebar verification",
  }, {
    id: "ee3df56a-8494-473f-9b01-0c7967759131",
    title: "Add conditional Coop control groups",
  }];
  var tasks = [];
  var sessions = [];
  for (var i = 0; i < legacy.length; i++) {
    var item = legacy[i];
    var child = session(50 + i, {
      storageId: item.id,
      title: item.title,
      coordinationMode: true,
      coordinationRole: "task_coordinator",
      coopControlledBy: { coopSessionStorageId: controlRootId, since: 1 },
      projectCoordinatorRef: rootRef,
      orchestrationPolicy: { portfolioExecution: { status: "failed" } },
    });
    sessions.push(child);
    tasks.push(Object.assign(task("dismissed-" + i, "dismissed", child), {
      workerSessionRef: { projectId: CLAY, sessionStorageId: item.id },
      resolutionReason: "Superseded by the completed visibility repair.",
      archivedAt: 1,
    }));
  }
  var root = session(49, {
    storageId: controlRootId,
    title: "clay coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: canonicalCoopId, since: 1 },
    orchestrationPolicy: {
      coopControlPlane: {
        version: 1,
        role: "project_coordinator",
        projectRef: { projectId: CLAY },
        createdAt: 1,
      },
    },
    orchestrationTasks: tasks,
  });
  var coopHome = session(1, { storageId: canonicalCoopId, coopHome: true });
  var lead = project("system-lead", "lead", "Coop", [coopHome, root], { isLead: true });
  var clay = project(CLAY, "clay", "Clay", sessions);

  var reconciled = [];
  var projection = buildGlobalCoopProjection({
    projects: [lead, clay],
    reconcileDismissedSession: function (projectRef, sessionRef, taskRef) {
      reconciled.push([projectRef.projectId, sessionRef.storageId, taskRef.taskId]);
      sessionRef.hidden = true;
    },
  });
  var tree = projection.projects[0].summary.coordinatorTree;

  assert.equal(tree.length, 1);
  var taskCoordinators = tree[0].children.filter(function (child) {
    return child.role === "task_coordinator";
  });
  assert.deepEqual(taskCoordinators, [],
    "dismissed tasks remain closed even when their immutable child binding is failed");
  assert.equal(JSON.stringify(tree).includes("64b2e4c4-e55d-490b-b111-81dc83569079"), false);
  assert.equal(JSON.stringify(tree).includes("905f2146-ee64-4f21-bc74-60b3f406404e"), false);
  assert.equal(JSON.stringify(tree).includes("e43eeac8-c25f-4905-b54c-1e95718a5740"), false);
  assert.equal(JSON.stringify(tree).includes("ee3df56a-8494-473f-9b01-0c7967759131"), false);
  assert.deepEqual(reconciled.map(function (item) { return item[1]; }), legacy.map(function (item) { return item.id; }));
  assert.equal(sessions.every(function (item) { return item.hidden === true; }), true,
    "only the exact dismissed task bindings are reconciled into hidden history");
});

test("sidebar hides historical failed coordinator revisions and retains latest attention", async function () {
  var canonicalCoopId = "871a194b-8879-40f7-a1fe-656e48e722af";
  var controlRootId = "457f9fa1-7024-40cc-acee-2cef6b2b8445";
  var rootRef = { projectId: "system-lead", sessionStorageId: controlRootId };

  function execution(taskId, revision, status) {
    return {
      portfolioTaskId: taskId,
      bindingRevision: revision,
      idempotencyKey: taskId + "-r" + revision,
      mode: "project_coordinator",
      status: status,
    };
  }

  function coordinator(id, title, binding) {
    return session(id, {
      storageId: "portfolio-coordinator-" + id,
      title: title,
      coordinationMode: true,
      coordinationRole: "task_coordinator",
      coopControlledBy: { coopSessionStorageId: controlRootId, since: 1 },
      projectCoordinatorRef: rootRef,
      orchestrationPolicy: { portfolioExecution: binding },
    });
  }

  function durableBinding(item, status) {
    return Object.assign({}, item.orchestrationPolicy.portfolioExecution, {
      status: status,
      targetProject: { projectId: CLAY },
      coordinator: { projectId: CLAY, sessionStorageId: item.storageId },
      projectCoordinator: rootRef,
      createdAt: item.localId,
      updatedAt: item.localId,
      completedAt: status === "completed" ? item.localId : null,
    });
  }

  var voiceOne = coordinator(71, "Fix compact Voice chat controls",
    execution("clay-voice-chat-controls-fix-2026-08-16", 1, "failed"));
  var voiceTwo = coordinator(72, "Recover compact Voice controls",
    execution("clay-voice-chat-controls-fix-2026-08-16", 2, "failed"));
  var voiceFour = coordinator(74, "Finish Voice controls after restart",
    execution("clay-voice-chat-controls-fix-2026-08-16", 4, "completed"));
  voiceFour.hidden = true;
  var routingOne = coordinator(81, "Fix worker routing and restart recovery",
    execution("clay-worker-routing-restart-reliability-2026-08-16", 1, "failed"));
  var routingTwo = coordinator(82, "Verify routing and checkpointed restart",
    execution("clay-worker-routing-restart-reliability-2026-08-16", 2, "completed"));
  routingTwo.hidden = true;
  var unresolvedPrior = coordinator(90, "Earlier unresolved failure",
    execution("clay-current-unresolved-failure-2026-08-16", 2, "failed"));
  var unresolved = coordinator(91, "Latest unresolved failure",
    execution("clay-current-unresolved-failure-2026-08-16", 3, "failed"));
  var active = coordinator(92, "Current active work",
    execution("clay-current-active-work-2026-08-16", 1, "running"));
  var queued = coordinator(93, "Current queued work",
    execution("clay-current-queued-work-2026-08-16", 1, "queued"));
  var reviewing = coordinator(94, "Current reviewing work",
    execution("clay-current-reviewing-work-2026-08-16", 1, "reviewing"));
  var children = [voiceOne, voiceTwo, voiceFour, routingOne, routingTwo,
    unresolvedPrior, unresolved, active, queued, reviewing];
  var root = session(70, {
    storageId: controlRootId,
    title: "Clay coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: canonicalCoopId, since: 1 },
    orchestrationPolicy: { coopControlPlane: {
      version: 1,
      role: "project_coordinator",
      projectRef: { projectId: CLAY },
      createdAt: 1,
    } },
    orchestrationTasks: children.map(function (item) {
      return Object.assign(task("task-" + item.localId, "running", item), {
        clientRef: "portfolio:" + item.orchestrationPolicy.portfolioExecution.portfolioTaskId + ":" +
          item.orchestrationPolicy.portfolioExecution.bindingRevision,
        workerSessionRef: { projectId: CLAY, sessionStorageId: item.storageId },
      });
    }),
  });
  var coopHome = session(1, { storageId: canonicalCoopId, coopHome: true });
  var lead = project("system-lead", "lead", "Coop", [coopHome, root], { isLead: true });
  var clay = project(CLAY, "clay", "Clay", children);
  var bindings = [
    durableBinding(voiceOne, "failed"),
    durableBinding(voiceTwo, "failed"),
    durableBinding(voiceFour, "completed"),
    durableBinding(routingOne, "failed"),
    durableBinding(routingTwo, "completed"),
    durableBinding(unresolvedPrior, "failed"),
    durableBinding(unresolved, "failed"),
    durableBinding(active, "active"),
    durableBinding(queued, "active"),
    durableBinding(reviewing, "active"),
  ];
  var projection = buildGlobalCoopProjection({
    projects: [lead, clay],
    portfolioBindings: bindings,
    coopTopicIndex: {
      ensureRetro: function () { return { ok: true }; },
      project: function () { return { groups: [] }; },
    },
  });
  var hierarchy = projection.projects[0].summary.coordinatorTree;
  var titles = hierarchy[0].children.map(function (item) { return item.title; });

  assert.deepEqual(titles.sort(), [
    "Current active work",
    "Current queued work",
    "Current reviewing work",
    "Latest unresolved failure",
  ], "only the newest committed revision retains its failed attention row");
  assert.equal(JSON.stringify(hierarchy).includes("Fix compact Voice chat controls"), false);
  assert.equal(JSON.stringify(hierarchy).includes("Recover compact Voice controls"), false);
  assert.equal(JSON.stringify(hierarchy).includes("Fix worker routing and restart recovery"), false);
  assert.equal(JSON.stringify(hierarchy).includes("Earlier unresolved failure"), false);

  globalThis.document = { createElement: createElement };
  var modelModule = await import(moduleUrl("sidebar-coop-topic-model.js") + "?superseded=" + Date.now());
  var renderer = await import(moduleUrl("sidebar-coop-hierarchy.js") + "?superseded=" + Date.now());
  var sections = modelModule.coopTopicSections({
    hasProjection: true,
    projects: projection.projects,
    uncategorisedTopics: [],
    crossProjectTopics: [],
  });
  var desktop = createElement("div");
  var mobile = createElement("div");
  renderer.renderCoopProjectHierarchy(desktop, sections[0].coordinators[0].hierarchy, {
    mobile: false,
    send: function () { return true; },
  });
  renderer.renderCoopProjectHierarchy(mobile, sections[0].coordinators[0].hierarchy, {
    mobile: true,
    send: function () { return true; },
  });
  assert.equal(JSON.stringify(desktop).includes("Fix compact Voice chat controls"), false);
  assert.equal(JSON.stringify(mobile).includes("Fix worker routing and restart recovery"), false);
  assert.equal(byClass(desktop, "coop-project-coordinator-row").filter(function (row) {
    return row.classList.contains("child");
  }).length, 4);
  assert.equal(byClass(mobile, "mobile-coop-project-coordinator-row").filter(function (row) {
    return row.classList.contains("child");
  }).length, 4);
});

test("Lead-reconciled terminal failures leave Clay and Webapp foreground hierarchy while current attention remains", function () {
  var canonicalCoopId = "871a194b-8879-40f7-a1fe-656e48e722af";
  var clayRootId = "clay-project-coordinator-root";
  var webappRootId = "webapp-project-coordinator-root";

  function execution(taskId, status, reconciled) {
    return Object.assign({
      portfolioTaskId: taskId,
      bindingRevision: 1,
      idempotencyKey: taskId + "-key",
      mode: "project_coordinator",
      status: status,
    }, reconciled ? {
      terminalAt: 100,
      projectCompletionResultEventId: "result-" + taskId,
      projectCompletionDeliveryEventId: "delivery-" + taskId,
    } : {});
  }

  function child(localId, projectId, rootId, title, taskId, status, reconciled) {
    return session(localId, {
      storageId: projectId + "-" + localId,
      title: title,
      coordinationMode: true,
      coordinationRole: "task_coordinator",
      coopControlledBy: { coopSessionStorageId: canonicalCoopId, since: 1 },
      projectCoordinatorRef: { projectId: "system-lead", sessionStorageId: rootId },
      orchestrationPolicy: { portfolioExecution: Object.assign(
        execution(taskId, status, reconciled), { targetProject: { projectId: projectId } }) },
    });
  }

  function root(localId, projectId, rootId, title, tasks) {
    return session(localId, {
      storageId: rootId,
      title: title,
      coordinationMode: true,
      coordinationRole: "project_coordinator",
      coopControlledBy: { coopSessionStorageId: canonicalCoopId, since: 1 },
      orchestrationPolicy: { coopControlPlane: {
        version: 1,
        role: "project_coordinator",
        projectRef: { projectId: projectId },
        createdAt: 1,
      } },
      orchestrationTasks: tasks.map(function (item) {
        return Object.assign(task("task-" + item.localId, item.parentTaskStatus || "running", item), {
          workerSessionRef: { projectId: projectId, sessionStorageId: item.storageId },
        });
      }),
    });
  }

  function binding(item, projectId) {
    var executionMetadata = item.orchestrationPolicy.portfolioExecution;
    return Object.assign({}, executionMetadata, {
      targetProject: { projectId: projectId },
      coordinator: { projectId: projectId, sessionStorageId: item.storageId },
      createdAt: 1,
      updatedAt: 100,
      completedAt: null,
    });
  }

  var clayHistorical = child(101, CLAY, clayRootId, "Historical Clay restart failure",
    "clay-historical-restart", "failed", true);
  var clayCurrent = child(102, CLAY, clayRootId, "Current Clay failure",
    "clay-current-failure", "failed", true);
  clayCurrent.parentTaskStatus = "failed";
  var clayAttention = child(103, CLAY, clayRootId, "Current Clay owner attention",
    "clay-owner-attention", "needs_input", false);
  var webappHistorical = child(201, WEBAPP, webappRootId, "Historical Webapp restart failure",
    "webapp-historical-restart", "failed", true);
  var webappCurrent = child(202, WEBAPP, webappRootId, "Current Webapp failure",
    "webapp-current-failure", "failed", false);

  var clayRoot = root(10, CLAY, clayRootId, "Clay coordinator",
    [clayHistorical, clayCurrent, clayAttention]);
  var webappRoot = root(20, WEBAPP, webappRootId, "Webapp coordinator",
    [webappHistorical, webappCurrent]);
  var coopHome = session(1, { storageId: canonicalCoopId, coopHome: true });
  var lead = project("system-lead", "lead", "Coop", [coopHome, clayRoot, webappRoot], { isLead: true });
  var clay = project(CLAY, "clay", "Clay", [clayHistorical, clayCurrent, clayAttention]);
  var webapp = project(WEBAPP, "webapp", "Webapp", [webappHistorical, webappCurrent]);
  var historicalChildEvidence = JSON.stringify({
    execution: clayHistorical.orchestrationPolicy.portfolioExecution,
    binding: binding(clayHistorical, CLAY),
  });
  var projection = buildGlobalCoopProjection({
    projects: [lead, clay, webapp],
    // Historical terminal bindings remain queryable in the session ledger but
    // are not required to remain in the active binding-store list.
    portfolioBindings: [],
    coopTopicIndex: {
      ensureRetro: function () { return { ok: true }; },
      project: function () { return { groups: [] }; },
    },
  });

  function childTitles(projectProjection) {
    return projectProjection.summary.coordinatorTree[0].children.map(function (item) {
      return item.title;
    }).sort();
  }

  assert.deepEqual(childTitles(projection.projects[0]), [
    "Current Clay failure",
    "Current Clay owner attention",
  ]);
  assert.deepEqual(childTitles(projection.projects[1]), ["Current Webapp failure"]);
  assert.equal(JSON.stringify(projection).includes("Historical Clay restart failure"), false);
  assert.equal(JSON.stringify(projection).includes("Historical Webapp restart failure"), false);
  assert.equal(JSON.stringify({
    execution: clayHistorical.orchestrationPolicy.portfolioExecution,
    binding: binding(clayHistorical, CLAY),
  }), historicalChildEvidence, "hierarchy projection does not rewrite durable failure evidence");
});

test("global Coop hierarchy fails closed on ambiguous storage records regardless of order", function () {
  var fixture = coordinatorFixture();
  fixture.clay.sm.sessions.set(fixture.duplicateWorker.localId, fixture.duplicateWorker);

  function assertAmbiguousWorkerHidden() {
    var projection = buildGlobalCoopProjection({ projects: [fixture.lead, fixture.clay] });
    var serialized = JSON.stringify(projection.projects[0].summary.coordinatorTree);
    assert.equal(serialized.includes("Implement hierarchy projection"), false);
    assert.equal(serialized.includes("Duplicate storage record"), false);
    assert.equal(projection.projects[0].summary.metrics.activeTaskWorkers, 1);
  }

  assertAmbiguousWorkerHidden();
  var entries = Array.from(fixture.clay.sm.sessions.entries());
  fixture.clay.sm.sessions = new Map([
    [fixture.duplicateWorker.localId, fixture.duplicateWorker],
  ].concat(entries.filter(function (entry) {
    return entry[0] !== fixture.duplicateWorker.localId;
  })));
  assertAmbiguousWorkerHidden();
});

test("global Coop hierarchy applies session ACLs independently at task and worker depth", function () {
  var fixture = coordinatorFixture();
  var denyWorker = buildGlobalCoopProjection({
    projects: [fixture.lead, fixture.clay],
    canAccessSession: function (_actor, _project, sessionValue) {
      return sessionValue.storageId !== "clay-worker-attention";
    },
  });
  var workerSummary = denyWorker.projects[0].summary;
  assert.equal(JSON.stringify(workerSummary.coordinatorTree).includes("clay-worker-attention"), false);
  assert.equal(workerSummary.metrics.activeWorkers, 1);
  assert.equal(workerSummary.metrics.activeTaskWorkers, 1);

  var denyTaskCoordinator = buildGlobalCoopProjection({
    projects: [fixture.lead, fixture.clay],
    canAccessSession: function (_actor, _project, sessionValue) {
      return sessionValue.storageId !== "clay-active-task-coordinator";
    },
  });
  var taskSummary = denyTaskCoordinator.projects[0].summary;
  assert.equal(JSON.stringify(taskSummary.coordinatorTree).includes("clay-active-task-coordinator"), false);
  assert.equal(JSON.stringify(taskSummary.coordinatorTree).includes("clay-worker-running"), false);
  assert.equal(taskSummary.metrics.activeWorkers, 0);
  assert.equal(taskSummary.metrics.activeTaskWorkers, 0);
});

test("global Coop hierarchy accepts the durable legacy worker storage binding", function () {
  var fixture = coordinatorFixture();
  var taskRecord = fixture.clayActive.orchestrationTasks[0];
  taskRecord.workerSessionStorageId = taskRecord.workerStorageId;
  delete taskRecord.workerStorageId;
  var projection = buildGlobalCoopProjection({ projects: [fixture.lead, fixture.clay] });
  assert.equal(JSON.stringify(projection.projects[0].summary.coordinatorTree)
    .includes("clay-worker-running"), true);
});

test("global Coop hierarchy rejects malformed durable bindings without local-id fallback", function () {
  var malformedValues = ["", 0, { invalid: true }];
  for (var i = 0; i < malformedValues.length; i++) {
    var fixture = coordinatorFixture();
    var taskRecord = fixture.clayActive.orchestrationTasks[0];
    taskRecord.workerStorageId = malformedValues[i];
    taskRecord.workerSessionId = fixture.clayWorkerRunning.localId;
    var projection = buildGlobalCoopProjection({ projects: [fixture.lead, fixture.clay] });
    assert.equal(JSON.stringify(projection.projects[0].summary.coordinatorTree)
      .includes("clay-worker-running"), false);
  }
});

test("global Coop hierarchy fails closed when canonical project roots are ambiguous", function () {
  var fixture = coordinatorFixture();
  var secondRoot = session(31, {
    storageId: "second-canonical-project-coordinator",
    title: "Second canonical project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationTasks: [],
  });
  fixture.clay.sm.sessions.set(secondRoot.localId, secondRoot);

  function assertNoArbitraryRoot() {
    var projection = buildGlobalCoopProjection({ projects: [fixture.lead, fixture.clay] });
    assert.equal(projection.projects[0].summary.coordinatorTree.length, 0);
    assert.equal(projection.projects[0].summary.metrics.activeCoordinators, 0);
  }

  assertNoArbitraryRoot();
  var entries = Array.from(fixture.clay.sm.sessions.entries());
  fixture.clay.sm.sessions = new Map([[secondRoot.localId, secondRoot]].concat(entries.filter(function (entry) {
    return entry[0] !== secondRoot.localId;
  })));
  assertNoArbitraryRoot();
});

test("project summary helper fails closed without canonical Coop identity", function () {
  var fixture = coordinatorFixture();
  var summary = globalCoopProjection.summaryForProject({}, fixture.clay);
  assert.equal(summary.coordinatorTree.length, 0);
  assert.equal(summary.activeWork.length, 0);
  assert.equal(summary.metrics.activeCoordinators, 0);
  assert.equal(summary.metrics.activeWorkers, 0);
  assert.equal(summary.metrics.activeTaskWorkers, 0);
});

test("global Coop hierarchy caps third-level worker fan-out synchronously", function () {
  var fixture = coordinatorFixture();
  for (var i = 0; i < 30; i++) {
    var worker = session(100 + i, {
      storageId: "fanout-worker-" + i,
      title: "Fan-out worker " + i,
      coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
      orchestrationParent: {
        taskId: "fanout-task-" + i,
        sessionStorageId: fixture.clayActive.storageId,
      },
    });
    fixture.clayActive.orchestrationTasks.push(task("fanout-task-" + i, "running", worker));
    fixture.clay.sm.sessions.set(worker.localId, worker);
  }
  var projection = buildGlobalCoopProjection({ projects: [fixture.lead, fixture.clay] });
  var taskCoordinator = projection.projects[0].summary.coordinatorTree[0].children[0];
  assert.equal(taskCoordinator.children.length, 24);
  assert.equal(projection.projects[0].summary.metrics.activeTaskWorkers, 24);
  assert.equal(taskCoordinator.children[0].title, "Fan-out worker 29",
    "the synchronous cap retains the existing status and recency ordering");
});

function createElement(tag) {
  var node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    className: "",
    type: "",
    _text: "",
  };
  Object.defineProperty(node, "textContent", {
    get: function () {
      if (!node.children.length) return node._text;
      return node.children.map(function (child) { return child.textContent; }).join("");
    },
    set: function (value) { node._text = String(value); node.children = []; },
  });
  node.classList = {
    contains: function (name) { return node.className.split(/\s+/).indexOf(name) !== -1; },
  };
  node.setAttribute = function (name, value) { node.attributes[name] = String(value); };
  node.appendChild = function (child) { node.children.push(child); return child; };
  node.addEventListener = function (name, handler) { node.listeners[name] = handler; };
  return node;
}

function descendants(node) {
  var result = [];
  for (var i = 0; i < node.children.length; i++) {
    result.push(node.children[i]);
    result = result.concat(descendants(node.children[i]));
  }
  return result;
}

function byClass(node, className) {
  return descendants(node).filter(function (item) { return item.classList.contains(className); });
}

function moduleUrl(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function projectedProject(projectId, title, childTitle, workerTitle) {
  return {
    projectRef: { projectId: projectId },
    title: title,
    topics: [],
    summary: {
      coordinatorTree: [{
        sessionRef: { projectId: projectId, sessionStorageId: title.toLowerCase() + "-project-coordinator" },
        title: "Project coordinator",
        role: "project_coordinator",
        status: "queued",
        children: childTitle ? [{
          sessionRef: { projectId: projectId, sessionStorageId: title.toLowerCase() + "-task-coordinator" },
          title: childTitle,
          role: "task_coordinator",
          status: "running",
          taskRef: {
            projectId: projectId,
            coordinatorSessionStorageId: title.toLowerCase() + "-project-coordinator",
            taskId: title.toLowerCase() + "-task",
          },
          children: workerTitle ? [{
            sessionRef: { projectId: projectId, sessionStorageId: title.toLowerCase() + "-worker" },
            taskRef: {
              projectId: projectId,
              coordinatorSessionStorageId: title.toLowerCase() + "-task-coordinator",
              taskId: title.toLowerCase() + "-worker-task",
            },
            title: workerTitle,
            role: "worker",
            status: "running",
            children: [],
          }] : [],
        }] : [],
      }],
    },
  };
}

test("shared Coop renderer places only active project coordinator rows in desktop and mobile global sidebars", async function () {
  globalThis.document = { createElement: createElement };
  var modelModule = await import(moduleUrl("sidebar-coop-topic-model.js") + "?v=" + Date.now());
  var hierarchyModel = await import(moduleUrl("sidebar-coop-hierarchy-model.js") + "?v=" + Date.now());
  var renderer = await import(moduleUrl("sidebar-coop-hierarchy.js") + "?v=" + Date.now());
  var model = {
    hasProjection: true,
    projects: [
      projectedProject(CLAY, "Clay", "Show project coordinators in Coop sidebar", "Implement hierarchy projection"),
      projectedProject(WEBAPP, "Webapp", ""),
    ],
    uncategorisedTopics: [],
    crossProjectTopics: [],
  };
  var sections = modelModule.coopTopicSections(model);
  assert.deepEqual(sections.map(function (section) { return section.label; }), ["Project coordinators"],
    "project roots share one global Coop group even when no Thread row exists");
  assert.deepEqual(sections[0].coordinators.map(function (coordinator) {
    return coordinator.label;
  }), ["Clay"]);

  var normalized = hierarchyModel.cloneCoopProjectHierarchy(model.projects[0].summary.coordinatorTree);
  assert.equal(normalized[0].children[0].children[0].role, "worker");
  assert.equal(normalized[0].children[0].children[0].taskRef.taskId, "clay-worker-task");

  var sent = [];
  var desktop = createElement("div");
  var mobile = createElement("div");
  for (var i = 0; i < sections[0].coordinators.length; i++) {
    renderer.renderCoopProjectHierarchy(desktop, sections[0].coordinators[i].hierarchy, {
      mobile: false, send: function (message) { sent.push(message); return true; },
    });
    renderer.renderCoopProjectHierarchy(mobile, sections[0].coordinators[i].hierarchy, {
      mobile: true, send: function () { return true; },
    });
  }

  var desktopRows = byClass(desktop, "coop-project-coordinator-row");
  var mobileRows = byClass(mobile, "mobile-coop-project-coordinator-row");
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("root"); }).length, 1);
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("child"); }).length, 1);
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("grandchild"); }).length, 1);
  assert.equal(mobileRows.filter(function (row) { return row.classList.contains("root"); }).length, 1);
  assert.equal(mobileRows.filter(function (row) { return row.classList.contains("child"); }).length, 1);
  assert.equal(mobileRows.filter(function (row) { return row.classList.contains("grandchild"); }).length, 1);
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("child"); })[0]
    .children[1].textContent,
    "Show project coordinators in Coop sidebar");
  var desktopWorker = desktopRows.filter(function (row) { return row.classList.contains("grandchild"); })[0];
  assert.equal(desktopWorker.children[0].attributes.title, "Working",
    "the status marker keeps the project-session tooltip interaction");
  desktopWorker.listeners.click();
  assert.deepEqual(sent[sent.length - 1], {
    type: "resolve_session_ref",
    sessionRef: { projectId: CLAY, sessionStorageId: "clay-worker" },
    scope: "owner_request_hierarchy",
  }, "clicking a worker opens its exact canonical SessionRef");
});

test("desktop and mobile sidebars omit completed terminal task coordinators", async function () {
  globalThis.document = { createElement: createElement };
  var modelModule = await import(moduleUrl("sidebar-coop-topic-model.js") + "?terminal=" + Date.now());
  var hierarchyModel = await import(moduleUrl("sidebar-coop-hierarchy-model.js") + "?terminal=" + Date.now());
  var renderer = await import(moduleUrl("sidebar-coop-hierarchy.js") + "?terminal=" + Date.now());
  var terminalProject = projectedProject(CLAY, "Clay", "Completed visible task coordinator", "");
  var terminal = terminalProject.summary.coordinatorTree[0].children[0];
  terminal.status = "completed";
  var model = {
    hasProjection: true,
    projects: [terminalProject],
    uncategorisedTopics: [],
    crossProjectTopics: [],
  };
  var sections = modelModule.coopTopicSections(model);
  var normalized = hierarchyModel.cloneCoopProjectHierarchy(
    terminalProject.summary.coordinatorTree);
  assert.deepEqual(sections, []);
  assert.deepEqual(normalized, []);

  var desktopSent = [];
  var mobileSent = [];
  var desktop = createElement("div");
  var mobile = createElement("div");
  assert.equal(renderer.renderCoopProjectHierarchy(desktop, normalized, {
    mobile: false,
    send: function (message) { desktopSent.push(message); return true; },
  }), 0);
  assert.equal(renderer.renderCoopProjectHierarchy(mobile, normalized, {
    mobile: true,
    send: function (message) { mobileSent.push(message); return true; },
  }), 0);
  assert.deepEqual(desktopSent, []);
  assert.deepEqual(mobileSent, []);
  assert.equal(byClass(desktop, "coop-project-coordinator-row").length, 0);
  assert.equal(byClass(mobile, "mobile-coop-project-coordinator-row").length, 0);
});

test("desktop and mobile render a navigable Thread container above task coordinators", async function () {
  globalThis.document = { createElement: createElement };
  var projectionClient = await import(moduleUrl("global-coop-projection.js"));
  var renderer = await import(moduleUrl("sidebar-coop-hierarchy.js") + "?thread=" + Date.now());
  var topicRef = { topicId: "auto-309310309310309310309310" };
  var hierarchy = [{
    sessionRef: { projectId: "system-lead", sessionStorageId: "clay-project-coordinator" },
    title: "Clay coordinator",
    role: "project_coordinator",
    status: "persistent",
    children: [{
      sessionRef: null,
      topicRef: topicRef,
      threadRef: { threadId: topicRef.topicId },
      projectRef: null,
      title: "Complete Thread containers and evolving titles",
      role: "thread",
      status: "needs_input",
      threadState: "handed_off",
      controlResults: [{
        role: "triage",
        title: "Triage Threads V2 routing",
        summary: "Main remains the safe fallback.",
        topicRef: topicRef,
      }],
      children: [{
        sessionRef: { projectId: CLAY, sessionStorageId: "implementation-coordinator" },
        title: "Implementation coordinator",
        role: "task_coordinator",
        status: "running",
        dependencyState: "independent",
        children: [{
          sessionRef: { projectId: CLAY, sessionStorageId: "desktop-worker" },
          title: "Desktop verification",
          role: "worker",
          status: "running",
          children: [],
        }],
      }, {
        sessionRef: { projectId: CLAY, sessionStorageId: "mobile-coordinator" },
        title: "Mobile verification coordinator",
        role: "task_coordinator",
        status: "running",
        dependencyState: "independent",
        children: [],
      }, {
        sessionRef: { projectId: CLAY, sessionStorageId: "integration-coordinator" },
        title: "Integrated verification coordinator",
        role: "task_coordinator",
        status: "queued",
        dependencyState: "waiting",
        dependencies: [{
          projectId: "system-lead",
          coordinatorSessionStorageId: "clay-project-coordinator",
          taskId: "implementation-task",
        }],
        children: [],
      }],
    }],
  }];
  projectionClient.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: { localId: 1 },
    projects: [{
      projectRef: { projectId: CLAY },
      slug: "clay",
      title: "Clay",
      summary: { coordinatorTree: hierarchy },
    }],
    topics: [{
      topicRef: topicRef,
      threadRef: { threadId: topicRef.topicId },
      projectRef: null,
      title: "Complete Thread containers and evolving titles",
      threadState: "handed_off",
      status: "open",
    }],
  });
  var sent = [];
  var desktop = createElement("div");
  var mobile = createElement("div");
  renderer.renderCoopProjectHierarchy(desktop, hierarchy, {
    mobile: false,
    send: function (message) { sent.push(message); return true; },
  });
  renderer.renderCoopProjectHierarchy(mobile, hierarchy, {
    mobile: true,
    send: function () { return true; },
  });

  var desktopRows = byClass(desktop, "coop-project-coordinator-row");
  var mobileRows = byClass(mobile, "mobile-coop-project-coordinator-row");
  assert.equal(byClass(desktop, "coop-control-result").length, 0,
    "control evidence is rendered only in the dedicated role section");
  assert.equal(byClass(mobile, "mobile-coop-control-result").length, 0,
    "mobile control evidence is rendered only in the dedicated role section");
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("child"); }).length, 1);
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("grandchild"); }).length, 3);
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("greatgrandchild"); }).length, 1);
  assert.equal(mobileRows.filter(function (row) { return row.classList.contains("child"); }).length, 1);
  assert.equal(mobileRows.filter(function (row) { return row.classList.contains("grandchild"); }).length, 3);
  assert.equal(mobileRows.filter(function (row) { return row.classList.contains("greatgrandchild"); }).length, 1);
  var threadRow = desktopRows.filter(function (row) { return row.classList.contains("child"); })[0];
  assert.equal(threadRow.children[1].textContent,
    "Complete Thread containers and evolving titles");
  assert.equal(threadRow.children[0].attributes.title, "Needs input");
  var dependencyRow = desktopRows.filter(function (row) {
    return row.children[1].textContent === "Integrated verification coordinator";
  })[0];
  assert.equal(dependencyRow.children[0].attributes.title, "Waiting on dependencies");
  threadRow.listeners.click();
  assert.deepEqual(sent[sent.length - 1], {
    type: "coop_topic_select",
    topicRef: topicRef,
    projectRef: null,
    historyScope: "topic",
  }, "clicking the nested container opens the same canonical Thread lens");
});
