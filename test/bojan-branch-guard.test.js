var test = require("node:test");
var assert = require("node:assert/strict");
var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

var REPO_ROOT = path.join(__dirname, "..");
var PUSH_SCRIPT = path.join(REPO_ROOT, "scripts", "push-bojan.js");

function run(command, args, cwd, options) {
  var opts = options || {};
  return childProcess.spawnSync(command, args, {
    cwd: cwd,
    encoding: "utf8",
    env: opts.env || process.env,
  });
}

function git(args, cwd, options) {
  var result = run("git", args, cwd, options);
  if (result.status !== 0) {
    throw new Error("git " + args.join(" ") + " failed: " + (result.stderr || result.stdout));
  }
  return String(result.stdout || "").trim();
}

function write(file, text) {
  fs.writeFileSync(file, text, "utf8");
}

function fixture(t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bojan-guard-"));
  var remote = path.join(root, "remote.git");
  var main = path.join(root, "main");
  var worker = path.join(root, "worker");
  var hooks = path.join(root, "hooks");
  fs.mkdirSync(hooks);
  fs.copyFileSync(path.join(REPO_ROOT, ".githooks", "pre-commit"),
    path.join(hooks, "pre-commit"));
  fs.copyFileSync(path.join(REPO_ROOT, ".githooks", "pre-push"),
    path.join(hooks, "pre-push"));
  fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
  fs.chmodSync(path.join(hooks, "pre-push"), 0o755);

  git(["init", "--bare", remote], root);
  git(["init", "-b", "bojan", main], root);
  git(["config", "user.name", "Test User"], main);
  git(["config", "user.email", "test@example.com"], main);
  write(path.join(main, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], main);
  git(["commit", "-m", "test: seed"], main);
  git(["remote", "add", "origin", remote], main);
  git(["push", "-u", "origin", "bojan"], main);
  git(["config", "core.hooksPath", hooks], main);
  git(["worktree", "add", "-b", "worker-change", worker, "origin/bojan"], main);

  t.after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root: root, remote: remote, main: main, worker: worker };
}

test("the hook rejects direct commits on local bojan", function (t) {
  var h = fixture(t);
  write(path.join(h.main, "local.txt"), "must stay uncommitted\n");
  git(["add", "local.txt"], h.main);
  var result = run("git", ["commit", "-m", "test: forbidden"], h.main);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /direct commits on bojan are blocked/);
  assert.equal(fs.readFileSync(path.join(h.main, "local.txt"), "utf8"),
    "must stay uncommitted\n", "the guard must preserve the owner's local work");
});

test("the wrapper pushes a worker and aligns a clean local bojan exactly", function (t) {
  var h = fixture(t);
  write(path.join(h.worker, "change.txt"), "worker change\n");
  git(["add", "change.txt"], h.worker);
  git(["commit", "-m", "test: worker change"], h.worker);

  var direct = run("git", ["push", "origin", "HEAD:bojan"], h.worker);
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /direct pushes to bojan are blocked/);

  var pushed = run(process.execPath, [PUSH_SCRIPT], h.worker);
  assert.equal(pushed.status, 0, pushed.stderr || pushed.stdout);
  var local = git(["rev-parse", "bojan"], h.main);
  var tracked = git(["rev-parse", "origin/bojan"], h.main);
  var remote = git(["rev-parse", "refs/heads/bojan"], h.remote);
  assert.equal(local, tracked);
  assert.equal(local, remote);
  assert.match(pushed.stdout, /local bojan and origin\/bojan now match/);
  assert.equal(fs.existsSync(h.worker), false, "completed worktree must be removed");
  assert.equal(git(["branch", "--list", "worker-change"], h.main), "");
});

test("the wrapper preserves an uncommitted main checkout after pushing", function (t) {
  var h = fixture(t);
  var oldLocal = git(["rev-parse", "bojan"], h.main);
  write(path.join(h.main, "owner.txt"), "owner work\n");
  write(path.join(h.worker, "change.txt"), "worker change\n");
  git(["add", "change.txt"], h.worker);
  git(["commit", "-m", "test: worker change"], h.worker);

  var pushed = run(process.execPath, [PUSH_SCRIPT], h.worker);
  assert.equal(pushed.status, 0, pushed.stderr || pushed.stdout);
  assert.match(pushed.stderr, /left local bojan unchanged.*uncommitted changes/);
  assert.equal(git(["rev-parse", "bojan"], h.main), oldLocal);
  assert.notEqual(git(["rev-parse", "origin/bojan"], h.main), oldLocal);
  assert.equal(fs.readFileSync(path.join(h.main, "owner.txt"), "utf8"), "owner work\n");
});

var cleanup = require("../scripts/cleanup-worktree").cleanup;

test("cleanup preserves unique commits and dirty merged work", function (t) {
  var h = fixture(t);
  write(path.join(h.worker, "pending.txt"), "pending\n");
  assert.equal(cleanup(h.main, h.worker), false);
  git(["add", "pending.txt"], h.worker);
  git(["commit", "-m", "test: unfinished work"], h.worker);
  assert.equal(cleanup(h.main, h.worker), false);
  assert.equal(fs.existsSync(path.join(h.worker, "pending.txt")), true);
});

test("cleanup preserves protected and locked worktrees", function (t) {
  var h = fixture(t);
  git(["branch", "-m", "codex/ui-overhaul-example"], h.worker);
  assert.equal(cleanup(h.main, h.worker), false);
  git(["branch", "-m", "worker-change"], h.worker);
  git(["worktree", "lock", h.worker], h.main);
  assert.equal(cleanup(h.main, h.worker), false);
  assert.equal(cleanup(h.main, h.main), false);
});

test("cleanup preserves worktrees occupied by a process", function (t) {
  var h = fixture(t);
  var active = childProcess.spawn(process.execPath, ["-e", "setInterval(function () {}, 1000)"], {
    cwd: h.worker, stdio: "ignore",
  });
  t.after(function () { active.kill(); });
  assert.equal(cleanup(h.main, h.worker), false);
  assert.equal(fs.existsSync(h.worker), true);
});
