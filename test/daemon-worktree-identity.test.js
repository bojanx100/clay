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

function createWorktreeFixture() {
  var parentPath = fs.mkdtempSync(path.join(os.tmpdir(), "clay-parent-project-"));
  var worktreePath = path.join(os.tmpdir(), "clay-temporary-worktree-" + process.pid + "-" + Date.now());
  git(["init", parentPath]);
  fs.writeFileSync(path.join(parentPath, "README.md"), "fixture\n");
  git(["-C", parentPath, "add", "README.md"]);
  git(["-C", parentPath, "-c", "user.name=Clay Test", "-c", "user.email=test@clay.invalid",
    "commit", "-m", "fixture"]);
  git(["-C", parentPath, "worktree", "add", "-b", "temporary-fixture", worktreePath]);
  return { parentPath: parentPath, worktreePath: worktreePath };
}

function removeWorktreeFixture(fixture) {
  try { git(["-C", fixture.parentPath, "worktree", "remove", "--force", fixture.worktreePath]); } catch (e) {}
  fs.rmSync(fixture.parentPath, { recursive: true, force: true });
  fs.rmSync(fixture.worktreePath, { recursive: true, force: true });
}

test("existing configured parent claims a temporary worktree before project ingress", function () {
  var parentProjectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var fixture = createWorktreeFixture();
  try {
    var found = daemonProjects.findRegisteredWorktree([{
      path: fixture.parentPath,
      slug: "clay",
      projectId: parentProjectId,
    }], fixture.worktreePath);

    assert.equal(found.slug, "clay--" + path.basename(fixture.worktreePath));
    assert.equal(found.title, "temporary-fixture");
    assert.deepEqual(found.worktreeMeta, {
      parentSlug: "clay",
      parentProjectId: parentProjectId,
      branch: "temporary-fixture",
      accessible: false,
    });
  } finally {
    removeWorktreeFixture(fixture);
  }
});

test("worktree ingress registers only the parent-owned ephemeral runtime", function () {
  var parentProjectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var fixture = createWorktreeFixture();
  var calls = [];
  var registered = [];
  try {
    var result = daemonProjects.registerParentOwnedWorktree({
      projects: [{
        path: fixture.parentPath,
        slug: "clay",
        projectId: parentProjectId,
        icon: "🧱",
        ownerId: "owner-1",
      }],
      path: fixture.worktreePath,
      relay: { addProject: function () {
        calls.push(Array.from(arguments));
        return true;
      } },
      registerWorktreeSlug: function (parentSlug, slug) {
        registered.push([parentSlug, slug]);
      },
    });

    var worktreeSlug = "clay--" + path.basename(fixture.worktreePath);
    assert.deepEqual(calls, [[fixture.worktreePath, worktreeSlug,
      "temporary-fixture", "🧱", "owner-1", {
        parentSlug: "clay", parentProjectId: parentProjectId,
        branch: "temporary-fixture", accessible: false,
      }]]);
    assert.deepEqual(registered, [["clay", worktreeSlug]]);
    assert.deepEqual(result, {
      ok: true,
      slug: worktreeSlug,
      existing: false,
      worktree: true,
      parentSlug: "clay",
      parentProjectId: parentProjectId,
    });
  } finally {
    removeWorktreeFixture(fixture);
  }
});
