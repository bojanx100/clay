var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var config = require("../lib/config");
var { resolveCreateProjectRequest, isPathInside } = require("../lib/project-path-utils");
var { attachGlobalWs } = require("../lib/server-global-ws");
var projectIdentity = require("../lib/project-identity");

test("project identity migration is stable across reorder, presentation changes, and relocation", function () {
  var configData = {
    projects: [
      { path: "/work/alpha", slug: "alpha", title: "Alpha", icon: "rocket" },
      { path: "/work/beta", slug: "beta" },
    ],
  };

  assert.equal(projectIdentity.migrateProjectIdentities(configData).changed, true);
  var alphaId = configData.projects[0].projectId;
  var betaId = configData.projects[1].projectId;
  assert.match(alphaId, /^[0-9a-f-]{36}$/);
  assert.notEqual(alphaId, betaId);

  configData.projects.reverse();
  configData.projects[1].slug = "renamed-alpha";
  configData.projects[1].title = "Renamed Alpha";
  configData.projects[1].icon = "sparkles";
  configData.projects[1].path = "/relocated/alpha";
  assert.equal(projectIdentity.migrateProjectIdentities(configData).changed, false);
  assert.equal(configData.projects[1].projectId, alphaId);
  assert.equal(configData.projects[0].projectId, betaId);
});

test("re-adding a removed project retains its durable project identity", function () {
  var projectId = projectIdentity.deterministicProjectId({ path: "/work/removed" });
  var entry = projectIdentity.createProjectEntry({ path: "/work/removed", slug: "restored" }, [
    { path: "/work/removed", projectId: projectId },
  ]);

  assert.equal(entry.projectId, projectId);
});

test("resolves an explicit new-project folder into its exact name and parent", function () {
  var request = resolveCreateProjectRequest({ path: "~/projects/career-agent" }, config.REAL_HOME);

  assert.equal(request.error, undefined);
  assert.equal(request.name, "career-agent");
  assert.equal(request.parentPath, path.join(config.REAL_HOME, "projects"));
  assert.equal(request.targetPath, path.join(config.REAL_HOME, "projects", "career-agent"));
});

test("keeps legacy name-only create requests compatible with the default folder", function () {
  var request = resolveCreateProjectRequest({ name: "career-agent" }, config.REAL_HOME);

  assert.deepEqual(request, { name: "career-agent", parentPath: null, targetPath: null });
});

test("rejects relative paths while allowing normal folder names", function () {
  assert.match(resolveCreateProjectRequest({ path: "projects/career-agent" }, config.REAL_HOME).error, /absolute path/);
  assert.equal(resolveCreateProjectRequest({ path: "/tmp/career agent" }, config.REAL_HOME).name, "career agent");
  assert.equal(resolveCreateProjectRequest({ path: "/tmp/career.agent" }, config.REAL_HOME).name, "career.agent");
  assert.match(resolveCreateProjectRequest({ path: "/" }, config.REAL_HOME).error, /Invalid project folder name/);
});

test("path containment does not accept sibling prefixes", function () {
  assert.equal(isPathInside("/home/alice", "/home/alice/projects/demo"), true);
  assert.equal(isPathInside("/home/alice", "/home/alice-2/projects/demo"), false);
});

test("global create handler forwards the selected parent folder", function () {
  var sent = [];
  var received = null;
  var handler = attachGlobalWs({
    onCreateProject: function (name, user, parentPath) {
      received = { name: name, user: user, parentPath: parentPath };
      return { ok: true, slug: "career-agent" };
    },
  });
  var ws = {
    readyState: 1,
    _clayUser: { id: "user-1", role: "admin" },
    send: function (payload) { sent.push(JSON.parse(payload)); },
  };

  handler.handleMessage(ws, { type: "create_project", path: "~/projects/career-agent" });

  assert.deepEqual(received, {
    name: "career-agent",
    user: ws._clayUser,
    parentPath: path.join(config.REAL_HOME, "projects"),
  });
  assert.deepEqual(sent, [{ type: "add_project_result", ok: true, slug: "career-agent" }]);
});

test("global create handler restricts non-admin paths to their home", function () {
  var called = false;
  var sent = [];
  var handler = attachGlobalWs({
    osUsers: true,
    usersModule: {
      getEffectivePermissions: function () { return { createProject: true }; },
    },
    onCreateProject: function () {
      called = true;
      return { ok: true };
    },
  });
  var ws = {
    readyState: 1,
    _clayUser: { id: "user-1", role: "member", linuxUser: "alice" },
    send: function (payload) { sent.push(JSON.parse(payload)); },
  };

  handler.handleMessage(ws, { type: "create_project", path: "/tmp/career-agent" });

  assert.equal(called, false);
  assert.match(sent[0].error, /only create directories under \/home\/alice/);
});

test("new-project UI uses the shared folder picker and submits a path", function () {
  var html = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "index.html"), "utf8");
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "add-project-modal.js"), "utf8");

  assert.match(html, /data-panel="path"/);
  assert.match(html, /id="add-project-path-label"/);
  assert.doesNotMatch(html, /id="add-project-create-input"/);
  assert.match(source, /type: type, path: projectPath/);
  assert.match(source, /New project folder/);
  assert.match(source, /msg\.path !== getFullPath\(addProjectInput\.value\)/);
});
