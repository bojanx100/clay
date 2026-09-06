var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachAutoLaunch } = require("../lib/project-auto-launch");
var autoApproval = require("../lib/coop-auto-approval-policy");

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

test("auto-approval control is owner-only, ProjectRef-bound, and canonical-Coop scoped", function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-auto-approval-ui-"));
  var projectId = "51e67388-cea0-52b7-8e01-cde68cae713c";
  var otherProjectId = "11111111-2222-4333-8444-555555555555";
  var responses = [];
  var store = autoApproval.createPolicyStore({ file: path.join(cwd, "auto-approval.json"),
    now: function () { return 1000; } });
  var users = {
    isMultiUser: function () { return true; },
    getAllUsers: function () { return [{ id: "owner-1" }]; },
  };
  var project = attachAutoLaunch({
    cwd: cwd,
    slug: "webapp",
    sm: { sessions: new Map(), getProjectId: function () { return projectId; } },
    getLeadMode: LEAD_OFF,
    autoApprovalPolicy: store,
    usersModule: users,
    getSessionForWs: function () { return { coopHome: false }; },
    sendTo: function (ws, message) { responses.push(message); },
  });
  var member = { _clayUser: { id: "member-1" } };
  var owner = { _clayUser: { id: "owner-1" } };
  try {
    assert.equal(project.handleMessage(member, { type: "set_auto_approval_project", enabled: true }), true);
    assert.equal(responses.pop().error, "forbidden");
    assert.equal(project.handleMessage(owner, {
      type: "set_auto_approval_project", projectRef: { projectId: otherProjectId }, enabled: true,
    }), true);
    assert.equal(responses.pop().error, "project_ref_mismatch");
    assert.equal(project.handleMessage(owner, { type: "set_auto_approval_project", enabled: true }), true);
    var enabled = responses.pop();
    assert.equal(enabled.state.effective.enabled, true);
    assert.equal(enabled.state.projectOverride.projectRef.projectId, projectId);
    assert.equal(project.handleMessage(owner, { type: "set_auto_approval_global", enabled: true }), true);
    assert.equal(responses.pop().error, "canonical_coop_required");

    var coop = attachAutoLaunch({
      cwd: cwd,
      slug: "lead",
      sm: { sessions: new Map(), getProjectId: function () { return "system-lead"; } },
      getLeadMode: LEAD_OFF,
      autoApprovalPolicy: store,
      usersModule: users,
      getSessionForWs: function () { return { coopHome: true }; },
      listAutoApprovalProjects: function () { return [{ projectRef: { projectId: projectId }, label: "Webapp" }]; },
      sendTo: function (ws, message) { responses.push(message); },
    });
    assert.equal(coop.handleMessage(owner, { type: "set_auto_approval_global", enabled: true }), true);
    var global = responses.pop();
    assert.equal(global.scope, "coop");
    assert.equal(global.state.defaultControl.enabled, true);
    assert.equal(global.state.projects[0].hasOverride, true,
      "Coop lists per-project overrides alongside its all-project control");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

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
// With Lead mode on, auto-launch preserves each eligible recipe's proven
// primitive while also handing the concrete session to Coop for ProjectRef
// ownership, progress, and acceptance handling.

var automationAudit = require("../lib/project-automation-audit");
var { createAutomationGate } = require("../lib/project-automation-gate");
var { createCandidateStore, contentDigest } = require("../lib/project-automation-candidates");
var { portfolioTaskIdFor, idempotencyKeyFor } = require("../lib/project-automation-identity");
var automationPolicy = require("../lib/project-automation-policy");
var automationQualification = require("../lib/project-automation-qualification");

var CUTOVER_PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var URBAN_STAY_PROJECT = "51e67388-cea0-52b7-8e01-cde68cae713c";

function typedIssueAutomation() {
  return {
    autonomy: { bug: "autonomous", feature: "owner_approval", ambiguous: "owner_approval" },
    externalActions: { done_workflow: "approval" },
    qualification: {
      version: 1,
      normalIssueIntake: {
        issueStates: ["open"],
        boardStatuses: ["Backlog", "Ready for development"],
        requireAllBoardItems: true,
        assignment: "owner",
        classification: { autonomous: ["bug"], ownerApproval: ["feature", "ambiguous"] },
      },
    },
  };
}

// Builds a real auto-launch wired to a real gate over throwaway state.
function makeCutoverHarness(recipeFilter) {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cutover-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  var recipe = {
    id: "issues",
    source: { provider: "github", kind: "issue", repo: "o/r", includeProjectItems: true },
    launch: { defaultLimit: 5 },
    session: {},
    completion: {},
    filter: recipeFilter || {},
  };
  fs.writeFileSync(path.join(tasksDir, "issues.json"), JSON.stringify(recipe));
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: { enabled: true, recipes: ["issues"], cron: "*/5 * * * *" },
    automation: typedIssueAutomation(),
  }));
  var started = [];
  var candidates = [];
  var sessions = new Map();
  var launcher = {
    loadRecipe: function () { return recipe; },
    findExistingSessionForItem: function () { return null; },
    findAnyLiveSessionForItem: function () { return null; },
    findAnyVisibleSessionForItem: function () { return null; },
    startSessionForItem: function (ws, r, item) {
      var session = { localId: item.number, storageId: "primitive-" + item.number,
        taskLauncher: { autoLaunch: true, itemKey: "o/r#" + item.number } };
      started.push(item.number);
      sessions.set(session.localId, session);
      return session;
    },
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
        return createCandidateStore({ cwd: cwd }).upsert(candidate);
      },
      audit: automationAudit.createAutomationAudit({ file: path.join(cwd, "audit.jsonl"), slug: "cutover" }),
    });
  }
  function buildAutoLaunch(gate) {
    return attachAutoLaunch({
      cwd: cwd,
      sm: { sessions: sessions, broadcastSessionList: function () {},
        getProjectId: function () { return CUTOVER_PROJECT; } },
      getTaskLauncher: function () { return launcher; },
      automationGate: gate,
      fetchItems: function () {
        return [{ number: 11, title: "boom", url: "https://github.com/o/r/issues/11",
          state: "OPEN", labels: [{ name: "bug" }], assignees: [{ login: "owner" }],
          projectItems: [{ id: "PVT_item_11", status: { name: "Backlog" } }], assignedToOwner: true }];
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

test("lead mode on: owner-gated work keeps the primitive launch", async function () {
  var h = makeCutoverHarness({});
  try {
    var result = await h.autoLaunch.launchScheduled("issues");
    assert.deepStrictEqual(h.started, [11], "Lead must not turn proposal into a launch veto");
    assert.strictEqual(result.started.length, 1);
    assert.ok(h.gate.audit.read().some(function (entry) { return entry.decision === "propose"; }));
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// The headline invariant of this revision: Lead ownership is additive. It may
// not swap an existing issue or PR primitive for a generic coordinator launch.
test("lead mode on: bug-autonomous work keeps the primitive launch", async function () {
  var h = makeCutoverHarness({ type: "bug" });
  try {
    await h.autoLaunch.launchScheduled("issues");
    assert.deepStrictEqual(h.started, [11], "the proven project launcher remains the execution primitive");
    assert.strictEqual(h.candidates.length, 1, "it proposes instead");
    assert.strictEqual(h.candidates[0].admission, "auto");
    assert.strictEqual(h.candidates[0].intent.recipeId, "issues");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// Launch state and the canonical binding jointly make repeated scans safe.
test("lead mode on: repeated ticks do not duplicate the primitive", async function () {
  var h = makeCutoverHarness({ type: "bug" });
  try {
    await h.autoLaunch.launchScheduled("issues");
    await h.autoLaunch.launchScheduled("issues");
    assert.deepStrictEqual(h.started, [11]);
    assert.strictEqual(h.candidates.length, 1,
      "the launch-state dedupe must stop before a second proposal or launch");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

// Durable launch state survives a restart and prevents a second primitive.
test("lead mode on: a restart does not duplicate an already launched primitive", async function () {
  var h = makeCutoverHarness({ type: "bug" });
  try {
    await h.autoLaunch.launchScheduled("issues");
    var restarted = h.restart();
    await restarted.launchScheduled("issues");
    assert.deepStrictEqual(h.started, [11]);
    assert.strictEqual(h.candidates.length, 1);
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
    source: settings.source || { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
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
    automation: typedIssueAutomation(),
  }));
  var started = [];
  var sessions = new Map();
  var legacySession = settings.legacySession || null;
  var saveCalls = settings.saveCalls || null;
  if (legacySession) sessions.set(legacySession.localId, legacySession);
  function legacySessionForItem(i) {
    if (!legacySession || !legacySession.taskLauncher) return null;
    return String(legacySession.taskLauncher.itemNumber) === String(i.number) ? legacySession : null;
  }
  var launcher = {
    loadRecipe: function () { return recipe; },
    findExistingSessionForItem: function (r, i) { return legacySessionForItem(i); },
    findAnyLiveSessionForItem: function (i) { return legacySessionForItem(i); },
    findAnyVisibleSessionForItem: function (i) { return legacySessionForItem(i); },
    startSessionForItem: function (ws, r, i) {
      var itemKey = (recipe.source.repo || "") + "#" + i.number;
      var session = {
        localId: i.number,
        storageId: "primitive-" + i.number,
        title: i.title,
        taskLauncher: { autoLaunch: true, itemKey: itemKey, automationClaimKey: itemKey },
      };
      started.push(i.number);
      sessions.set(session.localId, session);
      return session;
    },
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
    getExecutionBindings: function () {
      return Object.keys(bound).map(function (key) { return bound[key]; });
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
        coordinator: input.adoptSessionRef,
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
        sessions: sessions,
        saveSessionFile: function (session, options) {
          if (saveCalls) saveCalls.push({ session: session, options: options });
          return true;
        },
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
    recipe: recipe,
    saveCalls: saveCalls,
    // A fresh controller over the SAME durable project state, i.e. a restart.
    restart: function () { return buildAutoLaunch(); },
    // Marks an admitted item's binding terminal, the way a finishing worker
    // does. This is what has to free a slot.
    finish: function (portfolioTaskId) {
      bound[portfolioTaskId + ":1"].status = "completed";
      sessions.forEach(function (session) {
        var execution = executions.find(function (request) {
          return request.portfolioTaskId === portfolioTaskId &&
            request.adoptSessionRef.sessionStorageId === session.storageId;
        });
        if (execution) session.taskLauncher.workflowCompleted = true;
      });
    },
  };
}

function writePreviousPrimitiveCandidate(cwd, projectRef, recipe, item, itemKey, evidenceAt) {
  var loaded = automationPolicy.loadProjectAutomationPolicy({
    cwd: cwd,
    projectRef: projectRef,
  });
  assert.strictEqual(loaded.ok, true, loaded.reason);
  var receipt = automationQualification.receiptFor({
    policy: loaded.policy,
    projectRef: projectRef,
    recipe: {
      id: recipe.id,
      digest: automationPolicy.recipeDigest(recipe),
      kind: "issue",
    },
    item: item,
    itemKey: itemKey,
    itemClass: "bug",
    assignedToOwner: true,
    recipeAllowsUnassigned: false,
    now: evidenceAt,
  });
  assert.strictEqual(receipt.ok, true, receipt.reason);
  var record = {
    candidateKey: "launch:" + itemKey,
    itemKey: itemKey,
    itemClass: "bug",
    admission: "auto",
    projectRef: projectRef,
    policyDigest: loaded.policy.digest,
    recipeId: recipe.id,
    intent: {
      recipeId: recipe.id,
      primitiveLaunch: true,
      automationClaimKey: itemKey,
      number: item.number,
      url: item.url,
      title: item.title,
      autoKind: "issue",
    },
    eligibilityPass: "previous-scan",
    eligibility: {
      assignedToOwner: true,
      recipeAllowsUnassigned: false,
      reason: "assigned_to_owner",
    },
    qualificationReceipt: receipt.receipt,
    status: "pending",
    firstSeenAt: evidenceAt,
    lastSeenAt: evidenceAt,
    seenCount: 1,
  };
  record.digest = contentDigest(record);
  fs.writeFileSync(path.join(cwd, ".clay", "tasks", "automation-candidates.json"),
    JSON.stringify({
      schema: "clay.automation_candidates",
      version: 1,
      candidates: [record],
    }, null, 2) + "\n");
  return record;
}

// An unlabeled issue ASSIGNED TO THE OWNER, exactly as project-task-sources
// stamps it. The stamp is the proof of ownership every eligibility decision
// downstream reads; an item without it is not the owner's work.
function unlabeledIssue() {
  return {
    number: 2565, title: "PDF.js instead of Acusoft",
    url: "https://github.com/trialview/v2/issues/2565", state: "OPEN", labels: [],
    projectItems: [{ id: "PVT_item_2565", status: { name: "Backlog" } }],
    assignees: [{ login: "bojantv" }], assignedToOwner: true,
  };
}

// The same issue with nobody assigned — trialview/v2#2539's shape. This is the
// item that must never start work of its own accord.
function unassignedIssue() {
  return {
    number: 2539, title: "Download function on Bundle K is not working",
    url: "https://github.com/trialview/v2/issues/2539", state: "OPEN", labels: [],
    projectItems: [{ id: "PVT_item_2539", status: { name: "Backlog" } }],
    assignees: [], assignedToOwner: false,
  };
}

test("bug-scoped board work auto-launches through the canonical binding", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, unlabeledIssue());
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.started, [2565],
      "Lead ownership must preserve the proven primitive launch");
    assert.strictEqual(h.executions.length, 1, "eligible board work must reach a binding");
    var request = h.executions[0];
    assert.strictEqual(request.mode, "project_coordinator");
    assert.strictEqual(request.targetProject.projectId, CUTOVER_PROJECT,
      "the binding must target this project, never another");
    assert.strictEqual(request.source.projectId, "system-lead",
      "the binding must be attributed to the live Coop session");
    assert.strictEqual(request.bindingRevision, 1);
    assert.deepStrictEqual(request.adoptSessionRef,
      { projectId: CUTOVER_PROJECT, sessionStorageId: "primitive-2565" });
    assert.strictEqual(request.automationAuthorization.kind,
      "project_auto_launch_primitive");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("PR review keeps its primitive launch and is adopted by the same binding path", async function () {
  var item = {
    key: "trialview/v2#3010",
    number: 3010,
    title: "Review the failing PR",
    url: "https://github.com/trialview/v2/pull/3010",
    head_sha: "abc123",
    ci_failing: true,
    latestFeedbackTs: 1000,
    labels: [],
  };
  var h = makeIdleBoardHarness({}, item, {
    source: { provider: "github", kind: "pr-reviews", repo: "trialview/v2" },
  });
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.started, [3010]);
    assert.strictEqual(h.executions.length, 1);
    assert.strictEqual(h.executions[0].automationAuthorization.kind,
      "project_auto_launch_primitive");
    assert.deepStrictEqual(h.executions[0].adoptSessionRef,
      { projectId: CUTOVER_PROJECT, sessionStorageId: "primitive-3010" });
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
    assert.deepStrictEqual(h.started, [2565]);
    assert.strictEqual(h.executions.length, 1,
      "the admitted candidate must not be admitted a second time");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("a fresh eligible scan upgrades a legacy awaiting-owner candidate and admits it once", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, assignedIssue(2725));
  try {
    var candidateFile = path.join(h.cwd, ".clay", "tasks", "automation-candidates.json");
    fs.writeFileSync(candidateFile, JSON.stringify({
      schema: "clay.automation_candidates",
      version: 1,
      candidates: [{
        candidateKey: "launch:trialview/v2#2725",
        itemKey: "trialview/v2#2725",
        itemClass: "bug",
        admission: "owner_approval",
        projectRef: { projectId: CUTOVER_PROJECT },
        policyDigest: "legacy-policy",
        recipeId: "assigned-to-me",
        intent: {
          recipeId: "assigned-to-me",
          automationClaimKey: "trialview/v2#2725",
          number: 2725,
          autoKind: "issue",
        },
        eligibilityPass: "legacy-scan",
        eligibility: {
          assignedToOwner: true,
          recipeAllowsUnassigned: false,
          reason: "assigned_to_owner",
        },
        qualificationReceipt: null,
        status: "awaiting_owner",
        firstSeenAt: 1,
        lastSeenAt: 1,
        seenCount: 1,
        digest: "legacy-no-receipt",
        attention: { reason: "owner_approval_required", needsOwner: true, firstAt: 1, lastAt: 1, count: 1 },
        approvalStage: {
          portfolioTaskId: "auto:legacy:trialview-v2-2725",
          bindingRevision: 1,
          targetProject: { projectId: CUTOVER_PROJECT },
          question: "legacy owner approval",
          stagedAt: 1,
        },
      }],
    }));

    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.equal(h.executions.length, 1,
      "fresh qualified board evidence must replace the stale owner gate and reach Coop admission");
    assert.equal(h.executions[0].targetProject.projectId, CUTOVER_PROJECT);

    var stored = h.autoLaunch.candidateStore.get({ projectId: CUTOVER_PROJECT },
      "launch:trialview/v2#2725");
    assert.equal(stored.status, "admitted");
    assert.ok(stored.qualificationReceipt,
      "the new binding must be backed by this scan's typed qualification receipt");
    assert.equal(stored.attention, undefined,
      "a stale owner-approval attention record must not survive autonomous admission");
    assert.equal(stored.approvalStage, undefined,
      "a stale approval stage must not keep projecting an owner decision after admission");

    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.equal(h.executions.length, 1,
      "the next natural scan must reuse the same admitted candidate rather than duplicate work");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("a scheduled scan recovers an in-flight legacy primitive before live dedup", async function () {
  var saves = [];
  var legacy = {
    localId: 2881,
    storageId: "legacy-2881",
    taskLauncher: {
      autoLaunch: true,
      recipeId: "assigned-to-me",
      itemNumber: 2881,
      itemUrl: "https://github.com/trialview/v2/issues/2881",
      autoKind: "issue",
      itemKey: "",
      workflowCompleted: false,
    },
  };
  var item = assignedIssue(2881);
  var h = makeIdleBoardHarness({ type: "bug" }, item, {
    legacySession: legacy,
    saveCalls: saves,
  });
  try {
    var proposal = h.autoLaunch.automationGate.evaluateLaunch({
      itemKey: "trialview/v2#2881",
      eligibilityPass: "legacy-scan",
      item: item,
      recipe: h.recipe,
      recipeKind: "issue",
      recipeType: "bug",
      assignedToOwner: true,
      intent: {
        recipeId: "assigned-to-me",
        primitiveLaunch: true,
        automationClaimKey: "trialview/v2#2881",
        number: 2881,
        url: item.url,
        title: item.title,
        autoKind: "issue",
      },
    });
    assert.strictEqual(proposal.decision, "propose");
    item.projectItems[0].status.name = "🔄 In progress";
    await h.autoLaunch.runScheduled({ id: "autolaunch_assigned", task: "assigned-to-me" });
    assert.deepStrictEqual(h.started, [],
      "recovering an existing primitive must not start a second session");
    assert.strictEqual(h.executions.length, 1,
      "the exact current scan must adopt the existing session once");
    assert.strictEqual(legacy.taskLauncher.itemKey, "trialview/v2#2881");
    assert.ok(saves.some(function (save) {
      return save.options && save.options.durable === true;
    }), "the recovered identity must be durably persisted");
    var stored = h.autoLaunch.candidateStore.get({ projectId: CUTOVER_PROJECT },
      "launch:trialview/v2#2881");
    assert.strictEqual(stored.status, "admitted");
    assert.ok(stored.qualificationReceipt.coordinator.reasons.indexOf(
      "existing_primitive_in_flight") !== -1,
      "adoption must carry an explicit in-flight qualification reason");
    assert.deepStrictEqual(h.executions[0].adoptSessionRef, {
      projectId: CUTOVER_PROJECT,
      sessionStorageId: "legacy-2881",
    });
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("an expired prior receipt cannot recover an in-flight legacy primitive", async function () {
  var saves = [];
  var legacy = {
    localId: 2882,
    storageId: "legacy-2882",
    taskLauncher: {
      autoLaunch: true,
      recipeId: "assigned-to-me",
      itemNumber: 2882,
      itemUrl: "https://github.com/trialview/v2/issues/2882",
      autoKind: "issue",
      itemKey: "",
      workflowCompleted: false,
    },
  };
  var item = assignedIssue(2882);
  var h = makeIdleBoardHarness({ type: "bug" }, item, {
    legacySession: legacy,
    saveCalls: saves,
  });
  try {
    writePreviousPrimitiveCandidate(h.cwd, { projectId: CUTOVER_PROJECT },
      h.recipe, item, "trialview/v2#2882",
      Date.now() - automationQualification.MAX_RECEIPT_AGE_MS - 1000);
    item.projectItems[0].status.name = "🔄 In progress";
    await h.autoLaunch.runScheduled({ id: "autolaunch_assigned", task: "assigned-to-me" });
    assert.deepStrictEqual(h.started, [],
      "recovery must not replace the already-started primitive");
    assert.strictEqual(h.executions.length, 0,
      "an expired previous receipt alone must not authorize adoption");
    assert.strictEqual(legacy.taskLauncher.itemKey, "",
      "the legacy identity must not be rebound from stale qualification evidence");
    var stored = h.autoLaunch.candidateStore.get({ projectId: CUTOVER_PROJECT },
      "launch:trialview/v2#2882");
    assert.notStrictEqual(stored.status, "admitted");
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("a canonical binding snapshot keeps a crash-window legacy record at capacity", async function () {
  var h = makeIdleBoardHarness({ type: "bug" }, assignedIssue(2725), { maxConcurrent: 1 });
  try {
    var legacy = {
      candidateKey: "launch:trialview/v2#2522",
      itemKey: "trialview/v2#2522",
      itemClass: "bug",
      admission: "auto",
      projectRef: { projectId: CUTOVER_PROJECT },
      policyDigest: "legacy-policy",
      recipeId: "assigned-to-me",
      intent: { recipeId: "assigned-to-me", automationClaimKey: "trialview/v2#2522", autoKind: "issue" },
      qualificationReceipt: null,
      status: "admitted",
      firstSeenAt: 1,
      lastSeenAt: 1,
      seenCount: 1,
      digest: "legacy-no-pointer",
    };
    var candidateFile = path.join(h.cwd, ".clay", "tasks", "automation-candidates.json");
    fs.writeFileSync(candidateFile, JSON.stringify({
      schema: "clay.automation_candidates", version: 1, candidates: [legacy],
    }));
    var portfolioTaskId = portfolioTaskIdFor(legacy);
    h.bound[portfolioTaskId + ":1"] = {
      portfolioTaskId: portfolioTaskId,
      bindingRevision: 1,
      mode: "project_coordinator",
      targetProject: { projectId: CUTOVER_PROJECT },
      status: "active",
    };

    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 0,
      "a committed binding with a missing candidate pointer must still consume the only slot");
    var fresh = h.autoLaunch.candidateStore.get({ projectId: CUTOVER_PROJECT },
      "launch:trialview/v2#2725");
    assert.strictEqual(fresh.status, "pending",
      "the naturally scanned issue waits for capacity instead of bypassing the crash window");
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

// `assigned: "any"` is not assignment evidence. The typed normal-intake
// policy binds implementation eligibility to owner assignment, so this recipe
// may discover the item but cannot create an owner-approval bypass.
test("an assigned:any recipe cannot bypass typed owner assignment", async function () {
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
    assert.strictEqual(store.get({ projectId: URBAN_STAY_PROJECT }, key), null,
      "unassigned work creates no receipt-backed candidate");
    assert.strictEqual(h.executions.length, 0);
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

// Lead ownership is additive to the launch primitive. An owner-approval policy
// classification remains relevant to external actions, but cannot become a new
// literal-owner precondition for an otherwise eligible existing recipe.
test("unscoped eligible board work is launched without a new owner-turn gate", async function () {
  var h = makeIdleBoardHarness({}, unlabeledIssue());
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(h.started, [2565]);
    assert.strictEqual(h.executions.length, 1,
      "Lead adopts the primitive instead of waiting for a literal owner turn");
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
    url: "https://github.com/trialview/v2/issues/" + number, state: "OPEN", labels: [],
    projectItems: [{ id: "PVT_item_" + number, status: { name: "Backlog" } }],
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

// An include waives assignment and nothing else. With Lead on, however, the
// policy's owner-approval classification is not a new literal-owner launch gate:
// Lead adopts the same primitive the owner would have launched.
test("an owner inclusion does not create a literal-owner launch gate", async function () {
  var h = makeIdleBoardHarness({}, unassignedIssue());
  try {
    overridesModule.createOverrideStore({ cwd: h.cwd })
      .set("trialview/v2#2539", "include", { by: "bojan" });
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(h.executions.length, 1);
    assert.deepStrictEqual(h.started, [2539]);
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
function makeCoordinatorSessionManager(projectId) {
  var sessions = new Map();
  var nextLocalId = 100;
  return {
    sessions: sessions,
    getProjectId: function () { return projectId; },
    createSessionRaw: function (options) {
      var session = Object.assign({
        localId: nextLocalId++, history: [], orchestrationPolicy: {},
      }, options || {});
      sessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function () { return true; },
    appendToSessionFile: function () {},
    broadcastSessionList: function () {},
  };
}

test("end to end: a scan lands a real canonical binding, exactly once", async function () {
  var serverCrossProject = require("../lib/server-cross-project");
  var projectIdentity = require("../lib/project-identity");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-e2e-"));
  try {
    var tasksDir = path.join(cwd, ".clay", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    var recipe = {
      id: "assigned-to-me",
      source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
      launch: { defaultLimit: 10 }, session: {}, completion: {},
      filter: { type: "bug", assigned: "me" },
    };
    fs.writeFileSync(path.join(tasksDir, "assigned-to-me.json"), JSON.stringify(recipe));
    fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
      autoLaunch: { enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *", maxConcurrent: 5 },
      automation: typedIssueAutomation(),
    }));

    var bindingFile = path.join(cwd, "bindings.json");
    var delivered = [];
    var leadManager = makeCoordinatorSessionManager(projectIdentity.LEAD_PROJECT_ID);
    leadManager.sessions.set("coop", { coopHome: true, storageId: "coop-home-live" });
    var targetManager = makeCoordinatorSessionManager(CUTOVER_PROJECT);
    var autoLaunch = null;
    // The Lead project, holding the live Coop home session the router resolves
    // admission's source ref from. Nothing here is fabricated by the project.
    var leadContext = {
      getProjectId: function () { return projectIdentity.LEAD_PROJECT_ID; },
      getSessionManager: function () { return leadManager; },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    };
    var targetContext = {
      getProjectId: function () { return CUTOVER_PROJECT; },
      getSessionManager: function () { return targetManager; },
      validateAutomationAuthorization: function (input) {
        return autoLaunch.validateAutomationAuthorization(input);
      },
      deliverCrossProjectEnvelope: function (envelope) { delivered.push(envelope); return { ok: false }; },
    };
    var router = serverCrossProject.createCrossProjectRouter({
      allowLeadSourcedExecution: true,
      requireOwnerImplementationDecision: true,
      bindingFile: bindingFile,
      automationThreadIndex: {
        ensureAutomationThread: function (input) {
          return { ok: true, topicRef: { topicId: input.authorization.threadRef.threadId },
            threadRef: input.authorization.threadRef };
        },
      },
      onThreadHandedOff: function () { return { ok: true }; },
      ownerRequests: {
        claimCoordinator: function (input) {
          this.claimed = input.coordinator;
          return { ok: true };
        },
        canonicalCoordinator: function () { return this.claimed || null; },
      },
      getProjectContextById: function (projectId) {
        if (projectId === projectIdentity.LEAD_PROJECT_ID) return leadContext;
        if (projectId === CUTOVER_PROJECT) return targetContext;
        return null;
      },
    });

    var primitive = null;
    var taskLauncher = attachTaskLauncher({
      cwd: cwd,
      sm: targetManager,
      sdk: { startQuery: function () {} },
      usersModule: { isMultiUser: function () { return false; } },
      ensureProjectAccessForSession: function () { return true; },
      onProcessingChanged: function () {},
    });
    autoLaunch = attachAutoLaunch({
      cwd: cwd, slug: "webapp",
      sm: targetManager,
      getTaskLauncher: function () { return taskLauncher; },
      getLeadMode: function () { return true; },
      crossProject: router,
      fetchItems: function () { return [assignedIssue(2565)]; },
    });

    await autoLaunch.launchScheduled("assigned-to-me");

    // The binding is real, committed, on disk, and targets THIS project.
    primitive = targetManager.sessions.get(100);
    assert.ok(primitive, "the real task launcher should create the primitive session");
    assert.strictEqual(primitive.taskLauncher.itemKey, "trialview/v2#2565",
      "the primitive must persist the identity Coop authorizes");
    var persisted = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
    assert.strictEqual(persisted.bindings.length, 1, "the scan must land exactly one binding");
    var binding = persisted.bindings[0];
    assert.strictEqual(binding.mode, "project_coordinator");
    assert.strictEqual(binding.status, "active");
    assert.strictEqual(binding.targetProject.projectId, CUTOVER_PROJECT);
    assert.strictEqual(delivered.length, 0,
      "adoption must not replace the primitive with a generic delivery");

    // And the coordinator session it bound is the one the target reported.
    assert.strictEqual(binding.coordinator.sessionStorageId, primitive.storageId);
    assert.strictEqual(binding.projectCoordinator.projectId, projectIdentity.LEAD_PROJECT_ID);
    assert.strictEqual(primitive.coordinationRole, "task_coordinator");
    var roots = Array.from(leadManager.sessions.values()).filter(function (session) {
      return session.coordinationRole === "project_coordinator";
    });
    assert.strictEqual(roots.length, 1, "one resident ProjectRef coordinator owns the primitive");
    assert.strictEqual(roots[0].orchestrationTasks.length, 1);
    assert.strictEqual(roots[0].orchestrationTasks[0].workerStorageId, primitive.storageId);
    assert.strictEqual(autoLaunch.candidateStore.get({ projectId: CUTOVER_PROJECT },
      "launch:trialview/v2#2565").status, "admitted");

    // Idempotency against the real store: scanning again replays.
    await autoLaunch.launchScheduled("assigned-to-me");
    var again = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
    assert.strictEqual(again.bindings.length, 1, "a second scan must not create a second binding");
    assert.strictEqual(delivered.length, 0, "nor deliver generic duplicate work");
    assert.strictEqual(roots[0].orchestrationTasks.length, 1, "nor duplicate the coordinator task");

    autoLaunch.notifyNeedsInput(primitive, "Choose the owner-sensitive option");
    assert.strictEqual(roots[0].orchestrationTasks[0].status, "needs_input");
    autoLaunch.notifyCompleted(primitive, "Verified internal work");
    var completed = JSON.parse(fs.readFileSync(bindingFile, "utf8")).bindings[0];
    assert.strictEqual(completed.status, "completed");
    assert.strictEqual(roots[0].orchestrationTasks[0].status, "completed");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("end to end: canonical admission adopts live-shaped #2725 and #2777 primitives", async function () {
  var serverCrossProject = require("../lib/server-cross-project");
  var projectIdentity = require("../lib/project-identity");
  var bindingsModule = require("../lib/portfolio-execution-bindings");
  var authorization = require("../lib/project-automation-execution-authorization");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-e2e-canonical-adoption-"));
  try {
    var tasksDir = path.join(cwd, ".clay", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    var recipe = {
      id: "assigned-to-me",
      source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
      launch: { defaultLimit: 10 }, session: {}, completion: {},
      filter: { type: "bug", assigned: "me" },
    };
    fs.writeFileSync(path.join(tasksDir, "assigned-to-me.json"), JSON.stringify(recipe));
    fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
      autoLaunch: { enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *", maxConcurrent: 5 },
      automation: typedIssueAutomation(),
    }));

    var bindingFile = path.join(cwd, "bindings.json");
    var historicalStore = bindingsModule.createPortfolioExecutionBindings({
      file: bindingFile, now: function () { return 1788343227499; },
    });
    var prior2725Item = assignedIssue(2725);
    prior2725Item.projectItems[0].status.name = "Ready for development";
    var prior2725 = writePreviousPrimitiveCandidate(cwd, { projectId: CUTOVER_PROJECT }, recipe,
      prior2725Item, "trialview/v2#2725", 1788343227000);
    var oldTaskId = portfolioTaskIdFor(prior2725);
    var oldRequest = {
      source: { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: "coop-home-live" },
      targetProject: { projectId: CUTOVER_PROJECT },
      mode: "project_coordinator",
      portfolioTaskId: oldTaskId,
      bindingRevision: 2,
      idempotencyKey: idempotencyKeyFor(oldTaskId, 2),
      coopTopicRef: { topicId: "automation-" + require("../lib/project-automation-identity")
        .identityDigest(CUTOVER_PROJECT, "trialview/v2#2725") },
      automationAuthorization: null,
    };
    oldRequest.automationAuthorization = authorization.createAuthorization(prior2725, oldRequest, {
      kind: authorization.PRIMITIVE_KIND,
    });
    assert.ok(oldRequest.automationAuthorization, "old unrouted primitive authority must be valid");
    assert.equal(historicalStore.reserve(oldRequest).ok, true);
    assert.equal(historicalStore.releaseReservation(oldTaskId, 2, {
      reason: "old_pre_adoption_failure",
    }).ok, true);
    var currentConfig = JSON.parse(fs.readFileSync(path.join(tasksDir, "config.json"), "utf8"));
    currentConfig.automation.externalActions.comment = "approval";
    currentConfig.automation.autonomy.feature = "autonomous";
    fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify(currentConfig));

    var historical2777 = {
      source: { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: "coop-home-live" },
      targetProject: { projectId: CUTOVER_PROJECT },
      mode: "project_coordinator",
      portfolioTaskId: "historical-webapp-2777",
      bindingRevision: 1,
      idempotencyKey: "historical-webapp-2777-r1",
      candidateKey: "launch:trialview/v2#2777",
    };
    assert.equal(historicalStore.reserve(historical2777).ok, true);
    assert.equal(historicalStore.commit("historical-webapp-2777", 1, {
      projectId: CUTOVER_PROJECT, sessionStorageId: "historical-2777",
    }, {
      projectCoordinatorRef: { projectId: projectIdentity.LEAD_PROJECT_ID,
        sessionStorageId: "coop-home-live" },
    }).ok, true);
    assert.equal(historicalStore.complete("historical-webapp-2777", 1, {
      eventId: "historical-completion-2777", resultEventId: "historical-result-2777",
      terminalStatus: "completed",
    }).ok, true);
    var completed2777 = historicalStore.get("historical-webapp-2777", 1);

    var prior2777 = writePreviousPrimitiveCandidate(cwd, { projectId: CUTOVER_PROJECT }, recipe,
      assignedIssue(2777), "trialview/v2#2777", 1788343227000);
    prior2777.reconsideration = {
      schema: "clay.automation_candidate_reconsideration",
      version: 1,
      reason: "owner_requested_bounce_reconsideration",
      ownerRequestRefs: ["owner-ingress:2777", "owner-ingress:2777-reconsider"],
      requestedAt: 1788343227400,
      currentQualificationRequired: true,
      verifiedNoLiveSession: true,
      completionProof: {
        kind: "completed_binding",
        portfolioTaskId: completed2777.portfolioTaskId,
        bindingRevision: completed2777.bindingRevision,
        targetProject: completed2777.targetProject,
        completedAt: completed2777.completedAt,
        resultEventId: completed2777.resultEventId,
        completionEventId: completed2777.completionEventId,
        coordinator: completed2777.coordinator,
        projectCoordinator: completed2777.projectCoordinator,
      },
    };
    var candidateFile = path.join(cwd, ".clay", "tasks", "automation-candidates.json");
    var candidateState = JSON.parse(fs.readFileSync(candidateFile, "utf8"));
    candidateState.candidates[0] = prior2777;
    candidateState.candidates.push(prior2725);
    fs.writeFileSync(candidateFile, JSON.stringify(candidateState, null, 2) + "\n");

    var leadManager = makeCoordinatorSessionManager(projectIdentity.LEAD_PROJECT_ID);
    leadManager.sessions.set("coop", { coopHome: true, storageId: "coop-home-live" });
    var targetManager = makeCoordinatorSessionManager(CUTOVER_PROJECT);
    var autoLaunch = null;
    var delivered = [];
    var leadContext = {
      getProjectId: function () { return projectIdentity.LEAD_PROJECT_ID; },
      getSessionManager: function () { return leadManager; },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    };
    var targetContext = {
      getProjectId: function () { return CUTOVER_PROJECT; },
      getSessionManager: function () { return targetManager; },
      validateAutomationAuthorization: function (input) {
        return autoLaunch.validateAutomationAuthorization(input);
      },
      deliverCrossProjectEnvelope: function (envelope) { delivered.push(envelope); return { ok: false }; },
    };
    var router = serverCrossProject.createCrossProjectRouter({
      allowLeadSourcedExecution: true,
      requireOwnerImplementationDecision: true,
      bindingFile: bindingFile,
      automationThreadIndex: {
        ensureAutomationThread: function (input) {
          return { ok: true, topicRef: { topicId: input.authorization.threadRef.threadId },
            threadRef: input.authorization.threadRef };
        },
      },
      onThreadHandedOff: function () { return { ok: true }; },
      ownerRequests: {
        claimCoordinator: function (input) { this.claimed = input.coordinator; return { ok: true }; },
        canonicalCoordinator: function () { return this.claimed || null; },
      },
      getProjectContextById: function (projectId) {
        if (projectId === projectIdentity.LEAD_PROJECT_ID) return leadContext;
        if (projectId === CUTOVER_PROJECT) return targetContext;
        return null;
      },
    });
    var taskLauncher = attachTaskLauncher({
      cwd: cwd, sm: targetManager, sdk: { startQuery: function () {} },
      usersModule: { isMultiUser: function () { return false; } },
      ensureProjectAccessForSession: function () { return true; }, onProcessingChanged: function () {},
    });
    autoLaunch = attachAutoLaunch({
      cwd: cwd, slug: "webapp", sm: targetManager,
      getTaskLauncher: function () { return taskLauncher; },
      getLeadMode: function () { return true; }, crossProject: router,
      fetchItems: function () { return [assignedIssue(2725), assignedIssue(2777)]; },
    });

    await autoLaunch.launchScheduled("assigned-to-me");

    var persisted = JSON.parse(fs.readFileSync(bindingFile, "utf8")).bindings;
    var rearmed2725 = persisted.filter(function (binding) {
      return binding.portfolioTaskId === oldTaskId && binding.bindingRevision === 2;
    })[0];
    var adopted2777 = persisted.filter(function (binding) {
      return binding.workIdentity === "github:trialview/v2#2777" &&
        binding.portfolioTaskId !== "historical-webapp-2777";
    })[0];
    assert.equal(persisted.length, 3, "the two exact primitives add bindings without replacing history");
    assert.equal(rearmed2725.status, "active");
    assert.equal(adopted2777.status, "active");
    var primitive2725 = targetManager.sessions.get(100);
    var primitive2777 = targetManager.sessions.get(101);
    assert.equal(rearmed2725.coordinator.sessionStorageId, primitive2725.storageId,
      "#2725 reuses the launcher-created SessionRef");
    assert.equal(adopted2777.coordinator.sessionStorageId, primitive2777.storageId,
      "#2777 reuses the launcher-created SessionRef");
    assert.equal(rearmed2725.automationAuthorization.qualificationReceipt.item.boardItems[0].status,
      "backlog", "the old unrouted revision carries current qualification authority");
    assert.notEqual(rearmed2725.automationAuthorization.policyDigest,
      oldRequest.automationAuthorization.policyDigest,
      "the old reservation cannot retain superseded project-policy authority");
    assert.equal(completed2777.status, "completed");
    assert.equal(persisted.filter(function (binding) {
      return binding.portfolioTaskId === "historical-webapp-2777";
    })[0].completionEventId, "historical-completion-2777");
    assert.equal(primitive2725.coopControlledBy.coopSessionStorageId,
      rearmed2725.projectCoordinator.sessionStorageId,
      "the primitive is owned by its canonical Coop ProjectRef coordinator");
    assert.equal(primitive2777.coopControlledBy.coopSessionStorageId,
      adopted2777.projectCoordinator.sessionStorageId,
      "the primitive is owned by its canonical Coop ProjectRef coordinator");
    assert.equal(delivered.length, 0, "canonical adoption never creates a second generic session");

    await autoLaunch.launchScheduled("assigned-to-me");
    assert.equal(JSON.parse(fs.readFileSync(bindingFile, "utf8")).bindings.length, 3,
      "repeated scans converge on the same two primitive SessionRefs");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function registerPrimitiveRecoveryCase(scenario) {
test(scenario.name, async function () {
  var serverCrossProject = require("../lib/server-cross-project");
  var projectIdentity = require("../lib/project-identity");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-e2e-inflight-"));
  try {
    var tasksDir = path.join(cwd, ".clay", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    var recipe = {
      id: "assigned-to-me",
      source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
      launch: { defaultLimit: 10 }, session: {}, completion: {},
      filter: { type: "bug", assigned: "me" },
    };
    fs.writeFileSync(path.join(tasksDir, "assigned-to-me.json"), JSON.stringify(recipe));
    fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
      autoLaunch: { enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *", maxConcurrent: 5 },
      automation: typedIssueAutomation(),
    }));

    var bindingFile = path.join(cwd, "bindings.json");
    var delivered = [];
    var leadManager = makeCoordinatorSessionManager(projectIdentity.LEAD_PROJECT_ID);
    leadManager.sessions.set("coop", { coopHome: true, storageId: "coop-home-live" });
    var targetManager = makeCoordinatorSessionManager(CUTOVER_PROJECT);
    var autoLaunch = null;
    var leadContext = {
      getProjectId: function () { return projectIdentity.LEAD_PROJECT_ID; },
      getSessionManager: function () { return leadManager; },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    };
    var targetContext = {
      getProjectId: function () { return CUTOVER_PROJECT; },
      getSessionManager: function () { return targetManager; },
      validateAutomationAuthorization: function (input) {
        if (scenario.removeBeforeAdmission) fs.unlinkSync(evidenceStore.fileFor({
          projectId: CUTOVER_PROJECT, sessionStorageId: "legacy-2883",
        }));
        var validated = autoLaunch.validateAutomationAuthorization(input);
        if (scenario.hideBeforeCommit) primitive.hidden = true;
        return validated;
      },
      deliverCrossProjectEnvelope: function (envelope) { delivered.push(envelope); return { ok: false }; },
    };
    var router = serverCrossProject.createCrossProjectRouter({
      allowLeadSourcedExecution: true,
      requireOwnerImplementationDecision: true,
      bindingFile: bindingFile,
      automationThreadIndex: {
        ensureAutomationThread: function (input) {
          return { ok: true, topicRef: { topicId: input.authorization.threadRef.threadId },
            threadRef: input.authorization.threadRef };
        },
      },
      onThreadHandedOff: function () { return { ok: true }; },
      ownerRequests: {
        claimCoordinator: function (input) {
          this.claimed = input.coordinator;
          return { ok: true };
        },
        canonicalCoordinator: function () { return this.claimed || null; },
      },
      getProjectContextById: function (projectId) {
        if (projectId === projectIdentity.LEAD_PROJECT_ID) return leadContext;
        if (projectId === CUTOVER_PROJECT) return targetContext;
        return null;
      },
    });

    var taskLauncher = attachTaskLauncher({
      cwd: cwd,
      sm: targetManager,
      sdk: { startQuery: function () {} },
      usersModule: { isMultiUser: function () { return false; } },
      ensureProjectAccessForSession: function () { return true; },
      onProcessingChanged: function () {},
    });
    var item = assignedIssue(2883);
    var previousCandidate = writePreviousPrimitiveCandidate(cwd, { projectId: CUTOVER_PROJECT },
      recipe, item, "trialview/v2#2883", Date.now() -
        (scenario.historical ? automationQualification.MAX_RECEIPT_AGE_MS + 60000 : 0));
    var primitive = targetManager.createSessionRaw({
      storageId: "legacy-2883",
      title: item.title,
      taskLauncher: {
        autoLaunch: true,
        recipeId: "assigned-to-me",
        itemNumber: 2883,
        itemUrl: item.url,
        autoKind: "issue",
        itemKey: "",
        workflowCompleted: false,
      },
    });
    if (scenario.historical) {
      primitive.createdAt = previousCandidate.qualificationReceipt.evidenceAt + 25;
      var evidenceStore = require("../lib/project-primitive-launch-evidence")
        .createLaunchEvidenceStore({ cwd: cwd });
      var retained = evidenceStore.retain({
        sessionRef: { projectId: CUTOVER_PROJECT,
          sessionStorageId: scenario.wrongSession ? "unrelated-session" : "legacy-2883" },
        qualificationReceipt: previousCandidate.qualificationReceipt,
      });
      assert.strictEqual(retained.ok, true);
      if (scenario.lateLaunch) primitive.createdAt += automationQualification.MAX_RECEIPT_AGE_MS;
      // The candidate has since changed: only the immutable original record
      // can establish what was eligible when this exact session was created.
      writePreviousPrimitiveCandidate(cwd, { projectId: CUTOVER_PROJECT },
        recipe, item, "trialview/v2#2883",
        previousCandidate.qualificationReceipt.evidenceAt - automationQualification.MAX_RECEIPT_AGE_MS - 1);
    }
    item.projectItems[0].status.name = "🔄 In progress";
    if (scenario.closed) item.state = "CLOSED";
    if (scenario.unassigned) item.assignedToOwner = false;
    if (scenario.doneBoard) item.projectItems[0].status.name = "Dev Complete";
    autoLaunch = attachAutoLaunch({
      cwd: cwd,
      slug: "webapp",
      sm: targetManager,
      getTaskLauncher: function () { return taskLauncher; },
      getLeadMode: function () { return true; },
      crossProject: router,
      fetchItems: function () { return [item]; },
    });

    await autoLaunch.runScheduled({ id: "autolaunch_assigned", task: "assigned-to-me" });

    if (scenario.denied) {
      assert.strictEqual(primitive.taskLauncher.itemKey, "",
        "old launch evidence must not bypass a current or historical boundary");
      var deniedBindings = fs.existsSync(bindingFile) ? JSON.parse(fs.readFileSync(bindingFile, "utf8")).bindings : [];
      assert.strictEqual(deniedBindings.length, 0);
      assert.strictEqual(delivered.length, 0);
      return;
    }
    assert.strictEqual(primitive.taskLauncher.itemKey, "trialview/v2#2883",
      "legacy recovery must persist the exact primitive identity");
    var persisted = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
    assert.strictEqual(persisted.bindings.length, 1,
      "the production router must accept the verified in-flight primitive adoption");
    var binding = persisted.bindings[0];
    assert.strictEqual(binding.status, "active");
    assert.strictEqual(binding.coordinator.sessionStorageId, "legacy-2883");
    assert.strictEqual(binding.automationAuthorization.kind,
      "project_auto_launch_primitive");
    assert.strictEqual(delivered.length, 0,
      "valid primitive adoption must not deliver a generic duplicate command");
    await autoLaunch.runScheduled({ id: "autolaunch_assigned", task: "assigned-to-me" });
    assert.strictEqual(JSON.parse(fs.readFileSync(bindingFile, "utf8")).bindings.length, 1,
      "replaying recovery must retain exactly the original binding");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

}
[
  { name: "end to end: the real router adopts a current in-flight primitive" },
  { name: "end to end: historical launch evidence recovers the exact old primitive", historical: true },
  { name: "historical primitive recovery rejects a now-closed issue", historical: true, closed: true, denied: true },
  { name: "historical primitive recovery rejects lost assignment", historical: true, unassigned: true, denied: true },
  { name: "historical primitive recovery rejects a completed board status", historical: true, doneBoard: true, denied: true },
  { name: "historical primitive recovery rejects evidence for another session", historical: true, wrongSession: true, denied: true },
  { name: "historical primitive recovery rejects an expired receipt at launch", historical: true, lateLaunch: true, denied: true },
  { name: "historical primitive recovery rechecks evidence at final admission", historical: true, removeBeforeAdmission: true, denied: true },
  { name: "primitive adoption rechecks hidden state at commit", hideBeforeCommit: true, denied: true },
].forEach(registerPrimitiveRecoveryCase);

test("adopted require-user-trigger primitive fans in internal completion before owner Done", async function () {
  var serverCrossProject = require("../lib/server-cross-project");
  var projectIdentity = require("../lib/project-identity");
  var taskSources = require("../lib/project-task-sources");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-auto-fanin-"));
  var hidden = [];
  var externalEvaluations = 0;
  var reportCalls = 0;
  var pendingSaveAttempts = 0;
  var completionSaveAttempts = 0;
  var durableTaskLauncher = null;
  var originalGetIssueStatus = taskSources.getIssueStatus;
  taskSources.getIssueStatus = function () { return ""; };
  try {
    var tasksDir = path.join(cwd, ".clay", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    var recipe = {
      id: "assigned-to-me",
      source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
      launch: { defaultLimit: 10 }, session: {},
      completion: {
        marker: "CLAY_TASK_COMPLETE",
        requireUserTrigger: true,
        closeSession: true,
        archiveSession: true,
      },
      filter: { type: "bug", assigned: "me" },
    };
    fs.writeFileSync(path.join(tasksDir, "assigned-to-me.json"), JSON.stringify(recipe));
    fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
      autoLaunch: { enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *", maxConcurrent: 1 },
      automation: typedIssueAutomation(),
    }));

    var leadManager = makeCoordinatorSessionManager(projectIdentity.LEAD_PROJECT_ID);
    leadManager.sessions.set("coop", { coopHome: true, storageId: "coop-home-live" });
    var targetManager = makeCoordinatorSessionManager(CUTOVER_PROJECT);
    var failFirstCompletionSave = false;
    targetManager.saveSessionFile = function (session, options) {
      var launcherState = session && session.taskLauncher;
      if (launcherState && launcherState.executionCompletionPending &&
          !launcherState.executionCompletionReported) {
        pendingSaveAttempts++;
        assert.strictEqual(options && options.durable, true,
          "completion intent must survive a restart before coordinator delivery");
        durableTaskLauncher = JSON.parse(JSON.stringify(launcherState));
      } else if (launcherState && launcherState.executionCompletionReported &&
          !launcherState.completionCallbackInvoked) {
        completionSaveAttempts++;
        assert.strictEqual(options && options.durable, true,
          "capacity release must survive a restart before it is acknowledged");
        if (failFirstCompletionSave) {
          failFirstCompletionSave = false;
          return false;
        }
        durableTaskLauncher = JSON.parse(JSON.stringify(launcherState));
      }
      return true;
    };
    targetManager.hideSessionForActiveClients = function (localId) {
      hidden.push(localId);
      var session = targetManager.sessions.get(localId);
      if (session) session.hidden = true;
    };
    var autoLaunch = null;
    var leadContext = {
      getProjectId: function () { return projectIdentity.LEAD_PROJECT_ID; },
      getSessionManager: function () { return leadManager; },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    };
    var targetContext = {
      getProjectId: function () { return CUTOVER_PROJECT; },
      getSessionManager: function () { return targetManager; },
      validateAutomationAuthorization: function (input) {
        return autoLaunch.validateAutomationAuthorization(input);
      },
      deliverCrossProjectEnvelope: function () { return { ok: false }; },
    };
    var router = serverCrossProject.createCrossProjectRouter({
      allowLeadSourcedExecution: true,
      requireOwnerImplementationDecision: true,
      bindingFile: path.join(cwd, "bindings.json"),
      automationThreadIndex: {
        ensureAutomationThread: function (input) {
          return { ok: true, topicRef: { topicId: input.authorization.threadRef.threadId },
            threadRef: input.authorization.threadRef };
        },
      },
      onThreadHandedOff: function () { return { ok: true }; },
      ownerRequests: {
        claimCoordinator: function (input) {
          this.claimed = input.coordinator;
          return { ok: true };
        },
        canonicalCoordinator: function () { return this.claimed || null; },
      },
      getProjectContextById: function (projectId) {
        if (projectId === projectIdentity.LEAD_PROJECT_ID) return leadContext;
        if (projectId === CUTOVER_PROJECT) return targetContext;
        return null;
      },
    });
    var originalReport = router.reportAutoLaunchExecution;
    var failFirstReport = false;
    router.reportAutoLaunchExecution = function (input) {
      reportCalls++;
      if (failFirstReport) {
        failFirstReport = false;
        return { ok: false, reason: "temporary_delivery_failure" };
      }
      return originalReport(input);
    };
    var taskLauncher = attachTaskLauncher({
      cwd: cwd,
      sm: targetManager,
      sdk: { startQuery: function () {} },
      usersModule: { isMultiUser: function () { return false; } },
      ensureProjectAccessForSession: function () { return true; },
      onProcessingChanged: function () {},
      getAutomationGate: function () {
        return {
          evaluateExternal: function (input) {
            externalEvaluations++;
            return autoLaunch.automationGate.evaluateExternal(input);
          },
        };
      },
      onComplete: function (session, summary) {
        return autoLaunch.notifyCompleted(session, summary);
      },
    });
    var scanItems = [Object.assign({}, assignedIssue(2565), { key: "trialview/v2#2565" })];
    autoLaunch = attachAutoLaunch({
      cwd: cwd,
      slug: "webapp",
      sm: targetManager,
      getTaskLauncher: function () { return taskLauncher; },
      getLeadMode: function () { return true; },
      crossProject: router,
      fetchItems: function () { return scanItems; },
    });

    await autoLaunch.launchScheduled("assigned-to-me");
    var primitive = targetManager.sessions.get(100);
    assert.ok(primitive, "the real task launcher should create the primitive session");
    primitive.isProcessing = false;
    var persisted = JSON.parse(fs.readFileSync(path.join(cwd, "bindings.json"), "utf8"));
    var binding = persisted.bindings[0];
    var roots = Array.from(leadManager.sessions.values()).filter(function (session) {
      return session.coordinationRole === "project_coordinator";
    });
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].orchestrationTasks.length, 1);
    assert.strictEqual(binding.status, "active");

    failFirstReport = true;
    failFirstCompletionSave = true;
    taskLauncher.handleTaskTurnDone(primitive, "", "Verified the implementation. CLAY_TASK_COMPLETE: internal work");
    assert.notStrictEqual(primitive.taskLauncher.workflowCompleted, true,
      "the internal marker must not close the owner-gated local workflow");
    assert.ok(!primitive.taskLauncher.closeAfterNextTurn,
      "the internal marker must not arm a local owner-triggered close");
    assert.strictEqual(primitive.taskLauncher.ownerCompletionApproval, undefined,
      "the internal marker must not grant owner approval");
    assert.deepStrictEqual(hidden, [], "internal completion must not hide the session");
    assert.strictEqual(externalEvaluations, 0,
      "internal completion must not pass through the external Done gate");
    binding = JSON.parse(fs.readFileSync(path.join(cwd, "bindings.json"), "utf8")).bindings[0];
    assert.strictEqual(binding.status, "active",
      "a failed coordinator report must not claim internal completion");
    assert.notStrictEqual(primitive.taskLauncher.completionCallbackInvoked, true,
      "a failed coordinator report must remain retryable");
    assert.notStrictEqual(primitive.taskLauncher.executionCompletionReported, true,
      "a failed coordinator report must keep the capacity slot occupied");
    assert.ok(primitive.taskLauncher.executionCompletionPending,
      "a failed coordinator report must leave a durable retry intent");
    assert.strictEqual(pendingSaveAttempts, 1,
      "the retry intent must be durable before coordinator delivery begins");
    assert.strictEqual(completionSaveAttempts, 0,
      "a failed coordinator report must not persist a false completion");

    taskLauncher.handleTaskTurnDone(primitive, "", "Verified the implementation. CLAY_TASK_COMPLETE: internal work");
    binding = JSON.parse(fs.readFileSync(path.join(cwd, "bindings.json"), "utf8")).bindings[0];
    assert.strictEqual(binding.status, "completed");
    assert.strictEqual(roots[0].orchestrationTasks[0].status, "completed");
    assert.strictEqual(reportCalls, 2, "internal completion must retry the failed report");
    assert.strictEqual(completionSaveAttempts, 1);
    assert.notStrictEqual(primitive.taskLauncher.completionCallbackInvoked, true,
      "a failed durable save must keep coordinator completion retryable");
    assert.notStrictEqual(primitive.taskLauncher.executionCompletionReported, true,
      "a failed durable save must keep the live capacity slot occupied");
    assert.ok(primitive.taskLauncher.executionCompletionPending,
      "a failed acknowledgement save must restore the durable retry intent");

    // A fresh controller over the reloaded session state is the daemon-restart
    // path. It must finish the idempotent report without another model marker.
    primitive.taskLauncher = JSON.parse(JSON.stringify(durableTaskLauncher));
    autoLaunch = attachAutoLaunch({
      cwd: cwd,
      slug: "webapp",
      sm: targetManager,
      getTaskLauncher: function () { return taskLauncher; },
      getLeadMode: function () { return true; },
      crossProject: router,
      fetchItems: function () { return scanItems; },
    });
    var recovered = autoLaunch.drainLegacyAutomation();
    assert.strictEqual(recovered.completionReconciliation.recovered, 1);
    assert.strictEqual(recovered.completionReconciliation.pending, 0);
    assert.strictEqual(recovered.drained, 0,
      "a pending completion must never be re-adopted as live legacy work");
    assert.strictEqual(reportCalls, 3,
      "restart recovery must replay the idempotent coordinator report");
    assert.strictEqual(completionSaveAttempts, 2);
    assert.strictEqual(primitive.taskLauncher.executionCompletionReported, true);
    assert.strictEqual(primitive.taskLauncher.executionCompletionPending, undefined);

    scanItems.push(Object.assign({}, assignedIssue(2566), { key: "trialview/v2#2566" }));
    await autoLaunch.launchScheduled("assigned-to-me");
    assert.ok(targetManager.sessions.get(101),
      "terminal internal completion must release capacity for another primitive");

    // Duplicate marker delivery is harmless, and the real owner trigger still
    // closes the local task without sending a second coordinator completion.
    taskLauncher.handleTaskTurnDone(primitive, "", "CLAY_TASK_COMPLETE: internal work");
    assert.strictEqual(reportCalls, 3, "duplicate marker must remain idempotent");
    var directive = taskLauncher.handleTaskUserMessageDispatched(primitive, "mark as done");
    assert.ok(directive && directive.indexOf("CLAY_TASK_COMPLETE") !== -1);
    assert.strictEqual(externalEvaluations, 1, "only the owner trigger may reach the external gate");
    assert.ok(primitive.taskLauncher.ownerCompletionApproval,
      "the owner trigger should record its approval");
    taskLauncher.handleTaskTurnDone(primitive, "", "Done workflow complete. CLAY_TASK_COMPLETE: owner Done");
    assert.strictEqual(primitive.taskLauncher.workflowCompleted, true);
    assert.deepStrictEqual(hidden, [primitive.localId]);
    assert.strictEqual(reportCalls, 3, "owner-triggered local closure must not re-report completion");
  } finally {
    taskSources.getIssueStatus = originalGetIssueStatus;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("require-user-trigger non-primitives still wait for owner Done", function () {
  var h = makeTaskLauncher();
  try {
    var session = makeAutoSession();
    session.taskLauncher.completion.requireUserTrigger = true;
    session.orchestrationPolicy = { portfolioExecution: {
      automationAuthorization: { kind: "project_execution" },
    } };
    h.tl.handleTaskTurnDone(session, "", "Verified work. CLAY_TASK_COMPLETE");
    assert.notStrictEqual(session.taskLauncher.workflowCompleted, true);
    assert.strictEqual(h.completed.length, 0);
    assert.deepStrictEqual(h.hidden, []);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("standing autonomy dispatches before owner-thread checks and keeps external gates", function () {
  var serverCrossProject = require("../lib/server-cross-project");
  var projectIdentity = require("../lib/project-identity");
  var autonomyGrant = require("../lib/coop-autonomy-grant");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-standing-order-"));
  try {
    var policyFile = path.join(cwd, "scoped-autonomy-policy.json");
    fs.writeFileSync(policyFile, JSON.stringify({
      schema: autonomyGrant.SCHEMA,
      version: autonomyGrant.VERSION,
      enabled: true,
      projects: [{ projectId: CUTOVER_PROJECT, name: "Webapp" }],
      categories: ["read_only_diagnosis"],
      permanentlyGated: autonomyGrant.forbiddenIds(),
    }));
    var leadManager = makeCoordinatorSessionManager(projectIdentity.LEAD_PROJECT_ID);
    leadManager.sessions.set("coop", { coopHome: true, storageId: "coop-home-live" });
    var delivered = [];
    var claimed = null;
    var router = serverCrossProject.createCrossProjectRouter({
      allowLeadSourcedExecution: true,
      requireOwnerImplementationDecision: true,
      autonomyPolicyFile: policyFile,
      bindingFile: path.join(cwd, "bindings.json"),
      ownerRequests: {
        claimCoordinator: function (input) { claimed = input.coordinator; return { ok: true }; },
        canonicalCoordinator: function () { return claimed; },
      },
      getProjectContextById: function (projectId) {
        if (projectId === projectIdentity.LEAD_PROJECT_ID) {
          return { getSessionManager: function () { return leadManager; } };
        }
        return null;
      },
    });
    router.registerProjectResolver({
      getProjectId: function () { return CUTOVER_PROJECT; },
      deliverCrossProjectEnvelope: function (envelope) {
        delivered.push(envelope);
        return { ok: true, created: true,
          sessionRef: { projectId: CUTOVER_PROJECT, sessionStorageId: "diagnosis-session" } };
      },
    });
    var base = {
      source: { projectId: projectIdentity.LEAD_PROJECT_ID,
        sessionStorageId: "coop-home-live" },
      portfolioTaskId: "lead-standing-diagnosis",
      bindingRevision: 1,
      idempotencyKey: "lead-standing-diagnosis-r1",
      mode: "project_coordinator",
      targetProject: { projectId: CUTOVER_PROJECT },
      title: "Diagnose the launch ordering",
      objective: "Inspect and report the exact launch evidence.",
      acceptanceCriteria: "Return read-only evidence.",
      ownedPaths: "read-only: automation state",
    };
    var admitted = router.createProjectExecution(base);
    assert.strictEqual(admitted.ok, true,
      "a covered grant must not stop at an owner-turn or missing-Thread check");
    assert.strictEqual(delivered.length, 1);

    var gated = router.createProjectExecution(Object.assign({}, base, {
      portfolioTaskId: "lead-standing-external",
      idempotencyKey: "lead-standing-external-r1",
      objective: "Diagnose the launch and git push the result to origin.",
    }));
    assert.strictEqual(gated.ok, false);
    assert.strictEqual(gated.reason, "autonomy_grant_push_to_remote_gated",
      "the reordered grant must not widen external-action authority");
    assert.strictEqual(delivered.length, 1);
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


test("historical launch evidence is immutable and a copied proof cannot authorize recovery", function () {
  var item = assignedIssue(2999);
  var h = makeIdleBoardHarness({ type: "bug" }, item);
  try {
    var evidence = require("../lib/project-primitive-launch-evidence");
    var store = evidence.createLaunchEvidenceStore({ cwd: h.cwd });
    var ref = { projectId: CUTOVER_PROJECT, sessionStorageId: "actual-old-launch" };
    var old = writePreviousPrimitiveCandidate(h.cwd, { projectId: CUTOVER_PROJECT },
      h.recipe, item, "trialview/v2#2999", Date.now() - automationQualification.MAX_RECEIPT_AGE_MS - 1000);
    var record = { sessionRef: ref, qualificationReceipt: old.qualificationReceipt };
    assert.deepStrictEqual(store.retain(record), { ok: true, created: true });
    var before = fs.readFileSync(store.fileFor(ref));
    assert.deepStrictEqual(store.retain(record), { ok: true, created: false });
    var different = writePreviousPrimitiveCandidate(h.cwd, { projectId: CUTOVER_PROJECT },
      h.recipe, item, "trialview/v2#2999", old.qualificationReceipt.evidenceAt + 1);
    assert.strictEqual(store.retain({ sessionRef: ref,
      qualificationReceipt: different.qualificationReceipt }).reason, "historical_launch_evidence_conflict");
    assert.ok(before.equals(fs.readFileSync(store.fileFor(ref))));
    var session = { storageId: ref.sessionStorageId,
      createdAt: old.qualificationReceipt.evidenceAt + 25,
      taskLauncher: { autoLaunch: true, recipeId: h.recipe.id,
        itemNumber: item.number, itemUrl: item.url, itemKey: "" } };
    var policy = automationPolicy.loadProjectAutomationPolicy({ cwd: h.cwd,
      projectRef: { projectId: CUTOVER_PROJECT } }).policy;
    var input = { session: session, projectRef: { projectId: CUTOVER_PROJECT },
      recipe: h.recipe, itemKey: old.itemKey, policy: policy, now: Date.now() };
    var verified = store.verify(input);
    assert.strictEqual(verified.ok, true);
    item.projectItems[0].status.name = "In progress";
    var request = { policy: policy, projectRef: input.projectRef,
      recipe: old.qualificationReceipt.recipe, item: item, itemKey: old.itemKey,
      itemClass: "bug", assignedToOwner: true, recipeAllowsUnassigned: false,
      allowInFlightPrimitive: true, previousQualificationReceipt: old.qualificationReceipt,
      historicalPrimitiveLaunch: verified.proof, now: Date.now() };
    var fresh = automationQualification.receiptFor(request);
    assert.strictEqual(fresh.ok, true);
    assert.ok(automationQualification.normalizeReceipt(fresh.receipt));
    assert.strictEqual(fresh.receipt.historicalLaunch.receiptDigest, old.qualificationReceipt.digest);
    assert.strictEqual(automationQualification.receiptFor(Object.assign({}, request, {
      historicalPrimitiveLaunch: JSON.parse(JSON.stringify(verified.proof)),
    })).ok, false, "serialized proof data must not impersonate an internally verified launch");
    session.createdAt += 1;
    assert.strictEqual(automationQualification.receiptFor(request).ok, false,
      "a proof must stop working if actual session identity changes");
    session.createdAt -= 1;
    session.taskLauncher.itemUrl = "https://github.com/other/repo/issues/2999";
    assert.strictEqual(store.verify(input).ok, false,
      "matching issue number alone cannot establish repository identity");
    session.taskLauncher.itemUrl = item.url;
    var changedPolicy = JSON.parse(JSON.stringify(policy));
    changedPolicy.digest = "a".repeat(64);
    assert.strictEqual(store.verify(Object.assign({}, input, { policy: changedPolicy })).ok, false);
  } finally { fs.rmSync(h.cwd, { recursive: true, force: true }); }
});
