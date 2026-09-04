// Regressions for the Lead-mode-ON activity storm (2026-09-04).
//
// The auto-launch activity feed is a 200-entry ring buffer and it is the owner's
// only view of what automation is doing. A condition that repeats every tick for
// the same items therefore does not merely add noise — it EVICTS history.
//
// Live webapp state when this was found: all 200 entries were the SAME failure
// (`failed` / `invalid_candidate`) across just 16 distinct items, spanning 69.8
// minutes. Every genuine issue decision — including the "this issue is in Dev
// Complete" exclusions the owner had escalated about — had been pushed out of
// the buffer within the hour. That is why the board looked like nothing was
// happening at all, and why two prior attempts had no evidence to read.
//
// This is the storm half of the trialview/v2#2517 incident rebuilt in the feed,
// so the fix is the discipline the rest of this module already uses: an
// unchanged outcome for the same item is recorded once, and re-arms when the
// item's reason changes or it recovers.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachAutoLaunch } = require("../lib/project-auto-launch");
var { createCandidateStore } = require("../lib/project-automation-candidates");

// The canonical Webapp ProjectRef from the incident.
var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

// An assigned bug. `assignedToOwner` is the stamp project-task-sources puts on
// each item once it has matched the issue's assignees against a RESOLVED login;
// every eligibility decision downstream requires that proof.
function issueInStatus(status) {
  return {
    number: 2517,
    title: "Backlog bug that Coop never surfaced",
    url: "https://github.com/trialview/v2/issues/2517",
    labels: [{ name: "bug" }],
    assignees: [{ login: "bojantv" }],
    assignedToOwner: true,
    state: "OPEN",
    projectItems: [{ id: "PVT_item_2517", status: { name: status } }],
  };
}

function webappWorkspace() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-al-storm-"));
  var tasks = path.join(dir, ".clay", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, "assigned-to-me.json"), JSON.stringify({
    id: "assigned-to-me",
    source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
    launch: { defaultLimit: 5 },
    session: {},
    completion: {},
    filter: { type: "bug", assigned: "@me" },
  }));
  fs.writeFileSync(path.join(tasks, "config.json"), JSON.stringify({
    autoLaunch: { enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *" },
    automation: {
      autonomy: { bug: "autonomous", feature: "owner_approval", ambiguous: "owner_approval" },
      qualification: {
        version: 1,
        normalIssueIntake: {
          issueStates: ["open"],
          // The allow-list the real project runs. "Dev Complete" and "Done" are
          // post-development and must never qualify.
          boardStatuses: ["Backlog", "Ready for development"],
          requireAllBoardItems: true,
          assignment: "owner",
          classification: { autonomous: ["bug"], ownerApproval: ["feature", "ambiguous"] },
        },
      },
    },
  }));
  return dir;
}

function harness(fetchItems) {
  var dir = webappWorkspace();
  var started = [];
  var launcher = {
    loadRecipe: function () {
      return JSON.parse(fs.readFileSync(
        path.join(dir, ".clay", "tasks", "assigned-to-me.json"), "utf8"));
    },
    findExistingSessionForItem: function () { return null; },
    findAnyLiveSessionForItem: function () { return null; },
    findAnyVisibleSessionForItem: function () { return null; },
    startSessionForItem: function (ws, r, item) {
      started.push(item.number);
      return { localId: item.number, storageId: "s-" + item.number, title: "t" };
    },
  };
  var candidates = createCandidateStore({ cwd: dir });
  var autoLaunch = attachAutoLaunch({
    cwd: dir,
    slug: "webapp",
    sm: {
      sessions: new Map(), broadcastSessionList: function () {},
      saveSessionFile: function () {}, getProjectId: function () { return WEBAPP; },
    },
    getTaskLauncher: function () { return launcher; },
    getLeadMode: function () { return true; },
    candidateStore: candidates,
    fetchItems: fetchItems,
  });
  return { autoLaunch: autoLaunch, dir: dir, started: started, candidates: candidates };
}

function activity(dir) {
  try {
    var raw = JSON.parse(fs.readFileSync(
      path.join(dir, ".clay", "tasks", "auto-launch-activity.json"), "utf8"));
    return Array.isArray(raw) ? raw : (raw.events || []);
  } catch (e) { return []; }
}

function blockedIn(dir) {
  return activity(dir).filter(function (e) { return e.type === "blocked"; });
}

test("a post-development issue is excluded with a recorded reason, once — not once per tick",
  async function () {
    var h = harness(function () { return [issueInStatus("Dev Complete")]; });
    try {
      for (var i = 0; i < 12; i++) await h.autoLaunch.launchScheduled("assigned-to-me");

      // The exclusion must be RECORDED. A silent skip is what left the owner's
      // "engine launched Dev Complete work" escalation unexplainable for days.
      var blocked = blockedIn(h.dir);
      assert.strictEqual(blocked.length, 1,
        "12 identical ticks must leave exactly one entry, got " + blocked.length);
      assert.strictEqual(blocked[0].reason, "qualification_board_status_ineligible");
      assert.strictEqual(blocked[0].number, 2517);

      // And nothing may be proposed or started off a post-development item.
      assert.strictEqual(h.started.length, 0);
      assert.strictEqual(h.candidates.list().length, 0);

      // The buffer must not have been consumed by the steady state.
      assert.ok(activity(h.dir).length < 12, "a steady state must not fill the ring buffer");
    } finally {
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });

test("the latch is per item, so a second excluded issue is still reported", async function () {
  var items = [issueInStatus("Dev Complete")];
  var h = harness(function () { return items; });
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(blockedIn(h.dir).length, 1);

    // A DIFFERENT item hitting the same condition is new information: latching
    // per reason alone would have hidden every issue after the first.
    var second = issueInStatus("Dev Complete");
    second.number = 2600;
    items = [issueInStatus("Dev Complete"), second];
    await h.autoLaunch.launchScheduled("assigned-to-me");

    var numbers = blockedIn(h.dir).map(function (e) { return e.number; }).sort();
    assert.deepStrictEqual(numbers, [2517, 2600],
      "each excluded item must be reported once: " + JSON.stringify(numbers));
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a recovered issue is proposed normally, proving the latch suppressed no real change",
  async function () {
    var status = "Dev Complete";
    var h = harness(function () { return [issueInStatus(status)]; });
    try {
      await h.autoLaunch.launchScheduled("assigned-to-me");
      await h.autoLaunch.launchScheduled("assigned-to-me");
      assert.strictEqual(blockedIn(h.dir).length, 1);
      assert.strictEqual(h.candidates.list().length, 0);

      // The owner moves it back into an eligible column. The latch must not
      // stand between a genuine state change and the proposal.
      status = "Backlog";
      await h.autoLaunch.launchScheduled("assigned-to-me");
      assert.strictEqual(h.candidates.list().length, 1,
        "a recovered item must still be proposed");
      assert.strictEqual(h.candidates.list()[0].itemKey, "trialview/v2#2517");
    } finally {
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });
