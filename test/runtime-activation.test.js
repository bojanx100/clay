require("./helpers/isolated-clay-home");
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var execFileSync = require("child_process").execFileSync;
var net = require("net");
var activation = require("../lib/runtime-activation");
var verifyRuntime = require("../scripts/verify-runtime-activation").run;

function repository(t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-activation-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  function git(args) {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  }
  git(["init"]);
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "feature.js"), "module.exports = 1;\n");
  git(["add", "."]);
  git(["-c", "user.name=Clay Test", "-c", "user.email=test@clay.invalid", "commit", "-m", "feat: initial fixture"]);
  return { dir: dir, git: git };
}

test("activation compares actual serving checkout, boot source, and disk source", function (t) {
  var repo = repository(t);
  var runtime = activation.capture(repo.dir);
  var initial = activation.sourceIdentity(repo.dir);
  assert.equal(runtime.preflight(initial).alreadyActive, true);
  fs.writeFileSync(path.join(repo.dir, "lib", "feature.js"), "module.exports = 2;\n");
  var updated = activation.sourceIdentity(repo.dir);
  assert.equal(initial.revision, updated.revision, "uncommitted overlays keep the same HEAD");
  assert.notEqual(initial.sourceDigest, updated.sourceDigest, "source identity must detect the overlay anyway");
  assert.equal(runtime.preflight(updated).activationPending, true);
  assert.equal(activation.verify(runtime.inspect(), updated).ok, false);
  assert.equal(activation.verify(runtime.inspect(), initial).ok, false, "mixed disk/loaded source is not verified");
  assert.equal(runtime.preflight(initial).ok, false, "a restart cannot load source no longer on disk");
  var replacement = activation.capture(repo.dir);
  assert.equal(activation.verify(replacement.inspect(), updated).activationVerified, true);
});

test("the same commit in a different checkout cannot satisfy activation", function (t) {
  var repo = repository(t);
  var other = path.join(repo.dir, "other");
  repo.git(["worktree", "add", "--detach", other, "HEAD"]);
  var expected = activation.sourceIdentity(other);
  var runtime = activation.capture(repo.dir);
  assert.equal(expected.revision, runtime.inspect().boot.revision);
  assert.equal(runtime.preflight(expected).code, "ACTIVATION_TARGET_MISMATCH");
  assert.equal(activation.verify(runtime.inspect(), expected).ok, false);
});

test("a landed commit is not activation of a still-running process", function (t) {
  var repo = repository(t);
  var runtime = activation.capture(repo.dir);
  fs.writeFileSync(path.join(repo.dir, "lib", "feature.js"), "module.exports = 3;\n");
  repo.git(["add", "."]);
  repo.git(["-c", "user.name=Clay Test", "-c", "user.email=test@clay.invalid", "commit", "-m", "fix: fixture change"]);
  var expected = activation.sourceIdentity(repo.dir);
  assert.notEqual(expected.revision, runtime.inspect().boot.revision);
  assert.equal(runtime.preflight(expected).activationPending, true);
  assert.equal(activation.verify(runtime.inspect(), expected).ok, false);
});

async function socketFixture(t, handler) {
  var socket = path.join(os.tmpdir(), "clay-activate-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".sock");
  var server = net.createServer(function (connection) {
    var buffer = "";
    connection.on("data", function (chunk) {
      buffer += chunk;
      if (buffer.indexOf("\n") !== -1) connection.end(JSON.stringify(handler(JSON.parse(buffer))) + "\n");
    });
  });
  await new Promise(function (resolve) { server.listen(socket, resolve); });
  t.after(function () { server.close(); });
  return socket;
}

test("activation CLI verifies the replacement over real IPC instead of trusting restart success", async function (t) {
  var repo = repository(t);
  var runtime = activation.capture(repo.dir);
  fs.writeFileSync(path.join(repo.dir, "lib", "feature.js"), "module.exports = 4;\n");
  var restarted = 0;
  var socket = await socketFixture(t, function (message) {
    if (message.cmd === "runtime_identity") return { ok: true, runtime: runtime.inspect() };
    assert.equal(message.cmd, "restart");
    var check = runtime.preflight(message.activation);
    if (!check.ok) return check;
    restarted++;
    runtime = activation.capture(repo.dir);
    return { ok: true, pending: true };
  });
  assert.equal((await verifyRuntime({ socket: socket, checkout: repo.dir })).ok, false);
  assert.equal(restarted, 0, "the default command is read-only");
  var result = await verifyRuntime({ socket: socket, checkout: repo.dir, restart: true, timeoutMs: 1000 });
  assert.equal(result.activationVerified, true);
  assert.equal(restarted, 1);
  assert.equal((await verifyRuntime({ socket: socket, checkout: repo.dir, restart: true })).ok, true);
  assert.equal(restarted, 1, "already loaded source requires no second restart");
});

test("a successful no-op restart remains unverified", async function (t) {
  var repo = repository(t);
  var runtime = activation.capture(repo.dir);
  fs.writeFileSync(path.join(repo.dir, "lib", "feature.js"), "module.exports = 5;\n");
  var socket = await socketFixture(t, function (message) {
    return message.cmd === "runtime_identity" ? { ok: true, runtime: runtime.inspect() } : { ok: true };
  });
  assert.equal((await verifyRuntime({ socket: socket, checkout: repo.dir, restart: true, timeoutMs: 10 })).code,
    "ACTIVATION_PENDING");
});

test("an old runtime that cannot attest its source is not restarted blindly", async function (t) {
  var repo = repository(t);
  var requests = [];
  var socket = await socketFixture(t, function (message) { requests.push(message.cmd); return { ok: false, error: "unknown_command" }; });
  assert.equal((await verifyRuntime({ socket: socket, checkout: repo.dir, restart: true })).ok, false);
  assert.deepEqual(requests, ["runtime_identity"]);
});

test("the real isolated daemon reports its loaded source and refuses activation of a different checkout", { timeout: 30000 }, async function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-activation-daemon-"));
  var config = path.join(dir, "daemon-dev.json");
  var socket = path.join(dir, "daemon-dev.sock");
  var root = path.resolve(__dirname, "..");
  var preload = path.join(dir, "preload.js");
  fs.writeFileSync(preload, "require(" + JSON.stringify(path.join(root, "lib/server-tui-hooks.js")) +
    ").installTuiHooks = function () {};\n");
  fs.writeFileSync(config, JSON.stringify({ port: 0, host: "127.0.0.1", tls: false, projects: [] }));
  var env = Object.assign({}, process.env, { HOME: dir, CLAY_HOME: dir, CLAY_CONFIG: config, CLAY_DEV: "1" });
  delete env.SUDO_USER;
  delete env.SUDO_HOME;
  var child = require("child_process").spawn(process.execPath, ["--require", preload, path.join(root, "lib/daemon.js")],
    { cwd: dir, env: env, stdio: ["ignore", "pipe", "pipe"] });
  var output = "";
  child.stdout.on("data", function (data) { output += data; });
  child.stderr.on("data", function (data) { output += data; });
  t.after(async function () {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise(function (resolve) {
        var timer = setTimeout(function () { child.kill("SIGKILL"); resolve(); }, 5000);
        child.once("exit", function () { clearTimeout(timer); resolve(); });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  var send = require("../lib/ipc").sendIPCCommand;
  var deadline = Date.now() + 15000;
  var ready;
  while (Date.now() < deadline && child.exitCode === null) {
    ready = await send(socket, { cmd: "get_status" }, 200);
    if (ready && ready.ok) break;
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
  }
  assert.ok(ready && ready.ok, output.slice(-4000));
  var identity = await send(socket, { cmd: "runtime_identity" });
  assert.equal(identity.ok, true, JSON.stringify(identity));
  var expected = activation.sourceIdentity(root);
  assert.equal(activation.verify(identity.runtime, expected).ok, true);
  assert.equal(identity.runtime.pid, child.pid);
  assert.equal((await send(socket, { cmd: "restart", activation: expected })).alreadyActive, true);
  var wrong = activation.sourceIdentity(repository(t).dir);
  assert.equal((await send(socket, { cmd: "restart", activation: wrong })).code, "ACTIVATION_TARGET_MISMATCH");
  assert.equal((await send(socket, { cmd: "runtime_identity" })).runtime.pid, child.pid);
  var recoveryFile = path.join(dir, "recovery-events-dev.log");
  var canaries = fs.existsSync(recoveryFile) ? fs.readFileSync(recoveryFile, "utf8") : "";
  assert.doesNotMatch(canaries, /"kind":"(?:context_overflow|auto_resume|stream_stall)"/);
});
