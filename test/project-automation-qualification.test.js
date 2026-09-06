var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("crypto");
var fs = require("fs");
var os = require("os");
var path = require("path");

var policyModule = require("../lib/project-automation-policy");
var qualification = require("../lib/project-automation-qualification");
var taskSources = require("../lib/project-task-sources");
var { attachAutoLaunch } = require("../lib/project-auto-launch");

var PROJECT = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    var result = {};
    Object.keys(value).sort().forEach(function (key) { result[key] = canonical(value[key]); });
    return result;
  }
  return value;
}

function recipe() {
  return {
    id: "assigned-to-me",
    source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
    filter: { state: "open", assigned: "me", type: "bug" },
  };
}

function policy() {
  var source = recipe();
  var value = {
    projectRef: { projectId: PROJECT },
    derived: false,
    autonomy: { bug: "autonomous", feature: "owner_approval", ambiguous: "owner_approval",
      pr_review: "propose", default: "propose" },
    externalActions: { comment: "approval", done_workflow: "approval", merge: "approval", close: "approval" },
    boardExclusions: [],
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
    providerRules: { vendors: {} },
    recipes: [{ id: source.id, kind: "issue", repo: "trialview/v2", type: "bug",
      digest: policyModule.recipeDigest(source) }],
    sources: [],
  };
  value.digest = policyModule.policyDigest(value);
  return value;
}

function issue(overrides) {
  return Object.assign({
    number: 2811,
    state: "OPEN",
    projectItems: [
      { id: "PVT_item_backlog", status: { name: "Backlog" } },
      { id: "PVT_item_ready", status: { name: "Ready for development" } },
    ],
  }, overrides || {});
}

function input(overrides) {
  var source = recipe();
  return Object.assign({
    policy: policy(),
    projectRef: { projectId: PROJECT },
    recipe: { id: source.id, digest: policyModule.recipeDigest(source), kind: "issue" },
    item: issue(),
    itemKey: "trialview/v2#2811",
    itemClass: "bug",
    assignedToOwner: true,
    recipeAllowsUnassigned: false,
    now: 1000,
  }, overrides || {});
}

function configuredPolicy() {
  var value = policy();
  value.qualification = {
    version: 2,
    normalIssueIntake: {
      issueStates: ["open"],
      boardStatuses: ["Backlog", "Ready for development"],
      requireAllBoardItems: true,
      assignment: "owner",
      classification: { autonomous: ["bug"], ownerApproval: ["feature", "ambiguous"] },
      configuredBoard: { projectId: "PVT_unified", statusFieldId: "PVTSSF_unified_status" },
    },
  };
  value.digest = policyModule.policyDigest(value);
  return value;
}

function configuredIssue(overrides) {
  return Object.assign({
    number: 2811,
    state: "OPEN",
    projectItems: [
      { id: "PVTI_unified_backlog", projectId: "PVT_unified",
        status: { name: "Backlog", fieldId: "PVTSSF_unified_status" } },
      { id: "PVTI_planning", projectId: "PVT_planning", status: null },
    ],
  }, overrides || {});
}

function configuredInput(overrides) {
  return Object.assign({}, input({ policy: configuredPolicy(), item: configuredIssue() }), overrides || {});
}

function urbanStayAllIssuesRecipe() {
  return {
    id: "all-issues",
    source: { provider: "github", kind: "issue", repo: "bojanx100/urban-stay-web",
      fetchLimit: 100, ghAccount: "bojanx100" },
    filter: { state: "open", assigned: "any" },
  };
}

function noBoardRecipePolicy() {
  var source = urbanStayAllIssuesRecipe();
  var value = policy();
  value.qualification = {
    version: 3,
    normalIssueIntake: {
      issueStates: ["open"],
      boardStatuses: [],
      requireAllBoardItems: false,
      assignment: "recipe",
      recipeAllowsUnassigned: true,
      classification: { autonomous: ["bug"], ownerApproval: ["feature", "ambiguous"] },
    },
  };
  value.recipes = [{ id: source.id, kind: "issue", repo: "bojanx100/urban-stay-web", type: "",
    digest: policyModule.recipeDigest(source) }];
  value.digest = policyModule.policyDigest(value);
  return value;
}

function noBoardRecipeInput(overrides) {
  var source = urbanStayAllIssuesRecipe();
  return Object.assign({
    policy: noBoardRecipePolicy(),
    projectRef: { projectId: PROJECT },
    recipe: { id: source.id, digest: policyModule.recipeDigest(source), kind: "issue" },
    item: { number: 198, state: "OPEN" },
    itemKey: "bojanx100/urban-stay-web#198",
    itemClass: "bug",
    assignedToOwner: false,
    recipeAllowsUnassigned: taskSources.recipeAllowsUnassigned(source, {}),
    now: 1000,
  }, overrides || {});
}

test("qualification receipt binds fresh open issue, every board item, policy, recipe, and bug rule", function () {
  var created = qualification.receiptFor(input());
  assert.equal(created.ok, true, created.reason);
  assert.deepEqual(created.receipt.item.boardItems, [
    { id: "PVT_item_backlog", status: "backlog" },
    { id: "PVT_item_ready", status: "ready for development" },
  ]);
  assert.equal(created.receipt.classification.admission, "auto");
  assert.deepEqual(created.receipt.coordinator.reasons, [
    "issue_state_open", "all_board_items_allowed", "assigned_to_owner", "classification_bug_autonomous",
  ]);
  assert.equal(qualification.verifyReceipt(created.receipt, {
    policy: input().policy, now: 1001,
  }).ok, true);
});

test("an explicit recipe/no-board policy admits only Urban Stay's exact all-issues recipe", function () {
  var source = noBoardRecipeInput();
  assert.equal(policyModule.recipeDigest(urbanStayAllIssuesRecipe()),
    "21adf1651784d5a3654cab045b2ab9259676380c4d44c12ac57c2093300ba325");
  assert.equal(taskSources.recipeAllowsUnassigned(urbanStayAllIssuesRecipe(), {}), true);
  var created = qualification.receiptFor(source);
  assert.equal(created.ok, true, created.reason);
  assert.deepEqual(created.receipt.item.boardItems, []);
  assert.deepEqual(created.receipt.assignment, {
    required: "recipe", assignedToOwner: false, recipeAllowsUnassigned: true,
  });
  assert.ok(created.receipt.coordinator.reasons.indexOf("no_board_required") !== -1);
  assert.ok(created.receipt.coordinator.reasons.indexOf("recipe_allows_unassigned") !== -1);
  assert.equal(qualification.verifyReceipt(created.receipt, {
    policy: source.policy,
    candidate: {
      itemKey: source.itemKey,
      policyDigest: source.policy.digest,
      recipeId: source.recipe.id,
      itemClass: source.itemClass,
      projectRef: source.projectRef,
      eligibility: { assignedToOwner: false, recipeAllowsUnassigned: true },
      admission: "auto",
    },
    now: 1001,
  }).ok, true);
});

test("recipe/no-board qualification rejects missing policy, invalid policy, and broadened recipes", function () {
  assert.equal(qualification.receiptFor(noBoardRecipeInput({ policy: null })).reason,
    "qualification_policy_missing");

  var invalid = noBoardRecipePolicy();
  invalid.qualification.normalIssueIntake.boardStatuses = ["Backlog"];
  invalid.digest = policyModule.policyDigest(invalid);
  assert.equal(qualification.receiptFor(noBoardRecipeInput({ policy: invalid })).reason,
    "qualification_policy_missing");

  assert.equal(qualification.receiptFor(noBoardRecipeInput({
    recipeAllowsUnassigned: taskSources.recipeAllowsUnassigned(recipe(), {}),
  })).reason, "qualification_assignment_required");

  var broadened = urbanStayAllIssuesRecipe();
  delete broadened.filter.state;
  assert.equal(qualification.receiptFor(noBoardRecipeInput({
    recipe: { id: broadened.id, digest: policyModule.recipeDigest(broadened), kind: "issue" },
    recipeAllowsUnassigned: taskSources.recipeAllowsUnassigned(broadened, {}),
  })).reason, "qualification_recipe_mismatch");
});

test("recipe/no-board qualification rejects present or malformed Webapp board evidence", function () {
  var ineligible = qualification.receiptFor(noBoardRecipeInput({
    item: { number: 198, state: "OPEN", projectItems: [{
      id: "PVTI_unified_dev_complete",
      status: { name: "Dev Complete", fieldId: "PVTSSF_unified_status" },
    }] },
  }));
  assert.equal(ineligible.reason, "qualification_board_status_ineligible");

  var malformed = qualification.receiptFor(noBoardRecipeInput({
    item: { number: 198, state: "OPEN", projectItems: [{}] },
  }));
  assert.equal(malformed.reason, "qualification_board_evidence_missing");
});

test("recipe/no-board receipt verification rechecks the classification rule", function () {
  var source = noBoardRecipeInput();
  var created = qualification.receiptFor(source);
  assert.equal(created.ok, true, created.reason);
  var forged = JSON.parse(JSON.stringify(created.receipt));
  forged.classification = { itemClass: "bug", admission: "owner_approval", rule: "owner_approval" };
  forged.approval = { required: true, ownerApproved: false };
  var subject = {};
  Object.keys(forged).forEach(function (key) {
    if (key !== "digest") subject[key] = forged[key];
  });
  forged.digest = crypto.createHash("sha256")
    .update(JSON.stringify(canonical(subject))).digest("hex");
  assert.equal(qualification.verifyReceipt(forged, { policy: source.policy, now: 1001 }).reason,
    "qualification_receipt_policy_stale");
});

test("qualification fails closed when any required issue or board fact is absent or disallowed", function () {
  var cases = [{
    name: "closed issue",
    input: input({ item: issue({ state: "CLOSED" }) }),
    reason: "qualification_issue_state_ineligible",
  }, {
    name: "missing board item identity",
    input: input({ item: issue({ projectItems: [{ status: { name: "Backlog" } }] }) }),
    reason: "qualification_board_evidence_missing",
  }, {
    name: "in progress board item",
    input: input({ item: issue({ projectItems: [{ id: "PVT_item_progress", status: { name: "In progress" } }] }) }),
    reason: "qualification_board_status_ineligible",
  }, {
    name: "unassigned item",
    input: input({ assignedToOwner: false }),
    reason: "qualification_assignment_required",
  }, {
    name: "unapproved classification",
    input: input({ itemClass: "pr_review" }),
    reason: "qualification_classification_unapproved",
  }];
  for (var i = 0; i < cases.length; i++) {
    var result = qualification.receiptFor(cases[i].input);
    assert.equal(result.ok, false, cases[i].name);
    assert.equal(result.reason, cases[i].reason, cases[i].name);
  }
});

test("configured Webapp-board receipts bind Status and reject ineligible current status", function () {
  var created = qualification.receiptFor(configuredInput());
  assert.equal(created.ok, true, created.reason);
  assert.equal(created.receipt.policy.version, 2);
  assert.deepEqual(created.receipt.item.boardItems, [{
    id: "PVTI_unified_backlog",
    projectId: "PVT_unified",
    status: "backlog",
    statusFieldId: "PVTSSF_unified_status",
  }]);
  assert.ok(created.receipt.coordinator.reasons.indexOf("configured_board_items_allowed") !== -1);
  assert.equal(qualification.verifyReceipt(created.receipt, {
    policy: configuredInput().policy, now: 1001,
  }).ok, true);

  var wrongField = qualification.receiptFor(configuredInput({
    item: configuredIssue({ projectItems: [{ id: "PVTI_unified_backlog", projectId: "PVT_unified",
      status: { name: "Backlog", fieldId: "PVTSSF_wrong" } }] }),
  }));
  assert.equal(wrongField.reason, "qualification_board_evidence_missing");

  var ineligibleStatus = qualification.receiptFor(configuredInput({
    item: configuredIssue({ projectItems: [{ id: "PVTI_unified_dev_complete", projectId: "PVT_unified",
      status: { name: "Dev Complete", fieldId: "PVTSSF_unified_status" } }] }),
  }));
  assert.equal(ineligibleStatus.reason, "qualification_board_status_ineligible");

  var conflicting = qualification.receiptFor(configuredInput({
    item: configuredIssue({ projectItems: [
      { id: "PVTI_unified_duplicate", projectId: "PVT_unified",
        status: { name: "Backlog", fieldId: "PVTSSF_unified_status" } },
      { id: "PVTI_unified_duplicate", projectId: "PVT_unified",
        status: { name: "Ready for development", fieldId: "PVTSSF_unified_status" } },
    ] }),
  }));
  assert.equal(conflicting.reason, "qualification_board_evidence_missing");

  var changedPolicy = configuredPolicy();
  changedPolicy.qualification.normalIssueIntake.configuredBoard.projectId = "PVT_wrong";
  changedPolicy.digest = policyModule.policyDigest(changedPolicy);
  assert.equal(qualification.verifyReceipt(created.receipt, {
    policy: changedPolicy, now: 1001,
  }).reason, "qualification_receipt_policy_stale");
});

test("launch-time requalification rejects post-development and reassigned issues", function () {
  var movedToDevComplete = qualification.requalifyAtLaunch(input({
    item: issue({ projectItems: [{ id: "PVT_item_dev_complete", status: { name: "Dev Complete" } }] }),
  }));
  assert.equal(movedToDevComplete.ok, false);
  assert.equal(movedToDevComplete.reason, "qualification_board_status_ineligible");

  var reassigned = qualification.requalifyAtLaunch(input({ assignedToOwner: false }));
  assert.equal(reassigned.ok, false);
  assert.equal(reassigned.reason, "qualification_assignment_required");
});

test("auto-launch re-reads board status before starting an issue", async function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-launch-qualification-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: { enabled: true, recipeId: "assigned-to-me", recipes: ["assigned-to-me"] },
  }));
  var source = recipe();
  var launchCount = 0;
  var fetchCount = 0;
  var fetchArgs = [];
  var launcher = {
    loadRecipe: function () { return source; },
    findExistingSessionForItem: function () { return null; },
    findAnyLiveSessionForItem: function () { return null; },
    findAnyVisibleSessionForItem: function () { return null; },
    startSessionForItem: function () {
      launchCount++;
      return { localId: 1 };
    },
  };
  var autoLaunch = attachAutoLaunch({
    cwd: cwd,
    sm: { sessions: new Map(), broadcastSessionList: function () {} },
    getLeadMode: function () { return true; },
    getTaskLauncher: function () { return launcher; },
    automationGate: {
      refresh: function () { return { ok: true, policy: configuredPolicy() }; },
      evaluateLaunch: function () { return { decision: "execute" }; },
    },
    fetchItems: function (fetchCwd, fetchRecipe, args) {
      fetchCount++;
      fetchArgs.push(args);
      var current = configuredIssue(fetchCount === 1 ? {} : {
        projectItems: [{ id: "PVTI_unified_dev_complete", projectId: "PVT_unified",
          status: { name: "Dev Complete", fieldId: "PVTSSF_unified_status" } }],
      });
      current.assignedToOwner = true;
      return [current];
    },
  });

  try {
    var result = await autoLaunch.launchScheduled("assigned-to-me");
    assert.equal(fetchCount, 2, "the launch boundary must use a fresh issue read");
    assert.deepEqual(fetchArgs.map(function (value) { return value.qualificationBoard; }), [
      { projectId: "PVT_unified", statusFieldId: "PVTSSF_unified_status" },
      { projectId: "PVT_unified", statusFieldId: "PVTSSF_unified_status" },
    ], "both scheduler collection and launch requalification receive the typed board identity");
    assert.equal(launchCount, 0, "a current Dev Complete status must block launch");
    assert.equal(result.skipped.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("receipt expiry and policy drift cannot be replayed into a later binding", function () {
  var source = input();
  var receipt = qualification.receiptFor(source).receipt;
  assert.equal(qualification.verifyReceipt(receipt, {
    policy: source.policy,
    now: receipt.evidenceAt + qualification.MAX_RECEIPT_AGE_MS + 1,
  }).reason, "qualification_receipt_stale");

  var changedPolicy = policy();
  changedPolicy.qualification.normalIssueIntake.boardStatuses = ["backlog"];
  changedPolicy.digest = policyModule.policyDigest(changedPolicy);
  assert.equal(qualification.verifyReceipt(receipt, {
    policy: changedPolicy, now: receipt.evidenceAt + 1,
  }).reason, "qualification_receipt_policy_stale");
});
