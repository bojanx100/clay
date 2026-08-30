var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var projectIdentity = require("../lib/project-identity");
var attachProjectStatus = require("../lib/project-status").attachProjectStatus;

function clearSessionModules() {
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/tombstones")];
  delete require.cache[require.resolve("../lib/sessions")];
}

function createManager(projectDir, projectId) {
  return require("../lib/sessions").createSessionManager({
    cwd: projectDir,
    projectId: projectId,
    send: function () {},
  });
}

test("project status exposes the current durable project identity", function () {
  var projectId = "8e2a4e3c-11e9-5f0e-8d7c-08eb20b5e865";
  var status = attachProjectStatus({
    cwd: "/work/status-project",
    slug: "status-project",
    project: "status-project",
    currentVersion: "test",
    clients: new Set(),
    sm: { sessions: new Map(), getProjectId: function () { return projectId; } },
    send: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    projectClients: { getOnlineUsers: function () { return []; } },
    getProjectCount: function () { return 1; },
    getProjectList: function () { return []; },
    getProjectOwnerId: function () { return null; },
  });

  assert.equal(status.getProjectId(), projectId);
  assert.equal(status.getStatus().projectId, projectId);
});

test("worktree status retains its configured canonical parent project ID", function () {
  var parentProjectId = "1f813f68-79d7-53cc-9fc1-eb19c7485a37";
  var status = attachProjectStatus({
    cwd: "/work/status-worktree",
    slug: "status-project--feature",
    project: "status-worktree",
    currentVersion: "test",
    worktreeMeta: { parentSlug: "status-project", parentProjectId: parentProjectId, branch: "feature", accessible: true },
    clients: new Set(),
    sm: { sessions: new Map(), getProjectId: function () { return "21fec04e-5592-5c22-8acf-b6644ad6078f"; } },
    send: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    projectClients: { getOnlineUsers: function () { return []; } },
    getProjectCount: function () { return 1; },
    getProjectList: function () { return []; },
    getProjectOwnerId: function () { return null; },
  });

  assert.equal(status.getStatus().parentProjectId, parentProjectId);
});

test("temporary worktree runtimes use their parent's durable ProjectRef", function () {
  var parentProjectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var runtimeId = projectIdentity.projectIdForRuntime({
    projectId: "1f813f68-79d7-53cc-9fc1-eb19c7485a37",
  }, "/private/tmp/clay-fix", "clay--fix", {
    parentProjectId: parentProjectId,
  });

  assert.equal(runtimeId, parentProjectId);
});

test("one ProjectRef resolves sessions from parent and temporary worktree runtimes", function () {
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var parentSession = { storageId: "parent-session" };
  var worktreeSession = { storageId: "worktree-session" };
  var parent = {
    slug: "clay",
    getStatus: function () { return { isWorktree: false }; },
    getSessionManager: function () {
      return { resolveSessionRef: function (ref) {
        return ref.sessionStorageId === parentSession.storageId ? parentSession : null;
      } };
    },
  };
  var worktree = {
    slug: "clay--temporary",
    getStatus: function () { return { isWorktree: true, parentSlug: "clay" }; },
    getSessionManager: function () {
      return { resolveSessionRef: function (ref) {
        return ref.sessionStorageId === worktreeSession.storageId ? worktreeSession : null;
      } };
    },
  };
  var resolver = projectIdentity.createReferenceResolver({
    getProjectById: function (id) { return id === projectId ? parent : null; },
    getProjectsById: function (id) { return id === projectId ? [worktree, parent] : []; },
  });

  assert.strictEqual(resolver.resolveProjectRef({ projectId: projectId }).project, parent);
  assert.strictEqual(resolver.resolveSessionRef({
    projectId: projectId, sessionStorageId: parentSession.storageId,
  }).session, parentSession);
  var resolved = resolver.resolveSessionRef({
    projectId: projectId, sessionStorageId: worktreeSession.storageId,
  });
  assert.strictEqual(resolved.project, worktree);
  assert.strictEqual(resolved.session, worktreeSession);
});

test("ProjectRef and SessionRef resolve within their owning project manager", function () {
  var tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-ref-"));
  var firstDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-ref-first-"));
  var secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-ref-second-"));
  var priorHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tempHome;
  clearSessionModules();
  try {
    var firstId = "8b0e7f47-d7e3-5f4f-b952-6fcd55cc9a56";
    var secondId = "f3a97836-471f-5842-bc9f-5325a7e6b4dd";
    var firstManager = createManager(firstDir, firstId);
    var secondManager = createManager(secondDir, secondId);
    var firstSession = firstManager.createSessionRaw({ storageId: "same-storage-id" });
    var secondSession = secondManager.createSessionRaw({ storageId: "same-storage-id" });
    var firstProject = { projectId: firstId, slug: "first", getSessionManager: function () { return firstManager; } };
    var secondProject = { projectId: secondId, slug: "second", getSessionManager: function () { return secondManager; } };
    var resolver = projectIdentity.createReferenceResolver({
      getProjectById: function (projectId) {
        if (projectId === firstId) return firstProject;
        if (projectId === secondId) return secondProject;
        return null;
      },
      canAccessSession: function (actor, project) { return actor !== "denied" || project === firstProject; },
    });

    var firstRef = firstManager.getSessionRef(firstSession);
    var secondRef = secondManager.getSessionRef(secondSession);
    assert.deepEqual(firstRef, { projectId: firstId, sessionStorageId: "same-storage-id" });
    assert.deepEqual(secondRef, { projectId: secondId, sessionStorageId: "same-storage-id" });
    assert.strictEqual(resolver.resolveSessionRef(firstRef).session, firstSession);
    assert.strictEqual(resolver.resolveSessionRef(secondRef).session, secondSession);
    assert.strictEqual(resolver.resolveSessionRef(firstRef).project.slug, "first");

    var before = secondManager.sessions.size;
    assert.deepEqual(resolver.resolveSessionRef({ projectId: secondId, sessionStorageId: "missing" }), {
      ok: false,
      code: "session_not_found",
    });
    assert.equal(secondManager.sessions.size, before);
    assert.deepEqual(resolver.resolveSessionRef({ projectId: secondId, sessionStorageId: "same-storage-id" }, "denied"), {
      ok: false,
      code: "access_denied",
    });
    assert.deepEqual(resolver.resolveProjectRef({ projectId: "12e7b153-66b2-50e3-8c38-a504230639c0" }), {
      ok: false,
      code: "project_not_found",
    });
    assert.deepEqual(resolver.resolveProjectRef({ projectId: "not-an-id" }), {
      ok: false,
      code: "invalid_project_ref",
    });
  } finally {
    if (typeof priorHome === "string") process.env.CLAY_HOME = priorHome;
    else delete process.env.CLAY_HOME;
    clearSessionModules();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(firstDir, { recursive: true, force: true });
    fs.rmSync(secondDir, { recursive: true, force: true });
  }
});

test("TaskRef resolves through the coordinator storage ID without a local ID", function () {
  var projectId = "352e3033-da6d-516c-a3f6-e62181124604";
  var coordinator = {
    storageId: "coordinator-storage",
    localId: 44,
    orchestrationTasks: [{ taskId: "task-stable", status: "running" }],
  };
  var manager = {
    resolveSessionRef: function (ref) {
      return ref.sessionStorageId === coordinator.storageId ? coordinator : null;
    },
  };
  var project = { projectId: projectId, getSessionManager: function () { return manager; } };
  var resolver = projectIdentity.createReferenceResolver({
    getProjectById: function (id) { return id === projectId ? project : null; },
  });
  var ref = projectIdentity.taskRef({ projectId: projectId }, coordinator, "task-stable");

  assert.deepEqual(ref, {
    projectId: projectId,
    coordinatorSessionStorageId: "coordinator-storage",
    taskId: "task-stable",
  });
  assert.deepEqual(projectIdentity.normalizeTaskRef(Object.assign({ localId: 44 }, ref)), ref);
  assert.strictEqual(resolver.resolveTaskRef(ref).coordinator, coordinator);
  assert.equal(resolver.resolveTaskRef(ref).task.status, "running");
  assert.deepEqual(resolver.resolveTaskRef({
    projectId: projectId,
    coordinatorSessionStorageId: "coordinator-storage",
    taskId: "missing",
  }), { ok: false, code: "task_not_found" });
  assert.deepEqual(resolver.resolveTaskRef({
    projectId: projectId,
    coordinatorSessionStorageId: "coordinator-storage",
    taskId: "has spaces",
  }), { ok: false, code: "invalid_task_ref" });
});
