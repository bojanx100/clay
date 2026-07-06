var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachAutoLaunch } = require("../lib/project-auto-launch");
var { attachTaskLauncher } = require("../lib/project-task-launcher");

function makeTaskLauncher() {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-tasklauncher-"));
  var completed = [];
  var neededInput = [];
  var hidden = [];
  var tl = attachTaskLauncher({
    cwd: cwd,
    sm: {
      saveSessionFile: function () {},
      hideSessionForActiveClients: function (id) { hidden.push(id); },
      hideSession: function (id) { hidden.push(id); },
    },
    sdk: {},
    onComplete: function (session, summary) { completed.push({ session: session, summary: summary }); },
    onNeedsInput: function (session, text) { neededInput.push({ session: session, text: text }); },
  });
  return { tl: tl, cwd: cwd, completed: completed, neededInput: neededInput, hidden: hidden };
}

function makeAutoSession() {
  return {
    localId: 7,
    taskLauncher: {
      recipeId: "assigned-to-me",
      itemNumber: 1975,
      autoLaunch: true,
      autoKind: "issue",
      completion: {
        marker: "CLAY_TASK_COMPLETE",
        needsInputMarker: "CLAY_NEEDS_INPUT",
        closeSession: true,
        archiveSession: true,
      },
    },
  };
}

test("'mark as done' does not complete the workflow until the marker is emitted", function () {
  var h = makeTaskLauncher();
  try {
    var session = makeAutoSession();
    var directive = h.tl.handleTaskUserMessageDispatched(session, "Mark as done");
    // The user request latches a close and injects a directive that tells the
    // agent to finish and emit the completion marker.
    assert.strictEqual(session.taskLauncher.closeAfterNextTurn, true);
    assert.ok(directive && directive.indexOf("CLAY_TASK_COMPLETE") !== -1, "directive should reference the marker");

    // Agent asks a clarifying question instead of completing — must NOT close.
    h.tl.handleTaskTurnDone(session, "", "There are no todos. Could you clarify what to mark as done?");
    assert.notStrictEqual(session.taskLauncher.workflowCompleted, true);
    assert.strictEqual(h.completed.length, 0);
    assert.strictEqual(h.hidden.length, 0);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("workflow completes only when the marker is emitted", function () {
  var h = makeTaskLauncher();
  try {
    var session = makeAutoSession();
    h.tl.handleTaskUserMessageDispatched(session, "Mark as done");
    h.tl.handleTaskTurnDone(session, "", "Fixed the rename bug and pushed. CLAY_TASK_COMPLETE: fixed file-name display");
    assert.strictEqual(session.taskLauncher.workflowCompleted, true);
    assert.strictEqual(h.completed.length, 1);
    assert.strictEqual(h.completed[0].summary, "fixed file-name display");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("needs-input marker pauses for input without completing", function () {
  var h = makeTaskLauncher();
  try {
    var session = makeAutoSession();
    h.tl.handleTaskUserMessageDispatched(session, "Mark as done");
    h.tl.handleTaskTurnDone(session, "", "I need a decision here. CLAY_NEEDS_INPUT");
    assert.notStrictEqual(session.taskLauncher.workflowCompleted, true);
    assert.strictEqual(h.neededInput.length, 1);
    assert.strictEqual(h.completed.length, 0);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("auto-launch maxPasses config overrides pr-review recipe default", async function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-autolaunch-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: {
      enabled: true,
      recipeId: "pr-review",
      recipes: ["pr-review"],
      maxPasses: 5,
      cron: "*/5 * * * *",
    },
  }, null, 2) + "\n");

  var recipe = {
    id: "pr-review",
    source: { provider: "github", kind: "pr-reviews", repo: "owner/repo" },
    launch: { defaultLimit: 5, maxPasses: 2 },
    session: { title: "PR #{number} {title}" },
    completion: {},
  };
  var launchedItem = null;
  var launcher = {
    loadRecipe: function () {
      return recipe;
    },
    findExistingSessionForItem: function () {
      return null;
    },
    startSessionForItem: function (ws, r, item) {
      launchedItem = Object.assign({}, item);
      return { localId: 42, title: "PR #10 Fix me" };
    },
  };
  var autoLaunch = attachAutoLaunch({
    cwd: cwd,
    sm: {
      sessions: new Map(),
      broadcastSessionList: function () {},
    },
    getTaskLauncher: function () {
      return launcher;
    },
    fetchItems: function () {
      return [{
        number: 10,
        title: "Fix me",
        url: "https://github.com/owner/repo/pull/10",
        key: "owner/repo#10",
        head_sha: "abc123",
        ci_failing: false,
        latestFeedbackTs: Date.now(),
      }];
    },
  });

  try {
    var result = await autoLaunch.launchScheduled("pr-review");
    assert.strictEqual(result.started.length, 1);
    assert.ok(launchedItem, "PR item should launch");
    assert.strictEqual(launchedItem.max_passes, 5);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("issue auto-launch relaunches one legacy completed session without launch state", async function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-autolaunch-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: {
      enabled: true,
      recipeId: "assigned-to-me",
      recipes: ["assigned-to-me"],
      cron: "*/5 * * * *",
    },
  }, null, 2) + "\n");

  var recipe = {
    id: "assigned-to-me",
    source: { provider: "github", kind: "issues", repo: "owner/repo" },
    launch: { defaultLimit: 5 },
    session: { title: "Issue #{number} {title}" },
    completion: {},
  };
  var item = {
    number: 2002,
    title: "Bounced issue",
    url: "https://github.com/owner/repo/issues/2002",
  };
  var legacySession = {
    taskLauncher: {
      recipeId: "assigned-to-me",
      itemNumber: 2002,
      itemUrl: item.url,
      workflowCompleted: true,
    },
  };
  var launched = 0;
  var launcher = {
    loadRecipe: function () {
      return recipe;
    },
    findExistingSessionForItem: function (r, candidate, liveOnly) {
      assert.strictEqual(candidate.number, 2002);
      return liveOnly ? null : legacySession;
    },
    startSessionForItem: function () {
      launched++;
      return { localId: 44, title: "Issue #2002 Bounced issue" };
    },
  };
  var autoLaunch = attachAutoLaunch({
    cwd: cwd,
    sm: {
      sessions: new Map(),
      broadcastSessionList: function () {},
    },
    getTaskLauncher: function () {
      return launcher;
    },
    fetchItems: function () {
      return [item];
    },
  });

  try {
    var result = await autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(result.started.length, 1);
    assert.strictEqual(launched, 1);
    var state = JSON.parse(fs.readFileSync(path.join(tasksDir, "issue-launch-state.json"), "utf8"));
    assert.strictEqual(state["owner/repo#2002"].status, "launched");
    assert.strictEqual(state["owner/repo#2002"].armed, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("issue auto-launch does not repeatedly relaunch a completed session after state exists", async function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-autolaunch-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: {
      enabled: true,
      recipeId: "assigned-to-me",
      recipes: ["assigned-to-me"],
      cron: "*/5 * * * *",
    },
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(tasksDir, "issue-launch-state.json"), JSON.stringify({
    "owner/repo#2002": {
      status: "completed",
      statusAtCompletion: "Ready for development",
      armed: false,
      lastLaunchAt: 1,
      completedAt: 2,
      updatedAt: 2,
    },
  }, null, 2) + "\n");

  var recipe = {
    id: "assigned-to-me",
    source: { provider: "github", kind: "issues", repo: "owner/repo" },
    launch: { defaultLimit: 5 },
    session: { title: "Issue #{number} {title}" },
    completion: {},
  };
  var item = {
    number: 2002,
    title: "Bounced issue",
    url: "https://github.com/owner/repo/issues/2002",
  };
  var completedSession = {
    taskLauncher: {
      recipeId: "assigned-to-me",
      itemNumber: 2002,
      itemUrl: item.url,
      workflowCompleted: true,
    },
  };
  var launcher = {
    loadRecipe: function () {
      return recipe;
    },
    findExistingSessionForItem: function (r, candidate, liveOnly) {
      assert.strictEqual(candidate.number, 2002);
      return liveOnly ? null : completedSession;
    },
    startSessionForItem: function () {
      throw new Error("should not launch");
    },
  };
  var autoLaunch = attachAutoLaunch({
    cwd: cwd,
    sm: {
      sessions: new Map(),
      broadcastSessionList: function () {},
    },
    getTaskLauncher: function () {
      return launcher;
    },
    fetchItems: function () {
      return [item];
    },
  });

  try {
    var result = await autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(result.started.length, 0);
    assert.strictEqual(result.skipped.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("disabled auto-launch config ignores stale registry triggers", async function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-autolaunch-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: {
      enabled: false,
      recipeId: "assigned-to-me",
      recipes: ["assigned-to-me", "pr-review"],
      cron: "*/5 * * * *",
    },
  }, null, 2) + "\n");

  var fetched = 0;
  var launched = 0;
  var updated = null;
  var autoLaunch = attachAutoLaunch({
    cwd: cwd,
    sm: {
      sessions: new Map(),
      broadcastSessionList: function () {},
    },
    loopRegistry: {
      getById: function () {
        return { id: "autolaunch_assigned", enabled: true, task: "assigned-to-me" };
      },
      updateRecord: function (id, data) {
        updated = { id: id, data: data };
      },
    },
    getTaskLauncher: function () {
      return {
        loadRecipe: function () {
          launched++;
          return null;
        },
      };
    },
    fetchItems: function () {
      fetched++;
      return [];
    },
  });

  try {
    await autoLaunch.runScheduled({ id: "autolaunch_assigned", task: "assigned-to-me" });
    assert.strictEqual(fetched, 0);
    assert.strictEqual(launched, 0);
    assert.deepStrictEqual(updated, {
      id: "autolaunch_assigned",
      data: { enabled: false, nextRunAt: null },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Regression: the forked task-source worker must flush its IPC result before
// exiting. It previously called process.exit(0) synchronously right after
// process.send(), which raced the flush — on newer Node the parent saw 'exit'
// before 'message' and rejected every scan with "worker exited early", silently
// breaking scheduled auto-launch. Exercise the REAL child (not the injected sync
// fetch) so this path is covered. An unsupported source makes fetchItems throw
// fast with no network I/O; the point is the error is DELIVERED, not swallowed.
test("task-source worker delivers its result before exiting (no 'exited early')", async function () {
  var taskSources = require("../lib/project-task-sources");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-worker-"));
  try {
    var recipe = { id: "bogus", source: { provider: "nope" } };
    var err = null;
    try {
      await taskSources.fetchItemsAsync(cwd, recipe, {});
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected the scan to reject");
    assert.ok(
      /Unsupported task source/.test(err.message),
      "expected the worker's own error to be delivered, got: " + err.message
    );
    assert.ok(
      !/exited early/.test(err.message),
      "worker exited before flushing its IPC message: " + err.message
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
