var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var actionDecision = require("../lib/coop-action-decision");
var journalModule = require("../lib/coop-emergency-repair-journal");
var manifestModule = require("../lib/coop-emergency-repair-manifest");
var policyModule = require("../lib/coop-emergency-repair-policy");
var runtimeModule = require("../lib/coop-emergency-repair-runtime");
var schema = require("../lib/coop-emergency-repair-schema");

var PROJECT = "11111111-1111-4111-8111-111111111111";
var COOP = "coop-session";
var COORDINATOR = "target-coordinator";
var TASK = "repair-owner-decision";
var OWNER_DECISION = "owner-decision-53366e3c1b300fe3809c9e19";
var AUTH = schema.createHmacAuthenticator("emergency-repair-test-secret-must-be-at-least-thirty-two-bytes");

function binding() {
  return {
    targetProject: { projectId: PROJECT },
    taskRef: { projectId: PROJECT, coordinatorSessionStorageId: COORDINATOR, taskId: TASK },
    sourceSession: { projectId: "system-lead", sessionStorageId: COOP },
    ownerActorId: "owner-42",
    ownerIngressId: "coop:ba715db2-6fc8-4bae-a410-497bc6f27adb:19",
    ownerDecisionRef: OWNER_DECISION,
    portfolioTaskId: schema.PORTFOLIO_TASK_ID,
    bindingRevision: 1,
    planRevision: 1,
    planDigest: schema.PLAN_DIGEST,
  };
}

function manifest() {
  return manifestModule.signManifest({
    version: 1,
    recipe: schema.RECIPE,
    patchPaths: ["lib/coop-action-decision.js", "test/coop-emergency-repair-policy.test.js"],
    commands: [["node", "--test", "test/coop-emergency-repair-policy.test.js"]],
    maxPatchBytes: 128,
  }, AUTH);
}

function durableJournal() {
  var journal = journalModule.createMemoryJournal();
  journal.durable = true;
  return journal;
}

function input(extra) {
  return Object.assign({
    recipe: schema.RECIPE,
    binding: binding(),
    actorId: "owner-42",
    ownerIngressId: "coop:ba715db2-6fc8-4bae-a410-497bc6f27adb:19",
    ownerDecisionRef: OWNER_DECISION,
    taskState: "needs_input",
    action: { decision: "advance", note: "", directiveDigest: "a".repeat(64) },
    failure: { code: "orchestrator_unavailable", observedAt: 100, observer: "coop-action-decision" },
  }, extra || {});
}

function harness(extra) {
  var state = { workers: 0, verification: 0, activations: 0, reentries: 0, release: "b".repeat(64) };
  var opts = extra || {};
  var journal = opts.journal || durableJournal();
  var policy = policyModule.createEmergencyRepairPolicy({
    binding: binding(),
    journal: journal,
    authenticator: AUTH,
    manifest: manifest(),
    now: function () { return 1000; },
    bootstrapWorker: function (request) {
      state.workers++;
      return {
        repairId: request.repairId,
        workerRef: { projectId: PROJECT, sessionStorageId: "emergency-worker" },
        visible: true,
        durable: true,
        receiptId: "worker-receipt",
      };
    },
    independentVerifier: function (request) {
      state.verification++;
      var capsule = runtimeModule.signCapsule({
        version: 1,
        repairId: request.repairId,
        sourceDigest: "c".repeat(64),
        releaseDigest: "d".repeat(64),
        baseReleaseDigest: "b".repeat(64),
        snapshotId: "snapshot-1",
        checkpointId: "checkpoint-1",
        drainReceipt: "drain-1",
        probeDigest: "e".repeat(64),
        clean: true,
        attestedAt: 1000,
      }, AUTH);
      return {
        passed: true,
        verifierId: "independent-verifier",
        manifestDigest: request.manifest.manifestDigest,
        patchBytes: 12,
        capsule: capsule,
      };
    },
    runtimeDriver: {
      prepare: function () {
        return { snapshotId: "snapshot-1", checkpointId: "checkpoint-1", drainReceipt: "drain-1",
          currentReleaseDigest: state.release, rollbackDigest: state.release };
      },
      compareAndSwapRelease: function (expected, next) {
        if (state.release !== expected) return false;
        state.release = next;
        state.activations++;
        return true;
      },
      probe: function () { return { ok: true, probeDigest: "e".repeat(64) }; },
      rollbackRelease: function (expected, prior) {
        if (state.release !== expected) return false;
        state.release = prior;
        return true;
      },
    },
    reenterCoordinator: function (request) {
      state.reentries++;
      return { receiptId: "reentry-receipt", actionDigest: request.actionEscrow.actionDigest,
        binding: request.binding };
    },
  });
  return { journal: journal, policy: policy, state: state };
}

test("the approved recipe creates one durable worker, verifies independently, activates a release pointer, and re-enters once", function () {
  var h = harness();
  var started = h.policy.escrowOwnerDecision(input());
  assert.equal(started.ok, true);
  assert.equal(started.status, "worker_bootstrapped");
  assert.equal(h.state.workers, 1, "only the canonical target worker was bootstrapped");
  var replay = h.policy.escrowOwnerDecision(input());
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(h.state.workers, 1, "replay must not create a second visible worker");

  assert.equal(h.policy.verify(started.repairId, { result: "verified" }).status, "verified");
  assert.equal(h.state.verification, 1);
  assert.equal(h.policy.activate(started.repairId).status, "activated");
  assert.equal(h.state.release, "d".repeat(64));
  assert.equal(h.policy.reenter(started.repairId).status, "reentered");
  assert.equal(h.state.reentries, 1);
  assert.equal(h.policy.reenter(started.repairId).replay, true);
  assert.equal(h.state.reentries, 1, "re-entry is exactly once");
  var record = h.policy.inspect(started.repairId);
  assert.equal(record.receipt.signature.length, 64, "failure receipt is authenticated");
  assert.equal(record.lease.revokedAt, 1000, "re-entry revokes the last repair fence");
  assert.equal(record.verifier.verifierId, "independent-verifier");
  assert.notEqual(record.verifier.verifierId, record.worker.workerRef.sessionStorageId);
});

test("scope, recipe, state, and action replay conflicts fail closed without touching R6/R7 or ordinary work", function () {
  var h = harness();
  var deniedProject = h.policy.escrowOwnerDecision(input({ binding: Object.assign({}, binding(), {
    targetProject: { projectId: "22222222-2222-4222-8222-222222222222" },
  }) }));
  assert.equal(deniedProject.ok, false);
  assert.equal(deniedProject.code, "repair_scope_denied");
  assert.equal(h.state.workers, 0);
  var deniedR7 = h.policy.escrowOwnerDecision(input({ binding: Object.assign({}, binding(), {
    portfolioTaskId: "clay-r7-unrelated-recovery",
  }) }));
  assert.equal(deniedR7.code, "repair_scope_denied", "R7 is not an admitted recipe or task");
  var deniedR6 = h.policy.escrowOwnerDecision(input({ recipe: "r6_recovery" }));
  assert.equal(deniedR6.code, "repair_scope_denied", "R6 recovery is not an admitted recipe");
  var started = h.policy.escrowOwnerDecision(input());
  var conflicting = h.policy.escrowOwnerDecision(input({ action: {
    decision: "request_changes", note: "different escrow", directiveDigest: "f".repeat(64),
  } }));
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.code, "repair_replay_conflict");
  assert.equal(h.state.workers, 1, "the conflicting action cannot start ordinary or duplicate work");
  assert.equal(h.journal.read(started.repairId).immutable.recipe, schema.RECIPE);
});

test("a tampered durable failure receipt is rejected before a later operation", function () {
  var h = harness();
  var started = h.policy.escrowOwnerDecision(input());
  var tampered = h.journal.read(started.repairId);
  tampered.receipt.signature = "0".repeat(64);
  assert.equal(h.journal.compareAndSwap(started.repairId, tampered.revision, tampered).ok, true);
  assert.throws(function () { h.policy.inspect(started.repairId); }, {
    code: "EMERGENCY_REPAIR_RECEIPT_INVALID",
  });
});

test("the file journal persists CAS state across a policy restart and rejects stale writers", function () {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "clay-emergency-journal-"));
  var file = path.join(temp, "repair-journal.json");
  try {
    var journal = require("../lib/coop-emergency-repair-journal").createFileJournal({ file: file });
    var h = harness({ journal: journal });
    var started = h.policy.escrowOwnerDecision(input());
    var persisted = journal.read(started.repairId);
    assert.equal(persisted.status, "worker_bootstrapped");
    assert.equal(journal.compareAndSwap(started.repairId, persisted.revision - 1, persisted).ok, false,
      "a stale crash-recovery writer cannot overwrite the current repair epoch");
    var reopened = harness({ journal: require("../lib/coop-emergency-repair-journal").createFileJournal({ file: file }) });
    assert.equal(reopened.policy.inspect(started.repairId).worker.receiptId, "worker-receipt");
    assert.equal(reopened.policy.escrowOwnerDecision(input()).replay, true);
    assert.equal(reopened.state.workers, 0, "restart replay does not bootstrap another worker");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("manifest signatures, command allowlists, traversal, symlinks, and patch-size limits are enforced", function () {
  assert.throws(function () {
    manifestModule.normalizeManifest({ version: 1, recipe: schema.RECIPE,
      patchPaths: ["../lib/coop-emergency-repair-escape.js"],
      commands: [["sh", "-c", "echo owned"]], maxPatchBytes: 8 });
  }, { code: "EMERGENCY_REPAIR_MANIFEST_INVALID" });
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "clay-emergency-manifest-"));
  try {
    fs.mkdirSync(path.join(temp, "lib"));
    fs.symlinkSync(os.tmpdir(), path.join(temp, "lib", "coop-emergency-repair-escape.js"));
    var signed = manifestModule.signManifest({ version: 1, recipe: schema.RECIPE,
      patchPaths: ["lib/coop-emergency-repair-escape.js"],
      commands: [["node", "--test", "test/coop-emergency-repair-policy.test.js"]], maxPatchBytes: 8 }, AUTH);
    assert.throws(function () { manifestModule.verifyPaths(signed, temp, AUTH); }, {
      code: "EMERGENCY_REPAIR_MANIFEST_PATH_ESCAPE",
    });
    assert.throws(function () { manifestModule.assertPatchSize(9, signed, AUTH); }, {
      code: "EMERGENCY_REPAIR_MANIFEST_PATCH_LIMIT",
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("the normal action bridge can enter only the pre-bound named failure fallback", function () {
  var h = harness();
  var task = {
    taskId: TASK,
    status: "needs_input",
    ownerDecision: { decisionRef: OWNER_DECISION, status: "unanswered", state: "unanswered" },
  };
  var session = { storageId: COORDINATOR, orchestrationTasks: [task] };
  var project = {
    getSessionManager: function () { return { sessions: new Map([[1, session]]) }; },
    getTaskOrchestrator: function () { return null; },
  };
  var out = actionDecision.applyDecision({
    request: { projectRef: { projectId: PROJECT }, taskId: TASK, decision: "advance" },
    actorId: "owner-42",
    getProjectById: function () { return project; },
    emergencyRepairPolicy: h.policy,
    now: function () { return 100; },
  });
  assert.equal(out.ok, false, "the original owner action remains escrowed until normal re-entry");
  assert.equal(out.code, "emergency_repair_started");
  assert.equal(h.state.workers, 1);
  var wrongActor = actionDecision.applyDecision({
    request: { projectRef: { projectId: PROJECT }, taskId: TASK, decision: "advance" },
    actorId: "not-owner",
    getProjectById: function () { return project; },
    emergencyRepairPolicy: h.policy,
    now: function () { return 100; },
  });
  assert.equal(wrongActor.code, "orchestrator_unavailable");
  assert.equal(h.state.workers, 1);
});
