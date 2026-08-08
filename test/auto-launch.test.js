var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachAutoLaunch } = require("../lib/project-auto-launch");

// These suites encode LEGACY behavior, which the cutover preserves exactly
// while Lead mode is off (CTO-ORCHESTRATOR-ROADMAP 1.1, additive-only). Lead
// mode is stated explicitly so the assertions never depend on the machine's
// ambient ~/.clay config. Lead-mode-ON behavior is covered separately.
function LEAD_OFF() { return false; }
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

function makePrReviewSession() {
  var session = makeAutoSession();
  session.taskLauncher.recipeId = "pr-review";
  session.taskLauncher.autoKind = "pr-review";
  session.taskLauncher.itemNumber = 1644;
  return session;
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

test("auto-launched workflow closes its session window without close flags", function () {
  var h = makeTaskLauncher();
  try {
    var session = makeAutoSession();
    delete session.taskLauncher.completion.closeSession;
    delete session.taskLauncher.completion.archiveSession;
    h.tl.handleTaskTurnDone(session, "", "Finished autonomous review. CLAY_TASK_COMPLETE");
    assert.strictEqual(session.taskLauncher.workflowCompleted, true);
    assert.deepStrictEqual(h.hidden, [7]);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("pr-review workflow accepts standard PR completion marker as fallback", function () {
  var h = makeTaskLauncher();
  try {
    var session = makePrReviewSession();
    h.tl.handleTaskTurnDone(session, "", "Updated the PR and CI is green.\n\nCLAY_PR_REVIEW_COMPLETE: fixed review hardening items and CI green");
    assert.strictEqual(session.taskLauncher.workflowCompleted, true);
    assert.strictEqual(h.completed.length, 1);
    assert.strictEqual(h.completed[0].summary, "fixed review hardening items and CI green");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("issue workflow does not accept PR completion marker", function () {
  var h = makeTaskLauncher();
  try {
    var session = makeAutoSession();
    h.tl.handleTaskTurnDone(session, "", "Updated the issue branch.\n\nCLAY_PR_REVIEW_COMPLETE: done");
    assert.notStrictEqual(session.taskLauncher.workflowCompleted, true);
    assert.strictEqual(h.completed.length, 0);
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
  var autoLaunch = attachAutoLaunch({ getLeadMode: LEAD_OFF,
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
  var autoLaunch = attachAutoLaunch({ getLeadMode: LEAD_OFF,
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
  var autoLaunch = attachAutoLaunch({ getLeadMode: LEAD_OFF,
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

test("issue auto-launch does not relaunch an armed issue while a visible completed session remains", async function () {
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
    "owner/repo#2097": {
      status: "completed",
      statusAtCompletion: "Dev Complete",
      armed: true,
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
    number: 2097,
    title: "Visible completed issue",
    url: "https://github.com/owner/repo/issues/2097",
  };
  var visibleCompletedSession = {
    hidden: false,
    taskLauncher: {
      recipeId: "assigned-to-me",
      itemNumber: 2097,
      itemUrl: item.url,
      workflowCompleted: true,
    },
  };
  var launcher = {
    loadRecipe: function () {
      return recipe;
    },
    findExistingSessionForItem: function () {
      return visibleCompletedSession;
    },
    findAnyLiveSessionForItem: function () {
      return null;
    },
    findAnyVisibleSessionForItem: function () {
      return visibleCompletedSession;
    },
    startSessionForItem: function () {
      throw new Error("should not launch");
    },
  };
  var autoLaunch = attachAutoLaunch({ getLeadMode: LEAD_OFF,
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
    var state = JSON.parse(fs.readFileSync(path.join(tasksDir, "issue-launch-state.json"), "utf8"));
    assert.strictEqual(state["owner/repo#2097"].armed, true);
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
  var autoLaunch = attachAutoLaunch({ getLeadMode: LEAD_OFF,
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

// Regression: the schedule record must track config.json even when it is edited
// directly on disk (not via the set_auto_launch UI path, which calls
// ensureSchedule). Otherwise the record's cron/task/name drift until the next
// project attach — and a changed cron keeps firing at the old frequency.
// runScheduled now reconciles the record when it detects drift.
test("runScheduled reconciles a drifted schedule record with config", async function () {
  var scheduler = require("../lib/scheduler");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-drift-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  function writeCfg(al) {
    fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({ autoLaunch: al }, null, 2));
  }
  try {
    writeCfg({ enabled: true, recipes: ["pr-review"], cron: "*/5 * * * *" });
    var reg = scheduler.createLoopRegistry({ cwd: cwd });
    reg.load();
    var autoLaunch = attachAutoLaunch({ getLeadMode: LEAD_OFF, cwd: cwd, loopRegistry: reg, fetchItems: function () { return []; } });
    autoLaunch.ensureSchedule();
    var before = reg.getById("autolaunch_assigned");
    assert.strictEqual(before.task, "pr-review");
    var stamp = before.updatedAt;

    // Direct file edit (no UI): add a recipe and change the cron.
    writeCfg({ enabled: true, recipes: ["assigned-to-me", "pr-review"], cron: "*/10 * * * *" });
    // Record is still stale until a tick fires runScheduled.
    assert.strictEqual(reg.getById("autolaunch_assigned").cron, "*/5 * * * *");

    await autoLaunch.runScheduled(reg.getById("autolaunch_assigned"));
    var after = reg.getById("autolaunch_assigned");
    assert.strictEqual(after.task, "assigned-to-me,pr-review");
    assert.strictEqual(after.cron, "*/10 * * * *");
    assert.strictEqual(after.name, "Auto-launch: assigned-to-me, pr-review");
    assert.ok(after.updatedAt >= stamp, "updatedAt should advance on reconcile");

    // A subsequent no-drift tick must not rewrite the record.
    var stamp2 = after.updatedAt;
    await autoLaunch.runScheduled(reg.getById("autolaunch_assigned"));
    assert.strictEqual(reg.getById("autolaunch_assigned").updatedAt, stamp2, "no-drift tick should not touch the record");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Cross-recipe issue dedup: two issue recipes (e.g. a misconfigured one cloning
// the issue source) must not both launch the same issue.
test("findAnyLiveSessionForItem matches live sessions across recipes, ignores completed", function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-anylive-"));
  try {
    var sessions = new Map();
    sessions.set("a", { localId: 1, taskLauncher: { recipeId: "recipe-a", itemNumber: 5, itemUrl: "https://github.com/o/r/issues/5", workflowCompleted: false } });
    sessions.set("b", { localId: 2, taskLauncher: { recipeId: "recipe-a", itemNumber: 9, itemUrl: "https://github.com/o/r/issues/9", workflowCompleted: true } });
    var tl = attachTaskLauncher({
      cwd: cwd,
      sm: { sessions: sessions, saveSessionFile: function () {} },
      sdk: {},
      onComplete: function () {},
      onNeedsInput: function () {},
    });
    // Different recipe, same issue -> found (cross-recipe).
    assert.ok(tl.findAnyLiveSessionForItem({ number: 5, url: "https://github.com/o/r/issues/5" }));
    // Completed session -> not a live dup.
    assert.strictEqual(tl.findAnyLiveSessionForItem({ number: 9, url: "https://github.com/o/r/issues/9" }), null);
    // Unrelated issue -> none.
    assert.strictEqual(tl.findAnyLiveSessionForItem({ number: 7, url: "https://github.com/o/r/issues/7" }), null);
    // A same-numbered PR (different URL) must not collide with the issue.
    assert.strictEqual(tl.findAnyLiveSessionForItem({ number: 5, url: "https://github.com/o/r/pull/5" }), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("launchScheduled skips an issue already live under another recipe", async function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xrecipe-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: { enabled: true, recipeId: "issues-b", recipes: ["issues-b"], cron: "*/5 * * * *" },
  }, null, 2) + "\n");

  var recipe = { id: "issues-b", source: { provider: "github", kind: "issue", repo: "o/r" }, launch: { defaultLimit: 5 }, session: {}, completion: {} };
  var started = [];
  var launcher = {
    loadRecipe: function () { return recipe; },
    // Same-recipe check finds nothing (the live session belongs to another recipe)...
    findExistingSessionForItem: function () { return null; },
    // ...but the cross-recipe check does.
    findAnyLiveSessionForItem: function (item) { return item.number === 5 ? { localId: 99 } : null; },
    startSessionForItem: function (ws, r, item) { started.push(item.number); return { localId: 100 + item.number }; },
  };
  var autoLaunch = attachAutoLaunch({ getLeadMode: LEAD_OFF,
    cwd: cwd,
    sm: { sessions: new Map(), broadcastSessionList: function () {} },
    getTaskLauncher: function () { return launcher; },
    fetchItems: function () {
      return [
        { number: 5, title: "dup", url: "https://github.com/o/r/issues/5" },
        { number: 6, title: "fresh", url: "https://github.com/o/r/issues/6" },
      ];
    },
  });
  try {
    var result = await autoLaunch.launchScheduled("issues-b");
    assert.deepStrictEqual(started, [6], "only the non-duplicate issue should start");
    assert.strictEqual(result.skipped.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- Coop cutover: Lead mode ON -----------------------------------------------
//
// With Lead mode on, auto-launch keeps discovering but may only start work its
// OWN project policy makes autonomous, and only while holding a unique claim.
// Everything else becomes a proposal for Coop.

var automationAudit = require("../lib/project-automation-audit");
var { createAutomationGate } = require("../lib/project-automation-gate");

var CUTOVER_PROJECT = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";

// Builds a real auto-launch wired to a real gate over throwaway state.
function makeCutoverHarness(recipeFilter) {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cutover-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  var recipe = {
    id: "issues",
    source: { provider: "github", kind: "issue", repo: "o/r" },
    launch: { defaultLimit: 5 },
    session: {},
    completion: {},
    filter: recipeFilter || {},
  };
  fs.writeFileSync(path.join(tasksDir, "issues.json"), JSON.stringify(recipe));
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: { enabled: true, recipes: ["issues"], cron: "*/5 * * * *" },
  }));
  var started = [];
  var candidates = [];
  var launcher = {
    loadRecipe: function () { return recipe; },
    findExistingSessionForItem: function () { return null; },
    findAnyLiveSessionForItem: function () { return null; },
    findAnyVisibleSessionForItem: function () { return null; },
    startSessionForItem: function (ws, r, item) { started.push(item.number); return { localId: item.number }; },
  };
  function buildGate() {
    return createAutomationGate({
      cwd: cwd,
      slug: "cutover",
      projectRef: { projectId: CUTOVER_PROJECT },
      policyTtlMs: 0,
      getLeadMode: function () { return true; },
      emitCandidate: function (candidate) {
        candidates.push(candidate);
        // Typed handoff: an untyped return now reads as a lost candidate.
        return { ok: true, created: true, changed: true };
      },
      audit: automationAudit.createAutomationAudit({ file: path.join(cwd, "audit.jsonl"), slug: "cutover" }),
    });
  }
  function buildAutoLaunch(gate) {
    return attachAutoLaunch({
      cwd: cwd,
      sm: { sessions: new Map(), broadcastSessionList: function () {} },
      getTaskLauncher: function () { return launcher; },
      automationGate: gate,
      fetchItems: function () {
        return [{ number: 11, title: "boom", url: "https://github.com/o/r/issues/11", labels: [{ name: "bug" }] }];
      },
    });
  }
  var gate = buildGate();
  return {
    autoLaunch: buildAutoLaunch(gate),
    started: started,
    candidates: candidates,
    gate: gate,
    cwd: cwd,
    // A fresh daemon over the same project state.
    restart: function () { return buildAutoLaunch(buildGate()); },
  };
}

test("lead mode on: a project without bug autonomy starts nothing", async function () {
  var h = makeCutoverHarness({});
  try {
    var result = await h.autoLaunch.launchScheduled("issues");
    assert.deepStrictEqual(h.started, [], "nothing may start under Coop");
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(h.gate.audit.read().pop().decision, "propose");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// The headline invariant of the cutover: with Lead mode ON the project
// launcher starts ZERO sessions, even for work its own policy makes
// autonomous. Autonomy now decides how Coop ADMITS the candidate, not whether
// this controller may launch it.
test("lead mode on: even bug-autonomous work starts zero sessions", async function () {
  var h = makeCutoverHarness({ type: "bug" });
  try {
    await h.autoLaunch.launchScheduled("issues");
    assert.deepStrictEqual(h.started, [], "a project controller may not launch");
    assert.strictEqual(h.candidates.length, 1, "it proposes instead");
    assert.strictEqual(h.candidates[0].admission, "auto");
    assert.strictEqual(h.candidates[0].intent.recipeId, "issues");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// Two ticks — or two daemons, or two recipes — produce candidates that name
// the SAME work, so Coop's canonical binding dedupes them to one execution.
// The controller holds no state, so there is nothing to race.
test("lead mode on: repeated ticks propose the same work identically", async function () {
  var h = makeCutoverHarness({ type: "bug" });
  try {
    await h.autoLaunch.launchScheduled("issues");
    await h.autoLaunch.launchScheduled("issues");
    assert.deepStrictEqual(h.started, []);
    assert.strictEqual(h.candidates.length, 2);
    assert.strictEqual(h.candidates[0].candidateKey, h.candidates[1].candidateKey);
    assert.strictEqual(h.candidates[0].projectRef.projectId, h.candidates[1].projectRef.projectId);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// A restart replays the candidate rather than duplicating work: the controller
// keeps no launch state under Coop, so the second run is byte-identical.
test("lead mode on: a restart replays the candidate without local state", async function () {
  var h = makeCutoverHarness({ type: "bug" });
  try {
    await h.autoLaunch.launchScheduled("issues");
    var before = JSON.parse(JSON.stringify(h.candidates[0]));
    var restarted = h.restart();
    await restarted.launchScheduled("issues");
    assert.deepStrictEqual(h.started, []);
    var after = h.candidates[h.candidates.length - 1];
    assert.strictEqual(after.candidateKey, before.candidateKey);
    assert.strictEqual(after.admission, before.admission);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("lead mode on: a broken project policy proposes nothing", async function () {
  var h = makeCutoverHarness({ type: "bug" });
  try {
    fs.writeFileSync(path.join(h.cwd, ".clay", "tasks", "broken.json"), "{not json");
    h.gate.refresh();
    await h.autoLaunch.launchScheduled("issues");
    assert.deepStrictEqual(h.started, []);
    assert.deepStrictEqual(h.candidates, []);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// A hidden (archived) session must not block a relaunch — otherwise archiving a
// wrongly-launched session would permanently prevent the issue from being taken
// by the correct recipe.
test("dedup ignores hidden (archived) sessions", function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-hidden-"));
  try {
    var sessions = new Map();
    sessions.set("a", { localId: 1, hidden: true, taskLauncher: { recipeId: "pr-review", itemNumber: 2097, itemUrl: "https://github.com/o/r/issues/2097", workflowCompleted: false } });
    var tl = attachTaskLauncher({
      cwd: cwd,
      sm: { sessions: sessions, saveSessionFile: function () {} },
      sdk: {},
      onComplete: function () {},
      onNeedsInput: function () {},
    });
    var item = { number: 2097, url: "https://github.com/o/r/issues/2097" };
    assert.strictEqual(tl.findAnyLiveSessionForItem(item), null, "hidden session must not count as a cross-recipe dup");
    assert.strictEqual(tl.findExistingSessionForItem({ id: "pr-review" }, item, true), null, "hidden session must not count as a same-recipe live dup");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Vendor safety: if the picker wants a rate-limited vendor, fall back to an
// available one; if all configured vendors are rate-limited, defer the item.
function makeVendorLaunchHarness(rejectedVendors, weights) {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-vendor-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: { enabled: true, recipeId: "assigned-to-me", recipes: ["assigned-to-me"], cron: "*/5 * * * *", vendorWeights: weights },
  }, null, 2) + "\n");
  var recipe = { id: "assigned-to-me", source: { provider: "github", kind: "issue", repo: "o/r" }, launch: { defaultLimit: 10 }, session: {}, completion: {} };
  var launched = [];
  var launcher = {
    loadRecipe: function () { return recipe; },
    findExistingSessionForItem: function () { return null; },
    findAnyLiveSessionForItem: function () { return null; },
    startSessionForItem: function (ws, r, item, args) { launched.push({ number: item.number, vendor: args.vendor }); return { localId: item.number }; },
  };
  var entries = Object.keys(rejectedVendors).map(function (v) {
    return { type: "rate_limit_usage", vendor: v, rateLimitType: "5h", status: "rejected", resetsAt: Date.now() + 3600000 };
  });
  var autoLaunch = attachAutoLaunch({ getLeadMode: LEAD_OFF,
    cwd: cwd,
    sm: { sessions: new Map(), broadcastSessionList: function () {} },
    getTaskLauncher: function () { return launcher; },
    rateLimitCache: { liveEntries: function () { return entries; } },
    fetchItems: function () { return [{ number: 1, url: "https://github.com/o/r/issues/1" }]; },
  });
  return { autoLaunch: autoLaunch, cwd: cwd, launched: launched };
}

test("auto-launch falls back to the other vendor when the picked one is rate-limited", async function () {
  // claude rate-limited, only claude+codex configured -> must use codex.
  var h = makeVendorLaunchHarness({ claude: true }, { claude: 100, codex: 1 });
  try {
    var res = await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(res.started.length, 1);
    assert.strictEqual(h.launched[0].vendor, "codex", "should fall back to codex when claude is rate-limited");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("auto-launch defers when all configured vendors are rate-limited", async function () {
  var h = makeVendorLaunchHarness({ claude: true, codex: true }, { claude: 50, codex: 50 });
  try {
    var res = await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(res.started.length, 0, "nothing should start when every vendor is out");
    assert.strictEqual(res.vendorDeferred, 1);
    assert.strictEqual(h.launched.length, 0);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});
