var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");
var ownerRequests = require("../lib/coop-owner-requests");

// Coordinator cardinality and fan-in.
//
// Portfolio bindings already guarantee one active binding per portfolio task.
// That is not the property the owner cares about. The owner asks about a
// TOPIC, that topic touches one or more projects, and each affected project
// must end up with exactly ONE coordinator -- so a follow-up on the same topic
// reaches the coordinator already working on it instead of staffing a rival.

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var COOP_SESSION = "871a194b-8879-40f7-a1fe-656e48e722af";
var TOPIC = { topicId: "auto-a7daa4cc660639337d144d93" };
var OTHER_TOPIC = { topicId: "auto-51790c55a2629f5d66444f0c" };
var COORD_A = { projectId: CLAY, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" };
var COORD_B = { projectId: CLAY, sessionStorageId: "fb81abfe-324b-4e8c-a7c4-07da7d2c82cc" };
var COORD_WEBAPP = { projectId: WEBAPP, sessionStorageId: "7e539a81-8ecf-4943-ad26-bcaf6544f1c0" };

function tempFile() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-coordinators-"));
  return path.join(dir, "requests.json");
}

function makeLedger(file) {
  return ownerRequests.attachCoopOwnerRequests({ file: file || tempFile() });
}

function ingressId(sequence) {
  return "coop:" + COOP_SESSION + ":" + sequence;
}

function open(ledger, sequence, topicRef, projectRefs) {
  ledger.record({
    ingressId: ingressId(sequence),
    ingressSequence: sequence,
    sessionRef: { projectId: "system-lead", sessionStorageId: COOP_SESSION },
  });
  ledger.classify(ingressId(sequence), {
    kind: "new_topic", topicRef: topicRef, projectRefs: projectRefs || [],
  });
  return ingressId(sequence);
}

// --- exactly one coordinator per (topic, project) -----------------------------

test("the first claim for a topic and project becomes the canonical coordinator", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var claim = ledger.claimCoordinator({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: id,
  });

  assert.equal(claim.ok, true);
  assert.equal(claim.created, true);
  assert.deepEqual(claim.coordinator, COORD_A);
  assert.deepEqual(ledger.canonicalCoordinator(TOPIC, { projectId: CLAY }), COORD_A);
});

test("a follow-up on the same topic and project reuses the existing coordinator", function () {
  var ledger = makeLedger();
  var first = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: first });

  var followUp = open(ledger, 190, TOPIC, [{ projectId: CLAY }]);
  var claim = ledger.claimCoordinator({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: followUp,
  });

  assert.equal(claim.ok, true);
  assert.equal(claim.created, false, "a follow-up must not mint a second coordinator");
  assert.equal(claim.reused, true);
  assert.equal(ledger.coordinatorsForTopic(TOPIC).length, 1);
  // Both requests are linked to the one coordinator.
  assert.equal(ledger.get(first).links.coordinators.length, 1);
  assert.equal(ledger.get(followUp).links.coordinators.length, 1);
});

test("a rival coordinator for the same topic and project is refused, not recorded", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: id });

  var rival = ledger.claimCoordinator({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_B, ingressId: id,
  });

  assert.equal(rival.ok, false);
  assert.equal(rival.reason, "coordinator_exists");
  assert.deepEqual(rival.coordinator, COORD_A, "the refusal names the canonical coordinator to use instead");
  assert.equal(ledger.coordinatorsForTopic(TOPIC).length, 1);
});

test("one topic across two projects gets exactly one coordinator per project", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }, { projectId: WEBAPP }]);
  var clay = ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: id });
  var webapp = ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: WEBAPP }, coordinator: COORD_WEBAPP, ingressId: id });

  assert.equal(clay.created, true);
  assert.equal(webapp.created, true);
  assert.equal(ledger.coordinatorsForTopic(TOPIC).length, 2);
  assert.deepEqual(ledger.canonicalCoordinator(TOPIC, { projectId: CLAY }), COORD_A);
  assert.deepEqual(ledger.canonicalCoordinator(TOPIC, { projectId: WEBAPP }), COORD_WEBAPP);
});

test("the same project under a different topic is a different coordinator", function () {
  var ledger = makeLedger();
  var first = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var second = open(ledger, 183, OTHER_TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: first });
  var other = ledger.claimCoordinator({ topicRef: OTHER_TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_B, ingressId: second });

  assert.equal(other.ok, true);
  assert.equal(other.created, true, "cardinality is per topic AND project, not per project alone");
  assert.deepEqual(ledger.canonicalCoordinator(TOPIC, { projectId: CLAY }), COORD_A);
  assert.deepEqual(ledger.canonicalCoordinator(OTHER_TOPIC, { projectId: CLAY }), COORD_B);
});

test("a coordinator whose project does not match its ProjectRef is refused", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var claim = ledger.claimCoordinator({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_WEBAPP, ingressId: id,
  });

  assert.equal(claim.ok, false);
  assert.equal(claim.reason, "project_mismatch");
  assert.equal(ledger.canonicalCoordinator(TOPIC, { projectId: CLAY }), null);
});

test("a claim without a resolvable topic or project is refused", function () {
  var ledger = makeLedger();
  assert.equal(ledger.claimCoordinator({ projectRef: { projectId: CLAY }, coordinator: COORD_A }).ok, false);
  assert.equal(ledger.claimCoordinator({ topicRef: TOPIC, coordinator: COORD_A }).ok, false);
  assert.equal(ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY } }).ok, false);
});

test("claiming a coordinator never answers the owner", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: id });

  assert.equal(ledger.get(id).response.state, "unanswered");
  assert.equal(ledger.unanswered().length, 1);
});

test("coordinator claims survive a restart", function () {
  var file = tempFile();
  var first = makeLedger(file);
  var id = open(first, 182, TOPIC, [{ projectId: CLAY }]);
  first.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: id });

  var reloaded = makeLedger(file);
  assert.deepEqual(reloaded.canonicalCoordinator(TOPIC, { projectId: CLAY }), COORD_A);
  var reclaim = reloaded.claimCoordinator({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: id,
  });
  assert.equal(reclaim.created, false);
});

// --- fan-in ------------------------------------------------------------------

test("a coordinator outcome fans into every request on that topic", function () {
  var ledger = makeLedger();
  var first = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var second = open(ledger, 190, TOPIC, [{ projectId: CLAY }]);
  var elsewhere = open(ledger, 191, OTHER_TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: first });

  var updated = ledger.applyCoordinatorOutcome({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, status: "completed", summary: "Flow shipped.",
  });

  assert.deepEqual(updated.map(function (r) { return r.ingressSequence; }), [182, 190]);
  assert.equal(ledger.get(first).state, "done");
  assert.equal(ledger.get(second).state, "done");
  assert.equal(ledger.get(elsewhere).state, "open", "another topic is untouched");
});

test("fan-in of a completed execution still leaves the owner unanswered", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.applyCoordinatorOutcome({ topicRef: TOPIC, projectRef: { projectId: CLAY }, status: "completed" });

  assert.equal(ledger.get(id).state, "done");
  assert.equal(ledger.get(id).response.state, "unanswered");
  assert.equal(ledger.hasUnansweredOwnerRequests(), true);
});

test("a coordinator reporting needs_input projects the decision onto the owner request", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.applyCoordinatorOutcome({ topicRef: TOPIC, projectRef: { projectId: CLAY }, status: "needs_input" });

  assert.equal(ledger.get(id).state, "needs_input");
  assert.equal(ledger.list({ state: "needs_input" }).length, 1);
});

test("fan-in never resurrects a conversational request into execution", function () {
  var ledger = makeLedger();
  ledger.record({
    ingressId: ingressId(180), ingressSequence: 180,
    sessionRef: { projectId: "system-lead", sessionStorageId: COOP_SESSION },
  });
  ledger.classify(ingressId(180), { kind: "conversational", topicRef: TOPIC });

  var updated = ledger.applyCoordinatorOutcome({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, status: "completed",
  });

  assert.equal(updated.length, 0);
  assert.equal(ledger.get(ingressId(180)).state, "open");
});

test("a fan-in for an unknown topic changes nothing", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  assert.deepEqual(ledger.applyCoordinatorOutcome({
    topicRef: { topicId: "auto-000000000000000000000000" }, projectRef: { projectId: CLAY }, status: "completed",
  }), []);
  assert.equal(ledger.get(id).state, "open");
});

// --- safe topic closure -------------------------------------------------------

test("closing a topic settles its resolved requests", function () {
  var ledger = makeLedger();
  var first = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var second = open(ledger, 190, TOPIC, [{ projectId: CLAY }]);
  ledger.setState(first, "working");
  ledger.setState(second, "done");

  var result = ledger.reconcileTopicClosure(TOPIC);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settled.map(function (r) { return r.ingressSequence; }), [182, 190]);
  assert.equal(ledger.get(first).state, "done");
});

test("closing a topic preserves requests still needing the owner", function () {
  var ledger = makeLedger();
  var working = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var decision = open(ledger, 190, TOPIC, [{ projectId: CLAY }]);
  var blocked = open(ledger, 191, TOPIC, [{ projectId: CLAY }]);
  ledger.setState(working, "working");
  ledger.setState(decision, "needs_input");
  ledger.recordAttention(blocked, "project_target_unavailable");

  var result = ledger.reconcileTopicClosure(TOPIC);
  assert.deepEqual(result.preserved.map(function (r) { return r.ingressSequence; }), [190, 191]);
  assert.equal(ledger.get(decision).state, "needs_input", "closing must not hide an owner decision");
  assert.equal(ledger.get(blocked).state, "attention", "closing must not hide failed routing");
  assert.equal(ledger.get(working).state, "done");
});

test("closing a topic never marks an unanswered owner answered", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.reconcileTopicClosure(TOPIC);

  assert.equal(ledger.get(id).response.state, "unanswered");
  assert.equal(ledger.unanswered().length, 1, "an unanswered request stays queryable after close");
});

test("closing a topic is idempotent", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.setState(id, "working");

  var first = ledger.reconcileTopicClosure(TOPIC);
  var second = ledger.reconcileTopicClosure(TOPIC);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false, "a second close finds nothing left to settle");
  assert.deepEqual(second.settled.map(function (r) { return r.ingressSequence; }), [182]);
});

test("closing one topic leaves another topic's requests alone", function () {
  var ledger = makeLedger();
  var mine = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var other = open(ledger, 183, OTHER_TOPIC, [{ projectId: CLAY }]);
  ledger.setState(mine, "working");
  ledger.setState(other, "working");

  ledger.reconcileTopicClosure(TOPIC);
  assert.equal(ledger.get(mine).state, "done");
  assert.equal(ledger.get(other).state, "working");
});

test("closing an unknown topic is refused rather than settling everything", function () {
  var ledger = makeLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.setState(id, "working");

  assert.equal(ledger.reconcileTopicClosure(null).ok, false);
  assert.equal(ledger.get(id).state, "working");
});

// --- topic aliasing -----------------------------------------------------------
//
// Merging a topic seals it and points it at its canonical target. The ledger
// has to follow: a request filed under the alias is still the owner asking
// about the canonical topic, and leaving it behind means forTopic() and the
// owner overview silently under-report the work.

test("requests and claims follow a merged topic to its canonical target", function () {
  var ledger = makeLedger();
  var canonical = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var aliased = open(ledger, 190, OTHER_TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: OTHER_TOPIC, projectRef: { projectId: CLAY },
    coordinator: COORD_A, ingressId: aliased });

  var result = ledger.retopic(OTHER_TOPIC, TOPIC);
  assert.equal(result.ok, true);
  assert.equal(result.requests, 1);

  assert.deepEqual(ledger.forTopic(TOPIC).map(function (r) { return r.ingressSequence; }), [182, 190]);
  assert.deepEqual(ledger.forTopic(OTHER_TOPIC), []);
  assert.deepEqual(ledger.canonicalCoordinator(TOPIC, { projectId: CLAY }), COORD_A);
  assert.equal(ledger.canonicalCoordinator(OTHER_TOPIC, { projectId: CLAY }), null);
  assert.equal(ledger.get(aliased).topicRef.topicId, TOPIC.topicId);
});

test("aliasing never changes whether the owner was answered", function () {
  var ledger = makeLedger();
  var id = open(ledger, 190, OTHER_TOPIC, [{ projectId: CLAY }]);
  ledger.retopic(OTHER_TOPIC, TOPIC);
  assert.equal(ledger.get(id).response.state, "unanswered");
  assert.equal(ledger.unanswered().length, 1);
});

test("aliasing is idempotent and refuses a self-merge", function () {
  var ledger = makeLedger();
  open(ledger, 190, OTHER_TOPIC, [{ projectId: CLAY }]);
  assert.equal(ledger.retopic(OTHER_TOPIC, TOPIC).requests, 1);
  assert.equal(ledger.retopic(OTHER_TOPIC, TOPIC).requests, 0, "nothing left to move");
  assert.equal(ledger.retopic(TOPIC, TOPIC).ok, false);
  assert.equal(ledger.retopic(null, TOPIC).ok, false);
});

test("aliasing collapses rival coordinators onto the canonical claim", function () {
  var ledger = makeLedger();
  var a = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var b = open(ledger, 190, OTHER_TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: a });
  ledger.claimCoordinator({ topicRef: OTHER_TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_B, ingressId: b });

  ledger.retopic(OTHER_TOPIC, TOPIC);
  // The canonical topic already had a coordinator; the alias's rival cannot
  // displace it, and must not survive as a second claim on the same pair.
  assert.deepEqual(ledger.canonicalCoordinator(TOPIC, { projectId: CLAY }), COORD_A);
  assert.equal(ledger.coordinatorsForTopic(TOPIC).filter(function (ref) {
    return ref.sessionStorageId === COORD_B.sessionStorageId;
  }).length, 0, "the rival claim is dropped, not silently kept");
});

// --- P2 blockers from the independent Codex review ----------------------------
//
// Both are the same shape: a mutation applied in memory, a discarded persist()
// result, and a cheerful ok:true. The ledger's whole value is being trusted
// about durable facts, so reporting a fact that never reached disk is worse
// than failing.

// Explicit disk failure. Counting writes was brittle: collapsing a nested
// write into its parent silently moved where the injected failure landed.
function brokenDiskLedger() {
  var realFs = require("fs");
  var broken = false;
  var dir = realFs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-disk-"));
  var ledger = ownerRequests.attachCoopOwnerRequests({
    file: path.join(dir, "r.json"),
    fs: {
      readFileSync: realFs.readFileSync,
      existsSync: realFs.existsSync,
      renameSync: realFs.renameSync,
      mkdirSync: realFs.mkdirSync,
      writeFileSync: function (target, data, options) {
        if (broken) throw new Error("ENOSPC");
        return realFs.writeFileSync(target, data, options);
      },
    },
  });
  ledger._breakDisk = function () { broken = true; };
  ledger._healDisk = function () { broken = false; };
  ledger._file = path.join(dir, "r.json");
  return ledger;
}

test("a coordinator claim that cannot be persisted fails closed", function () {
  var ledger = brokenDiskLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger._breakDisk();

  var claim = ledger.claimCoordinator({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: id,
  });

  assert.equal(claim.ok, false, "a claim that never reached disk is not a claim");
  assert.equal(claim.reason, "persistence_failed");
  // And nothing leaked in memory: a restart would have silently un-owned the
  // pair, letting a different task claim it and produce two coordinators.
  assert.equal(ledger.canonicalCoordinator(TOPIC, { projectId: CLAY }), null);
  assert.equal(ledger.listCoordinators().length, 0);
  assert.equal(ledger.coordinatorsForTopic(TOPIC).length, 0);
});

test("a failed claim leaves the pair claimable, so a retry still works", function () {
  var file = tempFile();
  var ledger = makeLedger(file);
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var retry = ledger.claimCoordinator({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: id,
  });
  assert.equal(retry.ok, true, "a healthy retry claims normally");
  assert.equal(retry.created, true);
  assert.deepEqual(makeLedger(file).canonicalCoordinator(TOPIC, { projectId: CLAY }), COORD_A);
});

test("a topic merge moves requests and claims atomically, or not at all", function () {
  var ledger = brokenDiskLedger();
  var first = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: first });
  ledger._breakDisk();

  var merged = ledger.retopic(TOPIC, OTHER_TOPIC);
  assert.equal(merged.ok, false);
  assert.equal(merged.reason, "persistence_failed");
  // Neither half moved: requests still on the source topic, claim still under it.
  assert.deepEqual(ledger.get(first).topicRef, TOPIC);
  assert.equal(ledger.forTopic(OTHER_TOPIC).length, 0);
  assert.deepEqual(ledger.canonicalCoordinator(TOPIC, { projectId: CLAY }), COORD_A);
  assert.equal(ledger.canonicalCoordinator(OTHER_TOPIC, { projectId: CLAY }), null);
});

test("a successful merge carries response state, links and cardinality across", function () {
  var file = tempFile();
  var ledger = makeLedger(file);
  var answered = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var outstandingId = open(ledger, 183, TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: answered });
  ledger.linkExecution(answered, { task: { projectId: CLAY,
    coordinatorSessionStorageId: COORD_A.sessionStorageId, taskId: "task-1" } });
  ledger.markAnswered(answered, { eventIndex: 9 });

  var merged = ledger.retopic(TOPIC, OTHER_TOPIC);
  assert.equal(merged.ok, true);
  assert.equal(merged.requests, 2);

  // Response state survives: answered stays answered, outstanding stays owed.
  assert.equal(ledger.get(answered).response.state, "answered");
  assert.equal(ledger.get(outstandingId).response.state, "unanswered");
  assert.equal(ledger.unanswered().length, 1);
  // Links survive.
  assert.equal(ledger.get(answered).links.tasks.length, 1);
  assert.equal(ledger.get(answered).links.coordinators.length, 1);
  // Cardinality moved with the topic: one coordinator, under the target.
  assert.deepEqual(ledger.canonicalCoordinator(OTHER_TOPIC, { projectId: CLAY }), COORD_A);
  assert.equal(ledger.canonicalCoordinator(TOPIC, { projectId: CLAY }), null);
  assert.equal(ledger.coordinatorsForTopic(OTHER_TOPIC).length, 1);

  // And it survives a restart, still idempotent.
  var reloaded = makeLedger(file);
  assert.deepEqual(reloaded.canonicalCoordinator(OTHER_TOPIC, { projectId: CLAY }), COORD_A);
  assert.equal(reloaded.forTopic(OTHER_TOPIC).length, 2);
  var again = reloaded.retopic(TOPIC, OTHER_TOPIC);
  assert.equal(again.requests, 0, "re-merging an already-merged topic moves nothing");
  assert.equal(reloaded.coordinatorsForTopic(OTHER_TOPIC).length, 1);
});

test("merging into a topic that already owns the pair keeps exactly one coordinator", function () {
  var ledger = makeLedger();
  var source = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var target = open(ledger, 183, OTHER_TOPIC, [{ projectId: CLAY }]);
  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: source });
  ledger.claimCoordinator({ topicRef: OTHER_TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_B, ingressId: target });

  assert.equal(ledger.retopic(TOPIC, OTHER_TOPIC).ok, true);
  // One coordinator per (topic, project) is the rule; the incumbent wins.
  assert.equal(ledger.coordinatorsForTopic(OTHER_TOPIC).length, 1);
  assert.deepEqual(ledger.canonicalCoordinator(OTHER_TOPIC, { projectId: CLAY }), COORD_B);
  // The moved request is re-pointed at the surviving coordinator, not the loser.
  assert.deepEqual(ledger.get(source).links.coordinators, [COORD_B]);
});

test("a closure whose write fails does not report topics settled", function () {
  var ledger = brokenDiskLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger.setState(id, "working");
  ledger._breakDisk();

  var closed = ledger.reconcileTopicClosure(TOPIC);
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, "persistence_failed");
  assert.deepEqual(closed.settled, []);
  assert.equal(ledger.get(id).state, "working", "the in-memory state was rolled back");
});

// --- the exact break cases the re-review reproduced ---------------------------

test("a failed claim leaves nothing durable, not even through the request link", function () {
  // The nested linkExecution used to persist the whole state -- including the
  // just-pushed claim -- before the outer persist ran. Failing only the outer
  // write therefore returned persistence_failed while disk, and the topic-facing
  // links, still carried the coordinator.
  var ledger = brokenDiskLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger._breakDisk();

  var claim = ledger.claimCoordinator({
    topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: id,
  });
  assert.equal(claim.ok, false);
  assert.equal(ledger.listCoordinators().length, 0);
  assert.deepEqual(ledger.get(id).links.coordinators, [], "the request link must not leak the claim");
  assert.deepEqual(ledger.coordinatorsForTopic(TOPIC), []);

  // And nothing reached disk: a reload sees no claim at all.
  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: ledger._file });
  assert.equal(reloaded.canonicalCoordinator(TOPIC, { projectId: CLAY }), null);
  assert.deepEqual(reloaded.coordinatorsForTopic(TOPIC), []);
});

test("after a failed claim a retry on healthy disk succeeds and is durable", function () {
  var ledger = brokenDiskLedger();
  var id = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  ledger._breakDisk();
  assert.equal(ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY },
    coordinator: COORD_A, ingressId: id }).ok, false);

  ledger._healDisk();
  var retry = ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY },
    coordinator: COORD_A, ingressId: id });
  assert.equal(retry.ok, true);
  assert.equal(retry.created, true, "the failed attempt left the pair genuinely unclaimed");

  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: ledger._file });
  assert.deepEqual(reloaded.canonicalCoordinator(TOPIC, { projectId: CLAY }), COORD_A);
  assert.deepEqual(reloaded.get(id).links.coordinators, [COORD_A]);
});

test("a late requestRef write that fails is reported, not masked", function () {
  var ledger = brokenDiskLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record({ ingressId: id, ingressSequence: 182,
    sessionRef: { projectId: "system-lead", sessionStorageId: COOP_SESSION } });
  ledger._breakDisk();

  // record() used to mask this with `touch(...) || clone(existing)`, returning a
  // truthy record while the canonical event reference reached neither memory
  // nor disk -- and that reference is the whole content of the record.
  var late = ledger.record({ ingressId: id, ingressSequence: 182,
    sessionRef: { projectId: "system-lead", sessionStorageId: COOP_SESSION },
    requestRef: { projectId: "system-lead", sessionStorageId: COOP_SESSION, eventIndex: 7 } });
  assert.equal(late, null);
  assert.equal(ledger.get(id).requestRef, null);
});

test("merging repoints only the source topic's links, never an unrelated topic's", function () {
  // repointCoordinatorLinks rewrote the losing coordinator across EVERY request,
  // so merging A into B silently rewrote an unrelated topic's request from A to
  // B while that topic's canonical claim stayed A -- leaving it with two.
  var ledger = makeLedger();
  var sourceId = open(ledger, 182, TOPIC, [{ projectId: CLAY }]);
  var targetId = open(ledger, 183, OTHER_TOPIC, [{ projectId: CLAY }]);
  var THIRD = { topicId: "auto-cccccccccccccccccccccccc" };
  var unrelatedId = open(ledger, 184, THIRD, [{ projectId: CLAY }]);

  ledger.claimCoordinator({ topicRef: TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_A, ingressId: sourceId });
  ledger.claimCoordinator({ topicRef: OTHER_TOPIC, projectRef: { projectId: CLAY }, coordinator: COORD_B, ingressId: targetId });
  // The unrelated topic legitimately uses coordinator A too.
  ledger.linkExecution(unrelatedId, { coordinator: COORD_A });

  assert.equal(ledger.retopic(TOPIC, OTHER_TOPIC).ok, true);

  // The merged request follows the surviving coordinator.
  assert.deepEqual(ledger.get(sourceId).links.coordinators, [COORD_B]);
  // The unrelated topic is untouched, and still has exactly one coordinator.
  assert.deepEqual(ledger.get(unrelatedId).links.coordinators, [COORD_A],
    "an unrelated topic's link must not be rewritten by someone else's merge");
  assert.deepEqual(ledger.coordinatorsForTopic(THIRD), [COORD_A]);
});
