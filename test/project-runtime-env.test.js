var test = require("node:test");
var assert = require("node:assert/strict");
var createProjectRuntimeEnvResolver = require("../lib/project-runtime-env").createProjectRuntimeEnvResolver;

test("project runtime environment reads shared and project settings for each process", function () {
  var shared = "VALUE=shared\nSHARED_ONLY=yes";
  var projects = { alpha: "VALUE=project\nPROJECT_ONLY=yes" };
  var calls = [];
  var resolve = createProjectRuntimeEnvResolver({
    slug: "alpha",
    onGetSharedEnv: function () { calls.push("shared"); return { envrc: shared }; },
    onGetProjectEnv: function (slug) { calls.push("project:" + slug); return { envrc: projects[slug] }; },
  });

  var first = resolve({});
  assert.equal(first.VALUE, "project");
  assert.equal(first.SHARED_ONLY, "yes");
  assert.equal(first.PROJECT_ONLY, "yes");
  projects.alpha = "VALUE=changed";
  var second = resolve({});
  assert.equal(second.VALUE, "changed", "the resolver reads durable settings at process creation time");
  assert.equal(second.PROJECT_ONLY, undefined);
  assert.deepEqual(calls, ["shared", "project:alpha", "shared", "project:alpha"]);
});

test("OS-isolated runtime environment keeps the session owner's identity", function () {
  var resolvedUsers = [];
  var resolve = createProjectRuntimeEnvResolver({
    slug: "alpha",
    getLinuxUserForSession: function (session) { return session.owner; },
    getOsUserInfoForLinuxUser: function (linuxUser) {
      resolvedUsers.push(linuxUser);
      return { uid: 1200, gid: 1200, user: linuxUser, home: "/home/" + linuxUser, shell: "/bin/zsh" };
    },
    onGetSharedEnv: function () { return { envrc: "HOME=/unsafe\nTOKEN=shared" }; },
    onGetProjectEnv: function () { return { envrc: "TOKEN=project" }; },
  });

  var env = resolve({ owner: "alice" });
  assert.deepEqual(resolvedUsers, ["alice"]);
  assert.equal(env.HOME, "/home/alice");
  assert.equal(env.USER, "alice");
  assert.equal(env.TOKEN, "project");
});
