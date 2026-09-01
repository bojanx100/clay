var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var policy = require("../lib/coop-auto-approval-policy");
var safety = require("../lib/coop-scoped-autonomy-policy");

var PROJECT = "51e67388-cea0-52b7-8e01-cde68cae713c";
var OTHER_PROJECT = "11111111-2222-4333-8444-555555555555";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-auto-approval-"));
}

function candidate(overrides) {
  return Object.assign({
    candidateKey: "launch:repo#42",
    admission: "owner_approval",
    status: "pending",
    projectRef: { projectId: PROJECT },
    policyDigest: "policy-digest",
    eligibilityPass: "exact-scan",
    eligibility: { assignedToOwner: true, recipeAllowsUnassigned: false, reason: "assigned" },
    safety: safety.assessCandidateSafety({ title: "Correct a small empty state alignment" }),
  }, overrides || {});
}

test("default persistence follows Clay's configured data home", function () {
  var dir = tempDir();
  var previous = process.env.CLAY_HOME;
  try {
    process.env.CLAY_HOME = dir;
    var store = policy.createPolicyStore();
    assert.equal(store.defaultFile, path.join(dir, "lead", "auto-approval-policy.json"));
  } finally {
    if (previous == null) delete process.env.CLAY_HOME;
    else process.env.CLAY_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("project overrides are ProjectRef-bound, durable, and resolve over the all-project default", function () {
  var dir = tempDir();
  var file = path.join(dir, "auto-approval.json");
  try {
    var store = policy.createPolicyStore({ file: file, now: function () { return 1000; } });
    assert.equal(store.reserveCandidate(candidate()).reason, "auto_approval_disabled");
    assert.equal(store.setAllProjects({ enabled: true, actorId: "owner-1", at: 1000 }).ok, true);
    assert.equal(store.setProjectOverride({ projectRef: { projectId: PROJECT }, enabled: false,
      actorId: "owner-1", at: 1001 }).ok, true);
    assert.equal(store.reserveCandidate(candidate()).reason, "auto_approval_disabled",
      "a project override wins over the all-project setting");
    var foreign = store.reserveCandidate(candidate({ projectRef: { projectId: OTHER_PROJECT } }));
    assert.equal(foreign.ok, true, "the global scope applies only through the candidate's exact ProjectRef");
    assert.equal(foreign.grant.projectRef.projectId, OTHER_PROJECT);

    var restarted = policy.createPolicyStore({ file: file, now: function () { return 1002; } });
    var state = restarted.stateFor({ projectId: PROJECT }, [{ projectRef: { projectId: PROJECT }, label: "Clay" }]);
    assert.equal(state.ok, true);
    assert.equal(state.state.effective.enabled, false);
    assert.equal(state.state.projectOverride.control.provenance.actorId, "owner-1");
    assert.equal(state.state.audit.length, 3,
      "both owner control changes and the admitted reservation are retained in the audit projection");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reservations enforce limits and expire or revoke without leaving stale authority", function () {
  var dir = tempDir();
  var file = path.join(dir, "auto-approval.json");
  var clock = 2000;
  try {
    var store = policy.createPolicyStore({ file: file, now: function () { return clock; } });
    assert.equal(store.setProjectOverride({ projectRef: { projectId: PROJECT }, enabled: true,
      maxAdmissions: 1, expiresAt: 3000, actorId: "owner-1", at: 2000 }).ok, true);
    var first = store.reserveCandidate(candidate());
    assert.equal(first.ok, true);
    assert.equal(store.reserveCandidate(candidate({ candidateKey: "launch:repo#43" })).reason,
      "auto_approval_limit_reached");
    assert.equal(store.releaseReservation(first.grant).ok, true);
    assert.equal(store.reserveCandidate(candidate({ candidateKey: "launch:repo#43" })).ok, true,
      "a failed pre-binding dispatch returns its reservation capacity");

    clock = 3000;
    assert.equal(store.reserveCandidate(candidate({ candidateKey: "launch:repo#44" })).reason,
      "auto_approval_expired");
    assert.equal(store.validateGrant(candidate(), first.grant).reason, "auto_approval_revoked_or_stale",
      "an expired receipt cannot reach dispatch after a restart-safe revalidation");

    clock = 4000;
    assert.equal(store.setProjectOverride({ projectRef: { projectId: PROJECT }, enabled: true,
      actorId: "owner-1", at: clock }).ok, true);
    var active = store.reserveCandidate(candidate({ candidateKey: "launch:repo#45" }));
    assert.equal(active.ok, true);
    assert.equal(store.setProjectOverride({ projectRef: { projectId: PROJECT }, enabled: false,
      actorId: "owner-1", at: 4001 }).ok, true);
    assert.equal(store.validateGrant(candidate({ candidateKey: "launch:repo#45" }), active.grant).reason,
      "auto_approval_revoked_or_stale", "disable is an immediate kill for queued authorization");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the control scope is part of a reservation identity", function () {
  var dir = tempDir();
  var file = path.join(dir, "auto-approval.json");
  try {
    var store = policy.createPolicyStore({ file: file, now: function () { return 2000; } });
    assert.equal(store.setAllProjects({ enabled: true, actorId: "owner-1", at: 2000 }).ok, true);
    var global = store.reserveCandidate(candidate());
    assert.equal(global.ok, true);
    assert.equal(store.setProjectOverride({ projectRef: { projectId: PROJECT }, enabled: true,
      actorId: "owner-1", at: 2001 }).ok, true);
    var override = store.reserveCandidate(candidate());
    assert.equal(override.ok, true);
    assert.notEqual(override.grant.reservationId, global.grant.reservationId,
      "a same-revision override cannot reuse an all-project reservation");
    assert.equal(store.validateGrant(candidate(), override.grant).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hard safety exceptions never receive an auto-approval reservation", function () {
  var dir = tempDir();
  var file = path.join(dir, "auto-approval.json");
  try {
    var store = policy.createPolicyStore({ file: file, now: function () { return 1000; } });
    assert.equal(store.setProjectOverride({ projectRef: { projectId: PROJECT }, enabled: true,
      actorId: "owner-1", at: 1000 }).ok, true);
    safety.HAZARD_FIELDS.forEach(function (field) {
      var input = { title: "Correct a small empty state alignment" };
      input[field] = true;
      assert.equal(store.reserveCandidate(candidate({ safety: safety.assessCandidateSafety(input) })).reason,
        "auto_approval_" + field + "_gated", field + " remains explicitly owner-gated");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
