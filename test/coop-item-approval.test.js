var test = require("node:test");
var assert = require("node:assert/strict");

var itemApproval = require("../lib/coop-item-approval");

var CLAY_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var ELIGIBILITY = "clay-lead-project-policy-eligibility";

function attention(taskId, at, extra) {
  return Object.assign({
    type: "staffing_attention",
    attentionKey: taskId + ":1",
    itemId: taskId,
    portfolioTaskId: taskId,
    bindingRevision: 1,
    at: at,
    seq: at,
  }, extra || {});
}

test("owner approval wording is recognized only in narrow referential forms", function () {
  var approval = itemApproval.explicitItemApproval;
  // The exact turn from live state that recorded no decision at all.
  assert.deepEqual(approval("approve eligibility fix"), { subject: "eligibility fix" });
  assert.deepEqual(approval("approved"), { subject: "" });
  assert.deepEqual(approval("approve it"), { subject: "" });
  assert.deepEqual(approval("ok, approve the eligibility fix"),
    { subject: "eligibility fix" });

  // Questions, deferrals and negations are not approvals.
  assert.equal(approval("did you approve the eligibility fix?"), null);
  assert.equal(approval("approve it tomorrow"), null);
  assert.equal(approval("do not approve that"), null);
  assert.equal(approval("don't approve the eligibility fix"), null);
  assert.equal(approval("approve it later"), null);
  assert.equal(approval("maybe approve the eligibility fix"), null);
  assert.equal(approval("if you approve it we can start"), null);
  // Must OPEN with the verb, so a narrative mention is not authorization.
  assert.equal(approval("i will approve eligibility fix"), null);
  assert.equal(approval("we should approve this"), null);
  assert.equal(approval(""), null);
});

test("a named approval binds the exact pending revision that was waiting", function () {
  var events = [
    attention(ELIGIBILITY, 1000),
    attention("clay-unrelated-telemetry", 1100),
  ];
  var snapshot = itemApproval.pendingApprovalSnapshotAt(events, 2000);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.tasks.length, 2);

  var resolved = itemApproval.resolveApprovedTask(snapshot, "eligibility fix");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.task.portfolioTaskId, ELIGIBILITY);
  assert.equal(resolved.task.bindingRevision, 1);
});

test("an item that started waiting after the approval can never be swept in", function () {
  // The owner spoke at 2000; this item only appeared at 3000.
  var snapshot = itemApproval.pendingApprovalSnapshotAt([
    attention(ELIGIBILITY, 3000),
  ], 2000);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(itemApproval.resolveApprovedTask(snapshot, "eligibility").reason,
    "owner_approval_no_pending_item");
});

test("an attention with no real timestamp cannot satisfy the ordering rule", function () {
  // Live state contains exactly this record: a staffing_attention written with
  // at: 0. Treated as a real timestamp it would be "before" every approval ever
  // made, including approvals that predate the item, which defeats the whole
  // point of snapshotting what was already waiting.
  [0, -1, null, undefined, NaN, "1000"].forEach(function (bad) {
    var snapshot = itemApproval.pendingApprovalSnapshotAt([
      attention(ELIGIBILITY, bad),
    ], 2000);
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.tasks.length, 0, "at=" + String(bad) + " must not qualify");
  });
});

test("a resolved attention is no longer approvable", function () {
  var snapshot = itemApproval.pendingApprovalSnapshotAt([
    attention(ELIGIBILITY, 1000),
    { type: "attention_resolved", attentionKey: ELIGIBILITY + ":1", at: 1500, seq: 1500 },
  ], 2000);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.tasks.length, 0);
});

test("an ambiguous approval refuses to pick a winner", function () {
  var events = [
    attention("clay-eligibility-policy-one", 1000),
    attention("clay-eligibility-policy-two", 1100),
  ];
  var snapshot = itemApproval.pendingApprovalSnapshotAt(events, 2000);
  // Two items both match "eligibility": picking either could staff work the
  // owner did not authorize, so neither is chosen.
  assert.equal(itemApproval.resolveApprovedTask(snapshot, "eligibility policy").reason,
    "owner_approval_ambiguous");
  // A bare "approved" with more than one item waiting is equally ambiguous.
  assert.equal(itemApproval.resolveApprovedTask(snapshot, "").reason,
    "owner_approval_ambiguous");
  // Generic words alone identify nothing, even against a single candidate.
  var single = itemApproval.pendingApprovalSnapshotAt([attention(ELIGIBILITY, 1000)], 2000);
  assert.equal(itemApproval.resolveApprovedTask(single, "the fix").ok, true,
    "a single waiting item is unambiguous even when the wording is generic");
  assert.equal(itemApproval.resolveApprovedTask(snapshot, "the fix").reason,
    "owner_approval_ambiguous");
});

test("a named approval cannot override spend, budget or destructive gates", function () {
  ["spendRequired", "budgetException", "destructive", "blocked"].forEach(function (gate) {
    var extra = {};
    extra[gate] = true;
    var snapshot = itemApproval.pendingApprovalSnapshotAt([
      attention(ELIGIBILITY, 1000, extra),
    ], 2000);
    assert.equal(snapshot.tasks.length, 0, gate + " must stay excluded");
  });

  // But requiresSpecificOwnerApproval is exactly what this path is for: the
  // queue-wide sweep excludes it, a named approval admits it.
  var named = itemApproval.pendingApprovalSnapshotAt([
    attention(ELIGIBILITY, 1000, { requiresSpecificOwnerApproval: true, queueEligible: false }),
  ], 2000);
  assert.equal(named.tasks.length, 1);
  assert.equal(itemApproval.resolveApprovedTask(named, "eligibility").ok, true);
});

function admissionHarness(overrides) {
  var options = overrides || {};
  var event = Object.assign({
    type: "user_message",
    text: "approve eligibility fix",
    coopIngressId: "coop:canonical-coop:455",
    coopComposerScope: "main",
    _ts: 2000,
  }, options.event || {});
  var entry = Object.assign({
    ingressId: "coop:canonical-coop:455",
    receivedAt: 2000,
    projectRefs: [],
    response: { state: "answered" },
  }, options.entry || {});
  return {
    ownerRequests: { get: function () { return entry; }, forTopic: function () { return [entry]; } },
    canonicalOwnerEvent: function () { return options.noEvent ? null : event; },
    readLeadEvents: function () {
      return options.events || [attention(ELIGIBILITY, 1000)];
    },
  };
}

test("execution admission verifies the approval link independently", function () {
  var request = {
    portfolioTaskId: ELIGIBILITY,
    bindingRevision: 1,
    targetProject: { projectId: CLAY_ID },
    mode: "project_coordinator",
  };
  var input = { coopApprovalIngressId: "coop:canonical-coop:455" };

  var admitted = itemApproval.executionAdmission(input, request, {}, admissionHarness());
  assert.equal(admitted.ok, true);
  assert.equal(admitted.itemApproval.attentionKey, ELIGIBILITY + ":1");
  assert.equal(admitted.itemApproval.ingressId, "coop:canonical-coop:455");

  // No cited approval leaves the existing fail-closed default in charge.
  assert.equal(itemApproval.executionAdmission({}, request, {}, admissionHarness()), null);

  // A different revision than the one that was pending is not covered.
  var bumped = Object.assign({}, request, { bindingRevision: 2 });
  assert.equal(itemApproval.executionAdmission(input, bumped, {}, admissionHarness()).reason,
    "owner_approval_task_mismatch");

  // A withdrawn approval stops authorizing.
  var superseded = admissionHarness({ entry: { response: { state: "superseded" } } });
  assert.equal(itemApproval.executionAdmission(input, request, {}, superseded).reason,
    "owner_implementation_decision_required");

  // Text that is not an approval cannot ride the approval path.
  var conversational = admissionHarness({ event: { text: "did you approve it?" } });
  assert.equal(itemApproval.executionAdmission(input, request, {}, conversational).reason,
    "owner_implementation_decision_required");

  // A project the owner request is scoped away from is refused.
  var otherProject = admissionHarness({
    entry: { projectRefs: [{ projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" }] },
  });
  assert.equal(itemApproval.executionAdmission(input, request, {}, otherProject).reason,
    "owner_implementation_project_mismatch");
});

test("a cutover attention is pending for approval just like a staffing attention", function () {
  var BOARD = "webapp-automation-policy-board-exclusions";
  // Live state re-recorded this item as cutover_attention rather than
  // staffing_attention. The snapshot used to skip that type outright, so the
  // item could never be approved by name, never minted an owner Thread, and
  // every dispatch failed thread_ref_required instead.
  var cutover = attention(BOARD, 1000, { type: "cutover_attention" });
  var snapshot = itemApproval.pendingApprovalSnapshotAt([cutover], 2000);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].portfolioTaskId, BOARD);

  // Both types share one attention key, so resolution still clears it and a
  // resolved item does not linger as approvable.
  var resolved = itemApproval.pendingApprovalSnapshotAt([
    cutover,
    { type: "attention_resolved", attentionKey: BOARD + ":1", at: 1500, seq: 1500 },
  ], 2000);
  assert.deepEqual(resolved.tasks, []);

  // The ordering guarantee is unchanged: attention raised after the approval
  // was not already waiting, so it stays out of the snapshot.
  assert.deepEqual(
    itemApproval.pendingApprovalSnapshotAt([attention(BOARD, 3000, { type: "cutover_attention" })],
      2000).tasks, []);
});

test("a large pending backlog does not disable every named approval", function () {
  // Live state on 2026-08-19 held 38 unresolved attention items. The cap was 32,
  // inherited from coop-queue-authorization where it bounds how many tasks one
  // sweep may staff. A named approval staffs exactly one item regardless, so the
  // cap bounded nothing here -- it just failed the whole gate closed, forever,
  // since an unresolved backlog only grows.
  var events = [];
  for (var i = 0; i < 38; i++) {
    events.push({
      type: "staffing_attention",
      attentionKey: "clay-pending-item-" + i + ":1",
      itemId: "clay-pending-item-" + i,
      portfolioTaskId: "clay-pending-item-" + i,
      bindingRevision: 1,
      at: 1000 + i,
      seq: i + 1,
    });
  }
  events.push({
    type: "staffing_attention",
    attentionKey: "webapp-automation-policy-board-exclusions:2",
    itemId: "webapp-automation-policy-board-exclusions",
    portfolioTaskId: "webapp-automation-policy-board-exclusions",
    bindingRevision: 2,
    at: 2000,
    seq: 100,
  });

  var snapshot = itemApproval.pendingApprovalSnapshotAt(events, 5000);
  assert.equal(snapshot.ok, true, "39 waiting items must not nullify the snapshot");
  assert.equal(snapshot.tasks.length, 39, "the set is never truncated to fit a cap");

  // The authorization work is still done by unambiguous identification, not by
  // set size: a named approval resolves, and a bare one cannot.
  var named = itemApproval.resolveApprovedTask(snapshot,
    "webapp-automation-policy-board-exclusions");
  assert.equal(named.ok, true);
  assert.equal(named.task.portfolioTaskId, "webapp-automation-policy-board-exclusions");
  assert.equal(named.task.bindingRevision, 2);

  var bare = itemApproval.resolveApprovedTask(snapshot, "");
  assert.deepEqual(bare, { ok: false, reason: "owner_approval_ambiguous" },
    "a bare approval against many waiting items must still fail closed");

  // An approval that names something no pending item matches still fails closed,
  // and a wording that fits two candidates equally still refuses to pick.
  assert.deepEqual(itemApproval.resolveApprovedTask(snapshot, "something nobody queued"),
    { ok: false, reason: "owner_approval_unmatched_item" });
  assert.deepEqual(itemApproval.resolveApprovedTask(snapshot, "pending"),
    { ok: false, reason: "owner_approval_ambiguous" });
});
