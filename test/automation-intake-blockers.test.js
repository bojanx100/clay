// Regressions for the reproduced invariant gaps in the Coop intake boundary.
// Each is shaped like the reported reproduction.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createCandidateStore } = require("../lib/project-automation-candidates");
var { createCandidateAdmission } = require("../lib/project-automation-admission");
var { attachAutoLaunch } = require("../lib/project-auto-launch");
var { createAutomationGate } = require("../lib/project-automation-gate");
var automationAudit = require("../lib/project-automation-audit");
var leadBacklog = require("../lib/lead-backlog");
var policyModule = require("../lib/project-automation-policy");
var qualification = require("../lib/project-automation-qualification");

var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var URBAN_STAY = "51e67388-cea0-52b7-8e01-cde68cae713c";
var TEST_PASS = "current-test-scan";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-blockers-"));
}

function recipeFor(id, repo) {
  return {
    id: id,
    source: { provider: "github", kind: "issue", repo: repo, includeProjectItems: true },
    filter: {},
  };
}

function policyFor(ref) {
  var recipes = [
    recipeFor("assigned-to-me", "trialview/v2"),
    recipeFor("all-issues", "bojanx100/urban-stay-web"),
  ];
  var policy = {
    projectRef: ref,
    derived: false,
    autonomy: { bug: "autonomous", feature: "owner_approval", ambiguous: "owner_approval",
      pr_review: "propose", default: "propose" },
    externalActions: { comment: "approval", done_workflow: "approval", merge: "approval", close: "approval" },
    boardExclusions: [],
    qualification: {
      version: 1,
      normalIssueIntake: {
        issueStates: ["open"], boardStatuses: ["Backlog", "Ready for development"],
        requireAllBoardItems: true, assignment: "owner",
        classification: { autonomous: ["bug"], ownerApproval: ["feature", "ambiguous"] },
      },
    },
    providerRules: { vendors: {} },
    recipes: recipes.map(function (recipe) {
      return { id: recipe.id, kind: "issue", repo: recipe.source.repo, type: "",
        digest: policyModule.recipeDigest(recipe) };
    }),
    sources: [],
  };
  policy.digest = policyModule.policyDigest(policy);
  return policy;
}

function candidate(overrides) {
  var value = Object.assign({
    candidateKey: "launch:trialview/v2#2517",
    itemKey: "trialview/v2#2517",
    itemClass: "feature",
    admission: "owner_approval",
    projectRef: { projectId: WEBAPP },
    recipeId: "assigned-to-me",
    eligibilityPass: TEST_PASS,
    eligibility: {
      assignedToOwner: true,
      recipeAllowsUnassigned: false,
      reason: "assigned_to_owner",
    },
    intent: { recipeId: "assigned-to-me", number: 2517, autoKind: "issue" },
  }, overrides || {});
  var policy = policyFor(value.projectRef);
  var repo = String(value.itemKey).split("#")[0];
  var recipe = recipeFor(value.recipeId, repo);
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, "policyDigest")) {
    value.policyDigest = policy.digest;
  }
  if (!Object.prototype.hasOwnProperty.call(value, "qualificationReceipt")) {
    var receipt = qualification.receiptFor({
      policy: policy,
      projectRef: value.projectRef,
      recipe: { id: recipe.id, digest: policyModule.recipeDigest(recipe), kind: "issue" },
      item: { number: value.intent.number, state: "OPEN",
        projectItems: [{ id: "PVT_item_" + value.intent.number, status: { name: "Backlog" } }] },
      itemKey: value.itemKey,
      itemClass: value.itemClass,
      assignedToOwner: value.eligibility.assignedToOwner,
      recipeAllowsUnassigned: value.eligibility.recipeAllowsUnassigned,
      now: 1000,
    });
    if (receipt.ok) value.qualificationReceipt = receipt.receipt;
  }
  return value;
}

function withTestPass(admission) {
  var admitPending = admission.admitPending;
  admission.admitPending = function (options) {
    return admitPending(Object.assign({ eligibilityPass: TEST_PASS }, options || {}));
  };
  return admission;
}

function ownerDecision(store, projectId, candidateKey, approved) {
  var record = store.get({ projectId: projectId }, candidateKey);
  var stage = record && record.approvalStage || {};
  return store.decideOwner({ projectId: projectId }, candidateKey, {
    approved: approved,
    by: "user-owner",
    portfolioTaskId: stage.portfolioTaskId,
    bindingRevision: stage.bindingRevision,
  });
}

function fakeRouter() {
  var bound = {};
  var calls = [];
  return {
    calls: calls,
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
      calls.push(input);
      bound[input.portfolioTaskId + ":" + input.bindingRevision] = {
        portfolioTaskId: input.portfolioTaskId, bindingRevision: input.bindingRevision,
        mode: input.mode, idempotencyKey: input.idempotencyKey,
        targetProject: input.targetProject, status: "active",
      };
      return { ok: true };
    },
  };
}

function admissionFor(dir, router) {
  var store = createCandidateStore({ cwd: dir });
  return {
    store: store,
    admission: withTestPass(createCandidateAdmission({
      candidates: store,
      crossProject: router,
      getLeadMode: function () { return true; },
      now: function () { return 1000; },
      loadPolicy: function (projectRef) { return { ok: true, policy: policyFor(projectRef) }; },
      resolveCoopSource: function () { return router.coopSessionRef(); },
      audit: automationAudit.createAutomationAudit({
        file: path.join(dir, "audit.jsonl"), slug: "webapp" }),
    })),
  };
}

// --- 1. Owner approval must not be a dead end ---------------------------------

test("owner approval waits for a fresh eligible scan, then admits once", function () {
  var dir = tempDir();
  var router = fakeRouter();
  try {
    var h = admissionFor(dir, router);
    h.store.upsert(candidate());
    h.admission.admitPending();
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status,
      "awaiting_owner");
    assert.strictEqual(h.store.pending({ statuses: ["pending", "owner_approved"] }).candidates.length, 0);

    // The owner says yes.
    var decided = ownerDecision(h.store, WEBAPP, "launch:trialview/v2#2517", true);
    assert.strictEqual(decided.ok, true);
    assert.strictEqual(decided.candidate.status, "owner_approved");
    assert.strictEqual(decided.candidate.attention, undefined, "the decision resolves attention");
    assert.strictEqual(decided.candidate.eligibilityPass, null,
      "approval cannot reuse the scan that originally requested it");

    // Approval alone cannot bind stale work. A later current scan must re-see
    // the item and refresh the exact-pass evidence first.
    var stale = h.admission.admitPending();
    assert.strictEqual(stale.admitted, 0);
    assert.strictEqual(stale.revalidationDeferred, 1);
    assert.strictEqual(router.calls.length, 0);

    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.admitted, 1);
    assert.strictEqual(router.calls.length, 1);
    assert.strictEqual(h.admission.admitPending().admitted, 0, "never twice");
    assert.strictEqual(router.calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an owner NO resolves attention and never re-prompts", function () {
  var dir = tempDir();
  var router = fakeRouter();
  try {
    var h = admissionFor(dir, router);
    h.store.upsert(candidate());
    h.admission.admitPending();

    ownerDecision(h.store, WEBAPP, "launch:trialview/v2#2517", false);
    var record = h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    assert.strictEqual(record.status, "owner_declined");
    assert.strictEqual(record.attention, undefined);

    // Re-proposed by a later scan, and still declined — no new prompt.
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.ownerDecisions.length, 0, "a declined item must not re-prompt");
    assert.strictEqual(router.calls.length, 0, "and must never be admitted");
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status,
      "owner_declined");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The exact reported reproduction: awaiting_owner + a changed proposal that now
// auto-admits used to stay awaiting_owner forever, so pending() returned zero
// and the item could neither be admitted nor re-surfaced to the owner.
test("a policy change to auto releases awaiting_owner instead of stranding it", function () {
  var dir = tempDir();
  var router = fakeRouter();
  try {
    var h = admissionFor(dir, router);
    h.store.upsert(candidate());
    h.admission.admitPending();
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status,
      "awaiting_owner");

    // The project's policy now auto-admits this class, so waiting is stale.
    h.store.upsert(candidate({ admission: "auto", itemClass: "bug" }));
    var record = h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    assert.strictEqual(record.status, "pending",
      "the reason for waiting is gone, so the item must be admissible again");
    assert.strictEqual(h.store.pending({ statuses: ["pending", "owner_approved"] }).candidates.length, 1);
    assert.strictEqual(h.admission.admitPending().admitted, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an owner decision requires a real approver and an explicit verdict", function () {
  var dir = tempDir();
  try {
    var store = createCandidateStore({ cwd: dir });
    store.upsert(candidate());
    assert.strictEqual(store.decideOwner({ projectId: WEBAPP }, "launch:trialview/v2#2517",
      { approved: true }).reason, "owner_identity_required");
    assert.strictEqual(store.decideOwner({ projectId: WEBAPP }, "launch:trialview/v2#2517",
      { by: "owner" }).reason, "owner_decision_required");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an owner decision cannot escape the exact staged task revision", function () {
  var dir = tempDir();
  var router = fakeRouter();
  try {
    var h = admissionFor(dir, router);
    h.store.upsert(candidate());
    h.admission.admitPending();
    var record = h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    var wrong = h.store.decideOwner({ projectId: WEBAPP }, "launch:trialview/v2#2517", {
      approved: true,
      by: "user-owner",
      portfolioTaskId: record.approvalStage.portfolioTaskId,
      bindingRevision: record.approvalStage.bindingRevision + 1,
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, "owner_approval_scope_mismatch");
    assert.equal(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status,
      "awaiting_owner");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a post-hoc approval of already-admitted work fails closed", function () {
  var dir = tempDir();
  var router = fakeRouter();
  try {
    var h = admissionFor(dir, router);
    h.store.upsert(candidate({ admission: "auto", itemClass: "bug" }));
    h.admission.admitPending();
    var again = h.store.decideOwner({ projectId: WEBAPP }, "launch:trialview/v2#2517",
      { approved: true, by: "user-owner" });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, "owner_approval_not_staged");
    assert.strictEqual(h.admission.admitPending().admitted, 0);
    assert.strictEqual(router.calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an admitted Urban Stay candidate binds only Urban Stay's canonical ProjectRef", function () {
  var dir = tempDir();
  var router = fakeRouter();
  try {
    var h = admissionFor(dir, router);
    h.store.upsert(candidate({
      candidateKey: "launch:bojanx100/urban-stay-web#41",
      itemKey: "bojanx100/urban-stay-web#41",
      projectRef: { projectId: URBAN_STAY },
      admission: "auto",
      itemClass: "bug",
      recipeId: "all-issues",
      intent: { recipeId: "all-issues", number: 41, title: "Auto-launch regression" },
    }));
    assert.strictEqual(h.admission.admitPending().admitted, 1);
    assert.strictEqual(router.calls.length, 1);
    assert.deepStrictEqual(router.calls[0].targetProject, { projectId: URBAN_STAY });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. Vendor health must not suppress Coop intake ---------------------------

test("a rate-limited vendor does not suppress discovery under Lead mode ON", async function () {
  var dir = tempDir();
  try {
    var tasks = path.join(dir, ".clay", "tasks");
    fs.mkdirSync(tasks, { recursive: true });
    var recipe = {
      id: "assigned-to-me",
      source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
      launch: { defaultLimit: 5 }, session: {}, completion: {},
      filter: { type: "bug" },
    };
    fs.writeFileSync(path.join(tasks, "assigned-to-me.json"), JSON.stringify(recipe));
    fs.writeFileSync(path.join(tasks, "config.json"), JSON.stringify({
      autoLaunch: { enabled: true, recipes: ["assigned-to-me"], vendorWeights: { claude: 60, codex: 40 } },
      automation: {
        autonomy: { bug: "autonomous", feature: "owner_approval", ambiguous: "owner_approval" },
        qualification: policyFor({ projectId: WEBAPP }).qualification,
      },
    }));

    var candidates = [];
    var started = [];
    var gate = createAutomationGate({
      cwd: dir, slug: "webapp", projectRef: { projectId: WEBAPP }, policyTtlMs: 0,
      getLeadMode: function () { return true; },
      emitCandidate: function (c) { candidates.push(c); return { ok: true, created: true }; },
      audit: automationAudit.createAutomationAudit({
        file: path.join(dir, "audit.jsonl"), slug: "webapp" }),
    });
    var autoLaunch = attachAutoLaunch({
      cwd: dir, slug: "webapp",
      sm: { sessions: new Map(), broadcastSessionList: function () {},
        getProjectId: function () { return WEBAPP; } },
      getLeadMode: function () { return true; },
      automationGate: gate,
      // BOTH configured vendors throttled — the legacy launcher could not start
      // anything even if it wanted to.
      // The real cache shape: liveEntries() -> [{ vendor, status }].
      rateLimitCache: {
        liveEntries: function () {
          return [
            { vendor: "claude", status: "rejected" },
            { vendor: "codex", status: "rejected" },
          ];
        },
      },
      getTaskLauncher: function () {
        return {
          loadRecipe: function () { return recipe; },
          findExistingSessionForItem: function () { return null; },
          findAnyLiveSessionForItem: function () { return null; },
          findAnyVisibleSessionForItem: function () { return null; },
          startSessionForItem: function (w, r, i) { started.push(i.number); return { localId: i.number }; },
        };
      },
      fetchItems: function () {
        return [{ number: 2517, title: "b", url: "u", state: "OPEN", labels: [{ name: "bug" }],
          projectItems: [{ id: "PVT_item_2517", status: { name: "Backlog" } }],
          assignees: [{ login: "bojantv" }], assignedToOwner: true }];
      },
    });

    await autoLaunch.launchScheduled("assigned-to-me");
    assert.deepStrictEqual(started, [], "the controller still launches nothing");
    assert.strictEqual(candidates.length, 1,
      "but Coop owns routing and may pick a different provider, so it must still " +
      "learn the work exists");
    assert.strictEqual(candidates[0].itemKey, "trialview/v2#2517");
    // Provider state travels as evidence for Coop to weigh, not as a veto.
    assert.ok(candidates[0].intent.providerPolicy,
      "the candidate should carry provider evidence");
    assert.deepStrictEqual(
      candidates[0].intent.providerPolicy.rateLimitedVendors.sort(), ["claude", "codex"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 5. Safe migration of already-running legacy automation -------------------

function drainHarness(sessions) {
  var dir = tempDir();
  var tasks = path.join(dir, ".clay", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, "config.json"), JSON.stringify({
    autoLaunch: { enabled: true, recipes: [] },
  }));
  var store = createCandidateStore({ cwd: dir });
  var autoLaunch = attachAutoLaunch({
    cwd: dir, slug: "webapp",
    sm: {
      sessions: { forEach: function (fn) { (sessions || []).forEach(fn); } },
      broadcastSessionList: function () {},
      getProjectId: function () { return WEBAPP; },
    },
    getLeadMode: function () { return true; },
    candidateStore: store,
    getTaskLauncher: function () { return null; },
  });
  return { dir: dir, store: store, autoLaunch: autoLaunch };
}

test("a live legacy session is drained as adopted, not killed and not re-proposed", function () {
  var h = drainHarness([{
    localId: 3, storageId: "sess-legacy",
    taskLauncher: {
      autoLaunch: true, recipeId: "assigned-to-me", automationClaimKey: "trialview/v2#2503",
      itemNumber: 2503, itemUrl: "u", autoKind: "issue", workflowCompleted: false,
    },
  }]);
  try {
    var result = h.autoLaunch.drainLegacyAutomation();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.drained, 1);

    var record = h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2503");
    assert.ok(record, "the in-flight item must be recorded so it is not re-proposed");
    assert.strictEqual(record.status, "legacy_running");
    assert.strictEqual(record.legacyAdoption.sessionStorageId, "sess-legacy");
    // Not admissible: Coop holds no binding for it, and it is already running.
    assert.strictEqual(h.store.pending({ statuses: ["pending", "owner_approved"] }).candidates.length, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a drained legacy item is not re-proposed by a later scan", function () {
  var h = drainHarness([{
    localId: 3, storageId: "sess-legacy",
    taskLauncher: {
      autoLaunch: true, recipeId: "assigned-to-me", automationClaimKey: "trialview/v2#2503",
      itemNumber: 2503, autoKind: "issue", workflowCompleted: false,
    },
  }]);
  try {
    h.autoLaunch.drainLegacyAutomation();
    // Discovery proposes the same item; the adoption must win.
    h.store.upsert({
      candidateKey: "launch:trialview/v2#2503", itemKey: "trialview/v2#2503",
      itemClass: "bug", admission: "auto", projectRef: { projectId: WEBAPP },
    });
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2503").status,
      "legacy_running", "adopting then re-proposing must not duplicate the work");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a legacy session that cannot be attributed to an item fails closed", function () {
  var h = drainHarness([{
    localId: 4, storageId: "sess-unknown",
    taskLauncher: { autoLaunch: true, recipeId: "r", autoKind: "issue", workflowCompleted: false },
  }]);
  try {
    var result = h.autoLaunch.drainLegacyAutomation();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ambiguous, 1);
    assert.strictEqual(result.reason, "legacy_drain_ambiguous",
      "guessing either way could hide or duplicate real work");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("completed, internally completed, and hidden legacy sessions are not drained", function () {
  var h = drainHarness([
    { localId: 5, storageId: "a", taskLauncher: { autoLaunch: true, itemKey: "o/r#1", workflowCompleted: true } },
    { localId: 6, storageId: "b", hidden: true, taskLauncher: { autoLaunch: true, itemKey: "o/r#2" } },
    { localId: 7, storageId: "c", taskLauncher: { autoLaunch: false, itemKey: "o/r#3" } },
    { localId: 8, storageId: "d", taskLauncher: {
      autoLaunch: true, itemKey: "o/r#4", workflowCompleted: false,
      executionCompletionReported: true,
    } },
  ]);
  try {
    var result = h.autoLaunch.drainLegacyAutomation();
    assert.strictEqual(result.drained, 0);
    assert.strictEqual(result.ambiguous, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("Lead mode off drains nothing", function () {
  var dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, ".clay", "tasks"), { recursive: true });
    var store = createCandidateStore({ cwd: dir });
    var autoLaunch = attachAutoLaunch({
      cwd: dir, slug: "webapp",
      sm: { sessions: { forEach: function (fn) {
        fn({ localId: 1, storageId: "s", taskLauncher: { autoLaunch: true, itemKey: "o/r#1" } });
      } }, broadcastSessionList: function () {}, getProjectId: function () { return WEBAPP; } },
      getLeadMode: function () { return false; },
      candidateStore: store,
      getTaskLauncher: function () { return null; },
    });
    assert.strictEqual(autoLaunch.drainLegacyAutomation().skipped, "lead_mode_off");
    assert.strictEqual(store.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Live intake: filter.assigned "any" ----------------------------------------

// Urban Stay's canonical all-issues recipe uses assigned:"any". The task
// launcher treats that as NO assignee restriction; lead-backlog passed it
// through as a login, producing `gh issue list --assignee any`, which fails with
// "Could not find an assignee with the login 'any'" — so the whole canonical
// source collected nothing.
test("assigned:any means no assignee restriction, matching the task launcher", function () {
  var args = leadBacklog.ghIssueArgs({ repo: "o/r", filters: { assigned: "any" } });
  assert.strictEqual(args.indexOf("--assignee"), -1,
    "any must not become a literal login: " + args.join(" "));
});

test("assigned parity across every form the launcher accepts", function () {
  function args(assigned) {
    return leadBacklog.ghIssueArgs({ repo: "o/r", filters: { assigned: assigned } });
  }
  assert.strictEqual(args("me").join(" ").indexOf("--assignee @me") !== -1, true);
  assert.strictEqual(args("@me").join(" ").indexOf("--assignee @me") !== -1, true);
  assert.strictEqual(args("someone").join(" ").indexOf("--assignee someone") !== -1, true,
    "a real login is still filtered server-side");
  assert.strictEqual(args("").indexOf("--assignee"), -1);
  assert.strictEqual(args(null).indexOf("--assignee"), -1);
});

test("Urban Stay's any policy does not change Webapp's assigned-to-me query", function () {
  var urbanStay = leadBacklog.ghIssueArgs({
    repo: "bojanx100/urban-stay-web", filters: { assigned: "any" },
  });
  var webapp = leadBacklog.ghIssueArgs({
    repo: "trialview/v2", filters: { assigned: "me" },
  });
  assert.strictEqual(urbanStay.indexOf("--assignee"), -1);
  assert.deepEqual(webapp.slice(-2), ["--assignee", "@me"]);
});

test("assigned:any does not weaken the other filters", function () {
  var args = leadBacklog.ghIssueArgs({
    repo: "o/r",
    filters: { assigned: "any", state: "open", type: "feature", skipProjectStatuses: ["Done"] },
  }).join(" ");
  assert.ok(args.indexOf("--state open") !== -1, "state survives");
  assert.ok(args.indexOf("--label feature") !== -1, "type survives");
  assert.ok(args.indexOf("projectItems") !== -1,
    "board-status filtering still requests projectItems");
  assert.strictEqual(args.indexOf("--assignee"), -1);
});
