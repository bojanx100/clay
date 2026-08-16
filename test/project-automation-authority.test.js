// Tests for the project automation authority — the decision point that
// governs what legacy project automation may do once Coop owns routing.
//
// The invariants under test are safety properties, not preferences: no
// duplicate launch without a claim, no externally visible action without
// claim + completion evidence + approval, fail-closed on policy failure, and
// an exact pass-through when Lead mode is off.
var test = require("node:test");
var assert = require("node:assert");

var authority = require("../lib/project-automation-authority");

var NOW = 1785700000000;
var PROJECT_ID = "3f2a1b4c-5d6e-4f70-8912-a3b4c5d6e7f8";
var HOLDER = "autolaunch:clay:tick-1";

function policy(overrides) {
  return Object.assign({
    projectRef: { projectId: PROJECT_ID },
    derived: true,
    autonomy: { bug: "propose", feature: "propose", ambiguous: "propose", pr_review: "propose", default: "propose" },
    externalActions: { comment: "approval", done_workflow: "approval", merge: "approval", close: "approval" },
    boardExclusions: [],
    providerRules: { vendors: {} },
    recipes: [],
    sources: [],
    digest: "digest-1",
  }, overrides || {});
}

function liveClaim(overrides) {
  return Object.assign({ held: true, holder: HOLDER, expiresAt: NOW + 60000 }, overrides || {});
}

function completed(overrides) {
  return Object.assign({
    status: "completed",
    summary: "fixed the crash",
    verification: "node --test passed 1171/1171",
    escalationRequired: "no",
  }, overrides || {});
}

// Ownership defaults to PROVEN here so the stance, claim and external-action
// tests below keep testing what they are about. Automatic pickup requires work
// assigned to the owner, and that precondition has its own dedicated tests in
// the "Ownership" section — every one of which sets this explicitly.
function decide(overrides) {
  return authority.decideAutomation(Object.assign({
    leadMode: true,
    action: "launch",
    policy: policy(),
    holder: HOLDER,
    assignedToOwner: true,
    now: NOW,
  }, overrides || {}));
}

// --- Lead mode off: exact legacy pass-through -------------------------------

test("lead mode off passes every action through as legacy behavior", function () {
  var actions = ["discover", "launch", "external"];
  for (var i = 0; i < actions.length; i++) {
    var out = authority.decideAutomation({
      leadMode: false,
      action: actions[i],
      externalKind: "merge",
      now: NOW,
    });
    assert.strictEqual(out.decision, "execute", actions[i] + " must pass through");
    assert.strictEqual(out.reason, "lead_mode_off_legacy");
    assert.strictEqual(out.audit.legacy, true);
  }
});

test("lead mode off needs no policy at all", function () {
  var out = authority.decideAutomation({
    leadMode: false, action: "launch", policyError: "policy_malformed", now: NOW,
  });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "lead_mode_off_legacy");
});

// --- Discovery survives the cutover -----------------------------------------

test("discovery is allowed with lead mode on, even when policy failed to load", function () {
  var out = decide({ action: "discover", policy: null, policyError: "policy_malformed" });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "discovery_always_allowed");
});

// --- Fail-closed on policy failure ------------------------------------------

test("launch and external fail closed when the project policy cannot be loaded", function () {
  var reasons = ["policy_malformed", "policy_unreadable", "invalid_project_ref"];
  for (var i = 0; i < reasons.length; i++) {
    var launch = decide({ action: "launch", policy: null, policyError: reasons[i] });
    assert.strictEqual(launch.decision, "deny");
    assert.strictEqual(launch.reason, reasons[i]);
    assert.strictEqual(launch.audit.failClosed, true);

    var external = decide({
      action: "external", externalKind: "merge", policy: null, policyError: reasons[i],
      claim: liveClaim(), completion: completed(), approval: { granted: true, by: "owner" },
    });
    assert.strictEqual(external.decision, "deny", reasons[i] + " must deny external");
  }
});

test("a missing policy denies rather than defaulting to permissive", function () {
  var out = decide({ policy: null });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "policy_unavailable");
});

test("a policy carrying an unusable ProjectRef is rejected", function () {
  var out = decide({ policy: policy({ projectRef: { projectId: "not-a-project-id" } }) });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "invalid_project_ref");
});

test("an unknown action is denied", function () {
  var out = decide({ action: "merge-everything" });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "invalid_action");
});

test("an unrecognized autonomy stance never widens authority", function () {
  var out = decide({
    itemClass: "bug",
    policy: policy({ autonomy: { bug: "yolo", default: "propose" } }),
    claim: liveClaim(),
  });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "policy_malformed_stance");
});

// --- Launch: propose is the default under Coop -------------------------------

test("legacy automation may only propose when policy says propose", function () {
  var out = decide({ itemClass: "bug", claim: liveClaim() });
  assert.strictEqual(out.decision, "propose");
  assert.strictEqual(out.reason, "policy_requires_proposal");
});

test("an unknown item class falls back to the policy default, not to autonomy", function () {
  var out = decide({
    itemClass: "something-new",
    policy: policy({ autonomy: { bug: "autonomous", default: "propose" } }),
    claim: liveClaim(),
  });
  assert.strictEqual(out.decision, "propose");
});

test("policy may deny a class outright", function () {
  var out = decide({
    itemClass: "feature",
    policy: policy({ autonomy: { feature: "deny", default: "propose" } }),
    claim: liveClaim(),
  });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "policy_denies_class");
});

// --- Preserved autonomy still requires a unique unexpired claim --------------

test("autonomous class executes only while holding a live claim", function () {
  var autonomous = policy({ autonomy: { bug: "autonomous", default: "propose" } });
  var out = decide({ itemClass: "bug", policy: autonomous, claim: liveClaim() });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "policy_autonomous");
});

test("autonomous class is denied without a claim — no duplicate launch", function () {
  var autonomous = policy({ autonomy: { bug: "autonomous", default: "propose" } });
  var out = decide({ itemClass: "bug", policy: autonomous, claim: null });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "claim_required");
});

test("an expired or foreign claim is not a claim", function () {
  var autonomous = policy({ autonomy: { bug: "autonomous", default: "propose" } });
  var expired = decide({ itemClass: "bug", policy: autonomous, claim: liveClaim({ expiresAt: NOW }) });
  assert.strictEqual(expired.reason, "claim_required", "expiry is exclusive");

  var foreign = decide({ itemClass: "bug", policy: autonomous, claim: liveClaim({ holder: "another-tick" }) });
  assert.strictEqual(foreign.reason, "claim_required", "another holder's lease is not ours");

  var unheld = decide({ itemClass: "bug", policy: autonomous, claim: liveClaim({ held: false }) });
  assert.strictEqual(unheld.reason, "claim_required");
});

// --- Owner-gated capability work --------------------------------------------

test("owner_approval work proposes and flags approval until it is granted", function () {
  var gated = policy({ autonomy: { feature: "owner_approval", default: "propose" } });
  var out = decide({ itemClass: "feature", policy: gated, claim: liveClaim() });
  assert.strictEqual(out.decision, "propose");
  assert.strictEqual(out.reason, "owner_approval_required");
  assert.strictEqual(out.requiresApproval, true);
});

test("approved capability work still cannot skip the claim", function () {
  var gated = policy({ autonomy: { feature: "owner_approval", default: "propose" } });
  var noClaim = decide({
    itemClass: "feature", policy: gated, approval: { granted: true, by: "owner" },
  });
  assert.strictEqual(noClaim.decision, "deny");
  assert.strictEqual(noClaim.reason, "claim_required");

  var withClaim = decide({
    itemClass: "feature", policy: gated, approval: { granted: true, by: "owner" }, claim: liveClaim(),
  });
  assert.strictEqual(withClaim.decision, "execute");
  assert.strictEqual(withClaim.reason, "owner_approved");
});

test("an approval without an approver is not an approval", function () {
  var gated = policy({ autonomy: { feature: "owner_approval", default: "propose" } });
  var out = decide({
    itemClass: "feature", policy: gated, claim: liveClaim(), approval: { granted: true },
  });
  assert.strictEqual(out.decision, "propose");
  assert.strictEqual(out.reason, "owner_approval_required");
});

// --- Externally visible / destructive actions --------------------------------

function externalDecision(overrides) {
  return decide(Object.assign({
    action: "external",
    externalKind: "merge",
    claim: liveClaim(),
    completion: completed(),
    approval: { granted: true, by: "owner" },
  }, overrides || {}));
}

test("a fully authorized external action executes", function () {
  var out = externalDecision();
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "external_action_authorized");
});

test("every external kind is gated the same way", function () {
  var kinds = ["comment", "merge", "close"];
  for (var i = 0; i < kinds.length; i++) {
    assert.strictEqual(externalDecision({ externalKind: kinds[i] }).decision, "execute");
    assert.strictEqual(externalDecision({ externalKind: kinds[i], claim: null }).reason, "claim_required");
  }
});

test("an unknown external kind is denied", function () {
  var out = externalDecision({ externalKind: "force-push" });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "invalid_external_kind");
});

test("no external action without a unique unexpired claim", function () {
  assert.strictEqual(externalDecision({ claim: null }).reason, "claim_required");
  assert.strictEqual(externalDecision({ claim: liveClaim({ expiresAt: NOW - 1 }) }).reason, "claim_required");
  assert.strictEqual(externalDecision({ claim: liveClaim({ holder: "someone-else" }) }).reason, "claim_required");
});

test("no external action without project completion evidence", function () {
  assert.strictEqual(externalDecision({ completion: null }).reason, "completion_evidence_required");
  assert.strictEqual(
    externalDecision({ completion: completed({ status: "pending" }) }).reason,
    "completion_evidence_required");
  assert.strictEqual(
    externalDecision({ completion: completed({ summary: "" }) }).reason,
    "completion_evidence_required");
  assert.strictEqual(
    externalDecision({ completion: completed({ verification: "  " }) }).reason,
    "completion_evidence_required");
  assert.strictEqual(
    externalDecision({ completion: completed({ escalationRequired: "yes" }) }).reason,
    "completion_evidence_required");
});

test("no external action without the configured approval", function () {
  var out = externalDecision({ approval: null });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "approval_required");
  assert.strictEqual(out.requiresApproval, true);
});

test("policy may downgrade an external action to claim-only", function () {
  var claimOnly = policy({ externalActions: { comment: "claim", merge: "approval", close: "approval" } });
  var out = externalDecision({ externalKind: "comment", policy: claimOnly, approval: null });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.requiresApproval, false);
});

test("policy may forbid an external action entirely", function () {
  var denied = policy({ externalActions: { comment: "approval", merge: "deny", close: "approval" } });
  var out = externalDecision({ policy: denied });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "policy_denies_external_action");
});

test("an external kind missing from policy is denied, not defaulted", function () {
  var partial = policy({ externalActions: { comment: "approval" } });
  var out = externalDecision({ externalKind: "close", policy: partial });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "policy_denies_external_action");
});

test("the claim is checked before completion and approval so the audit names the first gap", function () {
  var out = externalDecision({ claim: null, completion: null, approval: null });
  assert.strictEqual(out.reason, "claim_required");
});

// --- The owner-triggered carve-out (deliberately narrow) ---------------------

test("an owner-triggered comment may proceed without completion evidence", function () {
  var out = externalDecision({
    externalKind: "comment", ownerTriggered: true, completion: null,
  });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "owner_triggered_external");
  assert.strictEqual(out.audit.ownerTriggered, true);
});

// The Done workflow grants comment + PR un-draft + board move. Filing it under
// "comment" understated it and would let a project that permitted comments
// unknowingly permit PR and board mutation, so it has its own kind.
test("the done workflow is a distinct kind, not a comment", function () {
  var out = externalDecision({
    externalKind: "done_workflow", ownerTriggered: true, completion: null,
  });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "owner_triggered_external");
  assert.strictEqual(out.audit.externalKind, "done_workflow");

  // Permitting comments must NOT imply permitting the Done workflow.
  var commentOnly = policy({
    externalActions: { comment: "claim", done_workflow: "deny", merge: "approval", close: "approval" },
  });
  var blocked = externalDecision({
    externalKind: "done_workflow", ownerTriggered: true, completion: null, policy: commentOnly,
  });
  assert.strictEqual(blocked.decision, "deny");
  assert.strictEqual(blocked.reason, "policy_denies_external_action");
});

test("the done workflow still requires a live claim", function () {
  assert.strictEqual(externalDecision({
    externalKind: "done_workflow", ownerTriggered: true, completion: null, claim: null,
  }).reason, "claim_required");
  assert.strictEqual(externalDecision({
    externalKind: "done_workflow", ownerTriggered: true, completion: null,
    claim: liveClaim({ expiresAt: NOW - 1 }),
  }).reason, "claim_required");
});

test("the done workflow is not owner-granted without an owner", function () {
  assert.strictEqual(externalDecision({
    externalKind: "done_workflow", ownerTriggered: false, completion: null,
  }).reason, "completion_evidence_required");
});

test("the carve-out never extends to merge or close", function () {
  var kinds = ["merge", "close"];
  for (var i = 0; i < kinds.length; i++) {
    var out = externalDecision({
      externalKind: kinds[i], ownerTriggered: true, completion: null,
    });
    assert.strictEqual(out.decision, "deny", kinds[i] + " must still need evidence");
    assert.strictEqual(out.reason, "completion_evidence_required");
  }
});

test("the carve-out still requires a claim and a real approver", function () {
  assert.strictEqual(externalDecision({
    externalKind: "comment", ownerTriggered: true, completion: null, claim: null,
  }).reason, "claim_required");

  assert.strictEqual(externalDecision({
    externalKind: "comment", ownerTriggered: true, completion: null, approval: null,
  }).reason, "completion_evidence_required");
});

test("the carve-out cannot revive an action the project policy forbids", function () {
  var denied = policy({ externalActions: { comment: "deny", merge: "approval", close: "approval" } });
  var out = externalDecision({
    externalKind: "comment", ownerTriggered: true, completion: null, policy: denied,
  });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "policy_denies_external_action");
});

// --- Classification ----------------------------------------------------------

test("PR-review work is classified by source kind, never by its labels", function () {
  var item = { labels: [{ name: "bug" }] };
  assert.strictEqual(authority.classifyAutomationItem(item, "pr-reviews"), "pr_review");
  assert.strictEqual(authority.classifyAutomationItem(item, "pr_review"), "pr_review");
});

test("feature and legacy labels outrank a bug label", function () {
  assert.strictEqual(
    authority.classifyAutomationItem({ labels: ["Bug", "Feature"] }, "issue"), "feature");
  assert.strictEqual(
    authority.classifyAutomationItem({ labels: ["bug", "legacy"] }, "issue"), "feature");
});

test("a decisive bug label classifies as bug", function () {
  assert.strictEqual(authority.classifyAutomationItem({ labels: [{ name: "BUG" }] }, "issue"), "bug");
});

test("an unlabeled item is ambiguous capability work, never a bug", function () {
  assert.strictEqual(authority.classifyAutomationItem({ labels: [] }, "issue"), "ambiguous");
  assert.strictEqual(authority.classifyAutomationItem({}, null), "ambiguous");
});

// The idle-board regression. project-automation-policy.deriveAutonomy grants
// `bug: autonomous` on the evidence that a recipe declares `filter.type: "bug"`,
// but that filter works by EXCLUDING feature/legacy labels rather than requiring
// a `bug` one — so the launcher legitimately returns unlabeled bug work. While
// classification read labels alone, every one of those items became "ambiguous"
// -> owner_approval, and the grant the project's own policy made could never be
// reached by the recipe that earned it. The board stayed idle indefinitely.
test("an unlabeled item from a bug-scoped recipe is bug work, not ambiguous", function () {
  assert.strictEqual(
    authority.classifyAutomationItem({ labels: [] }, "issue", "bug"), "bug");
  assert.strictEqual(
    authority.classifyAutomationItem({}, "issue", "bug"), "bug");
});

test("a feature-scoped or legacy-scoped recipe classifies its unlabeled work as feature", function () {
  assert.strictEqual(
    authority.classifyAutomationItem({ labels: [] }, "issue", "feature"), "feature");
  assert.strictEqual(
    authority.classifyAutomationItem({ labels: [] }, "issue", "legacy"), "feature");
});

// The recipe's scope is a fallback for an item that says nothing about itself.
// An item that DOES carry a decisive label still decides its own class, and
// still fails toward the stricter one, so a bug-scoped recipe can never
// reclassify capability work as an autonomous bug.
test("an item's own label outranks the scope its recipe declares", function () {
  assert.strictEqual(
    authority.classifyAutomationItem({ labels: ["feature"] }, "issue", "bug"), "feature");
  assert.strictEqual(
    authority.classifyAutomationItem({ labels: ["legacy"] }, "issue", "bug"), "feature");
});

// Recipe scope must never reach PR-lifecycle work: source kind is still first.
test("recipe scope cannot promote pr-review work out of its own class", function () {
  assert.strictEqual(
    authority.classifyAutomationItem({ labels: [] }, "pr-reviews", "bug"), "pr_review");
});

// An unscoped recipe grants nothing, so its work stays owner-gated. This is the
// half of the fix that keeps it from widening authority for any other project.
test("an unscoped recipe leaves unlabeled work ambiguous", function () {
  assert.strictEqual(authority.classifyAutomationItem({ labels: [] }, "issue", ""), "ambiguous");
  assert.strictEqual(authority.classifyAutomationItem({ labels: [] }, "issue", null), "ambiguous");
  assert.strictEqual(
    authority.classifyAutomationItem({ labels: [] }, "issue", "something-else"), "ambiguous");
});

// --- Ownership ---------------------------------------------------------------
//
// Automatic pickup requires work the owner has already taken on. This is an
// eligibility precondition rather than a policy stance, so it is checked before
// any stance and no stance can satisfy it — which is what stops a project's own
// `bug: autonomous` grant from reaching work nobody was assigned.

test("unassigned work is denied even where the project grants autonomy", function () {
  var out = decide({
    action: "launch", itemClass: "bug", itemKey: "trialview/v2#2539",
    policy: policy({ autonomy: { bug: "autonomous", default: "propose" } }),
    claim: liveClaim(), assignedToOwner: false,
  });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "not_assigned_to_owner");
});

test("an explicit recipe any-policy can advance unassigned work to its own project policy", function () {
  var out = decide({
    action: "launch", itemClass: "bug", itemKey: "urban-stay#198",
    policy: policy({ autonomy: { bug: "autonomous", default: "propose" } }),
    claim: liveClaim(), assignedToOwner: false, recipeAllowsUnassigned: true,
  });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "policy_autonomous");
  assert.strictEqual(out.audit.assignedToOwner, false);
  assert.strictEqual(out.audit.recipeAllowsUnassigned, true);
});

// Unproven is not the same as assigned. A missing stamp means the fetch layer
// could not establish ownership, and that must fail closed.
test("ownership must be proven, never assumed from a missing or loose value", function () {
  var probes = [undefined, null, "", 0, "yes", 1, {}];
  for (var i = 0; i < probes.length; i++) {
    var out = decide({
      action: "launch", itemClass: "bug", itemKey: "trialview/v2#1",
      claim: liveClaim(), assignedToOwner: probes[i],
    });
    assert.strictEqual(out.decision, "deny",
      "probe " + JSON.stringify(probes[i]) + " must not prove ownership");
    assert.strictEqual(out.reason, "not_assigned_to_owner");
  }
});

test("assigned autonomous work is still executable", function () {
  var out = decide({
    action: "launch", itemClass: "bug", itemKey: "trialview/v2#1",
    policy: policy({ autonomy: { bug: "autonomous", default: "propose" } }),
    claim: liveClaim(), assignedToOwner: true,
  });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "policy_autonomous");
});

// Ownership is checked first, so the audit reason names the real reason the
// item was refused rather than a downstream one.
test("ownership is refused before the policy stance is consulted", function () {
  var denied = decide({
    action: "launch", itemClass: "bug", itemKey: "trialview/v2#1",
    claim: null, assignedToOwner: false,
  });
  assert.strictEqual(denied.reason, "not_assigned_to_owner",
    "an unassigned item must not be reported as merely missing a claim");
});

// PR-review work carries ownership in its class: the source only returns PRs the
// owner authored or committed to, and the class is owner-gated by derivation.
test("pr-review work is not blocked by the board assignment rule", function () {
  var out = decide({
    action: "launch", itemClass: "pr_review", itemKey: "trialview/v2#2591",
    claim: liveClaim(), assignedToOwner: false,
  });
  assert.notStrictEqual(out.reason, "not_assigned_to_owner");
});

// Lead mode OFF is the legacy pass-through and is checked before anything else,
// so the pure authority still short-circuits. The launcher enforces ownership in
// that mode instead — see the auto-launch suite.
test("lead mode off remains a pure pass-through regardless of assignment", function () {
  var out = decide({
    leadMode: false, action: "launch", itemClass: "bug", assignedToOwner: false,
  });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "lead_mode_off_legacy");
});

test("the audit record carries the ownership proof it decided on", function () {
  var out = decide({
    action: "launch", itemClass: "bug", itemKey: "trialview/v2#1",
    claim: liveClaim(), assignedToOwner: true,
  });
  assert.strictEqual(out.audit.assignedToOwner, true);
  var denied = decide({
    action: "launch", itemClass: "bug", itemKey: "trialview/v2#2539",
    claim: liveClaim(), assignedToOwner: false,
  });
  assert.strictEqual(denied.audit.assignedToOwner, false);
});

// --- Audit -------------------------------------------------------------------

test("every decision carries an audit record identifying policy and project", function () {
  var out = decide({ itemClass: "bug", itemKey: "trialview/v2#2507", claim: liveClaim() });
  assert.strictEqual(out.audit.type, "project_automation_decision");
  assert.strictEqual(out.audit.action, "launch");
  assert.strictEqual(out.audit.decision, "propose");
  assert.strictEqual(out.audit.projectId, PROJECT_ID);
  assert.strictEqual(out.audit.itemClass, "bug");
  assert.strictEqual(out.audit.itemKey, "trialview/v2#2507");
  assert.strictEqual(out.audit.policyDigest, "digest-1");
  assert.strictEqual(out.audit.policyDerived, true);
  assert.strictEqual(out.audit.leadMode, true);
  assert.strictEqual(out.audit.at, NOW);
});

test("two projects with different policies decide differently on the same item", function () {
  var autonomousProject = policy({
    projectRef: { projectId: PROJECT_ID },
    autonomy: { bug: "autonomous", default: "propose" },
    digest: "webapp",
  });
  var strictProject = policy({
    projectRef: { projectId: "11111111-2222-4333-8444-555555555555" },
    autonomy: { bug: "propose", default: "propose" },
    digest: "clay",
  });
  var item = { itemClass: "bug", claim: liveClaim() };
  assert.strictEqual(decide(Object.assign({ policy: autonomousProject }, item)).decision, "execute");
  assert.strictEqual(decide(Object.assign({ policy: strictProject }, item)).decision, "propose");
});

// A prototype key must not slip past an allowlist and skip a deny-by-default
// branch, in a module whose stated rule is that a bug never widens authority.
test("inherited object keys cannot pass the action, kind or class allowlists", function () {
  var prototypeKeys = ["constructor", "toString", "hasOwnProperty", "__proto__"];
  for (var i = 0; i < prototypeKeys.length; i++) {
    var action = authority.decideAutomation({
      leadMode: true, action: prototypeKeys[i], policy: policy(), holder: HOLDER, now: NOW,
    });
    assert.strictEqual(action.decision, "deny", prototypeKeys[i] + " is not an action");
    assert.strictEqual(action.reason, "invalid_action");

    var external = externalDecision({ externalKind: prototypeKeys[i] });
    assert.strictEqual(external.decision, "deny", prototypeKeys[i] + " is not an external kind");
    assert.strictEqual(external.reason, "invalid_external_kind");

    // An inherited class key must fall back to the default stance, not read
    // an inherited stance off the autonomy table.
    var launch = decide({
      itemClass: prototypeKeys[i],
      policy: policy({ autonomy: { default: "propose" } }),
      claim: liveClaim(),
    });
    assert.strictEqual(launch.decision, "propose", prototypeKeys[i] + " must use the default stance");
  }
});

test("decisions are pure — the same input always yields the same output", function () {
  var input = {
    leadMode: true, action: "launch", itemClass: "bug", policy: policy(),
    claim: liveClaim(), holder: HOLDER, now: NOW,
  };
  assert.deepStrictEqual(
    authority.decideAutomation(input), authority.decideAutomation(input));
});
