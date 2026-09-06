var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var spawnSync = require("node:child_process").spawnSync;

function fixture(t, isolated) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-recent-projects-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var home = path.join(root, "owner");
  var state = path.join(root, "preview");
  fs.mkdirSync(home);
  fs.mkdirSync(state);
  var original = JSON.stringify({ recentProjects: [{ path: "/existing-project", slug: "existing" }] });
  fs.writeFileSync(path.join(home, ".clayrc"), original);
  var target = path.join(state, "nested", "recent-projects.json");
  var env = Object.assign({}, process.env, {
    CLAY_HOME: state, CLAY_TEST_FAKE_HOME: home,
  });
  delete env.SUDO_USER;
  delete env.CLAY_RC_PATH;
  if (isolated) env.CLAY_RC_PATH = target;
  return { home: home, target: target, original: original, env: env };
}

function run(config) {
  // Only the OS home lookup is isolated. Exercise the actual config module and
  // its real read/sync/remove/save operations against files on disk.
  var source = [
    "require('node:os').homedir = function () { return process.env.CLAY_TEST_FAKE_HOME; };",
    "var config = require('./lib/config');",
    "var before = config.loadClayrc();",
    "config.syncClayrc([{ path: '/preview-project', slug: 'preview' }]);",
    "var synced = config.loadClayrc();",
    "config.removeFromClayrc('/preview-project');",
    "console.log(JSON.stringify({ before: before, synced: synced, after: config.loadClayrc(), file: config.clayrcPath() }));",
  ].join("\n");
  var result = spawnSync(process.execPath, ["-e", source], {
    cwd: path.join(__dirname, ".."), env: config.env, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("a parallel instance reads and updates only its configured recent-project file", function (t) {
  var files = fixture(t, true);
  var result = run(files);
  assert.deepEqual(result.before.recentProjects, []);
  assert.equal(result.file, files.target);
  assert.deepEqual(result.synced.recentProjects.map(function (p) { return p.path; }), ["/preview-project"]);
  assert.deepEqual(result.after.recentProjects, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.target, "utf8")), result.after);
  assert.equal(fs.readFileSync(path.join(files.home, ".clayrc"), "utf8"), files.original);
});

test("the ordinary instance retains the existing owner recent-project inventory", function (t) {
  var files = fixture(t, false);
  var result = run(files);
  assert.equal(result.file, path.join(files.home, ".clayrc"));
  assert.equal(result.before.recentProjects[0].path, "/existing-project");
  assert.deepEqual(result.synced.recentProjects.map(function (p) { return p.path; }),
    ["/preview-project", "/existing-project"]);
  assert.equal(result.after.recentProjects[0].path, "/existing-project");
  assert.equal(fs.existsSync(files.target), false);
});
