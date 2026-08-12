var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");
var conversationControl = require("../lib/coop-conversation-control");
var ownerRequests = require("../lib/coop-owner-requests");
var topicIngress = require("../lib/coop-topic-ingress");

// The seam between the live ingress path and the durable owner-request ledger.
// The ledger's own unit tests prove the rules; these prove the WIRING obeys
// them -- that the thing which actually fires on a real turn is the answer
// hook, and that the things which fire when work starts are not.

var COOP_SESSION = "871a194b-8879-40f7-a1fe-656e48e722af";
var INGRESS = "coop:" + COOP_SESSION + ":182";
var TOPIC = { topicId: "auto-a7daa4cc660639337d144d93" };

function tempLedger() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-ingress-"));
  return ownerRequests.attachCoopOwnerRequests({ file: path.join(dir, "requests.json") });
}

function coopSession(history) {
  return {
    coopHome: true,
    storageId: COOP_SESSION,
    localId: "local-coop",
    history: history || [],
    coopConversationIngress: { nextSequence: 183, recent: [], activeIngressId: INGRESS },
  };
}

function recordIngress(ledger) {
  ledger.record({
    ingressId: INGRESS,
    ingressSequence: 182,
    ingressKind: "text",
    sessionRef: { projectId: "system-lead", sessionStorageId: COOP_SESSION },
    requestRef: { projectId: "system-lead", sessionStorageId: COOP_SESSION, eventIndex: 0 },
  });
}

// --- what counts as an answer -------------------------------------------------

test("a completed turn answers the owner", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  var session = coopSession([{ type: "user_message" }, { type: "result" }, { type: "done", code: 0 }]);

  assert.equal(conversationControl.markIngressAnswered(session, ledger), true);
  assert.equal(ledger.get(INGRESS).response.state, "answered");
  assert.equal(ledger.get(INGRESS).response.responseRef.eventIndex, 2);
});

test("a turn that errored out did not answer the owner", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  var session = coopSession([{ type: "user_message" }, { type: "error" }, { type: "done", code: 1 }]);

  assert.equal(conversationControl.markIngressAnswered(session, ledger), false);
  assert.equal(ledger.get(INGRESS).response.state, "unanswered");
  assert.equal(ledger.unanswered().length, 1);
});

// A Coop priority interrupt aborts the in-flight reply and still reaches the
// per-turn done hook (it sets steerInterruptRequested, which the stream's guard
// treats as a legitimate turn end). Without this check the owner's own
// follow-up would mark their previous question answered.
test("a turn cut short by the owner's next message did not answer the owner", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  var session = coopSession([{ type: "user_message" }, { type: "done", code: 0 }]);
  session.coopPriorityInterruptRequested = true;

  assert.equal(conversationControl.markIngressAnswered(session, ledger), false);
  assert.equal(ledger.get(INGRESS).response.state, "unanswered");
});

test("a turn still in flight has not answered anyone", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  var session = coopSession([{ type: "user_message" }, { type: "delta" }]);

  assert.equal(conversationControl.markIngressAnswered(session, ledger), false);
  assert.equal(ledger.get(INGRESS).response.state, "unanswered");
});

test("with no active ingress there is nothing to answer", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  var session = coopSession([{ type: "done", code: 0 }]);
  session.coopConversationIngress.activeIngressId = null;

  assert.equal(conversationControl.markIngressAnswered(session, ledger), false);
  assert.equal(ledger.get(INGRESS).response.state, "unanswered");
});

test("a non-Coop session never touches the owner-request ledger", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  var worker = { storageId: "09ba91a6-130a-4d44-9f10-3de30f7a10ce", localId: "w1",
    history: [{ type: "done", code: 0 }] };

  assert.equal(conversationControl.markIngressAnswered(worker, ledger), false);
  assert.equal(ledger.get(INGRESS).response.state, "unanswered");
});

test("the answer hook is idempotent across repeated turn-done fanout", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  var session = coopSession([{ type: "user_message" }, { type: "done", code: 0 }]);

  assert.equal(conversationControl.markIngressAnswered(session, ledger), true);
  var first = ledger.get(INGRESS).response.answeredAt;
  // A second fanout for the same ingress must not restamp the answer.
  conversationControl.markIngressAnswered(session, ledger);
  assert.equal(ledger.get(INGRESS).response.answeredAt, first);
});

test("answeringEvent reads the turn terminator, not the newest event", function () {
  assert.deepEqual(conversationControl.answeringEvent({
    history: [{ type: "done", code: 0 }, { type: "user_message" }],
  }), { eventIndex: 0, answered: true });
  assert.equal(conversationControl.answeringEvent({ history: [{ type: "delta" }] }), null);
});

// --- the routing decision carried to the ledger ------------------------------

function routeCtx(route, recorded) {
  return {
    validateCoopTopicIngress: function () { return route; },
    coopControl: {
      isCoopConversation: function () { return true; },
      recordAttention: function (session, code) { recorded.attention = code; },
    },
    sendTo: function () {},
  };
}

test("a freshly minted topic is carried to the ledger as a new topic", function () {
  var msg = { text: "implement this asap" };
  var recorded = {};
  var ok = topicIngress.prepareIngress(
    routeCtx({ ok: true, topicRef: TOPIC, created: true, classification: "new_topic" }, recorded),
    null, msg, {});

  assert.equal(ok, true);
  assert.equal(msg.coopClassification, "new_topic");
  assert.deepEqual(msg.coopTopicRef, TOPIC);
});

test("a reused topic is carried to the ledger as an existing topic", function () {
  var msg = { text: "and the coordinator part too" };
  var ok = topicIngress.prepareIngress(
    routeCtx({ ok: true, topicRef: TOPIC, created: false, classification: "existing_topic" }, {}),
    null, msg, {});

  assert.equal(ok, true);
  assert.equal(msg.coopClassification, "existing_topic");
});

test("a small conversational turn is carried to the ledger as conversational", function () {
  var msg = { text: "yes, continue" };
  topicIngress.prepareIngress(
    routeCtx({ ok: true, topicRef: TOPIC, created: false, classification: "conversational" }, {}),
    null, msg, {});

  assert.equal(msg.coopClassification, "conversational");
  // Conversational turns expect no execution, so nothing downstream may staff
  // a coordinator off the back of one.
  var ledger = tempLedger();
  recordIngress(ledger);
  var record = ledger.classify(INGRESS, { kind: msg.coopClassification, topicRef: TOPIC });
  assert.equal(record.expectsExecution, false);
});

test("an explicitly selected lens with no classifier verdict still reads as a reuse", function () {
  var msg = { text: "carry on here" };
  topicIngress.prepareIngress(routeCtx({ ok: true, topicRef: TOPIC }, {}), null, msg, {});
  assert.equal(msg.coopClassification, "existing_topic");
});

test("a refused route records attention and never reaches the ledger", function () {
  var recorded = {};
  var msg = { text: "do it in the missing project" };
  var ok = topicIngress.prepareIngress(
    routeCtx({ ok: false, code: "project_target_unavailable" }, recorded), null, msg, {});

  assert.equal(ok, false);
  assert.equal(recorded.attention, "project_target_unavailable");
  assert.equal(msg.coopClassification, undefined);
});
