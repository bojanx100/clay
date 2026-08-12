var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");
var ownerRequests = require("../lib/coop-owner-requests");

// The owner-request ledger is the durable record of what the owner asked and
// whether the owner was answered. It is reference-only, exactly like the topic
// index: it stores canonical event references, never transcript copies.
//
// Its one load-bearing rule is that starting work is NOT answering. A worker
// spawning, a coordinator binding, a task moving to running -- none of these
// may ever flip a request to answered. Only the owner-facing turn completing
// does that.

var LEAD_PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var COOP_SESSION = "871a194b-8879-40f7-a1fe-656e48e722af";
var TOPIC = { topicId: "auto-a7daa4cc660639337d144d93" };
var OTHER_TOPIC = { topicId: "auto-51790c55a2629f5d66444f0c" };

function tempFile(name) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-requests-"));
  return path.join(dir, name || "coop-owner-requests.json");
}

function makeLedger(options) {
  var opts = options || {};
  var clock = { value: opts.start || 1000 };
  var ledger = ownerRequests.attachCoopOwnerRequests({
    file: opts.file || tempFile(),
    now: function () { return clock.value; },
  });
  ledger._clock = clock;
  return ledger;
}

function ingress(sequence, extra) {
  return Object.assign({
    ingressId: "coop:" + COOP_SESSION + ":" + sequence,
    ingressSequence: sequence,
    ingressKind: "text",
    sessionRef: { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION },
    requestRef: { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION, eventIndex: sequence * 10 },
  }, extra || {});
}

// --- the request record itself ----------------------------------------------

test("recording an ingress creates an unanswered, reference-only request", function () {
  var ledger = makeLedger();
  var record = ledger.record(ingress(182));

  assert.equal(record.ingressId, "coop:" + COOP_SESSION + ":182");
  assert.equal(record.ingressSequence, 182);
  assert.equal(record.ingressKind, "text");
  assert.equal(record.response.state, "unanswered");
  assert.equal(record.response.answeredAt, null);
  assert.equal(record.state, "open");
  assert.equal(record.outcome, null);
  assert.deepEqual(record.requestRef,
    { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION, eventIndex: 1820 });
  // Reference-only: the ledger never copies what the owner wrote.
  assert.equal(JSON.stringify(record).indexOf("text\":\"") , -1);
});

test("a request without a usable ingress id is rejected rather than stored under a guessed key", function () {
  var ledger = makeLedger();
  assert.equal(ledger.record({ ingressSequence: 1 }), null);
  assert.equal(ledger.record(null), null);
  assert.equal(ledger.list().length, 0);
});

test("recording the same ingress twice is idempotent and never resets an answer", function () {
  var ledger = makeLedger();
  ledger.record(ingress(182));
  ledger.markAnswered("coop:" + COOP_SESSION + ":182", { eventIndex: 1825 });

  var again = ledger.record(ingress(182));
  assert.equal(again.response.state, "answered");
  assert.equal(ledger.list().length, 1);
});

// --- response semantics: worker start is not an answer -----------------------

test("linking a coordinator does NOT answer the owner", function () {
  var ledger = makeLedger();
  ledger.record(ingress(182));
  ledger.linkExecution("coop:" + COOP_SESSION + ":182", {
    coordinator: { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
  });

  var record = ledger.get("coop:" + COOP_SESSION + ":182");
  assert.equal(record.response.state, "unanswered", "spawning work must never count as answering");
  assert.equal(record.links.coordinators.length, 1);
  assert.equal(ledger.unanswered().length, 1);
});

test("linking tasks, workers and moving to working leaves the request unanswered", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger.linkExecution(id, { task: { projectId: LEAD_PROJECT, taskId: "task-1" } });
  ledger.linkExecution(id, {
    session: { projectId: LEAD_PROJECT, sessionStorageId: "09ba91a6-130a-4d44-9f10-3de30f7a10ce" },
  });
  ledger.setState(id, "working");

  var record = ledger.get(id);
  assert.equal(record.state, "working");
  assert.equal(record.response.state, "unanswered");
  assert.equal(ledger.unanswered().length, 1);
});

test("markAnswered is the only transition to answered and is stamped with the reply event", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger._clock.value = 2000;
  var record = ledger.markAnswered(id, { eventIndex: 1825 });

  assert.equal(record.response.state, "answered");
  assert.equal(record.response.answeredAt, 2000);
  assert.deepEqual(record.response.responseRef,
    { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION, eventIndex: 1825 });
  assert.equal(ledger.unanswered().length, 0);
});

test("answering does not close the request: work may still be running", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger.setState(id, "working");
  ledger.markAnswered(id, { eventIndex: 1825 });

  var record = ledger.get(id);
  assert.equal(record.response.state, "answered");
  assert.equal(record.state, "working", "an answered owner still has work in flight");
});

test("the first answer wins: a later turn cannot restamp an answered request", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger._clock.value = 2000;
  ledger.markAnswered(id, { eventIndex: 1825 });
  ledger._clock.value = 5000;
  var record = ledger.markAnswered(id, { eventIndex: 1900 });

  assert.equal(record.response.answeredAt, 2000);
  assert.equal(record.response.responseRef.eventIndex, 1825);
});

// --- classification ----------------------------------------------------------

test("classification records the routing decision durably", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.classify(id, {
    kind: "existing_topic",
    topicRef: TOPIC,
    projectRefs: [{ projectId: LEAD_PROJECT }],
    source: "keyword_overlap",
  });

  assert.equal(record.classification.kind, "existing_topic");
  assert.equal(record.classification.source, "keyword_overlap");
  assert.deepEqual(record.topicRef, TOPIC);
  assert.deepEqual(record.projectRefs, [{ projectId: LEAD_PROJECT }]);
});

test("a conversational classification carries no ProjectRef and expects no execution", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":180";
  ledger.record(ingress(180));
  var record = ledger.classify(id, { kind: "conversational", topicRef: OTHER_TOPIC, source: "low_information" });

  assert.equal(record.classification.kind, "conversational");
  assert.deepEqual(record.projectRefs, []);
  assert.equal(record.expectsExecution, false);
});

test("new_topic and existing_topic both expect execution once a ProjectRef is resolved", function () {
  var ledger = makeLedger();
  ledger.record(ingress(1));
  ledger.record(ingress(2));
  var created = ledger.classify("coop:" + COOP_SESSION + ":1",
    { kind: "new_topic", topicRef: TOPIC, projectRefs: [{ projectId: LEAD_PROJECT }] });
  var reused = ledger.classify("coop:" + COOP_SESSION + ":2",
    { kind: "existing_topic", topicRef: TOPIC, projectRefs: [{ projectId: LEAD_PROJECT }] });

  assert.equal(created.expectsExecution, true);
  assert.equal(reused.expectsExecution, true);
});

test("an unresolved ProjectRef records attention instead of silently dropping the request", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.recordAttention(id, "project_target_unavailable");

  assert.equal(record.state, "attention");
  assert.equal(record.attention, "project_target_unavailable");
  // Attention is an owner-blocking state, so the request is still outstanding.
  assert.equal(record.response.state, "unanswered");
});

test("an unknown attention code is normalized rather than stored as free prose", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.recordAttention(id, "the project named foo/bar could not be found on disk");

  assert.equal(record.attention, "attention_required");
});

// --- unanswered priority -----------------------------------------------------

test("unanswered returns oldest-first so the longest-waiting owner request leads", function () {
  var ledger = makeLedger();
  ledger.record(ingress(180));
  ledger.record(ingress(181));
  ledger.record(ingress(182));
  ledger.markAnswered("coop:" + COOP_SESSION + ":181", { eventIndex: 1815 });

  var pending = ledger.unanswered();
  assert.deepEqual(pending.map(function (r) { return r.ingressSequence; }), [180, 182]);
});

test("unanswered requests outrank routine work and say so", function () {
  var ledger = makeLedger();
  ledger.record(ingress(182));
  assert.equal(ledger.hasUnansweredOwnerRequests(), true);
  ledger.markAnswered("coop:" + COOP_SESSION + ":182", { eventIndex: 1825 });
  assert.equal(ledger.hasUnansweredOwnerRequests(), false);
});

test("a request answered but still working is not unanswered", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger.markAnswered(id, { eventIndex: 1825 });
  ledger.setState(id, "working");

  assert.equal(ledger.unanswered().length, 0);
  assert.equal(ledger.hasUnansweredOwnerRequests(), false);
});

// --- fan-in ------------------------------------------------------------------

test("an execution outcome fans into the request without inventing an answer", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger.classify(id, { kind: "new_topic", topicRef: TOPIC, projectRefs: [{ projectId: LEAD_PROJECT }] });
  ledger.setState(id, "working");
  ledger._clock.value = 3000;
  var record = ledger.applyOutcome(id, { status: "completed", summary: "Shipped the flow." });

  assert.equal(record.state, "done");
  assert.equal(record.outcome.status, "completed");
  assert.equal(record.outcome.at, 3000);
  assert.equal(record.response.state, "unanswered",
    "a completed execution is evidence, not an answer to the owner");
});

test("a failed execution moves the request to attention, not done", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.applyOutcome(id, { status: "failed", summary: "Route unavailable." });

  assert.equal(record.state, "attention");
  assert.equal(record.outcome.status, "failed");
});

test("a needs_input outcome projects the owner decision onto the request", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.applyOutcome(id, { status: "needs_input" });

  assert.equal(record.state, "needs_input");
});

test("requests for one topic are queryable so a follow-up finds the existing work", function () {
  var ledger = makeLedger();
  ledger.record(ingress(181));
  ledger.record(ingress(182));
  ledger.record(ingress(183));
  ledger.classify("coop:" + COOP_SESSION + ":181", { kind: "new_topic", topicRef: TOPIC });
  ledger.classify("coop:" + COOP_SESSION + ":182", { kind: "existing_topic", topicRef: TOPIC });
  ledger.classify("coop:" + COOP_SESSION + ":183", { kind: "new_topic", topicRef: OTHER_TOPIC });
  ledger.linkExecution("coop:" + COOP_SESSION + ":181", {
    coordinator: { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
  });

  var forTopic = ledger.forTopic(TOPIC);
  assert.deepEqual(forTopic.map(function (r) { return r.ingressSequence; }), [181, 182]);
  assert.deepEqual(ledger.coordinatorsForTopic(TOPIC), [
    { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
  ]);
});

// --- durability --------------------------------------------------------------

test("the ledger survives a restart with response and link state intact", function () {
  var file = tempFile();
  var first = makeLedger({ file: file });
  var id = "coop:" + COOP_SESSION + ":182";
  first.record(ingress(182));
  first.classify(id, { kind: "new_topic", topicRef: TOPIC, projectRefs: [{ projectId: LEAD_PROJECT }] });
  first.linkExecution(id, {
    coordinator: { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
  });

  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: file });
  var record = reloaded.get(id);
  assert.equal(record.response.state, "unanswered");
  assert.deepEqual(record.topicRef, TOPIC);
  assert.equal(record.links.coordinators.length, 1);
  assert.equal(reloaded.unanswered().length, 1);
});

test("links are deduplicated so a retried delegation does not inflate the record", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  var coordinator = { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" };
  ledger.record(ingress(182));
  ledger.linkExecution(id, { coordinator: coordinator });
  ledger.linkExecution(id, { coordinator: coordinator });

  assert.equal(ledger.get(id).links.coordinators.length, 1);
});

test("mutations against an unknown ingress id are no-ops, never silent inserts", function () {
  var ledger = makeLedger();
  assert.equal(ledger.markAnswered("coop:missing:1", {}), null);
  assert.equal(ledger.classify("coop:missing:1", { kind: "new_topic" }), null);
  assert.equal(ledger.linkExecution("coop:missing:1", {}), null);
  assert.equal(ledger.applyOutcome("coop:missing:1", { status: "completed" }), null);
  assert.equal(ledger.list().length, 0);
});
