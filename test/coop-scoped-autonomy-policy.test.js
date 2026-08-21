var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var spawnSync = require("node:child_process").spawnSync;

var policy = require("../lib/coop-scoped-autonomy-policy");

var PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var OTHER_PROJECT = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var INGRESS = "coop:canonical-coop:549";
var POLICY_TASK = "clay-scoped-auto-approval-policy";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-scoped-autonomy-"));
}

function ownerEvidence(overrides) {
  var entry = {
    ingressId: INGRESS,
    sessionRef: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 549 },
    receivedAt: 2000,
    expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn", at: 2000 },
    implementationScope: {
      projectRef: { projectId: PROJECT },
      topicRef: { topicId: "owner-scoped-policy" },
      portfolioTaskId: POLICY_TASK,
      bindingRevision: 1,
      idempotencyKey: POLICY_TASK + "-r1",
    },
  };
  var event = {
    type: "user_message",
    text: "do it",
    coopIngressId: INGRESS,
    from: "owner-1",
    _ts: 2000,
  };
  var value = overrides || {};
  return {
    authorizationTaskId: value.authorizationTaskId || POLICY_TASK,
    ownerRequest: Object.assign(entry, value.entry || {}),
    ownerEvent: Object.assign(event, value.event || {}),
  };
}

function pendingCandidate(overrides) {
  var candidate = {
    candidateKey: "launch:clay#42",
    itemKey: "clay#42",
    itemClass: "bug",
    admission: "owner_approval",
    status: "pending",
    projectRef: { projectId: PROJECT },
    policyDigest: "project-policy-digest",
    eligibilityPass: "current-scan",
    eligibility: {
      assignedToOwner: true,
      recipeAllowsUnassigned: false,
      reason: "assigned_to_owner",
    },
    safety: policy.assessCandidateSafety({ title: "Correct a small empty state alignment" }),
  };
  return Object.assign(candidate, overrides || {});
}

test("an exact owner-provisioned project grant persists across restart and preserves provenance", function () {
  var dir = tempDir();
  var file = path.join(dir, "scoped-policy.json");
  var original = ownerEvidence();
  try {
    var first = policy.createPolicyStore({ file: file });
    var activated = first.activate(original);
    assert.equal(activated.ok, true, activated.reason);
    assert.equal(activated.reused, false);
    assert.equal(activated.grant.owner.ingressId, INGRESS);
    assert.deepEqual(activated.grant.projectRef, { projectId: PROJECT });
    assert.deepEqual(original.ownerRequest.implementationDecision,
      { intent: "implement", source: "explicit_owner_turn", at: 2000 },
    "activation copies exact provenance; it never restamps the owner request");

    var restarted = policy.createPolicyStore({ file: file });
    var allowed = restarted.decide(pendingCandidate());
    assert.equal(allowed.ok, true, allowed.reason);
    assert.equal(allowed.reason, "scoped_policy_low_risk");
    assert.equal(allowed.grant.owner.ingressId, INGRESS);

    var otherProject = restarted.decide(pendingCandidate({ projectRef: { projectId: OTHER_PROJECT } }));
    assert.deepEqual(otherProject, { ok: false, reason: "scoped_policy_project_not_granted" },
      "the grant never broadens to another project after restart");

    var replay = restarted.activate(original);
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true, "replaying the same owner ingress adds no second grant");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a scoped-autonomy grant selects its exact policy scope from a multi-approval owner turn", function () {
  var unrelated = {
    projectRef: { projectId: OTHER_PROJECT },
    topicRef: { topicId: "owner-unrelated" },
    portfolioTaskId: "clay-unrelated-approved-task",
    bindingRevision: 1,
    idempotencyKey: "clay-unrelated-approved-task-r1",
  };
  var evidence = ownerEvidence({ entry: {
    implementationScope: unrelated,
    implementationScopes: [unrelated, {
      projectRef: { projectId: PROJECT },
      topicRef: { topicId: "owner-scoped-policy" },
      portfolioTaskId: POLICY_TASK,
      bindingRevision: 1,
      idempotencyKey: POLICY_TASK + "-r1",
    }],
  } });
  var result = policy.ownerGrantFrom(evidence);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.grant.projectRef, { projectId: PROJECT });
});

test("a scoped grant is never created from an injected, wrong-task, or unscoped owner record", function () {
  var dir = tempDir();
  var file = path.join(dir, "scoped-policy.json");
  try {
    [
      ownerEvidence({ event: { from: "", clientMessageId: "", coopIngressId: "" } }),
      ownerEvidence({ authorizationTaskId: "another-policy-task" }),
      ownerEvidence({ entry: { implementationScope: null } }),
      ownerEvidence({ entry: {
        implementationDecision: { intent: "fix", source: "explicit_owner_turn", at: 2000 },
      } }),
    ].forEach(function (evidence) {
      var result = policy.createPolicyStore({ file: file }).activate(evidence);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "scoped_policy_owner_provenance_required");
    });
    assert.deepEqual(policy.createPolicyStore({ file: file }).load().policy.grants, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the provisioning CLI reads the keyed durable owner ledger without accepting copied approval text", function () {
  var dir = tempDir();
  var policyFile = path.join(dir, "scoped-policy.json");
  var requestsFile = path.join(dir, "owner-requests.json");
  var historyFile = path.join(dir, "canonical-coop.jsonl");
  var evidence = ownerEvidence();
  try {
    fs.writeFileSync(requestsFile, JSON.stringify({
      schema: "clay.coop_owner_requests",
      version: 1,
      requests: { one: evidence.ownerRequest },
    }) + "\n");
    fs.writeFileSync(historyFile, JSON.stringify(evidence.ownerEvent) + "\n");
    var run = spawnSync(process.execPath, ["bin/coop-scoped-autonomy-policy.js",
      "--owner-ingress", INGRESS,
      "--authorization-task", POLICY_TASK,
      "--owner-requests", requestsFile,
      "--history", historyFile,
      "--policy-file", policyFile,
    ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    var output = JSON.parse(run.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.grant.owner.ingressId, INGRESS);
    assert.equal(policy.createPolicyStore({ file: policyFile }).decide(pendingCandidate()).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every retained approval class remains gated even with an active scoped policy", function () {
  var dir = tempDir();
  var file = path.join(dir, "scoped-policy.json");
  try {
    var store = policy.createPolicyStore({ file: file });
    assert.equal(store.activate(ownerEvidence()).ok, true);
    policy.HAZARD_FIELDS.forEach(function (field) {
      var input = { title: "Correct a small empty state alignment" };
      input[field] = true;
      var candidate = pendingCandidate({ safety: policy.assessCandidateSafety(input) });
      assert.deepEqual(store.decide(candidate), {
        ok: false,
        reason: "scoped_policy_" + field + "_gated",
      }, field + " cannot inherit the low-risk grant");
    });
    assert.deepEqual(store.decide(pendingCandidate({ safety: null })), {
      ok: false,
      reason: "scoped_policy_safety_unavailable",
    }, "missing safety evidence fails closed");
    assert.deepEqual(store.decide(pendingCandidate({ safety: policy.assessCandidateSafety({}) })), {
      ok: false,
      reason: "scoped_policy_not_low_risk",
    }, "unknown work is never guessed to be low risk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
