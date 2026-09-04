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

function makeHarness(kind, cleanupProcessing, fetchItems) {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-autolaunch-maintenance-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var recipeId = kind === "pr-reviews" ? "pr-review" : "assigned-to-me";
  var sessions = new Map();
  var launched = [];
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: {
      enabled: true,
      recipeId: recipeId,
      recipes: [recipeId],
      cron: "*/5 * * * *",
    },
  }, null, 2) + "\n");
  sessions.set(1, {
    localId: 1,
    title: "/cleanup",
    isProcessing: cleanupProcessing,
    history: [{ type: "user_message", text: "/cleanup" }],
  });

  var recipe = {
    id: recipeId,
    source: { provider: "github", kind: kind, repo: "owner/repo" },
    launch: { defaultLimit: 5, maxPasses: 2 },
    session: { title: "Task #{number} {title}" },
    completion: {},
  };
  var launcher = {
    loadRecipe: function () { return recipe; },
    findExistingSessionForItem: function () { return null; },
    findAnyLiveSessionForItem: function () { return null; },
    findAnyVisibleSessionForItem: function () { return null; },
    startSessionForItem: function (ws, loadedRecipe, item) {
      launched.push(item.number);
      return { localId: item.number, title: "Task #" + item.number };
    },
  };
  var defaultItems = [{
    number: 10,
    title: "Fix me",
    url: "https://github.com/owner/repo/pull/10",
    key: "owner/repo#10",
    // The owner's own assigned work — the only kind automatic pickup considers.
    assignedToOwner: true,
    head_sha: "abc123",
    ci_failing: true,
    latestFeedbackTs: Date.now(),
  }];
  var autoLaunch = attachAutoLaunch({ getLeadMode: LEAD_OFF,
    cwd: cwd,
    sm: {
      sessions: sessions,
      broadcastSessionList: function () {},
    },
    getTaskLauncher: function () { return launcher; },
    fetchItems: fetchItems || function () { return defaultItems; },
  });
  return {
    autoLaunch: autoLaunch,
    cleanup: sessions.get(1),
    cwd: cwd,
    defaultItems: defaultItems,
    launched: launched,
  };
}

test("PR auto-launch defers while /cleanup is processing", async function () {
  var fetched = 0;
  var h = makeHarness("pr-reviews", true, function () {
    fetched++;
    return h.defaultItems;
  });
  try {
    var result = await h.autoLaunch.launchScheduled("pr-review");
    assert.strictEqual(fetched, 0, "maintenance guard should avoid the GitHub scan");
    assert.strictEqual(result.maintenanceDeferred, true);
    assert.deepStrictEqual(h.launched, []);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("issue auto-launch continues while /cleanup is processing", async function () {
  var h = makeHarness("issues", true);
  try {
    var result = await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(result.maintenanceDeferred, false);
    assert.deepStrictEqual(h.launched, [10]);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("PR auto-launch resumes after /cleanup finishes", async function () {
  var h = makeHarness("pr-reviews", false);
  try {
    var result = await h.autoLaunch.launchScheduled("pr-review");
    assert.strictEqual(result.maintenanceDeferred, false);
    assert.deepStrictEqual(h.launched, [10]);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});

test("PR auto-launch rechecks /cleanup after an in-flight scan", async function () {
  var resolveItems;
  var h = makeHarness("pr-reviews", false, function () {
    return new Promise(function (resolve) { resolveItems = resolve; });
  });
  try {
    var launchPromise = h.autoLaunch.launchScheduled("pr-review");
    await new Promise(function (resolve) { setImmediate(resolve); });
    h.cleanup.isProcessing = true;
    resolveItems(h.defaultItems);
    var result = await launchPromise;
    assert.strictEqual(result.maintenanceDeferred, true);
    assert.deepStrictEqual(h.launched, []);
  } finally {
    fs.rmSync(h.cwd, { recursive: true, force: true });
  }
});
