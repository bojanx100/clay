var test = require("node:test");
var assert = require("node:assert/strict");

var policyModule = require("../lib/project-automation-policy");
var qualification = require("../lib/project-automation-qualification");

var PROJECT = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

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
