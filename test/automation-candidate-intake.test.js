// Regressions for the trialview/v2#2517 intake incident.
//
// What happened: an eligible assigned bug on the Webapp board was re-evaluated
// every five minutes for hours. Each tick wrote a `started` activity entry with
// sessionId:null and storageId:null, no session was ever created, no typed
// binding was ever reserved, and Coop never saw the work. Two defects, both
// reproduced below:
//
//   1. SILENT INTAKE LOSS. The gate computed a candidate and nothing was wired
//      to receive it, so the proposal existed only as a log line.
//   2. DISHONEST START + STORM. A falsy return from startSessionForItem was
//      recorded as "started" and pushed into the started list, so the caller
//      believed work had begun. Nothing deduped it, so it retried forever.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachAutoLaunch } = require("../lib/project-auto-launch");
var { createAutomationGate } = require("../lib/project-automation-gate");
var { createCandidateStore } = require("../lib/project-automation-candidates");
var automationAudit = require("../lib/project-automation-audit");

// The canonical Webapp ProjectRef from the incident.
var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

// trialview/v2#2517: assigned bug, Backlog, eligible.
//
// `assignedToOwner` is the stamp project-task-sources puts on each item once it
// has matched the issue's assignees against a RESOLVED login. The fixture always
// described this issue as assigned; it just never modeled the proof, and every
// eligibility decision downstream now requires it.
function issue2517() {
  return {
    number: 2517,
    title: "Backlog bug that Coop never surfaced",
    url: "https://github.com/trialview/v2/issues/2517",
    labels: [{ name: "bug" }],
    assignees: [{ login: "bojantv" }],
    assignedToOwner: true,
    state: "OPEN",
    projectItems: [{ id: "PVT_item_2517", status: { name: "Backlog" } }],
  };
}

// A Webapp-shaped workspace: bug-scoped assigned-issue recipe, with the board
// statuses the real project excludes.
function webappWorkspace(extraRecipe) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-2517-"));
  var tasks = path.join(dir, ".clay", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, "assigned-to-me.json"), JSON.stringify(Object.assign({
    id: "assigned-to-me",
    source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
    launch: { defaultLimit: 5 },
    session: {},
    completion: {},
    filter: { type: "bug", assigned: "@me", skipProjectStatuses: ["Done", "In Progress", "Dev Complete"] },
  }, extraRecipe || {})));
  fs.writeFileSync(path.join(tasks, "config.json"), JSON.stringify({
    autoLaunch: { enabled: true, recipes: ["assigned-to-me"], cron: "*/5 * * * *" },
    automation: {
      autonomy: { bug: "autonomous", feature: "owner_approval", ambiguous: "owner_approval" },
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
    },
  }));
  return dir;
}

function harness(options) {
  var opts = options || {};
  var dir = opts.cwd || webappWorkspace();
  var started = [];
  var sessionFactory = opts.startSessionForItem || function (ws, r, item) {
    return { localId: item.number, storageId: "s-" + item.number, title: "t" };
  };
  var launcher = {
    loadRecipe: function () { return JSON.parse(fs.readFileSync(
      path.join(dir, ".clay", "tasks", "assigned-to-me.json"), "utf8")); },
    findExistingSessionForItem: function () { return null; },
    findAnyLiveSessionForItem: function () { return null; },
    findAnyVisibleSessionForItem: function () { return null; },
    startSessionForItem: function (ws, r, item, a, u, o) {
      var s = sessionFactory(ws, r, item, a, u, o);
      if (s) started.push(item.number);
      return s;
    },
  };
  var candidates = createCandidateStore({ cwd: dir });
  var gate = createAutomationGate({
    cwd: dir,
    slug: "webapp",
    projectRef: { projectId: WEBAPP },
    policyTtlMs: 0,
    getLeadMode: function () { return opts.leadMode !== false; },
    emitCandidate: null, // replaced by attachAutoLaunch's real wiring
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "webapp" }),
  });
  var autoLaunch = attachAutoLaunch({
    cwd: dir,
    slug: "webapp",
    sm: { sessions: new Map(), broadcastSessionList: function () {}, saveSessionFile: function () {},
      getProjectId: function () { return WEBAPP; } },
    getTaskLauncher: function () { return launcher; },
    getLeadMode: function () { return opts.leadMode !== false; },
    candidateStore: candidates,
    automationGate: opts.useRealGate === false ? gate : undefined,
    fetchItems: opts.fetchItems || function () { return [issue2517()]; },
  });
  return { autoLaunch: autoLaunch, dir: dir, started: started, candidates: candidates };
}

function activity(dir) {
  try {
    var raw = JSON.parse(fs.readFileSync(path.join(dir, ".clay", "tasks", "auto-launch-activity.json"), "utf8"));
    return Array.isArray(raw) ? raw : (raw.events || []);
  } catch (e) { return []; }
}

// --- Defect 1: the intake handoff -------------------------------------------

test("#2517: an eligible bug produces exactly one durable candidate for Coop", async function () {
  var h = harness();
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    var pending = h.candidates.list({ status: "pending" });
    assert.strictEqual(pending.length, 1, "the bug must reach Coop, not just the log");
    assert.strictEqual(pending[0].itemKey, "trialview/v2#2517");
    assert.strictEqual(pending[0].projectRef.projectId, WEBAPP,
      "the candidate must carry the canonical Webapp ProjectRef");
    assert.strictEqual(pending[0].itemClass, "bug");
    assert.strictEqual(pending[0].admission, "auto",
      "a bug-scoped Webapp recipe auto-admits");
    assert.strictEqual(pending[0].intent.number, 2517);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: ticking for hours launches one candidate, never accumulates", async function () {
  var h = harness();
  try {
    for (var i = 0; i < 12; i++) await h.autoLaunch.launchScheduled("assigned-to-me");
    var all = h.candidates.list();
    assert.strictEqual(all.length, 1, "12 ticks must not create 12 candidates");
    assert.strictEqual(all[0].seenCount, 1,
      "launch state must suppress later rediscovery after the primitive starts");
    assert.ok(all[0].lastSeenAt >= all[0].firstSeenAt);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: repeated ticks do not spam the activity feed", async function () {
  var h = harness();
  try {
    for (var i = 0; i < 12; i++) await h.autoLaunch.launchScheduled("assigned-to-me");
    var proposed = activity(h.dir).filter(function (e) { return e.type === "proposed"; });
    assert.strictEqual(proposed.length, 1,
      "one proposal is news once; 12 ticks produced " + proposed.length + " entries");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: Lead mode ON preserves exactly one primitive launch", async function () {
  var h = harness();
  try {
    for (var i = 0; i < 6; i++) await h.autoLaunch.launchScheduled("assigned-to-me");
    var starts = activity(h.dir).filter(function (e) { return e.type === "started"; });
    assert.strictEqual(starts.length, 1, "the legacy primitive must start once under Lead");
    assert.strictEqual(starts[0].sessionId, 2517);
    assert.strictEqual(starts[0].storageId, "s-2517");
    assert.deepStrictEqual(h.started, [2517], "later ticks must not create a duplicate session");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a genuinely changed proposal is news again, an identical one is not", async function () {
  var h = harness();
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    await h.autoLaunch.launchScheduled("assigned-to-me");
    assert.strictEqual(activity(h.dir).filter(function (e) { return e.type === "proposed"; }).length, 1);

    // The same item reclassified is a real change and must resurface.
    var changed = h.candidates.upsert({
      candidateKey: "launch:trialview/v2#2517",
      itemKey: "trialview/v2#2517",
      itemClass: "feature",
      admission: "owner_approval",
      projectRef: { projectId: WEBAPP },
    });
    assert.strictEqual(changed.changed, true);
    assert.strictEqual(changed.created, false, "still the same candidate, not a second one");
    assert.strictEqual(h.candidates.list().length, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: once Coop admits it, later ticks refresh quietly", async function () {
  var h = harness();
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    h.candidates.markAdmitted({ projectId: WEBAPP }, "launch:trialview/v2#2517",
      { portfolioTaskId: "task-2517", bindingRevision: 1 });

    await h.autoLaunch.launchScheduled("assigned-to-me");
    var all = h.candidates.list();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].status, "admitted",
      "a re-proposal must not reopen work Coop already admitted");
    assert.strictEqual(all[0].binding.portfolioTaskId, "task-2517");
    assert.strictEqual(h.candidates.list({ status: "pending" }).length, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// --- Defect 2: a launch without a session ------------------------------------

test("#2517: a launch that yields no session is recorded failed, not started", async function () {
  // Lead OFF exercises the legacy launch path, which is where this defect bites.
  var h = harness({ leadMode: false, startSessionForItem: function () { return null; } });
  try {
    var result = await h.autoLaunch.launchScheduled("assigned-to-me");
    var events = activity(h.dir);
    assert.deepStrictEqual(events.filter(function (e) { return e.type === "started"; }), [],
      "a null session must never be recorded as started");
    var failed = events.filter(function (e) { return e.type === "failed"; });
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].reason, "session_not_created");
    assert.strictEqual(failed[0].number, 2517);
    assert.strictEqual(result.started.length, 0,
      "the caller must not believe work began");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a failed launch rolls back so it is retryable, not deduped forever", async function () {
  var h = harness({ leadMode: false, startSessionForItem: function () { return null; } });
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    var { createIssueLaunchState } = require("../lib/project-issue-launch-state");
    var state = createIssueLaunchState(h.dir);
    assert.strictEqual(state.hasEntry("trialview/v2#2517"), false,
      "a launch that never happened must not mark the issue launched");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a real session is still recorded started with its ids", async function () {
  var h = harness({ leadMode: false });
  try {
    await h.autoLaunch.launchScheduled("assigned-to-me");
    var starts = activity(h.dir).filter(function (e) { return e.type === "started"; });
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(starts[0].sessionId, 2517);
    assert.strictEqual(starts[0].storageId, "s-2517");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// --- Board exclusions and #2503 ------------------------------------------------

test("#2517: Webapp board exclusions still suppress In Progress work", function () {
  // #2503 is In Progress with a draft PR awaiting preview input. The exclusion
  // is applied by the task source while fetching, so that is where it is
  // asserted — the launch loop never sees an excluded item at all.
  var taskSources = require("../lib/project-task-sources");
  var recipe = {
    id: "assigned-to-me",
    source: { provider: "github", kind: "issue", repo: "trialview/v2" },
    filter: { type: "bug", skipProjectStatuses: ["Done", "In Progress", "Dev Complete"] },
  };
  var inProgress = {
    number: 2503, title: "already in flight",
    labels: [{ name: "bug" }],
    projectItems: [{ status: { name: "In Progress" } }],
  };
  var backlog = {
    number: 2517, title: "eligible",
    labels: [{ name: "bug" }],
    projectItems: [{ status: { name: "Backlog" } }],
  };
  assert.strictEqual(taskSources.issueMatches(recipe, {}, inProgress, null), false,
    "#2503 is In Progress and must not be re-proposed");
  assert.strictEqual(taskSources.issueMatches(recipe, {}, backlog, null), true,
    "#2517 in Backlog remains eligible");
});

test("#2517: a candidate-store write failure is reported, never silently dropped", function () {
  var dir = webappWorkspace();
  try {
    var failing = Object.create(fs);
    failing.writeFileSync = function () { throw new Error("disk full"); };
    var store = createCandidateStore({ fs: failing, cwd: dir });
    var result = store.upsert({
      candidateKey: "launch:trialview/v2#2517", itemKey: "trialview/v2#2517",
      itemClass: "bug", admission: "auto", projectRef: { projectId: WEBAPP },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "persistence_failed",
      "losing a candidate must surface, the way the legacy launch-state writes did not");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#2517: a candidate without a valid ProjectRef is refused", function () {
  var dir = webappWorkspace();
  try {
    var store = createCandidateStore({ cwd: dir });
    assert.strictEqual(store.upsert({
      candidateKey: "k", itemKey: "i", projectRef: { projectId: "not-a-ref" },
    }).reason, "invalid_candidate");
    assert.strictEqual(store.upsert({ projectRef: { projectId: WEBAPP } }).reason,
      "invalid_candidate");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
