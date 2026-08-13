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

var AUDITED_ANSWERED = [1, 2, 3, 4, 9, 28, 32, 36, 37, 53, 72, 73, 76,
  79, 82, 86, 103, 104, 106, 107, 115, 116, 126, 127, 128, 129, 131, 134,
  142, 147, 150, 151, 160, 161, 162, 163, 166, 167, 168, 173, 185, 187,
  198, 201, 202, 204, 209, 211, 213, 214, 223, 224];
var AUDITED_SUPERSEDED = [35, 85, 102, 105, 143, 148, 149, 174, 175, 176,
  192, 196, 215, 216];
var AUDITED_INFORMATIONAL = [184];

function auditedHistory() {
  var history = [];
  var responses = {};
  var sequences = AUDITED_ANSWERED.concat(AUDITED_SUPERSEDED, AUDITED_INFORMATIONAL)
    .sort(function (left, right) { return left - right; });
  for (var i = 0; i < sequences.length; i++) {
    var sequence = sequences[i];
    var uncategorised = [1, 2, 3, 4, 9].indexOf(sequence) >= 0;
    history.push(ingress(sequence, uncategorised ? { coopTopicRef: null } : {}));
    if (AUDITED_ANSWERED.indexOf(sequence) >= 0) {
      if (sequence === 187) {
        history.push({ type: "user_message", text: "[Clay direct-leaf completed] Audit report" });
      } else {
        history.push({ type: "delta", text: "Visible answer " + sequence });
      }
      responses[sequence] = history.length - 1;
    }
  }
  history.push(ingress(300));
  return { history: history, responses: responses };
}

function recordAuditPopulation(ledger, history) {
  for (var i = 0; i < history.length; i++) {
    var event = history[i];
    if (event.type !== "user_message" || !event.coopIngressId) continue;
    ledger.record({
      ingressId: event.coopIngressId,
      ingressSequence: event.coopIngressSequence,
      ingressKind: event.coopIngressKind,
      sessionRef: { projectId: "system-lead", sessionStorageId: COOP },
      requestRef: { projectId: "system-lead", sessionStorageId: COOP, eventIndex: i },
      receivedAt: event._ts,
      topicRef: event.coopTopicRef,
    });
  }
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

test("a genuinely repeated turn supersedes the interrupted copy", function () {
  var repeated = "what about 2539?";
  var out = run([ingress(1, { text: repeated }), { type: "delta" },
    ingress(2, { text: "  WHAT ABOUT   2539?  " }),
    { type: "delta" }, { type: "done", code: 0 }]);

  assert.equal(out.result.counts.superseded, 1);
  assert.equal(out.result.counts.answered, 1);
  // Superseded is terminal: the owner withdrew it, so it is not outstanding.
  assert.equal(out.ledger.unanswered().length, 0);
  assert.equal(out.ledger.get("coop:" + COOP + ":1").response.state, "superseded");
});

test("rapid distinct owner questions remain independently unresolved", function () {
  var first = ingress(240, { text: "what about 2539?" });
  var second = ingress(241, { text: "why did Coop miss that question?" });
  var out = run([first, { type: "delta", text: "partial" }, second,
    { type: "delta", text: "Answer to the second question." }, { type: "done", code: 0 }]);

  assert.equal(out.ledger.get(first.coopIngressId).response.state, "unanswered");
  assert.equal(out.ledger.get(second.coopIngressId).response.state, "answered");
  assert.deepEqual(out.ledger.unanswered().map(function (record) {
    return record.ingressSequence;
  }), [240]);
});

test("a turn still in flight is left unanswered", function () {
  var out = run([ingress(1), { type: "delta" }]);
  assert.equal(out.result.counts.unanswered, 1);
});

test("a silent retry terminator follows its automatic continuation to the visible reply", function () {
  var out = run([
    ingress(1), { type: "thinking_stop" }, { type: "done", code: 0 },
    { type: "scheduled_message_queued", text: "↻ Resuming the interrupted response", autoAction: true,
      coopContinuationIngressId: "coop:" + COOP + ":1" },
    { type: "scheduled_message_sent" },
    { type: "user_message", text: "↻ Resuming the interrupted response",
      coopContinuationIngressId: "coop:" + COOP + ":1" },
    { type: "delta", text: "The requested audit is complete." }, { type: "done", code: 0 },
  ]);

  assert.equal(out.result.counts.answered, 1);
  assert.equal(out.result.counts.unanswered, 0);
  assert.equal(out.ledger.get("coop:" + COOP + ":1").response.responseRef.eventIndex, 7);
});

test("an automatic continuation still needs its own visible assistant output", function () {
  var out = run([
    ingress(1), { type: "delta", text: "partial" }, { type: "done", code: 0 },
    { type: "scheduled_message_queued", text: "↻ Resuming the interrupted response", autoAction: true,
      coopContinuationIngressId: "coop:" + COOP + ":1" },
    { type: "scheduled_message_sent" },
    { type: "user_message", text: "↻ Resuming the interrupted response",
      coopContinuationIngressId: "coop:" + COOP + ":1" },
    { type: "done", code: 0 },
  ]);

  assert.equal(out.result.counts.answered, 0);
  assert.equal(out.result.counts.unanswered, 1);
});

test("the #2539 restart audit does not use a Lead tick as response evidence", function () {
  var owner = ingress(239, {
    text: "what about 2539?",
    coopIngressDispatchedAt: 2000,
  });
  var out = run([
    owner,
    { type: "info", text: "Conversation interrupted", _ts: 1500 },
    { type: "done", code: 0, _ts: 1500 },
    { type: "scheduled_message_queued", text: "↻ Lead tick", autoAction: true, _ts: 2100 },
    { type: "scheduled_message_sent", _ts: 2200 },
    { type: "user_message", text: "↻ Lead tick", autoAction: true, _ts: 2201 },
    { type: "delta", text: "Progress on a different question.", _ts: 2300 },
    { type: "done", code: 0, _ts: 2400 },
  ]);

  assert.equal(out.ledger.get(owner.coopIngressId).response.state, "unanswered");
  assert.equal(out.ledger.unanswered().length, 1);
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

test("independent historical evidence settles the exact 67-record population idempotently", function () {
  var fixture = auditedHistory();
  var ledger = ledgerFor();
  recordAuditPopulation(ledger, fixture.history);
  var evidence = {
    answered: AUDITED_ANSWERED.map(function (sequence) {
      return { sequence: sequence, responseEventIndex: fixture.responses[sequence] };
    }),
    superseded: AUDITED_SUPERSEDED,
    informational: AUDITED_INFORMATIONAL,
  };
  var all = AUDITED_ANSWERED.concat(AUDITED_SUPERSEDED, AUDITED_INFORMATIONAL);

  assert.equal(all.length, 67);
  assert.equal(new Set(all).size, 67);
  var first = backfill.reconcileOwnerRequestEvidence(ledger,
    { storageId: COOP, coopHome: true, history: fixture.history }, evidence);
  var second = backfill.reconcileOwnerRequestEvidence(ledger,
    { storageId: COOP, coopHome: true, history: fixture.history }, evidence);

  assert.deepEqual(first, { ok: true,
    counts: { answered: 52, superseded: 14, informational: 1, unchanged: 0 } });
  assert.deepEqual(second, { ok: true,
    counts: { answered: 0, superseded: 0, informational: 0, unchanged: 67 } });
  assert.equal(ledger.unanswered().map(function (record) { return record.ingressSequence; }).join(","), "300");
  assert.equal(ledger.get("coop:" + COOP + ":184").response.state, "not_required");
  assert.equal(ledger.get("coop:" + COOP + ":187").response.responseRef.eventIndex,
    fixture.responses[187]);
  assert.equal(ledger.get("coop:" + COOP + ":131").response.responseRef.eventIndex,
    fixture.responses[131]);
  assert.equal(ledger.list().filter(function (record) { return !record.topicRef; }).length, 5);
});

test("historical reconciliation rejects non-visible response evidence without mutation", function () {
  var fixture = auditedHistory();
  var ledger = ledgerFor();
  recordAuditPopulation(ledger, fixture.history);
  var result = backfill.reconcileOwnerRequestEvidence(ledger,
    { storageId: COOP, coopHome: true, history: fixture.history }, {
      answered: [{ sequence: 1, responseEventIndex: 0 }],
    });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_response_ref");
  assert.equal(ledger.get("coop:" + COOP + ":1").response.state, "unanswered");
});
