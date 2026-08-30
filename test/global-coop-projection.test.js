var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var buildGlobalCoopProjection = require("../lib/global-coop-projection").buildGlobalCoopProjection;
var createTopicIndex = require("../lib/coop-topic-index").createTopicIndex;

function session(id, value) {
  return Object.assign({
    localId: id,
    storageId: "session-" + id,
    title: "Session " + id,
    lastActivity: 10,
  }, value || {});
}

function project(projectId, slug, sessions, extra) {
  var manager = {
    sessions: new Map(sessions.map(function (item) { return [item.localId, item]; })),
    saveSessionFile: function () {},
    createSessionRaw: function (options) {
      var created = session(this.sessions.size + 100, options);
      this.sessions.set(created.localId, created);
      return created;
    },
  };
  return Object.assign({
    projectId: projectId,
    slug: slug,
    title: slug,
    sm: manager,
  }, extra || {});
}

function controlSession(id, role, title, extra) {
  return session(id, Object.assign({
    title: title,
    coordinationRole: "coop_control_plane",
    orchestrationPolicy: {
      coopControlPlane: { version: 1, role: role, projectRef: null, createdAt: 1 },
    },
  }, extra || {}));
}

test("exact Council and archived Triage executions project without persistent placeholders or duplicates", function () {
  var clayId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var topicRef = { topicId: "threads-v2" };
  var home = session(1, { storageId: "coop-home", coopHome: true, history: [] });
  var placeholderCouncil = controlSession(2, "council", "Council");
  var placeholderTriage = controlSession(3, "triage", "Triage");
  var rootRef = { projectId: "system-lead", sessionStorageId: "clay-root" };
  var root = session(4, {
    storageId: rootRef.sessionStorageId,
    title: "Clay coordinator",
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: home.storageId, since: 1 },
    orchestrationPolicy: { coopControlPlane: {
      version: 1, role: "project_coordinator", projectRef: { projectId: clayId }, createdAt: 1,
    } },
    orchestrationTasks: [{
      taskId: "council-task", clientRef: "portfolio:threads-v2-council-review:1",
      title: "Council: shape Threads V2", status: "running", externalTaskCoordinator: true,
      workerStorageId: "council-execution",
      workerSessionRef: { projectId: clayId, sessionStorageId: "council-execution" },
      coopTopicRef: topicRef,
    }, {
      taskId: "triage-task", clientRef: "portfolio:threads-v2-triage-review:1",
      title: "Triage Threads V2 routing", status: "completed", externalTaskCoordinator: true,
      workerStorageId: "triage-execution",
      workerSessionRef: { projectId: clayId, sessionStorageId: "triage-execution" },
      coopTopicRef: topicRef,
    }, {
      taskId: "ordinary-task", title: "Implement the accepted repair", status: "running",
      externalTaskCoordinator: true, workerStorageId: "ordinary-execution",
      workerSessionRef: { projectId: clayId, sessionStorageId: "ordinary-execution" },
      coopTopicRef: topicRef,
    }],
  });
  var council = session(20, {
    storageId: "council-execution",
    title: "Council: shape Threads V2",
    isProcessing: true,
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    projectCoordinatorRef: rootRef,
    coopControlledBy: { coopSessionStorageId: root.storageId, since: 1 },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "threads-v2-council-review", bindingRevision: 1,
      idempotencyKey: "threads-v2-council-review-r1", mode: "project_coordinator",
      controlRole: "council", reviewOnly: true, status: "running", updatedAt: 20,
    } },
  });
  var triage = session(21, {
    storageId: "triage-execution",
    title: "Triage Threads V2 routing",
    hidden: true,
    closedAt: 30,
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    projectCoordinatorRef: rootRef,
    coopControlledBy: { coopSessionStorageId: root.storageId, since: 1 },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "threads-v2-triage-review", bindingRevision: 1,
      idempotencyKey: "threads-v2-triage-review-r1", mode: "project_coordinator",
      status: "completed", completedAt: 30, updatedAt: 30,
    } },
    orchestrationProjectCompletion: {
      status: "completed", summary: "Triage kept Main as the safe fallback.",
      verification: "171 focused tests passed.", completedAt: 30,
    },
  });
  var ordinary = session(22, {
    storageId: "ordinary-execution",
    title: "Implement the accepted repair",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    projectCoordinatorRef: rootRef,
    coopControlledBy: { coopSessionStorageId: root.storageId, since: 1 },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "threads-v2-repair", bindingRevision: 1,
      idempotencyKey: "threads-v2-repair-r1", mode: "project_coordinator",
      status: "running", updatedAt: 25,
    } },
  });
  var ownerDirect = session(23, { title: "Owner direct conversation" });
  var lead = project("system-lead", "lead",
    [home, placeholderCouncil, placeholderTriage, root], { isLead: true });
  var clay = project(clayId, "clay", [council, triage, ordinary, ownerDirect], { title: "Clay" });
  var topicIndex = {
    ensureRetro: function () { return { ok: true }; },
    project: function () { return { groups: [{ kind: "uncategorised", topics: [{
      topicRef: topicRef, title: "Threads V2", status: "open", threadState: "exploring",
    }] }] }; },
  };

  var projection = buildGlobalCoopProjection({
    projects: [lead, clay], coopTopicIndex: topicIndex,
    canAccessProject: function () { return true; },
    canAccessSession: function () { return true; },
    canAccessArchivedSession: function () { return true; },
  });

  assert.deepEqual(projection.controlPlaneSessions.map(function (item) {
    return [item.role, item.title, item.sessionRef.projectId,
      item.sessionRef.sessionStorageId, item.status, item.processing];
  }), [["council", "Council: shape Threads V2", clayId,
    "council-execution", "running", true]]);
  assert.deepEqual(projection.controlPlaneResults.map(function (item) {
    return [item.role, item.title, item.summary, item.topicRef.topicId];
  }), [["triage", "Triage Threads V2 routing",
    "Triage kept Main as the safe fallback.", "threads-v2"]]);
  assert.equal(projection.topics[0].controlResults[0].summary,
    "Triage kept Main as the safe fallback.");
  assert.deepEqual(projection.projects[0].summary.coordinatorTree[0].children.map(function (item) {
    return item.sessionRef.sessionStorageId;
  }), ["ordinary-execution"], "Council is not duplicated under Clay's generic task hierarchy");
  assert.equal(JSON.stringify(projection).includes("Owner direct conversation"), false);

  var privateArchive = buildGlobalCoopProjection({
    projects: [lead, clay], coopTopicIndex: topicIndex,
    canAccessProject: function () { return true; },
    canAccessSession: function () { return true; },
    canAccessArchivedSession: function () { return false; },
  });
  assert.deepEqual(privateArchive.controlPlaneResults, [],
    "archived result evidence preserves the session ACL boundary");

  council.isProcessing = false;
  council.orchestrationPolicy.portfolioExecution.status = "needs_input";
  council.orchestrationPolicy.portfolioExecution.updatedAt = 40;
  var waiting = buildGlobalCoopProjection({
    projects: [lead, clay], coopTopicIndex: topicIndex,
    canAccessProject: function () { return true; },
    canAccessSession: function () { return true; },
  });
  assert.equal(waiting.controlPlaneSessions[0].status, "needs_input");
  assert.equal(waiting.controlPlaneSessions[0].processing, false,
    "waiting remains visible without a processing pulse");
});

test("a canonical Coop plan decision projects into the owner work ledger", function () {
  var clayId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var topicRef = { topicId: "post-council-plan" };
  var home = session(1, {
    storageId: "coop-plan-home",
    coopHome: true,
    orchestrationTasks: [{
      taskId: "plan-decision",
      clientRef: "owner-decision:owner-decision-123",
      title: "Owner decision: coherent role plan revision 1",
      status: "needs_input",
      userQuestion: "Accept these Council-derived defaults?",
      coopTopicRef: topicRef,
      updatedAt: 20,
      ownerDecision: {
        version: 1,
        decisionRef: "owner-decision-123",
        state: "unanswered",
        scope: {
          targetProject: { projectId: clayId }, portfolioTaskId: "coherent-role-plan",
          bindingRevision: 1, planRevision: 1, planDigest: "0123456789abcdef",
          coopTopicRef: topicRef,
        },
        createdAt: 10,
      },
    }],
  });
  var lead = project("system-lead", "lead", [home], { isLead: true });
  var clay = project(clayId, "clay", []);
  var index = {
    ensureRetro: function () { return { ok: true }; },
    project: function () {
      return { groups: [{ kind: "project", projectRef: { projectId: clayId }, topics: [{
        topicRef: topicRef, title: "Post-Council plan", status: "open", threadState: "exploring",
        projectRef: { projectId: clayId },
      }] }] };
    },
  };
  var projection = buildGlobalCoopProjection({
    projects: [lead, clay], coopTopicIndex: index,
    canAccessProject: function () { return true; },
    canAccessSession: function () { return true; },
  });
  assert.deepEqual(projection.actionQueue.map(function (item) {
    return [item.projectRef.projectId, item.taskId, item.status, item.topicRef.topicId];
  }), [["system-lead", "plan-decision", "needs_input", "post-council-plan"]]);
  assert.deepEqual(projection.ownerSidebar.open.map(function (entry) {
    return [entry.entryId, entry.reason, entry.topicRef.topicId];
  }), [["system-lead|owner-decision:owner-decision-123", "Accept these Council-derived defaults?", "post-council-plan"]]);
});

test("workspace work context hydrates compacted owner ingress and collapses one typed work item", function () {
  // Regression fixture for the Owner Work screenshot: follow-up ingresses in a
  // compacted Coop continuation used to render as repeated "Owner request #n"
  // rows because the display projection consulted only a warmed Topic title.
  var clayId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var oldId = "owner-work-before-compaction";
  var homeId = "owner-work-after-compaction";
  var topicRef = { topicId: "workspace-context" };
  var ingressOne = "coop:" + oldId + ":1";
  var ingressTwo = "coop:" + homeId + ":2";
  var ingressThree = "coop:" + homeId + ":3";
  var predecessor = session(1, { storageId: oldId, hidden: true, history: [{
    type: "user_message", coopIngressId: ingressOne,
    text: "Workspace session context is still vague after the first repair.",
  }] });
  var home = session(2, { storageId: homeId, coopHome: true,
    compactedFromStorageId: oldId, history: [{
      type: "user_message", coopIngressId: ingressTwo,
      text: "Fix Workspace context across Owner Work, Council, and Triage.",
    }, {
      type: "user_message", coopIngressId: ingressThree,
      text: "The same canonical workspace work is still missing useful context.",
    }],
  });
  var lead = project("system-lead", "lead", [predecessor, home], { isLead: true });
  var clay = project(clayId, "clay", [] , { title: "Clay" });
  var requests = [{
    ingressId: ingressOne, ingressSequence: 1, state: "open", receivedAt: 10, updatedAt: 10,
    requestRef: { projectId: "system-lead", sessionStorageId: oldId, eventIndex: 0 },
    response: { state: "unanswered" }, projectRefs: [{ projectId: clayId }], links: {},
  }, {
    ingressId: ingressTwo, ingressSequence: 2, state: "working", receivedAt: 20, updatedAt: 20,
    topicRef: topicRef,
    requestRef: { projectId: "system-lead", sessionStorageId: homeId, eventIndex: 0 },
    response: { state: "unanswered" }, projectRefs: [{ projectId: clayId }], links: {
      tasks: [{ projectId: clayId, taskId: "workspace-context-fix" }],
    },
  }, {
    ingressId: ingressThree, ingressSequence: 3, state: "working", receivedAt: 30, updatedAt: 30,
    topicRef: topicRef,
    requestRef: { projectId: "system-lead", sessionStorageId: homeId, eventIndex: 1 },
    response: { state: "unanswered" }, projectRefs: [{ projectId: clayId }], links: {},
  }, {
    ingressId: "coop:malformed:4", ingressSequence: 4, state: "open", receivedAt: 40, updatedAt: 40,
    requestRef: { projectId: "wrong-project", sessionStorageId: "missing", eventIndex: 0 },
    response: { state: "unanswered" }, projectRefs: [], links: {},
  }];
  var index = {
    ensureRetro: function () { return { ok: true }; },
    project: function () { return { groups: [{ kind: "project", projectRef: { projectId: clayId }, topics: [{
      topicRef: topicRef, title: "Fix Workspace context across Owner Work, Council, and Triage",
      status: "open", threadState: "exploring", projectRef: { projectId: clayId },
    }] }] }; },
  };
  var projection = buildGlobalCoopProjection({
    projects: [lead, clay], coopTopicIndex: index, ownerRequests: requests,
    portfolioBindings: [{ portfolioTaskId: "workspace-context-fix", bindingRevision: 1,
      targetProject: { projectId: clayId }, coopTopicRef: topicRef, status: "running", updatedAt: 50,
      coordinator: { projectId: clayId, sessionStorageId: "workspace-worker" } }],
    ownerLedgerSessions: [{ sessionRef: { projectId: clayId, sessionStorageId: "workspace-worker" },
      title: "Workspace context coordinator", role: "task_coordinator", lifecycleState: "running",
      coopTopicRef: topicRef, updatedAt: 50 }],
    canAccessProject: function () { return true; }, canAccessSession: function () { return true; },
  });
  var rows = projection.ownerSidebar.open;
  var hydrated = rows.find(function (row) { return row.ingressId === ingressOne; });
  var merged = rows.find(function (row) { return row.ingressIds.indexOf(ingressTwo) !== -1; });
  var malformed = rows.find(function (row) { return row.ingressId === "coop:malformed:4"; });
  assert.equal(rows.length, 3, "two lifecycle records for one TopicRef/task collapse into one row");
  assert.equal(hydrated.title, "Workspace session context is still vague after the first repair.");
  assert.deepEqual(hydrated.sourceSessionRef, { projectId: "system-lead", sessionStorageId: oldId },
    "the original compacted session remains a stable destination");
  assert.equal(merged.title, "Fix Workspace context across Owner Work, Council, and Triage");
  assert.equal(merged.status, "working");
  assert.deepEqual(merged.ingressIds, [ingressTwo, ingressThree]);
  assert.equal(merged.canonicalKey, "task:" + clayId + ":workspace-context-fix");
  assert.deepEqual(merged.projects, [{ projectRef: { projectId: clayId }, title: "Clay" }]);
  assert.equal(merged.sessions[0].sessionRef.sessionStorageId, "workspace-worker");
  assert.match(malformed.title, /^Owner work context unavailable/, "malformed provenance fails closed");
  assert.equal(malformed.sourceSessionRef, null, "malformed provenance cannot become a navigable source link");
  assert.equal(rows.some(function (row) { return /^Owner request\s*#/i.test(row.title); }), false);
});

test("Coop projects each accessible configured project into a main-lane lens with canonical nested sessions", function () {
  var home = session(1, { storageId: "coop-home", coopHome: true });
  var lead = project("system-lead", "lead", [home], { isLead: true });
  var task = {
    taskId: "active-work",
    title: "Fix project switch",
    objective: "Keep project navigation isolated",
    status: "running",
    currentActivity: "Adding target-keyed cache",
    updatedAt: 20,
  };
  var coordinator = session(10, {
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationTasks: [task],
    orchestrationProjectCompletion: {
      status: "completed",
      summary: "Earlier verified release",
      completedAt: 15,
    },
  });
  var directOwnerSession = session(11, { title: "Owner direct conversation" });
  var worker = session(12, {
    title: "Canonical worker",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { sessionStorageId: coordinator.storageId, taskId: task.taskId },
  });
  task.workerSessionId = worker.localId;
  task.workerStorageId = worker.storageId;
  var clay = project("11111111-1111-5111-8111-111111111111", "clay", [coordinator, directOwnerSession, worker], { title: "Clay" });
  var worktree = project("22222222-2222-5222-8222-222222222222", "clay--feature", [], { isWorktree: true });
  var mate = project("33333333-3333-5333-8333-333333333333", "mate-ada", [], { isMate: true });

  var projection = buildGlobalCoopProjection({ projects: [lead, clay, worktree, mate] });

  assert.equal(projection.coop.sessionRef.projectId, "system-lead");
  assert.equal(projection.projects.length, 1);
  var channel = projection.projects[0];
  assert.deepEqual(channel.projectRef, { projectId: clay.projectId });
  assert.equal(channel.channel.sessionRef.projectId, "system-lead");
  assert.equal(channel.channel.sessionRef.sessionStorageId, "coop-home");
  assert.equal(channel.channel.isLens, true);
  assert.equal(channel.summary.goals[0], "Keep project navigation isolated");
  assert.equal(channel.summary.activeWork[0].title, "Fix project switch");
  assert.equal(channel.summary.outcomes[0].summary, "Earlier verified release");
  assert.match(channel.summary.nextAction, /active delegated work/);
  assert.equal(Object.hasOwn(channel, "coordinators"), false);
  assert.equal(Object.hasOwn(channel, "directLeaves"), false);
  assert.equal(JSON.stringify(channel).includes("Owner direct conversation"), false);
  assert.equal(channel.summary.metrics.activeCoordinators, 1);
  assert.equal(channel.summary.metrics.activeWorkers, 1);
  assert.equal(channel.summary.coordinatorTree[0].sessionRef.projectId, clay.projectId);
  assert.equal(channel.summary.coordinatorTree[0].children[0].sessionRef.sessionStorageId, worker.storageId);

  var second = buildGlobalCoopProjection({ projects: [lead, clay] });
  assert.equal(second.projects[0].channel.sessionRef.sessionStorageId,
    channel.channel.sessionRef.sessionStorageId);
});

test("temporary worktree sessions project through their canonical parent ProjectRef", function () {
  var clayId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var home = session(1, { storageId: "coop-home", coopHome: true });
  var lead = project("system-lead", "lead", [home], { isLead: true });
  var coordinator = session(2, {
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: home.storageId, since: 1 },
    orchestrationTasks: [{
      taskId: "temporary-worktree-task",
      title: "Canonical worktree task",
      status: "running",
      updatedAt: 20,
    }],
  });
  var parent = project(clayId, "clay", [], { title: "Clay" });
  var worktree = project(clayId, "clay--temporary", [coordinator], {
    isWorktree: true,
    parentSlug: "clay",
    parentProjectId: clayId,
  });

  var controlManager = null;
  var projection = buildGlobalCoopProjection({
    projects: [lead, parent, worktree],
    ensureControlPlane: function (input) {
      controlManager = input.projects[0].manager;
    },
  });

  assert.equal(projection.projects.length, 1);
  assert.deepEqual(projection.projects[0].projectRef, { projectId: clayId });
  assert.equal(projection.projects[0].summary.activeWork[0].title, "Canonical worktree task");
  assert.equal(typeof controlManager.createSessionRaw, "function",
    "canonical control-plane maintenance keeps the parent manager write surface");
  assert.equal(controlManager.createSessionRaw({ storageId: "parent-only" }).storageId, "parent-only");
  assert.equal(parent.sm.sessions.has(100), true,
    "the aggregate manager writes to the canonical parent, not the temporary runtime");
});

test("canonical project coordinator activity is summarized from the bound project session", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var coop = session(1, { storageId: "canonical-coop", coopHome: true });
  var rootRef = { projectId: "system-lead", sessionStorageId: "control-root" };
  var currentRef = { projectId: projectId, sessionStorageId: "current-coordinator" };
  var current = session(10, {
    storageId: currentRef.sessionStorageId,
    title: "Fix current project visibility",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: rootRef.sessionStorageId, since: 20 },
    projectCoordinatorRef: rootRef,
    orchestrationPolicy: { portfolioExecution: {
      mode: "project_coordinator", status: "running", portfolioTaskId: "visibility-task",
      bindingRevision: 1, idempotencyKey: "visibility-task-r1",
    } },
    currentActivity: "Project coordinator is active",
  });
  var terminal = session(11, {
    storageId: "terminal-coordinator",
    coordinationRole: "task_coordinator",
    hidden: true,
    projectCoordinatorRef: rootRef,
    coopControlledBy: { coopSessionStorageId: rootRef.sessionStorageId, since: 20 },
    orchestrationPolicy: { portfolioExecution: {
      mode: "project_coordinator", status: "completed", portfolioTaskId: "old-task",
      bindingRevision: 1, idempotencyKey: "old-task-r1",
    } },
  });
  var root = session(2, {
    storageId: rootRef.sessionStorageId,
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: coop.storageId, since: 20 },
    orchestrationPolicy: { coopControlPlane: {
      version: 1, role: "project_coordinator", projectRef: { projectId: projectId }, createdAt: 20,
    } },
    orchestrationTasks: [{
      taskId: "visibility-root-task", title: current.title, status: "running",
      currentActivity: current.currentActivity, externalTaskCoordinator: true,
      workerStorageId: current.storageId, workerSessionRef: currentRef, updatedAt: 30,
    }, {
      taskId: "old-root-task", title: "Old coordinator", status: "completed",
      externalTaskCoordinator: true, workerStorageId: terminal.storageId,
      workerSessionRef: { projectId: projectId, sessionStorageId: terminal.storageId }, updatedAt: 25,
    }],
  });
  var lead = project("system-lead", "lead", [coop, root], { isLead: true });
  var target = project(projectId, "clay", [current, terminal]);
  var projection = buildGlobalCoopProjection({ projects: [lead, target] });
  var summary = projection.projects[0].summary;

  assert.deepEqual(summary.activeWork.map(function (item) {
    return [item.title, item.status, item.activity];
  }), [[current.title, "running", current.currentActivity]]);
  assert.equal(JSON.stringify(summary.activeWork).includes("terminal-coordinator"), false);
  assert.equal(summary.coordinatorTree[0].children[0].sessionRef.sessionStorageId,
    currentRef.sessionStorageId);
});

test("Coop projection keeps one persistent project root and retained terminal children out of active metrics", function () {
  var home = session(1, { storageId: "coop-home", coopHome: true });
  var lead = project("system-lead", "lead", [home], { isLead: true });
  var clayId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var webappId = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

  function controlled(id, value) {
    return session(id, Object.assign({
      coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    }, value || {}));
  }

  function projectRoot(id, storageId, tasks) {
    return controlled(id, {
      storageId: storageId,
      title: "Project coordinator",
      coordinationMode: true,
      coordinationRole: "project_coordinator",
      orchestrationTasks: tasks,
    });
  }

  var clayRoot = projectRoot(10, "clay-project-root", [{
    taskId: "active-task", status: "running",
  }, {
    taskId: "attention-task", status: "needs_input",
  }, {
    taskId: "completed-task", status: "completed",
  }]);
  var clayActive = controlled(11, {
    storageId: "clay-active-task", title: "Active task coordinator",
    coordinationMode: true, coordinationRole: "task_coordinator",
    orchestrationParent: { sessionStorageId: clayRoot.storageId, taskId: "active-task" },
  });
  var clayAttention = controlled(12, {
    storageId: "clay-attention-task", title: "Attention task coordinator",
    coordinationMode: true, coordinationRole: "task_coordinator",
    orchestrationParent: { sessionStorageId: clayRoot.storageId, taskId: "attention-task" },
  });
  var clayCompleted = controlled(13, {
    storageId: "clay-completed-task", title: "Completed task coordinator",
    coordinationMode: true, coordinationRole: "task_coordinator",
    orchestrationParent: { sessionStorageId: clayRoot.storageId, taskId: "completed-task" },
  });
  clayRoot.orchestrationTasks[0].workerSessionId = clayActive.localId;
  clayRoot.orchestrationTasks[0].workerStorageId = clayActive.storageId;
  clayRoot.orchestrationTasks[1].workerSessionId = clayAttention.localId;
  clayRoot.orchestrationTasks[1].workerStorageId = clayAttention.storageId;
  clayRoot.orchestrationTasks[2].workerSessionId = clayCompleted.localId;
  clayRoot.orchestrationTasks[2].workerStorageId = clayCompleted.storageId;
  var ownerCoordinator = session(14, {
    storageId: "owner-direct-coordinator", title: "Owner direct coordinator",
    coordinationMode: true,
  });

  var webappRoot = projectRoot(20, "webapp-project-root", [{
    taskId: "webapp-completed", status: "completed",
  }]);
  var webappCompleted = controlled(21, {
    storageId: "webapp-completed-task", title: "Completed Webapp task coordinator",
    coordinationMode: true, coordinationRole: "task_coordinator",
    orchestrationParent: { sessionStorageId: webappRoot.storageId, taskId: "webapp-completed" },
  });
  webappRoot.orchestrationTasks[0].workerSessionId = webappCompleted.localId;
  webappRoot.orchestrationTasks[0].workerStorageId = webappCompleted.storageId;

  var clay = project(clayId, "clay", [
    clayRoot, clayActive, clayAttention, clayCompleted, ownerCoordinator,
  ], { title: "Clay" });
  var webapp = project(webappId, "webapp", [webappRoot, webappCompleted], { title: "Webapp" });
  var projection = buildGlobalCoopProjection({ projects: [lead, clay, webapp] });

  assert.deepEqual(projection.projects.map(function (item) { return item.title; }), ["Clay", "Webapp"]);
  var clayTree = projection.projects[0].summary.coordinatorTree;
  assert.equal(clayTree.length, 1);
  assert.equal(clayTree[0].sessionRef.sessionStorageId, clayRoot.storageId);
  assert.deepEqual(clayTree[0].children.map(function (child) {
    return [child.sessionRef.sessionStorageId, child.status];
  }), [
    [clayActive.storageId, "running"],
    [clayAttention.storageId, "needs_input"],
    [clayCompleted.storageId, "completed"],
  ]);
  assert.equal(JSON.stringify(clayTree).includes(clayCompleted.storageId), true);
  assert.equal(JSON.stringify(clayTree).includes(ownerCoordinator.storageId), false);

  var webappTree = projection.projects[1].summary.coordinatorTree;
  assert.equal(webappTree.length, 1, "the reusable project row remains after its child completes");
  assert.equal(webappTree[0].sessionRef.sessionStorageId, webappRoot.storageId);
  assert.deepEqual(webappTree[0].children.map(function (child) {
    return [child.sessionRef.sessionStorageId, child.status];
  }), [[webappCompleted.storageId, "completed"]]);
  assert.equal(JSON.stringify(webappTree).includes(webappCompleted.storageId), true);
});

test("Coop summary applies project ACLs and summarizes attention without exposing attempts", function () {
  var lead = project("system-lead", "lead", [session(1, { storageId: "coop-home", coopHome: true })], { isLead: true });
  var blocked = session(2, {
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationTasks: [{
      taskId: "needs-owner",
      title: "Choose owner",
      status: "needs_input",
      userQuestion: "Which owner should approve this?",
      workerStorageId: "hidden-worker",
      attempt: 3,
    }],
  });
  var visible = project("44444444-4444-5444-8444-444444444444", "visible", [blocked]);
  var denied = project("55555555-5555-5555-8555-555555555555", "denied", []);
  var projection = buildGlobalCoopProjection({
    projects: [lead, visible, denied],
    canAccessProject: function (_, item) { return item !== denied; },
  });

  assert.deepEqual(projection.projects.map(function (item) { return item.slug; }), ["visible"]);
  assert.equal(projection.projects[0].summary.attention[0].title, "Choose owner");
  assert.match(projection.projects[0].summary.nextAction, /resolve attention/);
  assert.equal(JSON.stringify(projection.projects[0]).includes("hidden-worker"), false);
  assert.equal(JSON.stringify(projection.projects[0]).includes("attempt"), false);
});

test("global Coop projection exposes bounded topic lenses and revokes denied project topics", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-global-topic-"));
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var home = session(1, {
      storageId: "canonical-topic-home", coopHome: true,
      history: [
        { type: "user_message", text: "Navigation session restoration and sidebar", from: "owner", fromName: "Admin", clientMessageId: "cm-fixture" },
        { type: "delta_replace", text: "The navigation restoration is complete." },
        { type: "done" },
      ],
    });
    var lead = project("system-lead", "lead", [home], { isLead: true });
    var clay = project("5332aafc-31e7-5cb1-ba96-c8d90e78260e", "clay", []);
    buildGlobalCoopProjection({ projects: [lead, clay], coopTopicIndex: index });
    assert.equal(index.addEventMembership({ topicId: "navigation-session-restoration" }, [
      { eventIndex: 1 }, { eventIndex: 2 },
    ]).ok, true);
    var durableNavigation = index.resolve({ topicId: "navigation-session-restoration" }).topic;
    for (var eventIndex = 3; eventIndex < 21000; eventIndex++) {
      durableNavigation.eventRefs.push({
        projectId: "system-lead", sessionStorageId: "canonical-topic-home", eventIndex: eventIndex,
      });
    }
    var visible = buildGlobalCoopProjection({ projects: [lead, clay], coopTopicIndex: index });
    var navigation = visible.topics.find(function (topic) { return topic.topicRef.topicId === "navigation-session-restoration"; });
    assert.equal(navigation.projectRef.projectId, clay.projectId);
    assert.equal(navigation.group, "project");
    assert.deepEqual(navigation.canonicalEvents[0].eventRef, {
      eventKey: "canonical:canonical-topic-home:0", projectId: "system-lead",
      sessionStorageId: "canonical-topic-home", eventIndex: 0,
    });
    assert.equal(navigation.eventCount, 21000);
    assert.equal(navigation.turnCount, 1);
    assert.equal(navigation.canonicalEvents.length, 2);
    assert.equal(navigation.lastEventRef.eventIndex, 20999);
    assert.equal(Object.hasOwn(navigation, "canonicalTurnRanges"), false);
    assert.equal(navigation.status, "open");
    assert.equal(navigation.rollingSummary, "1 canonical turn");
    assert.equal(JSON.stringify(navigation).includes("Navigation session restoration and sidebar"), false);
    assert.equal(index.resolve({ topicId: "navigation-session-restoration" }).topic.eventRefs.length, 21000,
      "full membership remains in the server-side durable index");
    var rawTopic = visible.topicProjection.groups.reduce(function (found, group) {
      return found || group.topics.find(function (topic) { return topic.topicRef.topicId === "navigation-session-restoration"; });
    }, null);
    assert.equal(Object.hasOwn(rawTopic, "eventRefs"), true);
    assert.deepEqual(rawTopic.eventRefs, []);
    assert.deepEqual(rawTopic.turnRefs, []);
    assert.equal(JSON.stringify(visible).length < 20000, true,
      "a 21k-event topic does not inflate the initial sidebar projection");
    assert.equal(JSON.stringify(visible).includes('"eventIndex":10000'), false,
      "non-preview canonical memberships stay server-side");

    var revoked = buildGlobalCoopProjection({
      projects: [lead, clay], coopTopicIndex: index,
      canAccessProject: function (_, item) { return item !== clay; },
    });
    assert.equal(revoked.topics.some(function (topic) { return topic.projectRef && topic.projectRef.projectId === clay.projectId; }), false);

    var deniedCanonical = buildGlobalCoopProjection({
      projects: [lead, clay], coopTopicIndex: index,
      canAccessSession: function () { return false; },
    });
    assert.deepEqual(deniedCanonical.topics, []);
    assert.equal(deniedCanonical.topicProjection, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("building the global projection alone migrates pre-fix garbled titles exactly once", function () {
  // Owner evidence 2026-08-09 ~15:45: a genuine owner message in the canonical
  // Coop session left titleRetrofitAudit=0 -- the message-ingress retrofit
  // hook never ran for real owner traffic. The projection build is the daemon
  // path proven to execute with the cached canonical session, so the
  // migration must complete through it with NO message ingress at all.
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-title-migration-"));
  try {
    var file = path.join(dir, "lead", "topics.json");
    var index = createTopicIndex({ file: file, now: function () { return 10; } });
    var home = session(1, {
      storageId: "canonical-topic-home", coopHome: true,
      history: [
        { type: "user_message", text: "Navigation session restoration and sidebar", from: "owner", fromName: "Admin", clientMessageId: "cm-fixture" },
        { type: "delta_replace", text: "The navigation restoration is complete." },
        { type: "done" },
        // A second owner turn, so the automatic topic injected below is a thread
        // the owner came back to rather than a single passing remark. Quiet
        // one-turn automatic topics are deliberately withheld from the projection
        // (see coop-topic-promotion.test.js), and this test needs the migrated
        // title to reach the broadcast payload to prove anything at all.
        { type: "user_message", text: "Navigation session restoration follow up", from: "owner", fromName: "Admin", clientMessageId: "cm-fixture-2" },
        { type: "delta_replace", text: "The navigation restoration follow up is complete." },
        { type: "done" },
      ],
    });
    var lead = project("system-lead", "lead", [home], { isLead: true });
    buildGlobalCoopProjection({ projects: [lead], coopTopicIndex: index });

    // Inject a topic exactly as the old classifier minted it: contraction
    // fragment title, fingerprint intact, legacy-anchored to the real owner
    // turn -- the same shape as the ~30 garbled production rows.
    var crypto = require("node:crypto");
    var garbledTitle = "Don Session Restoration Sidebar";
    var digest = crypto.createHash("sha256").update("uncategorised\n" + garbledTitle.toLowerCase()).digest("hex");
    var topicId = "auto-" + digest.slice(0, 24);
    var state = index.load();
    state.topics[topicId] = {
      topicRef: { topicId: topicId }, title: garbledTitle, group: { kind: "uncategorised" },
      source: "automatic", status: "open", createdAt: 1, updatedAt: 1,
      keywords: [], eventRefs: [], relatedExecutions: [],
      turnRefs: [
        { sessionStorageId: "canonical-topic-home", startEventIndex: 0, endEventIndex: 2 },
        { sessionStorageId: "canonical-topic-home", startEventIndex: 3, endEventIndex: 5 },
      ],
    };
    index.save();
    delete index.load().titleRetrofit;

    // The failing ingress shape: the owner opens the app, the projection is
    // built. Nothing else happens.
    var visible = buildGlobalCoopProjection({ projects: [lead], coopTopicIndex: index });

    var persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    var migrated = persisted.topics[topicId];
    assert.notEqual(migrated.title, garbledTitle, "the garbled title is fixed by projection alone");
    assert.doesNotMatch(migrated.title, /\bDon\b/);
    assert.equal(migrated.topicRef.topicId, topicId, "identity preserved");
    assert.equal(migrated.titleRetrofitAudit.action, "retitled");
    assert.equal(persisted.titleRetrofit.schemaVersion,
      require("../lib/coop-topic-retrofit").TITLE_RETROFIT_SCHEMA_VERSION,
      "the exactly-once stamp is persisted");
    var seed = persisted.topics["navigation-session-restoration"];
    assert.equal(seed.title, "Navigation and session restoration", "seed titles untouched");
    var shown = [];
    visible.topicProjection.groups.forEach(function (group) {
      group.topics.forEach(function (t) { shown.push(t.title); });
    });
    assert.equal(shown.indexOf(garbledTitle), -1, "the broadcast projection carries the new title");
    assert.ok(shown.indexOf(migrated.title) !== -1);

    // Exactly once: a fresh process (new index instance over the same file)
    // must see the stamp and never re-run the migration body.
    var restarted = createTopicIndex({ file: file, now: function () { return 99; } });
    var again = restarted.ensureTitleRetrofit(home);
    assert.equal(again.alreadyComplete, true);
    buildGlobalCoopProjection({ projects: [lead], coopTopicIndex: restarted });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).titleRetrofit.completedAt,
      persisted.titleRetrofit.completedAt, "restart never re-stamps or re-runs");

    // Fail closed: an empty cached history must not run or burn the stamp.
    var emptyFile = path.join(dir, "lead", "topics-empty.json");
    fs.copyFileSync(file, emptyFile);
    var emptyIndex = createTopicIndex({ file: emptyFile, now: function () { return 50; } });
    delete emptyIndex.load().titleRetrofit;
    var bare = { storageId: "canonical-topic-home", coopHome: true, history: [] };
    assert.equal(emptyIndex.ensureTitleRetrofit(bare).code, "canonical_history_unavailable");
    assert.equal(emptyIndex.load().titleRetrofit, undefined, "stamp is not burned on an unusable call");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("topic related-session links stay top-level, ACL-filtered, and reference-only", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-related-sessions-"));
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var home = session(1, {
      storageId: "canonical-topic-home", coopHome: true,
      history: [
        { type: "user_message", text: "Navigation session restoration and sidebar", from: "owner", fromName: "Admin", clientMessageId: "cm-fixture" },
        { type: "delta_replace", text: "The navigation restoration is complete." },
        { type: "done" },
      ],
    });
    var lead = project("system-lead", "lead", [home], { isLead: true });

    var coordinator = session(10, { storageId: "clay-coordinator", coordinationMode: true, title: "Sidebar coordinator" });
    var directOwner = session(11, { storageId: "clay-direct", title: "Owner direct conversation" });
    var worker = session(12, {
      storageId: "clay-worker", title: "Worker attempt 2",
      orchestrationParent: { sessionStorageId: "clay-coordinator", taskId: "task-1" },
    });
    var hidden = session(13, { storageId: "clay-hidden", title: "Hidden session", hidden: true });
    var clay = project("5332aafc-31e7-5cb1-ba96-c8d90e78260e", "clay", [coordinator, directOwner, worker, hidden]);
    var otherTopLevel = session(20, { storageId: "webapp-top", title: "Webapp work" });
    var webapp = project("11111111-1111-5111-8111-111111111111", "webapp", [otherTopLevel], { title: "Webapp" });

    buildGlobalCoopProjection({ projects: [lead, clay, webapp], coopTopicIndex: index });
    var topicRef = { topicId: "navigation-session-restoration" };

    // Link a top-level coordinator, a worker, a nested child, a missing
    // session, and a session in another project.
    assert.equal(index.linkExecution(topicRef, {
      sessionRef: { projectId: clay.projectId, sessionStorageId: "clay-coordinator" },
      taskRef: { projectId: clay.projectId, coordinatorSessionStorageId: "clay-coordinator", taskId: "task-1" },
      children: [{ sessionRef: { projectId: clay.projectId, sessionStorageId: "clay-worker" } }],
    }).ok, true);
    assert.equal(index.linkExecution(topicRef, {
      sessionRef: { projectId: clay.projectId, sessionStorageId: "clay-worker" },
    }).ok, true);
    assert.equal(index.linkExecution(topicRef, {
      sessionRef: { projectId: clay.projectId, sessionStorageId: "clay-hidden" },
    }).ok, true);
    assert.equal(index.linkExecution(topicRef, {
      sessionRef: { projectId: clay.projectId, sessionStorageId: "clay-gone" },
    }).ok, true);
    assert.equal(index.linkExecution(topicRef, {
      sessionRef: { projectId: webapp.projectId, sessionStorageId: "webapp-top" },
    }).ok, true);
    // Duplicate of an already-linked top-level session.
    assert.equal(index.linkExecution(topicRef, {
      sessionRef: { projectId: clay.projectId, sessionStorageId: "clay-coordinator" },
    }).ok, true);

    var visible = buildGlobalCoopProjection({ projects: [lead, clay, webapp], coopTopicIndex: index });
    var topic = visible.topics.find(function (item) { return item.topicRef.topicId === topicRef.topicId; });

    assert.deepEqual(topic.relatedSessions, [
      {
        sessionRef: { projectId: clay.projectId, sessionStorageId: "clay-coordinator" },
        projectRef: { projectId: clay.projectId },
        title: "Sidebar coordinator",
      },
      {
        sessionRef: { projectId: webapp.projectId, sessionStorageId: "webapp-top" },
        projectRef: { projectId: webapp.projectId },
        title: "Webapp work",
      },
    ]);
    // The old worker-tree shape is gone from the topic payload entirely.
    assert.equal(Object.hasOwn(topic, "relatedExecution"), false);
    assert.equal(Object.hasOwn(topic, "relatedExecutions"), false);
    var serializedTopics = JSON.stringify(visible.topics) + JSON.stringify(visible.topicProjection);
    assert.equal(serializedTopics.includes("clay-worker"), false, "worker sessions are never linked");
    assert.equal(serializedTopics.includes("clay-hidden"), false, "hidden sessions are never linked");
    assert.equal(serializedTopics.includes("clay-gone"), false, "missing sessions are never linked");
    assert.equal(serializedTopics.includes("Worker attempt 2"), false, "no attempt history reaches the client");
    assert.equal(serializedTopics.includes("task-1"), false, "no task references reach the client");

    // Durable state keeps the full link graph; only the projection is narrowed.
    var durable = index.resolve(topicRef).topic.relatedExecutions;
    assert.equal(durable.length, 6);
    assert.equal(durable[0].children[0].sessionRef.sessionStorageId, "clay-worker");

    // Revoking the project revokes its links, and per-session ACLs apply too.
    var revoked = buildGlobalCoopProjection({
      projects: [lead, clay, webapp], coopTopicIndex: index,
      canAccessProject: function (_, item) { return item !== webapp; },
    });
    var revokedTopic = revoked.topics.find(function (item) { return item.topicRef.topicId === topicRef.topicId; });
    assert.deepEqual(revokedTopic.relatedSessions.map(function (link) { return link.sessionRef.sessionStorageId; }),
      ["clay-coordinator"]);

    var sessionDenied = buildGlobalCoopProjection({
      projects: [lead, clay, webapp], coopTopicIndex: index,
      canAccessSession: function (_, item, target) { return item === lead || target.storageId !== "clay-coordinator"; },
    });
    var deniedTopic = sessionDenied.topics.find(function (item) { return item.topicRef.topicId === topicRef.topicId; });
    assert.deepEqual(deniedTopic.relatedSessions.map(function (link) { return link.sessionRef.sessionStorageId; }),
      ["webapp-top"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
