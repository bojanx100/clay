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
    // The owner's own work: automatic pickup considers nothing else.
    assignedToOwner: true,
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
    // The owner's own work: automatic pickup considers nothing else.
    assignedToOwner: true,
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
    assignedToOwner: true,
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
        { number: 5, title: "dup", url: "https://github.com/o/r/issues/5", assignedToOwner: true },
        { number: 6, title: "fresh", url: "https://github.com/o/r/issues/6", assignedToOwner: true },
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
var { createCandidateStore } = require("../lib/project-automation-candidates");

var CUTOVER_PROJECT = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
var URBAN_STAY_PROJECT = "51e67388-cea0-52b7-8e01-cde68cae713c";

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
        return [{ number: 11, title: "boom", url: "https://github.com/o/r/issues/11",
          labels: [{ name: "bug" }], assignees: [{ login: "owner" }], assignedToOwner: true }];
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

// --- The idle-board regression ----------------------------------------------
//
// Webapp's board sat idle for days with Lead mode ON: every tick proposed the
// same work and every candidate landed as `owner_approval`/`awaiting_owner`, so
// admission deferred it forever and nothing ever launched. The project's own
// policy DID grant `bug: autonomous` — derived from its `assigned-to-me` recipe
// declaring `filter.type: "bug"` — but that filter excludes feature/legacy
// labels rather than requiring a `bug` one, so the issues it returns carry no
// label at all. Classification read labels only, so it answered "ambiguous" for
// every one of them and the grant was unreachable by construction.
//
// The fixture below is the production shape: a bug-scoped recipe returning an
// UNLABELED issue. It is deliberately not the labeled item the older cutover
// tests use, because a `bug` label is exactly what hid this defect from them.
function makeIdleBoardHarness(recipeFilter, item, options) {
  var settings = options || {};
  var leadMode = settings.leadMode !== false;
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-idle-board-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  var recipe = {
    id: "assigned-to-me",
    source: settings.source || { provider: "github", kind: "issue", repo: "trialview/v2" },
    launch: { defaultLimit: 10 },
    session: {},
    completion: {},
    filter: recipeFilter || {},
  };
  fs.writeFileSync(path.join(tasksDir, "assigned-to-me.json"), JSON.stringify(recipe));
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: {
      enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *",
      maxConcurrent: settings.maxConcurrent || 5,
    },
  }));
  var started = [];
  var launcher = {
    loadRecipe: function () { return recipe; },
    findExistingSessionForItem: function () { return null; },
    findAnyLiveSessionForItem: function () { return null; },
    findAnyVisibleSessionForItem: function () { return null; },
    startSessionForItem: function (ws, r, i) { started.push(i.number); return { localId: i.number }; },
  };
  // Behaves like the real binding store: the same (portfolioTaskId, revision)
  // replays instead of creating a second execution.
  var bound = {};
  var executions = [];
  var crossProject = {
    coopSessionRef: function () {
      return { projectId: "system-lead", sessionStorageId: "coop-home-live" };
    },
    getExecutionBinding: function (taskId, revision) {
      return bound[taskId + ":" + revision] || null;
    },
    createProjectExecution: function (input) {
      executions.push(input);
      var key = input.portfolioTaskId + ":" + input.bindingRevision;
      if (bound[key]) return { ok: false, reason: "active_binding_exists" };
      bound[key] = {
        portfolioTaskId: input.portfolioTaskId,
        bindingRevision: input.bindingRevision,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        targetProject: input.targetProject,
        status: "active",
      };
      return { ok: true, binding: bound[key] };
    },
  };
  // One or many items — the concurrency tests need a board, not a single issue.
  var items = Array.isArray(item) ? item : [item];
  function buildAutoLaunch() {
    return attachAutoLaunch({
      cwd: cwd,
      slug: "webapp",
      sm: {
        sessions: new Map(),
        broadcastSessionList: function () {},
        getProjectId: function () { return settings.projectId || CUTOVER_PROJECT; },
      },
      getTaskLauncher: function () { return launcher; },
      getLeadMode: function () { return leadMode; },
      crossProject: crossProject,
      fetchItems: function () { return items; },
    });
  }
  var autoLaunch = buildAutoLaunch();
  return {
    autoLaunch: autoLaunch, started: started, executions: executions,
    cwd: cwd, crossProject: crossProject, bound: bound, launcher: launcher,
    // A fresh controller over the SAME durable project state, i.e. a restart.
    restart: function () { return buildAutoLaunch(); },
    // Marks an admitted item's binding terminal, the way a finishing worker
    // does. This is what has to free a slot.
    finish: function (portfolioTaskId) {
      bound[portfolioTaskId + ":1"].status = "completed";
    },
  };
}

// An unlabeled issue ASSIGNED TO THE OWNER, exactly as project-task-sources
// stamps it. The stamp is the proof of ownership every eligibility decision
// downstream reads; an item without it is not the owner's work.
function unlabeledIssue() {
  return {
    number: 2565, title: "PDF.js instead of Acusoft",
    url: "https://github.com/trialview/v2/issues/2565", labels: [],
    assignees: [{ login: "bojantv" }], assignedToOwner: true,
  };
}

// The same issue with nobody assigned — trialview/v2#2539's shape. This is the
// item that must never start work of its own accord.
function unassignedIssue() {
  return {
    number: 2539, title: "Download function on Bundle K is not working",
    url: "https://github.com/trialview/v2/issues/2539", labels: [],
    assignees: [], assignedToOwner: false,
  };
}

test("bug-scoped board work auto-launches through the canonical binding", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, unlabeledIssue());
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    // The controller itself still launches nothing — Coop owns that.
    assert.deepStrictEqual(h.started, [], "a project controller may not launch");
    // What must change is that the work is ADMITTED rather than parked on the
    // owner. Before the fix this array was empty and the candidate sat in
    // awaiting_owner forever, which is precisely the idle board.
    assert.strictEqual(h.executions.length, 1, "eligible board work must reach a binding");
    var request = h.executions[0];
    assert.strictEqual(request.mode, "project_coordinator");
    assert.strictEqual(request.targetProject.projectId, CUTOVER_PROJECT,
      "the binding must target this project, never another");
    assert.strictEqual(request.source.projectId, "system-lead",
      "the binding must be attributed to the live Coop session");
    assert.strictEqual(request.bindingRevision, 1);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// Idempotency is the other half: restoring pickup must not restore duplicate
// execution. A second tick re-proposes the same item (the controller is
// stateless and must), and it has to resolve to the SAME binding.
test("a second tick over the same board work creates no second execution", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, unlabeledIssue());
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.started, []);
    assert.strictEqual(h.executions.length, 1,
      "the admitted candidate must not be admitted a second time");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// --- Strict ownership -------------------------------------------------------
//
// The eligibility contract: automatic pickup requires work the owner has taken
// on. An unassigned board item is not that, whatever its class or the project's
// autonomy. trialview/v2#2539 was unassigned, was proposed bug/auto, and
// produced PR #2591 — an artifact nobody had asked for.
test("unassigned board work never launches and never reaches a binding", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, unassignedIssue());
  try {
    var result = await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.started, [], "unassigned work must never start");
    assert.deepStrictEqual(h.executions, [],
      "unassigned work must never be admitted through a binding");
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.unassignedSkipped, 1, "the skip must be attributable");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// Urban Stay deliberately configured `assigned: "any"`: this is not a GitHub
// assignee and does not make the issue assigned to the owner. It lets the
// project's own recipe surface the work, then its unscoped policy keeps the
// work owner-gated until Coop records an explicit admission.
test("an assigned:any recipe reaches its canonical binding after owner admission", async function () {
  var item = unassignedIssue();
  item.number = 198;
  item.title = "Urban Stay auto-launch regression";
  item.url = "https://github.com/bojanx100/urban-stay-web/issues/198";
  item.recipeAllowsUnassigned = true;
  var h = makeIdleBoardHarness({ assigned: "any" }, item, {
    projectId: URBAN_STAY_PROJECT,
    source: {
      provider: "github", kind: "issue", repo: "bojanx100/urban-stay-web",
      ghAccount: "bojanx100",
    },
  });
  var store = createCandidateStore({ cwd: h.cwd });
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    var key = "launch:bojanx100/urban-stay-web#198";
    assert.strictEqual(store.get({ projectId: URBAN_STAY_PROJECT }, key).status,
      "awaiting_owner", "unscoped Urban-style work must not silently auto-admit");
    assert.strictEqual(h.executions.length, 0);

    var approved = store.decideOwner({ projectId: URBAN_STAY_PROJECT }, key,
      { approved: true, by: "bojan" });
    assert.strictEqual(approved.ok, true);

    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 1);
    assert.strictEqual(h.executions[0].targetProject.projectId, URBAN_STAY_PROJECT);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// Ownership is proof, not an assumption. An item the fetch layer could not
// stamp — an unresolvable gh login, a source that carries no assignees — is
// refused rather than treated as the owner's.
test("board work with unproven ownership is refused, not assumed", async function () {
  var unstamped = unlabeledIssue();
  delete unstamped.assignedToOwner;
  var h = makeIdleBoardHarness({ type: "bug" }, unstamped);
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.started, []);
    assert.deepStrictEqual(h.executions, [],
      "an unstamped item must not be admitted");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// Ownership is checked outside the Coop gate, because the gate short-circuits
// to legacy behavior with Lead mode off — and "must never auto-launch" has to
// hold in both modes. Under Lead OFF an ASSIGNED item still launches, so this
// proves the check discriminates rather than simply blocking everything.
test("lead mode off still refuses unassigned work but launches assigned work", async function () {
  var blocked = makeIdleBoardHarness({ type: "bug" }, unassignedIssue(), { leadMode: false });
  try {
    await blocked.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(blocked.started, [],
      "legacy mode is not an exemption from ownership");
  } finally {
    fs.rmSync(blocked.cwd, { recursive: true, force: true });
  }
  var allowed = makeIdleBoardHarness({ type: "bug" }, unlabeledIssue(), { leadMode: false });
  try {
    await allowed.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(allowed.started, [2565],
      "legacy mode must still run the owner's own assigned work");
  } finally {
    fs.rmSync(allowed.cwd, { recursive: true, force: true });
  }
});

// The containment half. A project whose recipe declares no scope has granted no
// autonomy, so its work must still stop at the owner gate and reach no binding.
test("unscoped board work stays owner-gated and reaches no binding", async function () {
  var h = makeIdleBoardHarness({}, unlabeledIssue());
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.started, []);
    assert.deepStrictEqual(h.executions, [],
      "work no policy made autonomous must never be admitted automatically");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// PR-review work is owner-gated by derivation and must stay that way even when
// the same project also runs a bug-scoped issue launcher.
test("pr-review work is not swept up by a project's bug autonomy", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, unlabeledIssue());
  try {
    var gate = createAutomationGate({
      cwd: h.cwd, slug: "webapp", projectRef: { projectId: CUTOVER_PROJECT },
      policyTtlMs: 0, getLeadMode: function () { return true; },
      emitCandidate: function () { return { ok: true, created: true, changed: true }; },
      audit: automationAudit.createAutomationAudit({
        file: path.join(h.cwd, "pr-audit.jsonl"), slug: "webapp",
      }),
    });
    var decision = gate.evaluateLaunch({
      itemKey: "trialview/v2#2356", item: { labels: [] },
      recipeKind: "pr-reviews", recipeType: "bug",
    });
    assert.strictEqual(decision.requiresApproval, true,
      "PR lifecycle work must stay owner-gated regardless of recipe scope");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// --- The canonical pickup policy --------------------------------------------
//
// Webapp automation scans the board continuously and starts eligible issues the
// owner is already assigned, holding a safe concurrency level and refilling it
// as workers finish. It does not wait for a Lead tick or a manual steer, it
// survives restarts without duplicating work, and the owner's explicit word
// about one item outranks all of it.

var overridesModule = require("../lib/project-automation-overrides");

function assignedIssue(number) {
  return {
    number: number, title: "Board item " + number,
    url: "https://github.com/trialview/v2/issues/" + number, labels: [],
    assignees: [{ login: "bojantv" }], assignedToOwner: true,
  };
}

// 1. An assigned, eligible board change triggers a launch — with no Lead tick,
//    no manual steer, and nothing driving it but the scan itself.
test("an assigned eligible board change launches on the scan alone", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, assignedIssue(2565));
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 1,
      "the scan alone must put the work in flight");
    assert.strictEqual(h.executions[0].targetProject.projectId, CUTOVER_PROJECT);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// 3. Concurrency is a LEVEL, not a per-scan quota: it fills to the limit, holds
//    there while work is in flight, and refills as workers finish.
test("concurrency holds at the limit and backfills as workers complete", async function () {
  var board = [assignedIssue(1), assignedIssue(2), assignedIssue(3), assignedIssue(4)];
  var h = makeIdleBoardHarness({ type: "bug" }, board, { maxConcurrent: 2 });
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 2,
      "only the limit may be in flight, however much the board offers");

    // A second scan changes nothing while both slots are still occupied.
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 2,
      "a full system must not accumulate work every tick");

    // A worker finishes. Its slot must be reused, not leaked.
    h.finish(h.executions[0].portfolioTaskId);
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 3, "a freed slot must backfill");

    h.finish(h.executions[1].portfolioTaskId);
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 4, "and keep backfilling");

    // Every admission is a distinct item: backfill must not re-run finished work.
    var ids = h.executions.map(function (e) { return e.portfolioTaskId; });
    assert.strictEqual(new Set(ids).size, 4, "no item may be executed twice");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// 4. A restart resumes scanning and is idempotent: the durable candidate and
//    binding state mean the same board yields no second execution.
test("a restart resumes scanning without re-executing admitted work", async function () {
  var board = [assignedIssue(1), assignedIssue(2)];
  var h = makeIdleBoardHarness({ type: "bug" }, board, { maxConcurrent: 5 });
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 2);

    var restarted = h.restart();
    await restarted.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 2,
      "a restarted controller must replay, never duplicate");

    // And it is still LIVE after the restart: finishing one backfills the next.
    h.finish(h.executions[0].portfolioTaskId);
    await restarted.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 2,
      "nothing left to take, so nothing new is executed");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// The schedule is what makes scanning continuous, and it is re-established at
// attach time — so a restart resumes scanning without anyone asking it to.
test("the scan schedule is re-established on attach, not on a steer", function () {
  var h = makeIdleBoardHarness({ type: "bug" }, assignedIssue(1));
  try {
    var registered = [];
    var reg = {
      getById: function () { return null; },
      register: function (record) { registered.push(record); },
      updateRecord: function () {},
      nextRunTime: function () { return 0; },
    };
    var withRegistry = attachAutoLaunch({
      cwd: h.cwd, slug: "webapp", loopRegistry: reg,
      sm: { sessions: new Map(), getProjectId: function () { return CUTOVER_PROJECT; } },
      getTaskLauncher: function () { return null; },
      getLeadMode: function () { return true; },
      fetchItems: function () { return []; },
    });
    withRegistry.ensureSchedule();
    assert.strictEqual(registered.length, 1, "attaching must restore the scan");
    assert.strictEqual(registered[0].mode, "autolaunch");
    assert.strictEqual(registered[0].enabled, true);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// 5. The owner's explicit word wins — in both directions.
test("an explicit owner exclusion beats assignment and every automatic rule", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, assignedIssue(2565));
  try {
    var written = overridesModule.createOverrideStore({ cwd: h.cwd })
      .set("trialview/v2#2565", "exclude", { by: "bojan", reason: "handling this myself" });
    assert.strictEqual(written.ok, true);
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.started, []);
    assert.deepStrictEqual(h.executions, [],
      "an owner exclusion must stop work the rules would otherwise run");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("an explicit owner inclusion runs one unassigned item without widening the rule", async function () {
  var board = [unassignedIssue(), assignedIssue(2565)];
  var h = makeIdleBoardHarness({ type: "bug" }, board);
  try {
    // Only #2539 is named. #2565 is assigned and eligible on its own.
    overridesModule.createOverrideStore({ cwd: h.cwd })
      .set("trialview/v2#2539", "include", { by: "bojan", reason: "one-off continuation" });
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 2, "the named item and the assigned one both run");

    // The rule itself is untouched: a DIFFERENT unassigned item stays idle.
    var other = makeIdleBoardHarness({ type: "bug" }, unassignedIssue());
    try {
      await other.autoLaunch.launchScheduled("assigned-to-me");
      assert.deepStrictEqual(other.executions, [],
        "one authorized exception must not make unassigned work eligible in general");
    } finally {
      fs.rmSync(other.cwd, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// An include waives ASSIGNMENT and nothing else. Work the project's own policy
// sends to the owner still goes to the owner.
test("an owner inclusion does not waive the approval gate", async function () {
  // An unscoped recipe grants no autonomy, so this class is owner-gated.
  var h = makeIdleBoardHarness({}, unassignedIssue());
  try {
    overridesModule.createOverrideStore({ cwd: h.cwd })
      .set("trialview/v2#2539", "include", { by: "bojan" });
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.executions, [],
      "an include is not an approval — the approval gate still holds");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("owner-approved work is revalidated by the current scan before binding", async function () {
  var item = assignedIssue(2565);
  var board = [item];
  // An unscoped recipe deliberately requires owner approval.
  var h = makeIdleBoardHarness({}, board);
  var store = createCandidateStore({ cwd: h.cwd });
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    var key = "launch:trialview/v2#2565";
    assert.strictEqual(store.get({ projectId: CUTOVER_PROJECT }, key).status,
      "awaiting_owner");

    var approved = store.decideOwner({ projectId: CUTOVER_PROJECT }, key,
      { approved: true, by: "bojan" });
    assert.strictEqual(approved.ok, true);
    assert.strictEqual(approved.candidate.status, "owner_approved");
    assert.strictEqual(approved.candidate.eligibilityPass, null);

    // Source-level recipe, feature/bug, board/status, PR/branch and collision
    // gates all suppress an item by omitting it from this exact fetch result.
    board.length = 0;
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 0,
      "an earlier owner approval cannot bypass a current source/gate miss");

    // Session dedup and ownership are downstream of fetch but upstream of the
    // candidate handoff. They must likewise leave the old approval powerless.
    board.push(item);
    h.launcher.findAnyLiveSessionForItem = function () { return { localId: 99 }; };
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 0,
      "an owner-approved item already in flight must not bind again");

    h.launcher.findAnyLiveSessionForItem = function () { return null; };
    item.assignedToOwner = false;
    item.assignees = [];
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 0,
      "an owner-approved item that is no longer assigned must not bind");

    // Once a later scan sees it pass every current gate, the approval remains
    // meaningful and the same candidate may bind exactly once.
    item.assignedToOwner = true;
    item.assignees = [{ login: "bojantv" }];
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 1);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// An unreadable override file must not read as "no exclusions".
test("an unreadable override file stops the scan rather than ignoring exclusions", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, assignedIssue(2565));
  try {
    fs.writeFileSync(path.join(h.cwd, ".clay", "tasks", "automation-overrides.json"), "{ broken");
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.executions, [],
      "instructions we cannot read must not be assumed absent");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// Work already in flight is not picked up again, whatever the board says. The
// scan is stateless and re-offers the same item every tick, so this is what
// stops a continuously-scanning launcher from launching continuously.
test("an item already live under any recipe is not launched again", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, assignedIssue(2565));
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 1);
    // Now the item is live somewhere. The next scan must leave it alone even
    // though it is still assigned, still eligible, and still on the board.
    h.launcher.findAnyLiveSessionForItem = function () { return { localId: 99 }; };
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 1, "in-flight work must not be re-taken");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// PR-backed work: once an issue's fix is open as a PR the board moves it out of
// a ready status, and the exclusion is applied while FETCHING — so the launch
// loop never sees it at all. Asserted at the source, where it happens.
test("PR-backed board work is excluded before the launcher ever sees it", function () {
  var taskSources = require("../lib/project-task-sources");
  var recipe = {
    id: "assigned-to-me",
    source: { provider: "github", kind: "issue", repo: "trialview/v2" },
    filter: {
      type: "bug", assigned: "me",
      skipProjectStatuses: ["Done", "In Progress", "Dev Complete", "Ready for production"],
    },
  };
  function issue(number, status) {
    return {
      number: number, title: "n", labels: [{ name: "bug" }],
      assignees: [{ login: "bojantv" }],
      projectItems: [{ status: { name: status } }],
    };
  }
  // The PR-backed states.
  assert.strictEqual(taskSources.issueMatches(recipe, {}, issue(2539, "Dev Complete"), "bojantv"), false,
    "an issue whose fix is already a PR must not be re-taken");
  assert.strictEqual(taskSources.issueMatches(recipe, {}, issue(2540, "Ready for production"), "bojantv"), false);
  assert.strictEqual(taskSources.issueMatches(recipe, {}, issue(2541, "In Progress"), "bojantv"), false);
  // And the one that is genuinely available still is.
  assert.strictEqual(taskSources.issueMatches(recipe, {}, issue(2565, "Backlog"), "bojantv"), true);
});

test("assigned:any is source policy, not a literal GitHub assignee", function () {
  var taskSources = require("../lib/project-task-sources");
  var urbanRecipe = {
    source: { provider: "github", kind: "issue", repo: "bojanx100/urban-stay-web", ghAccount: "bojanx100" },
    filter: { state: "open", assigned: "any" },
  };
  assert.strictEqual(taskSources.resolveGhAccount("/unused", urbanRecipe, {}), "bojanx100");
  assert.strictEqual(taskSources.recipeAllowsUnassigned(urbanRecipe, {}), true);
  assert.strictEqual(taskSources.recipeAllowsUnassigned(urbanRecipe, { assigned: "me" }), false);
  assert.strictEqual(taskSources.issueMatches(urbanRecipe, {}, {
    number: 198, title: "Urban Stay issue", labels: [], assignees: [], projectItems: [],
  }, "bojanx100"), true);
});

// The full standing contract, end to end, through the REAL cross-project router
// and the REAL portfolio binding store — no fake in the admission path. This is
// the test that proves the repaired pipeline actually lands a canonical
// ProjectRef binding on disk rather than merely satisfying a stub.
test("end to end: a scan lands a real canonical binding, exactly once", async function () {
  var serverCrossProject = require("../lib/server-cross-project");
  var projectIdentity = require("../lib/project-identity");
  var externalTarget = require("../lib/project-task-orchestrator-external");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-e2e-"));
  try {
    var tasksDir = path.join(cwd, ".clay", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    var recipe = {
      id: "assigned-to-me",
      source: { provider: "github", kind: "issue", repo: "trialview/v2" },
      launch: { defaultLimit: 10 }, session: {}, completion: {},
      filter: { type: "bug", assigned: "me" },
    };
    fs.writeFileSync(path.join(tasksDir, "assigned-to-me.json"), JSON.stringify(recipe));
    fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
      autoLaunch: { enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *", maxConcurrent: 5 },
    }));

    var bindingFile = path.join(cwd, "bindings.json");
    var delivered = [];
    // The Lead project, holding the live Coop home session the router resolves
    // admission's source ref from. Nothing here is fabricated by the project.
    var leadContext = {
      getProjectId: function () { return projectIdentity.LEAD_PROJECT_ID; },
      getSessionManager: function () {
        var sessions = new Map();
        sessions.set("coop", { coopHome: true, storageId: "coop-home-live" });
        return { sessions: sessions };
      },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    };
    var targetContext = {
      getProjectId: function () { return CUTOVER_PROJECT; },
      getSessionManager: function () { return { sessions: new Map() }; },
      // Validates with the REAL intake function and refuses exactly as
      // production does. A stub that accepted anything is how a prose-only
      // payload passed a green suite and then produced 22 unrouted bindings on
      // the live board: production builds its brief from NAMED fields and
      // rejects the command outright when `objective` is empty.
      deliverCrossProjectEnvelope: function (envelope) {
        delivered.push(envelope);
        var brief = externalTarget.executionBrief(envelope.payload || {});
        if (!brief.objective) return { ok: false, reason: "invalid_payload" };
        return {
          ok: true, created: true, localSessionId: 7,
          sessionRef: { projectId: CUTOVER_PROJECT, sessionStorageId: "coordinator-session" },
        };
      },
    };
    var router = serverCrossProject.createCrossProjectRouter({
      bindingFile: bindingFile,
      getProjectContextById: function (projectId) {
        if (projectId === projectIdentity.LEAD_PROJECT_ID) return leadContext;
        if (projectId === CUTOVER_PROJECT) return targetContext;
        return null;
      },
    });

    var autoLaunch = attachAutoLaunch({
      cwd: cwd, slug: "webapp",
      sm: {
        sessions: new Map(), broadcastSessionList: function () {},
        getProjectId: function () { return CUTOVER_PROJECT; },
      },
      getTaskLauncher: function () {
        return {
          loadRecipe: function () { return recipe; },
          findExistingSessionForItem: function () { return null; },
          findAnyLiveSessionForItem: function () { return null; },
          findAnyVisibleSessionForItem: function () { return null; },
          startSessionForItem: function () { throw new Error("the controller must not launch"); },
        };
      },
      getLeadMode: function () { return true; },
      crossProject: router,
      fetchItems: function () { return [assignedIssue(2565)]; },
    });

    await autoLaunch.launchScheduled("assigned-to-me");

    // The binding is real, committed, on disk, and targets THIS project.
    var persisted = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
    assert.strictEqual(persisted.bindings.length, 1, "the scan must land exactly one binding");
    var binding = persisted.bindings[0];
    assert.strictEqual(binding.mode, "project_coordinator");
    assert.strictEqual(binding.status, "active");
    assert.strictEqual(binding.targetProject.projectId, CUTOVER_PROJECT);
    assert.strictEqual(delivered.length, 1, "the target project must actually receive the command");

    // And the coordinator session it bound is the one the target reported.
    assert.strictEqual(binding.coordinator.sessionStorageId, "coordinator-session");

    // Idempotency against the real store: scanning again replays.
    await autoLaunch.launchScheduled("assigned-to-me");
    var again = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
    assert.strictEqual(again.bindings.length, 1, "a second scan must not create a second binding");
    assert.strictEqual(delivered.length, 1, "nor deliver the work twice");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Continuous scanning only works if a failed attempt leaves the work RETRYABLE.
// A target that cannot start a coordinator must not strand a reserved binding:
// a stranded `pending` record blocks every later revision with
// active_binding_exists while being impossible to terminalize, so the item
// would be lost for good instead of retried on the next scan.
test("end to end: a delivery that starts no coordinator strands no binding", async function () {
  var serverCrossProject = require("../lib/server-cross-project");
  var projectIdentity = require("../lib/project-identity");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-e2e-fail-"));
  try {
    var tasksDir = path.join(cwd, ".clay", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    var recipe = {
      id: "assigned-to-me",
      source: { provider: "github", kind: "issue", repo: "trialview/v2" },
      launch: { defaultLimit: 10 }, session: {}, completion: {},
      filter: { type: "bug", assigned: "me" },
    };
    fs.writeFileSync(path.join(tasksDir, "assigned-to-me.json"), JSON.stringify(recipe));
    fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
      autoLaunch: { enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *", maxConcurrent: 5 },
    }));
    var bindingFile = path.join(cwd, "bindings.json");
    var leadContext = {
      getProjectId: function () { return projectIdentity.LEAD_PROJECT_ID; },
      getSessionManager: function () {
        var sessions = new Map();
        sessions.set("coop", { coopHome: true, storageId: "coop-home-live" });
        return { sessions: sessions };
      },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    };
    var healthy = false;
    var targetContext = {
      getProjectId: function () { return CUTOVER_PROJECT; },
      getSessionManager: function () { return { sessions: new Map() }; },
      deliverCrossProjectEnvelope: function () {
        if (!healthy) return { ok: false, reason: "session_start_failed" };
        return { ok: true, created: true,
          sessionRef: { projectId: CUTOVER_PROJECT, sessionStorageId: "coordinator-session" } };
      },
    };
    var router = serverCrossProject.createCrossProjectRouter({
      bindingFile: bindingFile,
      getProjectContextById: function (projectId) {
        if (projectId === projectIdentity.LEAD_PROJECT_ID) return leadContext;
        if (projectId === CUTOVER_PROJECT) return targetContext;
        return null;
      },
    });
    var autoLaunch = attachAutoLaunch({
      cwd: cwd, slug: "webapp",
      sm: { sessions: new Map(), broadcastSessionList: function () {},
        getProjectId: function () { return CUTOVER_PROJECT; } },
      getTaskLauncher: function () {
        return {
          loadRecipe: function () { return recipe; },
          findExistingSessionForItem: function () { return null; },
          findAnyLiveSessionForItem: function () { return null; },
          findAnyVisibleSessionForItem: function () { return null; },
          startSessionForItem: function () { throw new Error("the controller must not launch"); },
        };
      },
      getLeadMode: function () { return true; },
      crossProject: router,
      fetchItems: function () { return [assignedIssue(2565)]; },
    });

    await autoLaunch.launchScheduled("assigned-to-me");
    var afterFailure = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
    var live = afterFailure.bindings.filter(function (b) {
      return b.status === "active" || b.status === "pending";
    });
    assert.deepStrictEqual(live, [], "a failed delivery must leave no live binding behind");

    // The target recovers. The very next scan must pick the item up — the whole
    // point of a continuous scan is that it heals without anyone intervening.
    healthy = true;
    await autoLaunch.launchScheduled("assigned-to-me");
    var recovered = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
    var active = recovered.bindings.filter(function (b) { return b.status === "active"; });
    assert.strictEqual(active.length, 1, "the next scan must recover the work by itself");
    assert.strictEqual(active[0].targetProject.projectId, CUTOVER_PROJECT);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// The activation regression, stated as a property: A BROKEN ROUTE MUST NOT
// FAN OUT. The live run put 22 candidates through a limit of 5 because the cap
// counted successes rather than attempts, so every one reserved and released a
// durable `unrouted` binding. A limit that only bounds what works does not
// bound a failure, which is precisely when bounding matters.
test("end to end: a broken route makes at most maxConcurrent attempts per scan", async function () {
  var serverCrossProject = require("../lib/server-cross-project");
  var projectIdentity = require("../lib/project-identity");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-e2e-fanout-"));
  try {
    var tasksDir = path.join(cwd, ".clay", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    var recipe = {
      id: "assigned-to-me",
      source: { provider: "github", kind: "issue", repo: "trialview/v2" },
      launch: { defaultLimit: 10 }, session: {}, completion: {},
      filter: { type: "bug", assigned: "me" },
    };
    fs.writeFileSync(path.join(tasksDir, "assigned-to-me.json"), JSON.stringify(recipe));
    fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
      autoLaunch: { enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *", maxConcurrent: 5 },
    }));
    var bindingFile = path.join(cwd, "bindings.json");
    var leadContext = {
      getProjectId: function () { return projectIdentity.LEAD_PROJECT_ID; },
      getSessionManager: function () {
        var sessions = new Map();
        sessions.set("coop", { coopHome: true, storageId: "coop-home-live" });
        return { sessions: sessions };
      },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    };
    var attempts = 0;
    var targetContext = {
      getProjectId: function () { return CUTOVER_PROJECT; },
      getSessionManager: function () { return { sessions: new Map() }; },
      // Every route fails, exactly as the live board did.
      deliverCrossProjectEnvelope: function () {
        attempts++;
        return { ok: false, reason: "invalid_payload" };
      },
    };
    var router = serverCrossProject.createCrossProjectRouter({
      bindingFile: bindingFile,
      getProjectContextById: function (projectId) {
        if (projectId === projectIdentity.LEAD_PROJECT_ID) return leadContext;
        if (projectId === CUTOVER_PROJECT) return targetContext;
        return null;
      },
    });
    // A 22-item board, the size that actually broke.
    var board = [];
    for (var i = 0; i < 22; i++) board.push(assignedIssue(2500 + i));
    var autoLaunch = attachAutoLaunch({
      cwd: cwd, slug: "webapp",
      sm: { sessions: new Map(), broadcastSessionList: function () {},
        getProjectId: function () { return CUTOVER_PROJECT; } },
      getTaskLauncher: function () {
        return {
          loadRecipe: function () { return recipe; },
          findExistingSessionForItem: function () { return null; },
          findAnyLiveSessionForItem: function () { return null; },
          findAnyVisibleSessionForItem: function () { return null; },
          startSessionForItem: function () { throw new Error("the controller must not launch"); },
        };
      },
      getLeadMode: function () { return true; },
      crossProject: router,
      fetchItems: function () { return board; },
    });

    await autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(attempts, 5,
      "a failing route must be attempted at most maxConcurrent times, not once per board item");
    var persisted = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
    assert.ok(persisted.bindings.length <= 5,
      "a broken scan must not strand a durable binding per board item, got " +
      persisted.bindings.length);

    // And the failure must not have eaten capacity: released reservations hold
    // no worker, so the next scan gets its full budget again rather than
    // grinding to a permanent halt.
    var unrouted = persisted.bindings.filter(function (b) { return b.status === "unrouted"; });
    assert.strictEqual(unrouted.length, persisted.bindings.length,
      "every failed route must be released, not left live");
    await autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(attempts, 10,
      "the next scan must still have its full budget — unrouted must not consume capacity");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
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
    fetchItems: function () { return [{ number: 1, url: "https://github.com/o/r/issues/1", assignedToOwner: true }]; },
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
