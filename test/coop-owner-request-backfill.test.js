var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");
var backfill = require("../lib/coop-owner-request-backfill");
var ownerRequests = require("../lib/coop-owner-requests");

// Reconstructing outstanding owner requests from the canonical transcript.
//
// The rule under test is the one the live path uses: a `done` is not evidence
// of an answer. Clay writes done(0) on turns that were aborted -- the owner
// asked, Coop emitted "Conversation interrupted", and nobody replied. Counting
// those as answered is exactly how days of unanswered requests stayed invisible.

var COOP = "871a194b-8879-40f7-a1fe-656e48e722af";
var TOPIC = { topicId: "auto-a7daa4cc660639337d144d93" };

function ingress(sequence, extra) {
  return Object.assign({
    type: "user_message",
    coopIngressId: "coop:" + COOP + ":" + sequence,
    coopIngressSequence: sequence,
    coopIngressKind: "text",
    coopTopicRef: TOPIC,
    _ts: 1000 * sequence,
    text: "owner text " + sequence,
  }, extra || {});
}

function ledgerFor() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-backfill-"));
  return ownerRequests.attachCoopOwnerRequests({ file: path.join(dir, "r.json") });
}

function run(history) {
  var ledger = ledgerFor();
  var result = backfill.backfillOwnerRequests(ledger,
    { storageId: COOP, coopHome: true, history: history }, {});
  return { ledger: ledger, result: result };
}

test("a turn with assistant output before its terminator answered the owner", function () {
  var out = run([ingress(1), { type: "delta" }, { type: "done", code: 0 }]);
  assert.equal(out.result.counts.answered, 1);
  assert.equal(out.result.counts.unanswered, 0);
  assert.equal(out.ledger.unanswered().length, 0);
});

test("an aborted turn did NOT answer the owner, despite done(0)", function () {
  // The exact shape the live transcript records for an aborted Coop turn.
  var out = run([ingress(1),
    { type: "thinking_stop" },
    { type: "info", text: "■ Conversation interrupted - tell the model what to do differently." },
    { type: "done", code: 0 }]);

  assert.equal(out.result.counts.answered, 0);
  assert.equal(out.result.counts.unanswered, 1);
  assert.equal(out.ledger.unanswered()[0].ingressSequence, 1);
});

test("an interruption notice discards partial output that preceded it", function () {
  var out = run([ingress(1), { type: "delta" },
    { type: "info", text: "Interrupted · What should Claude do instead?" },
    { type: "done", code: 0 }]);
  assert.equal(out.result.counts.unanswered, 1);
});

test("an errored turn did not answer the owner", function () {
  var out = run([ingress(1), { type: "delta" }, { type: "error" }, { type: "done", code: 1 }]);
  assert.equal(out.result.counts.unanswered, 1);
});

test("a turn the owner replaced before it finished is superseded, not unanswered", function () {
  var out = run([ingress(1), { type: "delta" },
    ingress(2), { type: "delta" }, { type: "done", code: 0 }]);

  assert.equal(out.result.counts.superseded, 1);
  assert.equal(out.result.counts.answered, 1);
  // Superseded is terminal: the owner withdrew it, so it is not outstanding.
  assert.equal(out.ledger.unanswered().length, 0);
  assert.equal(out.ledger.get("coop:" + COOP + ":1").response.state, "superseded");
});

test("a turn still in flight is left unanswered", function () {
  var out = run([ingress(1), { type: "delta" }]);
  assert.equal(out.result.counts.unanswered, 1);
});

test("the backfill is idempotent and never re-answers", function () {
  var ledger = ledgerFor();
  var history = [ingress(1), { type: "thinking_stop" },
    { type: "info", text: "Conversation interrupted" }, { type: "done", code: 0 },
    ingress(2), { type: "delta" }, { type: "done", code: 0 }];
  var session = { storageId: COOP, coopHome: true, history: history };

  var first = backfill.backfillOwnerRequests(ledger, session, {});
  var second = backfill.backfillOwnerRequests(ledger, session, {});
  assert.deepEqual(first.counts, second.counts);
  assert.equal(ledger.unanswered().length, 1);
  assert.equal(ledger.list().length, 2);
});

test("backfilled requests carry the canonical event reference, not the text", function () {
  var out = run([ingress(1), { type: "delta" }, { type: "done", code: 0 }]);
  var record = out.ledger.get("coop:" + COOP + ":1");

  assert.deepEqual(record.requestRef,
    { projectId: "system-lead", sessionStorageId: COOP, eventIndex: 0 });
  assert.deepEqual(record.topicRef, TOPIC);
  assert.equal(record.receivedAt, 1000);
  assert.equal(JSON.stringify(record).indexOf("owner text"), -1);
});

test("a backfilled classification never invents execution intent", function () {
  var out = run([ingress(1), { type: "delta" }, { type: "done", code: 0 }]);
  var record = out.ledger.get("coop:" + COOP + ":1");
  // It landed on a topic -- a fact. Whether that topic was new at the time is
  // not recoverable, so it reads as a reuse rather than a fresh workstream.
  assert.equal(record.classification.kind, "existing_topic");
  assert.equal(record.classification.source, "transcript_backfill");
});

test("auditOwnerRequests reports state without touching any ledger", function () {
  var audited = backfill.auditOwnerRequests([
    ingress(1), { type: "info", text: "Conversation interrupted" }, { type: "done", code: 0 },
    ingress(2), { type: "delta" }, { type: "done", code: 0 },
  ]);
  assert.deepEqual(audited.map(function (a) { return a.state; }), ["unanswered", "answered"]);
  assert.equal(audited[0].eventIndex, 0);
});

test("history with no owner ingress audits to nothing", function () {
  assert.deepEqual(backfill.auditOwnerRequests([{ type: "delta" }, { type: "done", code: 0 }]), []);
  assert.deepEqual(backfill.auditOwnerRequests(null), []);
});
