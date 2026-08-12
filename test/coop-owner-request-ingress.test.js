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
  var session = coopSession([{ type: "user_message" }, { type: "delta" }, { type: "done", code: 0 }]);
  session.coopPriorityInterruptRequested = true;

  conversationControl.markIngressAnswered(session, ledger);
  assert.notEqual(ledger.get(INGRESS).response.state, "answered");
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
  var session = coopSession([{ type: "user_message" }, { type: "result" }, { type: "done", code: 0 }]);

  assert.equal(conversationControl.markIngressAnswered(session, ledger), true);
  var first = ledger.get(INGRESS).response.answeredAt;
  // A second fanout for the same ingress must not restamp the answer.
  conversationControl.markIngressAnswered(session, ledger);
  assert.equal(ledger.get(INGRESS).response.answeredAt, first);
});

test("answeringEvent reads the turn terminator, not the newest event", function () {
  // A bare done with no assistant output before it answered nobody.
  assert.deepEqual(conversationControl.answeringEvent({
    history: [{ type: "delta" }, { type: "done", code: 0 }, { type: "user_message" }],
  }), { eventIndex: 1, answered: true });
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

// --- the ledger is never resolved implicitly ---------------------------------
//
// Regression: the ingress seam used to fall back to the process-wide default
// ledger when none was injected. That put the owner's real
// ~/.clay/lead/coop-owner-requests.json on the hot path of anything that drove
// the ingress pipeline -- and a test doing exactly that wrote a fixture record
// into it. No injection now means no durable write, anywhere.

var coopIngressModule = require("../lib/project-user-message-coop");

test("the ingress seam records nothing when no ledger is injected", function () {
  var saved = [];
  var seam = coopIngressModule.attachCoopForegroundIngress({
    sm: { saveSessionFile: function (session) { saved.push(session); } },
  });
  var session = coopSession([{ type: "user_message", coopIngressId: INGRESS }]);
  var metadata = { coopIngress: { ingressId: INGRESS, sequence: 182, kind: "text", key: "k" } };

  // Must not throw, and must still do its original job of stamping the item.
  seam.recordPrepared(session, metadata, { coopTopicRef: { topicId: "t" } }, "prepared");
  assert.equal(session.history[0].coopIngressPreparedText, "prepared");
  assert.equal(saved.length, 1);
  assert.equal(seam.recordUnroutable(session,
    { coop: true, ingressId: INGRESS, sequence: 182, kind: "text" }, "project_target_unavailable"), null);
});

test("the answer hook records nothing when no ledger is injected", function () {
  var session = coopSession([{ type: "user_message" }, { type: "done", code: 0 }]);
  assert.equal(conversationControl.markIngressAnswered(session, null), false);
});

test("an injected ledger is the one that is written", function () {
  var ledger = tempLedger();
  var seam = coopIngressModule.attachCoopForegroundIngress({
    coopOwnerRequests: ledger,
    sm: { saveSessionFile: function () {} },
  });
  var session = coopSession([{ type: "user_message", coopIngressId: INGRESS }]);
  seam.recordPrepared(session,
    { coopIngress: { ingressId: INGRESS, sequence: 182, kind: "text", key: "k" } },
    { coopTopicRef: TOPIC, coopClassification: "existing_topic" }, "prepared");

  var record = ledger.get(INGRESS);
  assert.equal(record.response.state, "unanswered");
  assert.deepEqual(record.topicRef, TOPIC);
  assert.equal(record.requestRef.eventIndex, 0);
  assert.equal(record.classification.kind, "existing_topic");
});

// --- the interrupt flag must be consumed, not left sticky --------------------
//
// Regression, found by review: coopPriorityInterruptRequested is set in
// enqueueCoopIngress and reset nowhere in the daemon, unlike its siblings
// taskStopRequested/steerInterruptRequested which sdk-bridge-stream clears.
// Guarding on it without consuming it meant ONE routine interrupt -- the owner
// typing a follow-up while Coop was mid-reply -- silently stopped every later
// turn on that session from ever being marked answered.

test("an interrupted request is superseded, not left dangling forever", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  var session = coopSession([{ type: "user_message" }, { type: "delta" }, { type: "done", code: 0 }]);
  session.coopPriorityInterruptRequested = true;

  assert.equal(conversationControl.markIngressAnswered(session, ledger), true);
  var record = ledger.get(INGRESS);
  assert.equal(record.response.state, "superseded", "the owner withdrew it; nobody answered it");
  assert.equal(record.response.answeredAt, null);
  assert.equal(record.response.supersededBy, "owner_interrupt");
  // Terminal, so it stops pinning the owner queue and the Lead tick.
  assert.equal(ledger.unanswered().length, 0);
  assert.equal(ledger.hasUnansweredOwnerRequests(), false);
});

test("the interrupt flag is consumed so the NEXT turn can still be answered", function () {
  var ledger = tempLedger();
  var second = "coop:" + COOP_SESSION + ":183";
  recordIngress(ledger);
  var session = coopSession([{ type: "user_message" }, { type: "delta" }, { type: "done", code: 0 }]);
  session.coopPriorityInterruptRequested = true;
  conversationControl.markIngressAnswered(session, ledger);
  assert.equal(session.coopPriorityInterruptRequested, false, "the flag must not stay set");

  // The follow-up turn completes normally and MUST be recorded as answered.
  ledger.record({ ingressId: second, ingressSequence: 183,
    sessionRef: { projectId: "system-lead", sessionStorageId: COOP_SESSION } });
  session.coopConversationIngress.activeIngressId = second;
  session.history = [{ type: "user_message" }, { type: "result" }, { type: "done", code: 0 }];

  assert.equal(conversationControl.markIngressAnswered(session, ledger), true);
  assert.equal(ledger.get(second).response.state, "answered");
});

// --- a done(0) is not an answer on its own -----------------------------------

test("a stream-drop retry does not answer the owner", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  // sdk-bridge-stream emits info + done(0) and then RESUMES the same turn.
  var session = coopSession([{ type: "user_message" }, { type: "info" }, { type: "done", code: 0 }]);
  session.streamEndedAutoRetryQueued = true;

  assert.equal(conversationControl.markIngressAnswered(session, ledger), false);
  assert.equal(ledger.get(INGRESS).response.state, "unanswered");
  assert.equal(ledger.unanswered().length, 1);
});

test("a turn that produced no assistant output did not answer anyone", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  var session = coopSession([{ type: "user_message" }, { type: "info" }, { type: "done", code: 0 }]);

  assert.equal(conversationControl.markIngressAnswered(session, ledger), false);
  assert.deepEqual(conversationControl.answeringEvent(session), { eventIndex: 2, answered: false });
});

test("output from an earlier turn is not this turn's answer", function () {
  // Turn 1 replied; turn 2 produced nothing before its own done.
  var history = [
    { type: "user_message" }, { type: "result" }, { type: "done", code: 0 },
    { type: "user_message" }, { type: "info" }, { type: "done", code: 0 },
  ];
  assert.deepEqual(conversationControl.answeringEvent({ history: history }),
    { eventIndex: 5, answered: false });
});

test("a superseded request is never counted as answered", function () {
  var ledger = tempLedger();
  recordIngress(ledger);
  ledger.supersede(INGRESS, "owner_interrupt");
  var record = ledger.get(INGRESS);

  assert.equal(record.response.state, "superseded");
  assert.notEqual(record.response.state, "answered");
  // And a later real answer cannot overwrite the withdrawal.
  assert.equal(ledger.markAnswered(INGRESS, { eventIndex: 5 }).response.state, "superseded");
});
