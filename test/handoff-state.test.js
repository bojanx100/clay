var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { execFileSync } = require("child_process");

var handoffState = require("../lib/handoff-state");

function initRepo() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-handoff-state-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  execFileSync("git", ["checkout", "-q", "-b", "work-branch"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "hi");
  return dir;
}

test("collectGitStateAsync reports branch and dirty files off the event loop", async function () {
  handoffState.__clearGitStateCache();
  var dir = initRepo();
  var state = await handoffState.collectGitStateAsync(dir);
  assert.strictEqual(state.branch, "work-branch");
  assert.ok(state.dirtyFiles.indexOf("a.txt") !== -1);
});

test("a warmed cache lets the sync collector skip the blocking shell-out", async function () {
  handoffState.__clearGitStateCache();
  var dir = initRepo();
  await handoffState.warmGitStateCache(dir);
  // Change the tree AFTER warming: a real shell-out would see b.txt, a cache
  // read would not — so its absence proves the cached snapshot was used.
  fs.writeFileSync(path.join(dir, "b.txt"), "later");
  var state = handoffState.collectGitState(dir);
  assert.strictEqual(state.branch, "work-branch");
  assert.ok(state.dirtyFiles.indexOf("a.txt") !== -1);
  assert.strictEqual(state.dirtyFiles.indexOf("b.txt"), -1,
    "sync collector returned the warmed snapshot, not a fresh shell-out");
});

test("collectGitState falls back to a synchronous shell-out on a cache miss", function () {
  handoffState.__clearGitStateCache();
  var dir = initRepo();
  var state = handoffState.collectGitState(dir);
  assert.strictEqual(state.branch, "work-branch");
  assert.ok(state.dirtyFiles.indexOf("a.txt") !== -1);
});

test("an injected exec fn always uses the sync path and ignores the cache", async function () {
  handoffState.__clearGitStateCache();
  var dir = initRepo();
  await handoffState.warmGitStateCache(dir);
  var calls = [];
  function fakeExec(cmd, args) {
    calls.push(args[0]);
    if (args[0] === "rev-parse") return "injected-branch";
    if (args[0] === "status") return " M injected.txt";
    return "";
  }
  var state = handoffState.collectGitState(dir, fakeExec);
  assert.strictEqual(state.branch, "injected-branch",
    "explicit execFn bypasses the cache so tests stay deterministic");
  assert.ok(calls.indexOf("rev-parse") !== -1);
});
