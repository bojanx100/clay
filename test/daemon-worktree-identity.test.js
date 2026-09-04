var test = require("node:test");
var assert = require("node:assert/strict");
var childProcess = require("node:child_process");
var fs = require("node:fs");
var ipc = require("../lib/ipc");
var os = require("node:os");
var path = require("node:path");
var daemonProjects = require("../lib/daemon-projects");

function git(args) {
  return childProcess.execFileSync("git", args, { encoding: "utf8" });
}

// These tests boot a real daemon, which spawns its own children. Waiting for the
// daemon to exit does not mean those grandchildren are gone, and one still
// flushing into the directory makes a recursive remove fail with ENOTEMPTY
// partway through its walk. `force` only suppresses ENOENT, so it does nothing
// for this.
//
// Measured, not assumed: against a writer that lingers ~250ms after teardown
// starts, force-only failed 5 of 5 runs and force+retries passed 5 of 5. The
// bound is real though -- a writer that never stops defeats retries too (0 of 5
// either way), so this covers a straggler finishing its last write, which is the
// case here, and not a genuinely leaked process.
function removeTree(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function canonicalPath(value) {
  var resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch (e) { return resolved; }
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

function createBrowserHelperFixture(parentPath) {
  var helperPath = parentPath + "-chrome";
  git(["init", helperPath]);
  return helperPath;
}

function createIndependentProjectFixture() {
  var projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "unrelated-project-"));
  git(["init", projectPath]);
  return projectPath;
}

function removeWorktreeFixture(fixture) {
  try { git(["-C", fixture.parentPath, "worktree", "remove", "--force", fixture.worktreePath]); } catch (e) {}
  removeTree(fixture.parentPath);
  removeTree(fixture.worktreePath);
}

function waitForDaemonStatus(socketPath, child) {
  var deadline = Date.now() + 10000;
  return new Promise(function (resolve, reject) {
    function probe() {
      ipc.sendIPCCommand(socketPath, { cmd: "get_status" }, 250).then(function (status) {
        if (status && status.ok) {
          resolve(status);
          return;
        }
        if (child.exitCode !== null) {
          reject(new Error("fixture daemon exited before listening"));
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("fixture daemon did not listen within 10 seconds"));
          return;
        }
        setTimeout(probe, 50);
      });
    }
    probe();
  });
}

function waitForProject(socketPath, child, predicate) {
  var deadline = Date.now() + 10000;
  return new Promise(function (resolve, reject) {
    function probe() {
      ipc.sendIPCCommand(socketPath, { cmd: "get_status" }, 250).then(function (status) {
        if (status && status.ok && status.projects.some(predicate)) {
          resolve(status);
          return;
        }
        if (child.exitCode !== null) {
          reject(new Error("fixture daemon exited before registering the project"));
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("fixture daemon did not register the project within 10 seconds"));
          return;
        }
        setTimeout(probe, 50);
      });
    }
    probe();
  });
}

function stopDaemon(child, socketPath) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (child.exitCode === null) child.kill("SIGTERM");
    }, 3000);
    child.once("exit", function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    ipc.sendIPCCommand(socketPath, { cmd: "shutdown" }, 1000).then(function () {
      if (child.exitCode !== null && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
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

test("configured execution roots are discarded while their canonical project remains", function () {
  var parentProjectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var fixture = createWorktreeFixture();
  var browserHelperPath = createBrowserHelperFixture(fixture.parentPath);
  var unrelatedProjectPath = createIndependentProjectFixture();
  var isolatedPath = path.join(os.tmpdir(), path.basename(fixture.parentPath) + "-r6-isolated.fixture");
  fs.mkdirSync(isolatedPath);
  try {
    var reconciliation = daemonProjects.reconcileConfiguredProjects([{
      path: fixture.parentPath,
      slug: "clay",
      projectId: parentProjectId,
    }, {
      path: fixture.worktreePath,
      slug: "clay-fix-r6-compaction-source-stream-fanout",
      projectId: "e9afddc4-9943-5b8c-971c-2b267ed3b361",
    }, {
      path: isolatedPath,
      slug: "clay-r6-isolated-fixture",
      projectId: "3dac89c5-58c5-5998-bd32-369df1aa54c6",
    }, {
      path: browserHelperPath,
      slug: "clay-chrome",
      projectId: "f2b7c47a-bb03-5b3d-89ff-dd32ddb2be53",
    }, {
      path: unrelatedProjectPath,
      slug: "unrelated-project",
      projectId: "ce1151e9-92c9-5b0a-bbc7-b12c03e6276e",
    }]);

    assert.deepEqual(reconciliation.projects.map(function (project) { return project.slug; }),
      ["clay", "unrelated-project"]);
    assert.deepEqual(reconciliation.discarded.map(function (item) {
      return [item.project.slug, item.kind, item.parent.slug];
    }), [
      ["clay-fix-r6-compaction-source-stream-fanout", "worktree", "clay"],
      ["clay-r6-isolated-fixture", "temporary_execution", "clay"],
      ["clay-chrome", "browser_helper", "clay"],
    ]);
  } finally {
    removeTree(isolatedPath);
    removeTree(browserHelperPath);
    removeTree(unrelatedProjectPath);
    removeWorktreeFixture(fixture);
  }
});

test("configured /private/tmp canary root is discarded while its canonical project remains", function () {
  var parentPath = fs.mkdtempSync(path.join(os.tmpdir(), "clay-r6-private-parent-"));
  var parentName = path.basename(parentPath);
  var isolatedPath = fs.mkdtempSync(path.join("/private/tmp", parentName + "-r6-isolated."));
  try {
    var reconciliation = daemonProjects.reconcileConfiguredProjects([{
      path: parentPath,
      slug: "clay",
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
    }, {
      path: isolatedPath,
      slug: "clay-r6-isolated-fixture",
      projectId: "3dac89c5-58c5-5998-bd32-369df1aa54c6",
    }]);

    assert.deepEqual(reconciliation.projects.map(function (project) { return project.slug; }), ["clay"]);
    assert.deepEqual(reconciliation.discarded.map(function (item) {
      return [item.project.slug, item.kind, item.parent.slug];
    }), [["clay-r6-isolated-fixture", "temporary_execution", "clay"]]);
  } finally {
    removeTree(parentPath);
    removeTree(isolatedPath);
  }
});

test("daemon startup discards a stale worktree config row in favor of its canonical parent", async function () {
  var parentProjectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var staleProjectId = "e9afddc4-9943-5b8c-971c-2b267ed3b361";
  var fixture = createWorktreeFixture();
  var browserHelperPath = createBrowserHelperFixture(fixture.parentPath);
  var unrelatedProjectPath = createIndependentProjectFixture();
  var isolatedPath = path.join(os.tmpdir(), path.basename(fixture.parentPath) + "-r6-isolated.fixture");
  fs.mkdirSync(isolatedPath);
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clay-worktree-runtime-"));
  var configPath = path.join(home, "daemon-dev.json");
  var socketPath = path.join(home, "daemon-dev.sock");
  var child = null;
  try {
    fs.writeFileSync(path.join(home, ".clayrc"), JSON.stringify({
      recentProjects: [{
        path: fixture.parentPath,
        slug: "clay",
      }, {
        path: fixture.worktreePath,
        slug: "clay-fix-r6-compaction-source-stream-fanout",
      }, {
        path: isolatedPath,
        slug: "clay-r6-isolated-fixture",
      }, {
        path: browserHelperPath,
        slug: "clay-chrome",
      }, {
        path: unrelatedProjectPath,
        slug: "unrelated-project",
      }],
    }));
    fs.writeFileSync(configPath, JSON.stringify({
      port: 0,
      host: "127.0.0.1",
      tls: false,
      projects: [{
        path: fixture.parentPath,
        slug: "clay",
        projectId: parentProjectId,
      }, {
        path: fixture.worktreePath,
        slug: "clay-fix-r6-compaction-source-stream-fanout",
        projectId: staleProjectId,
      }, {
        path: isolatedPath,
        slug: "clay-r6-isolated-fixture",
        projectId: "3dac89c5-58c5-5998-bd32-369df1aa54c6",
      }, {
        path: browserHelperPath,
        slug: "clay-chrome",
        projectId: "f2b7c47a-bb03-5b3d-89ff-dd32ddb2be53",
      }, {
        path: unrelatedProjectPath,
        slug: "unrelated-project",
        projectId: "ce1151e9-92c9-5b0a-bbc7-b12c03e6276e",
      }],
    }));
    var environment = Object.assign({}, process.env, {
      HOME: home,
      CLAY_HOME: home,
      CLAY_CONFIG: configPath,
      CLAY_DEV: "1",
    });
    delete environment.SUDO_USER;
    delete environment.SUDO_HOME;
    child = childProcess.spawn(process.execPath, [path.join(__dirname, "../lib/daemon.js")], {
      cwd: path.join(__dirname, ".."),
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
    });

    await waitForDaemonStatus(socketPath, child);
    var status = await waitForProject(socketPath, child, function (project) {
      return project.isWorktree && canonicalPath(project.path) === canonicalPath(fixture.worktreePath);
    });
    var registeredProjects = status.projects;
    var projects = registeredProjects.filter(function (project) {
      var projectPath = canonicalPath(project.path);
      return projectPath === canonicalPath(fixture.parentPath) ||
        projectPath === canonicalPath(fixture.worktreePath);
    });
    var worktrees = projects.filter(function (project) { return project.isWorktree; });
    assert.equal(registeredProjects.filter(function (project) {
      return project.slug === "clay-fix-r6-compaction-source-stream-fanout";
    }).length, 0, "a stale config row must never reach the runtime project registry");
    assert.equal(registeredProjects.filter(function (project) {
      return project.slug === "clay-r6-isolated-fixture" || project.slug === "clay-chrome";
    }).length, 0, "temporary execution and browser helper rows must never reach the project picker");
    assert.equal(registeredProjects.filter(function (project) {
      return project.slug === "unrelated-project";
    }).length, 1, "an unrelated configured project must remain visible");
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0].projectId, parentProjectId);
    assert.equal(worktrees[0].parentProjectId, parentProjectId);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).projects.map(function (project) {
      return project.slug;
    }), ["clay", "unrelated-project"], "stale execution roots must not survive a discovery refresh");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".clayrc"), "utf8")).recentProjects.map(function (project) {
      return project.path;
    }), [fixture.parentPath, unrelatedProjectPath],
    "stale execution roots must not remain as inactive recent projects for a later CLI restore");
  } finally {
    if (child) await stopDaemon(child, socketPath);
    removeTree(home);
    removeTree(isolatedPath);
    removeTree(browserHelperPath);
    removeTree(unrelatedProjectPath);
    removeWorktreeFixture(fixture);
  }
});
