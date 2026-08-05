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
