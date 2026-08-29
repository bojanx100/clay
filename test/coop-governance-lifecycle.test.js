var assert = require("assert");
var crypto = require("crypto");
var fs = require("fs");
var os = require("os");
var path = require("path");
var test = require("node:test");
var lifecycle = require("../lib/coop-governance-lifecycle");

var DAY = 24 * 60 * 60 * 1000;
var DIGEST = crypto.createHash("sha256").update("plan revision one").digest("hex");
var DIGEST_TWO = crypto.createHash("sha256").update("plan revision two").digest("hex");

function fixture() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-governance-lifecycle-"));
  var now = 1000;
  return {
    root: root,
    advance: function (ms) { now += ms; },
    store: lifecycle.createLifecycle({
      file: path.join(root, "governance-lifecycle.jsonl"),
      contentDir: path.join(root, "learning-content"),
      now: function () { return now; },
    }),
    workstream: {
      workstreamId: "workstream-governance",
      topicRef: { topicId: "owner-governance" },
      targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
      portfolioTaskId: "clay-governance-lifecycle",
    },
  };
}

function record(store, value) {
  var result = store.record(value);
  assert.equal(result.ok, true, result.code || result.reason);
  return result;
}

function prepareApprovedPlan(value) {
  var store = value.store;
  var workstream = value.workstream;
  record(store, { recordId: "workstream", type: "workstream", actor: "coop", workstream: workstream });
  record(store, {
    recordId: "evidence", type: "stage_run", actor: "triage", workstream: workstream,
    stageRun: { stageRunId: "evidence-1", stage: "evidence_review", evidenceDigest: "evidence-a" },
  });
  record(store, {
    recordId: "council", type: "stage_run", actor: "council", workstream: workstream,
    stageRun: { stageRunId: "council-1", stage: "council", riskSelected: true, evidenceDigest: "council-a" },
  });
  record(store, {
    recordId: "plan", type: "plan_revision", actor: "coop", workstream: workstream,
    planRevision: { planRevision: 1, planDigest: DIGEST, scopeDigest: "scope-a" },
  });
  record(store, {
    recordId: "decision", type: "owner_decision", actor: "owner", workstream: workstream,
    ownerDecision: { planRevision: 1, planDigest: DIGEST, decision: "approved", ownerIngressId: "coop:owner:1" },
  });
}

test("records an immutable lifecycle and permits execution only through its exact grant", function () {
  var value = fixture();
  prepareApprovedPlan(value);
  var reused = record(value.store, {
    recordId: "workstream", type: "workstream", actor: "coop", workstream: value.workstream,
  });
  assert.equal(reused.reused, true);
  var grant = record(value.store, {
    recordId: "grant", type: "implementation_grant", actor: "coop", workstream: value.workstream,
    implementationGrant: {
      grantId: "grant-1", planRevision: 1, planDigest: DIGEST,
      portfolioTaskId: value.workstream.portfolioTaskId, bindingRevision: 1,
      idempotencyKey: "governance-binding-1", targetProject: value.workstream.targetProject,
    },
  });
  assert.equal(grant.reused, false);
  assert.equal(value.store.executionAdmission({
    grantId: "grant-1", portfolioTaskId: value.workstream.portfolioTaskId,
    bindingRevision: 1, idempotencyKey: "governance-binding-1",
    targetProject: value.workstream.targetProject,
  }).ok, true);
  assert.equal(value.store.executionAdmission({
    grantId: "grant-1", portfolioTaskId: value.workstream.portfolioTaskId,
    bindingRevision: 2, idempotencyKey: "governance-binding-1",
    targetProject: value.workstream.targetProject,
  }).code, "grant_scope_mismatch");
  record(value.store, {
    recordId: "admitted", type: "implementation_admitted", actor: "coop", workstream: value.workstream,
    implementationAdmission: { grantId: "grant-1", bindingRevision: 1 },
  });
  record(value.store, {
    recordId: "executing", type: "execution_started", actor: "project_coordinator", workstream: value.workstream,
    execution: { grantId: "grant-1", bindingRevision: 1 },
  });
  record(value.store, {
    recordId: "verified", type: "verification", actor: "project_coordinator", workstream: value.workstream,
    verification: { grantId: "grant-1", bindingRevision: 1, evidenceDigest: "verified-a" },
  });
  record(value.store, { recordId: "closed", type: "closed", actor: "coop", workstream: value.workstream });
  assert.equal(value.store.state().phase, "closed");
  assert.equal(value.store.read().events.length, 10);
});

test("rejects stale owner decisions, self-approval, and conflicting idempotent records", function () {
  var value = fixture();
  record(value.store, { recordId: "workstream", type: "workstream", actor: "coop", workstream: value.workstream });
  assert.equal(value.store.record({
    recordId: "bad-evidence", type: "stage_run", actor: "coop", workstream: value.workstream,
    stageRun: { stageRunId: "evidence-1", stage: "evidence_review", evidenceDigest: "evidence-a" },
  }).code, "stage_run_actor_forbidden");
  var wrong = value.store.record({
    recordId: "wrong-decision", type: "owner_decision", actor: "coop", workstream: value.workstream,
    ownerDecision: { planRevision: 1, planDigest: DIGEST, decision: "approved", ownerIngressId: "coop:owner:1" },
  });
  assert.equal(wrong.code, "owner_decision_actor_forbidden");
  var first = value.store.record({ recordId: "same", type: "stage_run", actor: "triage", workstream: value.workstream,
    stageRun: { stageRunId: "same-stage", stage: "evidence_review", evidenceDigest: "evidence-a" } });
  assert.equal(first.ok, true);
  var conflict = value.store.record({ recordId: "same", type: "stage_run", actor: "triage", workstream: value.workstream,
    stageRun: { stageRunId: "same-stage", stage: "evidence_review", evidenceDigest: "evidence-b" } });
  assert.equal(conflict.code, "idempotency_conflict");
});

test("requires a risk-selected Council run and invalidates an earlier grant when a new plan is drafted", function () {
  var value = fixture();
  record(value.store, { recordId: "workstream", type: "workstream", actor: "coop", workstream: value.workstream });
  record(value.store, {
    recordId: "evidence", type: "stage_run", actor: "triage", workstream: value.workstream,
    stageRun: { stageRunId: "evidence-1", stage: "evidence_review", riskSelected: true, evidenceDigest: "evidence-a" },
  });
  assert.equal(value.store.record({
    recordId: "plan", type: "plan_revision", actor: "coop", workstream: value.workstream,
    planRevision: { planRevision: 1, planDigest: DIGEST, scopeDigest: "scope-a" },
  }).code, "council_required");
  record(value.store, {
    recordId: "council", type: "stage_run", actor: "council", workstream: value.workstream,
    stageRun: { stageRunId: "council-1", stage: "council", riskSelected: true, evidenceDigest: "council-a" },
  });
  record(value.store, {
    recordId: "plan", type: "plan_revision", actor: "coop", workstream: value.workstream,
    planRevision: { planRevision: 1, planDigest: DIGEST, scopeDigest: "scope-a" },
  });
  record(value.store, {
    recordId: "decision", type: "owner_decision", actor: "owner", workstream: value.workstream,
    ownerDecision: { planRevision: 1, planDigest: DIGEST, decision: "approved", ownerIngressId: "coop:owner:1" },
  });
  record(value.store, {
    recordId: "grant", type: "implementation_grant", actor: "coop", workstream: value.workstream,
    implementationGrant: { grantId: "grant-1", planRevision: 1, planDigest: DIGEST,
      portfolioTaskId: value.workstream.portfolioTaskId, bindingRevision: 1,
      idempotencyKey: "governance-binding-1", targetProject: value.workstream.targetProject },
  });
  record(value.store, {
    recordId: "plan-2", type: "plan_revision", actor: "coop", workstream: value.workstream,
    planRevision: { planRevision: 2, planDigest: DIGEST_TWO, scopeDigest: "scope-b" },
  });
  assert.equal(value.store.executionAdmission({ grantId: "grant-1", portfolioTaskId: value.workstream.portfolioTaskId,
    bindingRevision: 1, idempotencyKey: "governance-binding-1", targetProject: value.workstream.targetProject }).code,
  "stale_plan_digest");
});

test("requires a grant snapshot and recovery reference before recording adoption", function () {
  var value = fixture();
  prepareApprovedPlan(value);
  record(value.store, {
    recordId: "grant", type: "implementation_grant", actor: "coop", workstream: value.workstream,
    implementationGrant: { grantId: "grant-1", planRevision: 1, planDigest: DIGEST,
      portfolioTaskId: value.workstream.portfolioTaskId, bindingRevision: 1,
      idempotencyKey: "governance-binding-1", targetProject: value.workstream.targetProject },
  });
  assert.equal(value.store.record({
    recordId: "adoption", type: "adoption", actor: "coop", workstream: value.workstream,
    adoption: { grantId: "grant-1", bindingRevision: 1, sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e", sessionStorageId: "session-1" } },
  }).code, "adoption_snapshot_required");
  assert.equal(record(value.store, {
    recordId: "adoption", type: "adoption", actor: "coop", workstream: value.workstream,
    adoption: { grantId: "grant-1", bindingRevision: 1, snapshotDigest: "snapshot-a", recoveryRef: "recovery-a",
      sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e", sessionStorageId: "session-1" } },
  }).ok, true);
});

test("keeps retracted learning content for thirty days then leaves a content-free tombstone", function () {
  var value = fixture();
  record(value.store, { recordId: "workstream", type: "workstream", actor: "coop", workstream: value.workstream });
  record(value.store, {
    recordId: "learning", type: "learning", actor: "evidence_review", workstream: value.workstream,
    learning: { learningId: "learning-1", version: 1, supersedesVersion: 0, scope: "workstream", confidence: 0.8,
      provenance: [{ kind: "stage_run", id: "evidence-1" }],
      expiresAt: 1000 + 60 * DAY, content: "Observed evidence only." },
  });
  assert.equal(value.store.learning("learning-1").content, "Observed evidence only.");
  record(value.store, {
    recordId: "retraction", type: "learning_retraction", actor: "coop", workstream: value.workstream,
    learningRetraction: { learningId: "learning-1", reason: "Evidence superseded" },
  });
  assert.equal(value.store.purgeRetractedLearning().purged, 0);
  value.advance(31 * DAY);
  assert.equal(value.store.purgeRetractedLearning().purged, 1);
  var learning = value.store.learning("learning-1");
  assert.equal(learning.content, undefined);
  assert.equal(learning.tombstone, true);
  assert.equal(learning.contentRef, undefined);
});

test("keeps normative learning behind an exact owner-promotion reference and detects tampering", function () {
  var value = fixture();
  record(value.store, { recordId: "workstream", type: "workstream", actor: "coop", workstream: value.workstream });
  assert.equal(value.store.record({
    recordId: "normative", type: "learning", actor: "coop", workstream: value.workstream,
    learning: { learningId: "learning-normative", version: 1, supersedesVersion: 0, scope: "project", confidence: 0.9,
      provenance: [{ kind: "stage_run", id: "evidence-1" }],
      expiresAt: 1000 + DAY, normative: true, content: "Never self-authorize." },
  }).code, "learning_promotion_required");
  record(value.store, {
    recordId: "evidence", type: "stage_run", actor: "triage", workstream: value.workstream,
    stageRun: { stageRunId: "evidence-1", stage: "evidence_review", evidenceDigest: "evidence-a" },
  });
  record(value.store, {
    recordId: "plan", type: "plan_revision", actor: "coop", workstream: value.workstream,
    planRevision: { planRevision: 1, planDigest: DIGEST, scopeDigest: "scope-a" },
  });
  record(value.store, {
    recordId: "decision", type: "owner_decision", actor: "owner", workstream: value.workstream,
    ownerDecision: { planRevision: 1, planDigest: DIGEST, decision: "approved", ownerIngressId: "coop:owner:1" },
  });
  record(value.store, {
    recordId: "normative", type: "learning", actor: "coop", workstream: value.workstream,
    learning: { learningId: "learning-normative", version: 1, supersedesVersion: 0, scope: "project", confidence: 0.9,
      provenance: [{ kind: "stage_run", id: "evidence-1" }],
      expiresAt: 1000 + DAY, normative: true, ownerDecisionRef: "decision", content: "Never self-authorize." },
  });
  var raw = fs.readFileSync(path.join(value.root, "governance-lifecycle.jsonl"), "utf8");
  fs.writeFileSync(path.join(value.root, "governance-lifecycle.jsonl"), raw.replace("workstream-governance", "workstream-tampered"));
  assert.equal(value.store.read().code, "lifecycle_tampered");
});

test("versions learning corrections and refuses replayed authority or second recovery adoption", function () {
  var value = fixture();
  prepareApprovedPlan(value);
  record(value.store, {
    recordId: "grant", type: "implementation_grant", actor: "coop", workstream: value.workstream,
    implementationGrant: { grantId: "grant-1", planRevision: 1, planDigest: DIGEST,
      portfolioTaskId: value.workstream.portfolioTaskId, bindingRevision: 1,
      idempotencyKey: "governance-binding-1", targetProject: value.workstream.targetProject },
  });
  record(value.store, {
    recordId: "learning-v1", type: "learning", actor: "triage", workstream: value.workstream,
    learning: { learningId: "learning-corrected", version: 1, supersedesVersion: 0, scope: "project",
      confidence: 0.6, expiresAt: 1000 + DAY, provenance: [{ kind: "stage_run", id: "evidence-1" }],
      content: "Initial observation." },
  });
  assert.equal(value.store.record({
    recordId: "learning-v3", type: "learning", actor: "triage", workstream: value.workstream,
    learning: { learningId: "learning-corrected", version: 3, supersedesVersion: 1, scope: "project",
      confidence: 0.9, expiresAt: 1000 + DAY, provenance: [{ kind: "stage_run", id: "evidence-1" }],
      content: "Invalid gap." },
  }).code, "learning_version_invalid");
  record(value.store, {
    recordId: "learning-v2", type: "learning", actor: "triage", workstream: value.workstream,
    learning: { learningId: "learning-corrected", version: 2, supersedesVersion: 1, scope: "project",
      confidence: 0.9, expiresAt: 1000 + DAY, provenance: [{ kind: "stage_run", id: "evidence-1" }],
      content: "Corrected observation." },
  });
  assert.equal(value.store.learning("learning-corrected").version, 2);
  record(value.store, {
    recordId: "adoption", type: "adoption", actor: "coop", workstream: value.workstream,
    adoption: { grantId: "grant-1", bindingRevision: 1, snapshotDigest: "snapshot-a", recoveryRef: "recovery-a",
      sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e", sessionStorageId: "session-1" } },
  });
  assert.equal(value.store.record({
    recordId: "adoption-again", type: "adoption", actor: "coop", workstream: value.workstream,
    adoption: { grantId: "grant-1", bindingRevision: 1, snapshotDigest: "snapshot-b", recoveryRef: "recovery-b",
      sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e", sessionStorageId: "session-2" } },
  }).code, "adoption_exists");
  var replayed = value.store.replay([{ type: "workstream", actor: "owner", workstream: value.workstream }]);
  assert.equal(replayed.code, "workstream_actor_forbidden");
});
