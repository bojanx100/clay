var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var spawnSync = require("node:child_process").spawnSync;

function freshConfig(t) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clay-pid-liveness-"));
  var previous = process.env.CLAY_HOME;
  process.env.CLAY_HOME = home;
  delete require.cache[require.resolve("../lib/config")];
  var config = require("../lib/config");
  t.after(function () {
    if (previous === undefined) delete process.env.CLAY_HOME;
    else process.env.CLAY_HOME = previous;
    delete require.cache[require.resolve("../lib/config")];
    fs.rmSync(home, { recursive: true, force: true });
  });
  return config;
}

function deadPid() {
  return spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid;
}

test("isPidAlive distinguishes process existence from signal permission", function (t) {
  var config = freshConfig(t);
  var realKill = process.kill;
  t.after(function () { process.kill = realKill; });

  process.kill = function () {
    var err = new Error("not permitted");
    err.code = "EPERM";
    throw err;
  };
  assert.equal(config.isPidAlive(4242), true, "EPERM proves the process exists");

  process.kill = function () {
    var err = new Error("gone");
    err.code = "ESRCH";
    throw err;
  };
  assert.equal(config.isPidAlive(4242), false, "ESRCH is the dead-process answer");

  process.kill = function () { throw new Error("unknown probe failure"); };
  assert.equal(config.isPidAlive(4242), true, "unknown errors do not authorize cleanup");
});

test("isPidAlive rejects malformed and process-group selectors before probing", function (t) {
  var config = freshConfig(t);
  var realKill = process.kill;
  var asked = false;
  process.kill = function () { asked = true; };
  t.after(function () { process.kill = realKill; });

  var malformed = [0, -1, 1.5, NaN, Infinity, "1", null, undefined, {}, [], true];
  for (var i = 0; i < malformed.length; i++) {
    assert.equal(config.isPidAlive(malformed[i]), false);
  }
  assert.equal(asked, false, "invalid pids never reach process.kill");
});

test("isPidAlive reports a signalable process alive and a completed child dead", function (t) {
  var config = freshConfig(t);
  assert.equal(config.isPidAlive(process.pid), true);
  var gone = deadPid();
  assert.equal(config.isPidAlive(gone), false);
});

test("isDaemonAlive preserves a foreign process config on EPERM", function (t) {
  var config = freshConfig(t);
  var realKill = process.kill;
  t.after(function () { process.kill = realKill; });
  config.ensureConfigDir();
  config.saveConfig({ pid: 4242, port: 4711, projects: [] });
  fs.writeFileSync(config.socketPath(), "socket-marker");
  process.kill = function () {
    var err = new Error("not permitted");
    err.code = "EPERM";
    throw err;
  };

  assert.equal(config.isDaemonAlive(config.loadConfig()), true);
  assert.equal(fs.readFileSync(config.socketPath(), "utf8"), "socket-marker");
  assert.equal(config.loadConfig().pid, 4242);
});

test("isDaemonAlive still clears a confirmed dead process", function (t) {
  var config = freshConfig(t);
  var realKill = process.kill;
  t.after(function () { process.kill = realKill; });
  config.ensureConfigDir();
  config.saveConfig({ pid: 4242, port: 4711, projects: [{ path: "/tmp/p", slug: "p" }] });
  fs.writeFileSync(config.socketPath(), "socket-marker");
  process.kill = function () {
    var err = new Error("gone");
    err.code = "ESRCH";
    throw err;
  };

  assert.equal(config.isDaemonAlive(config.loadConfig()), false);
  assert.equal(fs.existsSync(config.socketPath()), false);
  assert.equal(config.loadConfig().pid, null);
  assert.deepEqual(config.loadConfig().projects, [{ path: "/tmp/p", slug: "p" }]);
});
