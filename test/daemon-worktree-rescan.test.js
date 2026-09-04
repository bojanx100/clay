var test = require("node:test");
var assert = require("node:assert/strict");
var childProcess = require("node:child_process");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var daemonProjects = require("../lib/daemon-projects");

function git(args) {
  return childProcess.execFileSync("git", args, { encoding: "utf8" });
}

function createFixture() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-worktree-rescan-"));
  var parentPath = path.join(root, "parent");
  var firstPath = path.join(root, "first");
  var secondPath = path.join(root, "second");
  fs.mkdirSync(parentPath);
  git(["init", parentPath]);
  fs.writeFileSync(path.join(parentPath, "README.md"), "fixture\n");
  git(["-C", parentPath, "add", "README.md"]);
  git(["-C", parentPath, "-c", "user.name=Clay Test", "-c",
    "user.email=test@clay.invalid", "commit", "-m", "fixture"]);
  git(["-C", parentPath, "worktree", "add", "-b", "rescan-first", firstPath]);
  git(["-C", parentPath, "worktree", "add", "-b", "rescan-second", secondPath]);
  return { root: root, parentPath: parentPath, firstPath: firstPath, secondPath: secondPath };
}

function createRelay() {
  var projects = {};
  var added = [];
  var removed = [];
  var broadcasts = [];
  return {
    added: added,
    removed: removed,
    broadcasts: broadcasts,
    addProject: function (worktreePath, slug) {
      projects[slug] = worktreePath;
      added.push(slug);
      return true;
    },
    removeProject: function (slug) {
      delete projects[slug];
      removed.push(slug);
    },
    getProjects: function () {
      return Object.keys(projects);
    },
    broadcastAll: function (message) {
      broadcasts.push(message);
    },
  };
}

test("worktree rescan preserves inventory on errors and confirms removals", async function () {
  var fixture = createFixture();
  var relay = createRelay();
  var slug = "rescan-parent-" + process.pid + "-" + Date.now();
  var gitPath = path.join(fixture.parentPath, ".git");
  var disabledGitPath = path.join(fixture.parentPath, ".git.disabled");
  try {
    var initial = await daemonProjects.scanAndRegisterWorktrees(relay,
      fixture.parentPath, slug, null, null, "5332aafc-31e7-5cb1-ba96-c8d90e78260e");
    assert.equal(initial.ok, true);
    assert.equal(initial.added, 2);
    assert.equal(relay.added.length, 2);

    fs.renameSync(gitPath, disabledGitPath);
    var failed = await daemonProjects.rescanWorktrees(relay,
      fixture.parentPath, slug, null, null, null,
      "5332aafc-31e7-5cb1-ba96-c8d90e78260e");
    fs.renameSync(disabledGitPath, gitPath);

    assert.equal(failed.ok, false);
    assert.equal(relay.removed.length, 0,
      "a failed Git scan must never be interpreted as an empty inventory");

    git(["-C", fixture.parentPath, "worktree", "remove", "--force", fixture.firstPath]);
    var firstMiss = await daemonProjects.rescanWorktrees(relay,
      fixture.parentPath, slug, null, null, null,
      "5332aafc-31e7-5cb1-ba96-c8d90e78260e");
    assert.equal(firstMiss.ok, true);
    assert.equal(firstMiss.removed, 0);
    assert.equal(relay.removed.length, 0,
      "one successful missing scan is not enough to tear down a project context");

    var confirmed = await daemonProjects.rescanWorktrees(relay,
      fixture.parentPath, slug, null, null, null,
      "5332aafc-31e7-5cb1-ba96-c8d90e78260e");
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.removed, 1);
    assert.deepEqual(relay.removed, [slug + "--first"]);
  } finally {
    if (fs.existsSync(disabledGitPath) && !fs.existsSync(gitPath)) {
      fs.renameSync(disabledGitPath, gitPath);
    }
    daemonProjects.cleanupWorktreesForParent(relay, slug);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("worktree discovery skips non-Git projects instead of starting failed rescans", async function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-non-git-rescan-"));
  var parentPath = path.join(root, "plain-project");
  var relay = createRelay();
  var slug = "plain-project-" + process.pid + "-" + Date.now();
  fs.mkdirSync(parentPath);
  try {
    var result = await daemonProjects.scanAndRegisterWorktrees(relay,
      parentPath, slug, null, null, "5332aafc-31e7-5cb1-ba96-c8d90e78260e");
    assert.deepEqual(result, { ok: true, skipped: "not_git_repository" });
    assert.equal(relay.added.length, 0);
    assert.equal(relay.removed.length, 0);
    assert.equal(relay.broadcasts.length, 0);
  } finally {
    daemonProjects.cleanupWorktreesForParent(relay, slug);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
