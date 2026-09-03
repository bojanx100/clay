// A worktree registration outlives its directory: git keeps the row until
// someone runs `git worktree prune`. Clay's daemon registers every scanned
// worktree as a project, so a stale row became a project pointing at a path
// that cannot be opened -- and because only pruning clears the row, it came
// back on every rescan. Observed live: 126 registered projects against 16 real
// ones, with 45 leftover /private/tmp agent worktrees.
//
// These tests drive real git rather than asserting on hand-written porcelain
// text, so they stay honest if the output format changes.
var test = require("node:test");
var assert = require("node:assert/strict");
var childProcess = require("node:child_process");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var worktree = require("../lib/worktree");

function git(cwd, args) {
  return childProcess.execFileSync("git", args, {
    cwd: cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
}

function removeTree(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function makeRepo() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-wt-missing-"));
  var repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "."]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "init"]);
  return { root: root, repo: repo };
}

test("a worktree whose directory was deleted is not reported as scannable", function () {
  var fixture = makeRepo();
  try {
    var livePath = path.join(fixture.root, "live");
    var gonePath = path.join(fixture.root, "gone");
    git(fixture.repo, ["worktree", "add", "-q", livePath, "-b", "live"]);
    git(fixture.repo, ["worktree", "add", "-q", gonePath, "-b", "gone"]);

    var before = worktree.scanWorktrees(fixture.repo).map(function (wt) { return wt.dirName; });
    assert.deepEqual(before.sort(), ["gone", "live"], "precondition: both are scanned while present");

    // Exactly what an agent worktree cleanup does: remove the directory and
    // leave the registration behind.
    removeTree(gonePath);

    // git still lists the row, which is why the daemon kept rediscovering it.
    var porcelain = git(fixture.repo, ["worktree", "list", "--porcelain"]);
    assert.ok(porcelain.indexOf(gonePath) !== -1,
      "precondition: git still reports the stale registration");

    var after = worktree.scanWorktrees(fixture.repo).map(function (wt) { return wt.dirName; });
    assert.deepEqual(after, ["live"],
      "a registration with no directory must not be handed out as a project");
  } finally {
    removeTree(fixture.root);
  }
});

test("a worktree that still has files on disk is never dropped", function () {
  var fixture = makeRepo();
  try {
    var keepPath = path.join(fixture.root, "keep");
    git(fixture.repo, ["worktree", "add", "-q", keepPath, "-b", "keep"]);
    fs.writeFileSync(path.join(keepPath, "unsaved.txt"), "work in progress\n");

    var found = worktree.scanWorktrees(fixture.repo);
    var names = found.map(function (wt) { return wt.dirName; });
    assert.deepEqual(names, ["keep"],
      "an existing worktree stays scannable even with uncommitted work");
    assert.equal(found[0].branch, "keep", "its branch is still reported");
  } finally {
    removeTree(fixture.root);
  }
});

test("the async scan drops the same stale registration as the sync scan", function (t, done) {
  var fixture = makeRepo();
  var gonePath = path.join(fixture.root, "gone-async");
  var livePath = path.join(fixture.root, "live-async");
  git(fixture.repo, ["worktree", "add", "-q", livePath, "-b", "live-async"]);
  git(fixture.repo, ["worktree", "add", "-q", gonePath, "-b", "gone-async"]);
  removeTree(gonePath);

  // Signature is cb(err, results). Reading the first argument as the results
  // makes this assertion vacuous rather than failing, which is exactly how it
  // slipped through once already.
  worktree.scanWorktreesAsync(fixture.repo, function (err, results) {
    try {
      assert.equal(err, null, "the scan itself must succeed");
      assert.ok(Array.isArray(results), "results must be an array, not the error argument");
      var names = results.map(function (wt) { return wt.dirName; });
      assert.deepEqual(names, ["live-async"],
        "both scan paths must agree, or the rescan timer reintroduces the row the sync path dropped");
      done();
    } catch (err2) {
      done(err2);
    } finally {
      removeTree(fixture.root);
    }
  });
});

test("the parent checkout itself is still excluded from its own scan", function () {
  var fixture = makeRepo();
  try {
    var livePath = path.join(fixture.root, "live");
    git(fixture.repo, ["worktree", "add", "-q", livePath, "-b", "live"]);
    var names = worktree.scanWorktrees(fixture.repo).map(function (wt) { return wt.dirName; });
    assert.deepEqual(names, ["live"],
      "the main working tree exists, so only the missing-directory rule may remove rows");
  } finally {
    removeTree(fixture.root);
  }
});
