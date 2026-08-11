var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var net = require("node:net");
var spawnSync = require("node:child_process").spawnSync;
var createDevServerSupervisor =
  require("../lib/project-workspace-dev-supervisor").createDevServerSupervisor;

function makeFixture(t, overrides) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-dev-supervisor-"));
  var projectDir = path.join(root, "project");
  var stateRoot = path.join(root, "state");
  fs.mkdirSync(projectDir, { recursive: true });
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });

  var spawned = [];
  var killed = [];
  var nextPid = 4200;
  var options = Object.assign({
    projectDir: projectDir,
    slug: "example",
    stateRoot: stateRoot,
    daemonPid: 101,
    now: function () { return 100000; },
    isPidAlive: function () { return true; },
    checkPort: function (port, cb) { cb(false); },
    portBelongsToDir: function (port, dir, cb) { cb(false); },
    spawn: function (command, args, spawnOptions) {
      var child = {
        pid: nextPid++,
        unref: function () {},
        once: function () {},
      };
      spawned.push({ command: command, args: args, options: spawnOptions, child: child });
      return child;
    },
    killProcessGroup: function (record, cb) {
      killed.push(record);
      cb(true);
    },
    recordRecoveryEvent: function () {},
  }, overrides || {});

  return {
    root: root,
    projectDir: projectDir,
    stateRoot: stateRoot,
    spawned: spawned,
    killed: killed,
    options: options,
    create: function (more) {
      return createDevServerSupervisor(Object.assign({}, options, more || {}));
    },
  };
}

function startInput(fixture) {
  return {
    cwd: fixture.projectDir,
    script: "dev",
    command: "npm run dev",
    port: 4173,
    branch: "feature/restart-safe",
  };
}

function reservePort() {
  return new Promise(function (resolve, reject) {
    var server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", function () {
      var port = server.address().port;
      server.close(function () { resolve(port); });
    });
  });
}

function waitForPort(port, expectedLive, tries) {
  return new Promise(function (resolve, reject) {
    function poll(left) {
      var socket = net.connect({ host: "127.0.0.1", port: port });
      var settled = false;
      function finish(live) {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (live === expectedLive) return resolve();
        if (left <= 1) {
          return reject(new Error(
            "Port " + port + " did not become " + (expectedLive ? "live" : "closed")
          ));
        }
        setTimeout(function () { poll(left - 1); }, 50);
      }
      socket.once("connect", function () { finish(true); });
      socket.once("error", function () { finish(false); });
      socket.setTimeout(250, function () { finish(false); });
    }
    poll(40);
  });
}

test("managed development servers are detached and persisted", function (t) {
  var fixture = makeFixture(t);
  var supervisor = fixture.create();
  var result = supervisor.start(startInput(fixture));

  assert.strictEqual(result.ok, true);
  assert.strictEqual(fixture.spawned.length, 1);
  assert.strictEqual(fixture.spawned[0].options.detached, true);
  assert.strictEqual(fixture.spawned[0].options.cwd, fixture.projectDir);
  assert.strictEqual(fixture.spawned[0].options.env.PORT, "4173");
  assert.deepStrictEqual(fixture.spawned[0].options.stdio.slice(0, 1), ["ignore"]);
  assert.strictEqual(result.record.owner, "managed");
  assert.strictEqual(result.record.pid, 4200);
  assert.ok(fs.existsSync(supervisor.statePath));
});

test("a real managed server survives the launching daemon process", async function (t) {
  var fixture = makeFixture(t);
  var port = await reservePort();
  var serverScript = path.join(fixture.projectDir, "server.js");
  fs.writeFileSync(serverScript, [
    "var http = require('http');",
    "var server = http.createServer(function (req, res) { res.end('ok'); });",
    "server.listen(" + port + ", '127.0.0.1');",
    "process.on('SIGTERM', function () { server.close(function () { process.exit(0); }); });",
  ].join("\n"));

  var supervisorPath = path.join(__dirname, "..", "lib", "project-workspace-dev-supervisor.js");
  var parentSource = [
    "var create = require(" + JSON.stringify(supervisorPath) + ").createDevServerSupervisor;",
    "var supervisor = create({ projectDir: " + JSON.stringify(fixture.projectDir) +
      ", slug: 'real', stateRoot: " + JSON.stringify(fixture.stateRoot) + " });",
    "var result = supervisor.start({ cwd: " + JSON.stringify(fixture.projectDir) +
      ", script: 'dev', command: " +
      JSON.stringify(JSON.stringify(process.execPath) + " " + JSON.stringify(serverScript)) +
      ", port: " + port + " });",
    "if (!result.ok) { console.error(result.error); process.exit(1); }",
  ].join("\n");
  var parent = spawnSync(process.execPath, ["-e", parentSource], { encoding: "utf8", timeout: 5000 });
  assert.strictEqual(parent.status, 0, parent.stderr || parent.stdout);
  await waitForPort(port, true, 40);

  var replacement = createDevServerSupervisor({
    projectDir: fixture.projectDir,
    slug: "real",
    stateRoot: fixture.stateRoot,
  });
  var record = replacement.entryFor(fixture.projectDir);
  assert.ok(record && record.pid, "replacement daemon should load the detached server record");
  replacement.stop(fixture.projectDir);
  await waitForPort(port, false, 40);
});

test("a replacement daemon adopts a still-running managed server without respawning it", function (t) {
  var fixture = makeFixture(t, {
    checkPort: function (port, cb) { cb(true); },
    portBelongsToDir: function (port, dir, cb) { cb(true); },
  });
  var first = fixture.create({ daemonPid: 101 });
  first.start(startInput(fixture));

  var restored = [];
  var second = fixture.create({ daemonPid: 202 });
  second.restore(function (record, respawned) {
    restored.push({ record: record, respawned: respawned });
  });

  assert.strictEqual(fixture.spawned.length, 1);
  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].record.pid, 4200);
  assert.strictEqual(restored[0].respawned, false);
});

test("a replacement daemon relaunches a recently detected external server", function (t) {
  var fixture = makeFixture(t);
  var first = fixture.create({ daemonPid: 101 });
  first.observeExternal(startInput(fixture));

  var restored = [];
  var second = fixture.create({ daemonPid: 202 });
  second.restore(function (record, respawned) {
    restored.push({ record: record, respawned: respawned });
  });

  assert.strictEqual(fixture.spawned.length, 1);
  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].record.owner, "managed");
  assert.strictEqual(restored[0].respawned, true);
});

test("a replacement daemon rebases a surviving external server before an intentional stop", function (t) {
  var fixture = makeFixture(t, {
    checkPort: function (port, cb) { cb(true); },
    portBelongsToDir: function (port, dir, cb) { cb(true); },
  });
  var first = fixture.create({ daemonPid: 101 });
  first.observeExternal(startInput(fixture));

  var second = fixture.create({ daemonPid: 202 });
  second.restore(function () {
    assert.fail("a surviving external server must not be respawned");
  });
  var adopted = second.entryFor(fixture.projectDir);

  assert.strictEqual(fixture.spawned.length, 0);
  assert.strictEqual(adopted.owner, "external");
  assert.strictEqual(adopted.daemonPid, 202);
  assert.strictEqual(second.forgetStoppedExternal(fixture.projectDir), true);
  assert.strictEqual(second.entryFor(fixture.projectDir), null);
});

test("an intentional same-daemon stop is not resurrected", function (t) {
  var fixture = makeFixture(t);
  var supervisor = fixture.create({ daemonPid: 101 });
  supervisor.observeExternal(startInput(fixture));
  supervisor.restore(function () {
    assert.fail("same-daemon external server must not be restored");
  });

  assert.strictEqual(fixture.spawned.length, 0);
  assert.strictEqual(supervisor.entryFor(fixture.projectDir), null);
});

test("stopping a managed server clears desired state and terminates its process group", function (t) {
  var fixture = makeFixture(t);
  var supervisor = fixture.create();
  var result = supervisor.start(startInput(fixture));
  var stopped = null;
  supervisor.stop(fixture.projectDir, function (ok) { stopped = ok; });

  assert.strictEqual(stopped, true);
  assert.strictEqual(fixture.killed.length, 1);
  assert.strictEqual(fixture.killed[0].groupPid, result.record.pid);
  assert.strictEqual(supervisor.entryFor(fixture.projectDir), null);
});
