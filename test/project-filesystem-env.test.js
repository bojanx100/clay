var test = require("node:test");
var assert = require("node:assert/strict");
var attachFilesystem = require("../lib/project-filesystem").attachFilesystem;
var validateEnvString = require("../lib/runtime-env").validateEnvString;

function createFilesystem(overrides) {
  overrides = overrides || {};
  return attachFilesystem({
    cwd: process.cwd(),
    slug: "alpha",
    osUsers: null,
    sm: { sessions: new Map() },
    send: function () {},
    sendTo: overrides.sendTo || function () {},
    safePath: function () { return null; },
    safeAbsPath: function () { return null; },
    getOsUserInfoForWs: function () { return null; },
    startFileWatch: function () {},
    stopFileWatch: function () {},
    startDirWatch: function () {},
    usersModule: { getEffectivePermissions: function () { return { projectSettings: true }; } },
    fsAsUser: function () {},
    validateEnvString: validateEnvString,
    onEnvironmentChanged: overrides.onEnvironmentChanged || function () {},
    opts: overrides.opts || {},
    IGNORED_DIRS: new Set(),
    BINARY_EXTS: new Set(),
    IMAGE_EXTS: new Set(),
    FS_MAX_SIZE: 1024,
  });
}

test("saved project environment refreshes runtime after validated persistence", function () {
  var saved = null;
  var refreshes = 0;
  var response = null;
  var filesystem = createFilesystem({
    sendTo: function (ws, msg) { response = msg; },
    onEnvironmentChanged: function () { refreshes++; },
    opts: { onSetProjectEnv: function (slug, envrc) { saved = { slug: slug, envrc: envrc }; return { ok: true }; } },
  });

  filesystem.handleFilesystemMessage({}, { type: "set_project_env", slug: "alpha", envrc: "export PROJECT_TOKEN=\"value\"" });
  assert.deepEqual(saved, { slug: "alpha", envrc: "export PROJECT_TOKEN=\"value\"" });
  assert.equal(refreshes, 1);
  assert.equal(response.ok, true);
  assert.match(response.timing, /newly created coding-agent processes/i);
});

test("failed or invalid environment persistence does not refresh runtime", function () {
  var saves = 0;
  var refreshes = 0;
  var responses = [];
  var filesystem = createFilesystem({
    sendTo: function (ws, msg) { responses.push(msg); },
    onEnvironmentChanged: function () { refreshes++; },
    opts: { onSetSharedEnv: function () { saves++; return { ok: false, error: "write failed" }; } },
  });

  filesystem.handleFilesystemMessage({}, { type: "set_shared_env", envrc: "TOKEN=$(command)" });
  filesystem.handleFilesystemMessage({}, { type: "set_shared_env", envrc: "TOKEN=value" });
  assert.equal(saves, 1, "invalid input never reaches persistence");
  assert.equal(refreshes, 0);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].error, /Unsupported executable syntax/);
  assert.equal(responses[1].error, "write failed");
});
