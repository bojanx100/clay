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
