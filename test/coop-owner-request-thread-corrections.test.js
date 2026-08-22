var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");
var ownerRequests = require("../lib/coop-owner-requests");

// Reassigning a Coop Thread turn to another Thread has to carry the owner
// requests that were made in that turn.
//
// The turn is addressed positionally (start/end event index into the canonical
// transcript) while each owner request carries its own absolute
// requestRef.eventIndex, and those stored indices drift: transcript delta
// coalescing rewrites the transcript on every reload without repointing them.
// On live state essentially none of them still land on their own ingress event
// and most point past the end of the transcript, so the positional range test
// matched nothing -- a reassignment moved zero requests and still reported
// success. These tests pin the identity-resolved behaviour: resolve the owner
// turn by the immutable coopIngressId and range-test where it actually sits.

var COOP_SESSION = "871a194b-8879-40f7-a1fe-656e48e722af";
var OTHER_SESSION = "0f0b2c4b-8a3e-4b62-8f0d-6f3b2b1a9c77";
var FROM_TOPIC = { topicId: "auto-a7daa4cc660639337d144d93" };
var TO_TOPIC = { topicId: "auto-51790c55a2629f5d66444f0c" };

function tempFile() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-thread-corrections-"));
  return path.join(dir, "requests.json");
}

function makeLedger() {
  return ownerRequests.attachCoopOwnerRequests({ file: tempFile() });
}

function ingressId(sequence) {
  return "coop:" + COOP_SESSION + ":" + sequence;
}

function ownerTurn(sequence) {
  return { type: "user_message", text: "please do it", coopIngressId: ingressId(sequence) };
}

function filler(count) {
  var items = [];
  for (var i = 0; i < count; i++) items.push({ type: "assistant_message", text: "delta" });
  return items;
}

// Records an owner request on FROM_TOPIC whose stored requestRef.eventIndex is
// whatever the transcript said when it was written. No implementation decision,
// so the request carries no execution admission and stays movable.
function open(ledger, sequence, storedEventIndex, sessionStorageId) {
  var storageId = sessionStorageId || COOP_SESSION;
  ledger.record({
    ingressId: ingressId(sequence),
    ingressSequence: sequence,
    sessionRef: { projectId: "system-lead", sessionStorageId: storageId },
    requestRef: { projectId: "system-lead", sessionStorageId: storageId,
      eventIndex: storedEventIndex },
  });
  ledger.classify(ingressId(sequence), { kind: "new_topic", topicRef: FROM_TOPIC });
  return ingressId(sequence);
}

function turnRef(start, end) {
  return { sessionStorageId: COOP_SESSION, startEventIndex: start, endEventIndex: end };
}

function topicIdOf(ledger, id) {
  var record = ledger.get(id);
  return record && record.topicRef && record.topicRef.topicId || null;
}

test("a turn reassignment moves a request whose stored event index has drifted", function () {
  var ledger = makeLedger();
  // Written when the ingress sat at 9000; coalescing later rewrote the
  // transcript and the same owner turn now sits at index 12.
  var id = open(ledger, 459, 9000);
  var history = filler(12).concat([ownerTurn(459)], filler(4));
  assert.equal(history[12].coopIngressId, ingressId(459), "the fixture must encode the drift");

  var moved = ledger.retopicTurn(FROM_TOPIC, TO_TOPIC, turnRef(10, 15), history);

  assert.equal(moved.ok, true);
  assert.equal(moved.requests, 1, "the drifted index must not hide the request from its own turn");
  assert.equal(topicIdOf(ledger, id), TO_TOPIC.topicId);
});

test("identity beats a stale index that happens to fall inside the turn", function () {
  var ledger = makeLedger();
  // The stored index lands inside the turn by accident. The owner turn it
  // denotes actually sits at 40, outside the turn, so it must not move.
  var id = open(ledger, 460, 12);
  var history = filler(40).concat([ownerTurn(460)]);

  var moved = ledger.retopicTurn(FROM_TOPIC, TO_TOPIC, turnRef(10, 15), history);

  assert.equal(moved.ok, true);
  assert.equal(moved.requests, 0);
  assert.equal(topicIdOf(ledger, id), FROM_TOPIC.topicId);
});

test("an ingress absent from the transcript falls back to its stored index", function () {
  var ledger = makeLedger();
  var id = open(ledger, 461, 12);
  var history = filler(20).concat([ownerTurn(999)]);

  var moved = ledger.retopicTurn(FROM_TOPIC, TO_TOPIC, turnRef(10, 15), history);

  assert.equal(moved.ok, true);
  assert.equal(moved.requests, 1, "an unresolvable ingress must behave exactly as it did before");
  assert.equal(topicIdOf(ledger, id), TO_TOPIC.topicId);
});

test("a caller that passes no history still matches on the stored index", function () {
  var ledger = makeLedger();
  var id = open(ledger, 462, 12);

  var moved = ledger.retopicTurn(FROM_TOPIC, TO_TOPIC, turnRef(10, 15));

  assert.equal(moved.ok, true);
  assert.equal(moved.requests, 1);
  assert.equal(topicIdOf(ledger, id), TO_TOPIC.topicId);
});

test("a duplicated ingress fails closed instead of guessing a position", function () {
  var ledger = makeLedger();
  var id = open(ledger, 463, 9000);
  // The same ingress appears twice. Resolution refuses to pick a winner, and
  // the drifted stored index it falls back to is outside the turn, so the
  // request stays where it is rather than being moved on a guess.
  var history = filler(11).concat([ownerTurn(463)], filler(1), [ownerTurn(463)]);

  var moved = ledger.retopicTurn(FROM_TOPIC, TO_TOPIC, turnRef(10, 15), history);

  assert.equal(moved.ok, true);
  assert.equal(moved.requests, 0);
  assert.equal(topicIdOf(ledger, id), FROM_TOPIC.topicId);
});

test("a request from another session is never resolved against this transcript", function () {
  var ledger = makeLedger();
  // Same ingress sequence, different session. The session guard has to run
  // before resolution, or this transcript would answer for a turn it does not
  // contain.
  var id = open(ledger, 464, 9000, OTHER_SESSION);
  var history = filler(12).concat([ownerTurn(464)]);

  var moved = ledger.retopicTurn(FROM_TOPIC, TO_TOPIC, turnRef(10, 15), history);

  assert.equal(moved.ok, true);
  assert.equal(moved.requests, 0);
  assert.equal(topicIdOf(ledger, id), FROM_TOPIC.topicId);
});

test("an admitted execution still refuses the whole reassignment", function () {
  var ledger = makeLedger();
  var id = open(ledger, 465, 9000);
  ledger.classify(id, { kind: "new_topic", topicRef: FROM_TOPIC,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } });
  var history = filler(12).concat([ownerTurn(465)]);

  var moved = ledger.retopicTurn(FROM_TOPIC, TO_TOPIC, turnRef(10, 15), history);

  assert.equal(moved.ok, false);
  assert.equal(moved.reason, "execution_already_admitted");
  assert.equal(topicIdOf(ledger, id), FROM_TOPIC.topicId);
});
