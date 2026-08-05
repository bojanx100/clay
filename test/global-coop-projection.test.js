var test = require("node:test");
var assert = require("node:assert/strict");
var buildGlobalCoopProjection = require("../lib/global-coop-projection").buildGlobalCoopProjection;

var APP_ID = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
var WORKTREE_ID = "ffb5f2d1-9aac-5735-ae17-42ca99de7d8f";
var HIDDEN_ID = "d8af2cc1-ea08-5b4c-82e6-e729d3a7dcef";

function context(status, sessions) {
  return {
    projectId: status.projectId,
    slug: status.slug,
    getStatus: function () { return status; },
    getSessionManager: function () { return { sessions: new Map(sessions.map(function (s) { return [s.localId, s]; })) }; },
  };
}

function hasForbiddenField(value) {
  var forbidden = { history: true, orchestrationTasks: true, terminalId: true, cwd: true, process: true, query: true };
  if (!value || typeof value !== "object") return false;
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    if (forbidden[keys[i]]) return true;
    if (hasForbiddenField(value[keys[i]])) return true;
  }
  return false;
}

test("global Coop projection groups canonical project refs, tasks, attempts, and worktrees", function () {
  var coordinator = {
    localId: 7,
    storageId: "coordinator",
    title: "App coordinator",
    vendor: "codex",
    model: "gpt-5.6",
    coordinationMode: true,
    lastActivity: 200,
    orchestrationTasks: [{
      taskId: "task-app",
      status: "running",
      progress: 55,
      currentActivity: "Checking the focused suite",
      attempt: 3,
      workerStorageId: "worker-current",
    }],
  };
  var previousWorker = {
    localId: 8,
    storageId: "worker-old",
    title: "Earlier worker",
    vendor: "claude",
    model: "sonnet",
    createdAt: 10,
    history: [{ type: "user_message", orchestrationTaskId: "task-app", origin: { kind: "coordinator" } }],
  };
  var currentWorker = {
    localId: 9,
    storageId: "worker-current",
    title: "Current worker",
    vendor: "codex",
    requestedModel: "gpt-5.6",
    createdAt: 20,
    orchestrationParent: { taskId: "task-app", sessionStorageId: "coordinator" },
  };
  var directLeaf = {
    localId: 10,
    storageId: "direct-leaf",
    title: "Direct leaf",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  var app = context({ projectId: APP_ID, slug: "app", title: "App", icon: "rocket" }, [
    coordinator, previousWorker, currentWorker, directLeaf,
  ]);
  var worktree = context({
    projectId: WORKTREE_ID,
    slug: "app--feature",
    title: "Feature",
    parentProjectId: APP_ID,
  }, []);
  var unavailableTask = {
    localId: 11,
    storageId: "missing-coordinator",
    title: "Unavailable worker source",
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "task-missing",
      status: "needs_input",
      workerStorageId: "deleted-worker",
      attempt: 1,
    }],
  };
  var hidden = context({ projectId: HIDDEN_ID, slug: "hidden", title: "Hidden" }, [unavailableTask]);
  var projection = buildGlobalCoopProjection({
    projects: [app, worktree, hidden],
    actor: { id: "owner" },
    canAccessProject: function (actor, project) { return project !== hidden; },
    canAccessSession: function () { return true; },
    unreadForSession: function (actor, project, session) { return session.storageId === "direct-leaf" ? 2 : 0; },
  });

  assert.equal(projection.type, "global_coop_projection");
  assert.deepEqual(projection.projects.map(function (group) { return group.projectRef.projectId; }), [APP_ID]);
  var appGroup = projection.projects[0];
  assert.equal(appGroup.slug, "app");
  assert.equal(appGroup.worktrees[0].projectRef.projectId, WORKTREE_ID);
  assert.equal(appGroup.worktrees[0].parentProjectId, APP_ID);
  assert.equal(appGroup.coordinators[0].sessionRef.sessionStorageId, "coordinator");
  assert.equal(appGroup.coordinators[0].role, "coordinator");
  assert.equal(appGroup.directLeaves[0].role, "direct_leaf");
  assert.equal(appGroup.directLeaves[0].unread, 2);
  var task = appGroup.coordinators[0].tasks[0];
  assert.deepEqual(task.taskRef, {
    projectId: APP_ID,
    coordinatorSessionStorageId: "coordinator",
    taskId: "task-app",
  });
  assert.deepEqual(task.attempts.map(function (attempt) {
    return [attempt.sessionRef.sessionStorageId, attempt.attempt, attempt.current, attempt.historical];
  }), [
    ["worker-old", 1, false, true],
    ["worker-current", 3, true, false],
  ]);
  assert.equal(hasForbiddenField(projection), false);
});

test("global Coop projection keeps unavailable worker refs explicit without leaking denied sessions", function () {
  var coordinator = {
    localId: 1,
    storageId: "coordinator",
    coordinationMode: true,
    orchestrationTasks: [{ taskId: "task-missing", status: "needs_input", workerStorageId: "gone", attempt: 2 }],
  };
  var deniedWorker = {
    localId: 2,
    storageId: "gone",
    title: "Do not expose",
    orchestrationParent: { taskId: "task-missing", sessionStorageId: "coordinator" },
  };
  var app = context({ projectId: APP_ID, slug: "app", title: "App" }, [coordinator, deniedWorker]);
  var projection = buildGlobalCoopProjection({
    projects: [app],
    canAccessSession: function (actor, project, session) { return session !== deniedWorker; },
  });
  var attempt = projection.projects[0].coordinators[0].tasks[0].attempts[0];

  assert.deepEqual(attempt, {
    sessionRef: { projectId: APP_ID, sessionStorageId: "gone" },
    role: "worker",
    availability: "unavailable",
    attempt: 2,
    current: true,
    historical: false,
  });
  assert.equal(JSON.stringify(projection).includes("Do not expose"), false);
});

test("equal session storage IDs remain unambiguous across canonical projects", function () {
  var first = context({ projectId: APP_ID, slug: "first", title: "First" }, [{
    localId: 1,
    storageId: "same-storage",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  }]);
  var second = context({ projectId: HIDDEN_ID, slug: "second", title: "Second" }, [{
    localId: 1,
    storageId: "same-storage",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  }]);
  var projection = buildGlobalCoopProjection({ projects: [first, second] });

  assert.deepEqual(projection.projects.map(function (group) {
    return group.directLeaves[0].sessionRef;
  }), [
    { projectId: APP_ID, sessionStorageId: "same-storage" },
    { projectId: HIDDEN_ID, sessionStorageId: "same-storage" },
  ]);
});
