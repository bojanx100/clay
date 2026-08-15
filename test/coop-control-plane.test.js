var test = require("node:test");
var assert = require("node:assert/strict");
var controlPlane = require("../lib/coop-control-plane");
var projectIdentity = require("../lib/project-identity");
var globalProjection = require("../lib/global-coop-projection");
var topicConnection = require("../lib/coop-topic-connection");

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP = "11111111-1111-5111-8111-111111111111";

function manager() {
  var sessions = new Map();
  var saved = [];
  sessions.set(1, { localId: 1, storageId: "canonical-coop", coopHome: true, history: [] });
  return {
    sessions: sessions,
    saved: saved,
    createSessionRaw: function (input) {
      var session = Object.assign({ localId: sessions.size + 1, history: [] }, input || {});
      sessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function (session) { saved.push(session.storageId); },
  };
}

test("Coop owns one project-named persistent coordinator per ProjectRef plus Council and Triage", function () {
  var sm = manager();
  var result = controlPlane.ensureControlPlane(sm, [
    { projectRef: { projectId: CLAY }, title: "Clay" },
    { projectRef: { projectId: WEBAPP }, title: "Webapp" },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(sm.sessions.size, 5);
  assert.deepEqual(result.coordinators.map(function (session) { return session.title; }),
    ["Clay coordinator", "Webapp coordinator"]);
  assert.deepEqual(result.coordinators.map(function (session) {
    return controlPlane.projectCoordinatorPolicy(session).projectRef;
  }), [{ projectId: CLAY }, { projectId: WEBAPP }]);
  assert.equal(result.council.title, "Council");
  assert.equal(result.triage.title, "Triage");
  assert.equal(result.coordinators.every(function (session) {
    return session.coopControlledBy.coopSessionStorageId === "canonical-coop";
  }), true);

  var replay = controlPlane.ensureControlPlane(sm, [
    { projectRef: { projectId: CLAY }, title: "Clay" },
    { projectRef: { projectId: WEBAPP }, title: "Webapp" },
  ]);
  assert.equal(replay.changed, false);
  assert.equal(sm.sessions.size, 5, "control-plane projection is idempotent");
});

test("a Lead-resident project coordinator owns a target-project task coordinator by exact refs", function () {
  var sm = manager();
  var coopRef = { projectId: projectIdentity.LEAD_PROJECT_ID,
    sessionStorageId: "canonical-coop" };
  var root = controlPlane.ensureProjectCoordinator(sm, { projectId: CLAY }, "Clay", coopRef);
  var request = {
    portfolioTaskId: "portfolio-control-plane",
    bindingRevision: 6,
    targetProject: { projectId: CLAY },
    coopTopicRef: { topicId: "thread-control-plane" },
  };
  var task = controlPlane.prepareTask(sm, root, request, {
    title: "Verify activated fixes and finish cleanup",
    objective: "Verify the bounded project work.",
  });
  var childRef = { projectId: CLAY, sessionStorageId: "task-coordinator" };
  assert.equal(controlPlane.bindTask(sm, root, task, childRef), true);
  assert.deepEqual(task.workerSessionRef, childRef);
  assert.equal(task.status, "running");
  assert.equal(controlPlane.taskForRequest(root, request), task);
  assert.deepEqual(projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root),
    { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: root.storageId });
});

test("global Coop projects Lead root to target task coordinator to its worker", function () {
  var leadManager = manager();
  var ensured = controlPlane.ensureControlPlane(leadManager, [
    { projectRef: { projectId: CLAY }, title: "Clay" },
  ]);
  var root = ensured.coordinators[0];
  var rootRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root);
  var request = { portfolioTaskId: "portfolio-tree", bindingRevision: 1,
    targetProject: { projectId: CLAY } };
  var task = controlPlane.prepareTask(leadManager, root, request,
    { title: "Verify activated fixes", objective: "Verify the fixes." });
  var child = {
    localId: 11, storageId: "task-coordinator", title: "Verify activated fixes",
    coordinationMode: true, coordinationRole: "task_coordinator",
    projectCoordinatorRef: rootRef,
    coopControlledBy: { coopSessionStorageId: root.storageId, since: 1 },
    orchestrationTasks: [{ taskId: "worker-task", title: "Run focused tests",
      status: "running", workerStorageId: "worker-session" }],
  };
  var worker = {
    localId: 12, storageId: "worker-session", title: "Run focused tests",
    coopControlledBy: { coopSessionStorageId: root.storageId, since: 1 },
    orchestrationParent: { sessionId: 11, sessionStorageId: child.storageId,
      taskId: "worker-task" },
  };
  var targetManager = { sessions: new Map([[11, child], [12, worker]]) };
  controlPlane.bindTask(leadManager, root, task,
    { projectId: CLAY, sessionStorageId: child.storageId });
  var topicIndex = {
    ensureRetro: function () { return { ok: true }; },
    ensureTitleRetrofit: function () {},
    ensureTopicConsolidation: function () {},
    ensureDispositionBackfill: function () {},
    project: function () { return { groups: [] }; },
  };
  var result = globalProjection.buildGlobalCoopProjection({
    projects: [{
      projectId: projectIdentity.LEAD_PROJECT_ID,
      getStatus: function () { return { projectId: projectIdentity.LEAD_PROJECT_ID, slug: "lead" }; },
      getSessionManager: function () { return leadManager; },
    }, {
      projectId: CLAY,
      getStatus: function () { return { projectId: CLAY, slug: "clay", title: "Clay" }; },
      getSessionManager: function () { return targetManager; },
    }],
    coopTopicIndex: topicIndex,
    canAccessProject: function () { return true; },
    canAccessSession: function () { return true; },
  });
  var tree = result.projects[0].summary.coordinatorTree;
  assert.equal(tree[0].title, "Clay coordinator");
  assert.equal(tree[0].sessionRef.projectId, projectIdentity.LEAD_PROJECT_ID);
  assert.equal(tree[0].children[0].title, "Verify activated fixes");
  assert.equal(tree[0].children[0].sessionRef.projectId, CLAY);
  assert.equal(tree[0].children[0].children[0].title, "Run focused tests");
  assert.deepEqual(result.controlPlaneSessions.map(function (item) { return item.title; }),
    ["Council", "Triage"]);
});

test("legacy target-local hierarchy migrates without terminalizing active evidence", function () {
  var leadManager = manager();
  var targetSessions = new Map();
  var targetSaved = [];
  var legacyRoot = {
    localId: 20, storageId: "legacy-project-root", title: "Project coordinator",
    coordinationRole: "project_coordinator", coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: "canonical-coop", since: 1 },
    orchestrationTasks: [{ taskId: "legacy-task", clientRef: "portfolio:legacy-work:2",
      title: "Blocked existing work", status: "needs_input", externalTaskCoordinator: true,
      workerStorageId: "legacy-child" }],
  };
  var child = {
    localId: 21, storageId: "legacy-child", title: "Blocked existing work",
    coordinationRole: "task_coordinator", coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: "canonical-coop", since: 1 },
    orchestrationParent: { sessionId: 20, sessionStorageId: legacyRoot.storageId,
      taskId: "legacy-task" },
    orchestrationPolicy: { portfolioExecution: { status: "needs_input",
      source: { projectId: CLAY, sessionStorageId: legacyRoot.storageId } } },
    orchestrationTasks: [{ taskId: "legacy-worker-task", status: "blocked",
      workerStorageId: "legacy-worker" }],
  };
  var worker = {
    localId: 22, storageId: "legacy-worker", title: "Preserved blocked worker",
    coopControlledBy: { coopSessionStorageId: "canonical-coop", since: 1 },
    orchestrationParent: { sessionId: 21, sessionStorageId: child.storageId,
      taskId: "legacy-worker-task" },
  };
  targetSessions.set(20, legacyRoot);
  targetSessions.set(21, child);
  targetSessions.set(22, worker);
  var targetManager = { sessions: targetSessions,
    saveSessionFile: function (session) { targetSaved.push(session.storageId); } };
  var rebound = [];
  var result = controlPlane.ensureControlPlane(leadManager, [{
    projectRef: { projectId: CLAY }, title: "Clay", manager: targetManager,
    migrateBinding: function (from, to) { rebound.push({ from: from, to: to }); return { ok: true }; },
  }]);
  assert.equal(result.migrations.length, 1);
  assert.equal(rebound.length, 1);
  assert.equal(child.orchestrationParent, undefined);
  assert.equal(child.controlPlaneParent.taskId, "legacy-task");
  assert.equal(child.orchestrationPolicy.portfolioExecution.status, "needs_input");
  assert.deepEqual(child.orchestrationPolicy.portfolioExecution.source,
    result.migrations[0].to);
  assert.equal(worker.coopControlledBy.coopSessionStorageId,
    result.migrations[0].to.sessionStorageId);
  assert.equal(result.coordinators[0].orchestrationTasks[0].status, "needs_input");
  assert.deepEqual(targetSaved, ["legacy-child", "legacy-worker"]);
});

test("owner hierarchy navigation authorizes only refs present in the global Coop tree", function () {
  var workerRef = { projectId: CLAY, sessionStorageId: "visible-worker" };
  var projection = { projects: [{ summary: { coordinatorTree: [{
    sessionRef: { projectId: "system-lead", sessionStorageId: "clay-coordinator" },
    children: [{ sessionRef: { projectId: CLAY, sessionStorageId: "task-coordinator" },
      children: [{ sessionRef: workerRef, children: [] }] }],
  }] } }] };
  assert.equal(topicConnection.globalHierarchyContainsSession(projection, workerRef), true);
  assert.equal(topicConnection.globalHierarchyContainsSession(projection,
    { projectId: CLAY, sessionStorageId: "unprojected-worker" }), false);
});
