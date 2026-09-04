var test = require("node:test");
var assert = require("node:assert");
var path = require("node:path");
var workspaceModule = require("../lib/project-live-ui-workspace");
var attachWorkspace = require("../lib/project-workspace").attachWorkspace;

function inspectHarness(options) {
  options = options || {};
  var requestedUser = null;
  var workspace = workspaceModule.attachProjectLiveUiWorkspace({
    getProjectList: function (userId) {
      requestedUser = userId;
      return [{ slug: "webapp", path: "/repo/webapp" }];
    },
    listenerWorkingDirs: function (port, cb) {
      cb(options.dirs || ["/repo/.worktrees/design/webapp"]);
    },
    mapListener: function (dir, projects, cb) {
      cb(options.matches || [{
        projectSlug: "webapp",
        projectLabel: "Webapp",
        writableRoot: "/repo/.worktrees/design/webapp",
      }]);
    },
    tailscaleUrlForPort: function (port, cb) {
      cb(options.tailscaleUrl || null);
    },
  });
  return {
    inspect: function (url) {
      return new Promise(function (resolve) {
        workspace.inspect(url, "user-a", resolve);
      });
    },
    requestedUser: function () { return requestedUser; },
  };
}

test("Live UI target ports accept only HTTP origins", function () {
  assert.strictEqual(workspaceModule.targetPort("http://localhost:4242/a"), 4242);
  assert.strictEqual(workspaceModule.targetPort("https://example.test/a"), 443);
  assert.strictEqual(workspaceModule.targetPort("file:///tmp/a"), null);
  assert.strictEqual(workspaceModule.targetPort("not a url"), null);
});

test("workspace matching accepts a server below the registered project root", function () {
  assert.strictEqual(workspaceModule.sameWorkspace({
    git: true,
    common: "/repo/.git",
    relative: "webapp/src",
  }, {
    git: true,
    common: "/repo/.git",
    relative: "webapp",
  }), true);
  assert.strictEqual(workspaceModule.sameWorkspace({
    git: true,
    common: "/repo/.git",
    relative: "api",
  }, {
    git: true,
    common: "/repo/.git",
    relative: "webapp",
  }), false);
});

test("listener mapping binds a subdirectory server to the registered git root", async function () {
  var root = path.resolve(__dirname, "..");
  var matches = await new Promise(function (resolve) {
    workspaceModule.mapListener(path.join(root, "lib"), [{
      slug: "clay",
      title: "Clay",
      path: root,
    }], resolve);
  });
  assert.deepStrictEqual(matches, [{
    projectSlug: "clay",
    projectLabel: "Clay",
    writableRoot: root,
  }]);
});

test("inspected loopback servers resolve through the access-filtered project list", async function () {
  var harness = inspectHarness();
  var result = await harness.inspect("http://localhost:4242/account");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.target.projectSlug, "webapp");
  assert.strictEqual(result.target.worktreeLabel, "design");
  assert.strictEqual(result.target.writableRoot,
    "/repo/.worktrees/design/webapp");
  assert.strictEqual(harness.requestedUser(), "user-a");
});

test("loopback aliases retain the exact inspected origin", async function () {
  var harness = inspectHarness();
  var result = await harness.inspect("http://127.0.0.1:4242/account");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.target.localUrl, "http://127.0.0.1:4242");
});

test("remote inspected origins must equal the server-derived Tailscale origin", async function () {
  var accepted = inspectHarness({
    tailscaleUrl: "http://100.80.20.10:4242",
  });
  var result = await accepted.inspect("http://100.80.20.10:4242/account");
  assert.strictEqual(result.ok, true);

  var denied = inspectHarness({
    tailscaleUrl: "http://100.80.20.10:4242",
  });
  var deniedResult = await denied.inspect("https://attacker.example/account");
  assert.strictEqual(deniedResult.ok, false);
  assert.strictEqual(deniedResult.code, "LIVE_UI_TARGET_ORIGIN_DENIED");
});

test("unregistered server workspaces are rejected", async function () {
  var harness = inspectHarness({ matches: [] });
  var result = await harness.inspect("http://localhost:4242/account");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "LIVE_UI_TARGET_PROJECT_NOT_FOUND");
});

test("chat workspace bindings persist and reject another project", function () {
  var persisted = [];
  var workspace = attachWorkspace({
    cwd: "/repo/clay",
    slug: "clay",
    send: function () {},
    sendTo: function () {},
    getSessionForWs: function () { return null; },
    hydrateImageRefs: function () {},
    tm: {},
    getOsUserInfoForWs: function () {},
    usersModule: {},
    osUsers: false,
    getProjectList: function () { return []; },
    persistSession: function (session) { persisted.push(session); },
  });
  var session = {};
  assert.strictEqual(workspace.bindLiveUiTarget(session, {
    projectSlug: "clay",
    writableRoot: "/repo/.worktrees/design",
  }), true);
  assert.strictEqual(session.devCwdAbs, "/repo/.worktrees/design");
  assert.deepStrictEqual(persisted, [session]);
  assert.strictEqual(workspace.bindLiveUiTarget(session, {
    projectSlug: "other",
    writableRoot: "/repo/other",
  }), false);
  assert.strictEqual(session.devCwdAbs, "/repo/.worktrees/design");
});
