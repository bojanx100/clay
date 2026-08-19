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

function digestEvent(event) {
  return require("node:crypto").createHash("sha256").update([
    String(event.type || ""), String(event._ts || ""), String(event.text || event.content || ""),
  ].join("\n")).digest("hex");
}

function digestRange(history, start, end) {
  var proof = [];
  for (var i = start; i <= end; i++) proof.push(i + ":" + digestEvent(history[i]));
  return require("node:crypto").createHash("sha256").update(proof.join("\n")).digest("hex");
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

test("an explicit implementation decision persists once across restart backfill", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-backfill-restart-"));
  var file = path.join(dir, "r.json");
  var history = [ingress(281, { text: "ok set it to implement..." })];
  var session = { storageId: COOP, coopHome: true, history: history };
  var firstLedger = ownerRequests.attachCoopOwnerRequests({ file: file });

  backfill.backfillOwnerRequests(firstLedger, session, {});
  var first = firstLedger.get("coop:" + COOP + ":281");
  var restartedLedger = ownerRequests.attachCoopOwnerRequests({ file: file });
  backfill.backfillOwnerRequests(restartedLedger, session, {});
  var replayed = restartedLedger.get("coop:" + COOP + ":281");

  assert.deepEqual(replayed.implementationDecision, first.implementationDecision);
  assert.deepEqual(replayed.implementationDecision, {
    intent: "implement",
    source: "explicit_owner_turn",
    at: 281000,
  });
  assert.equal(restartedLedger.list().length, 1);
});

test("startup migration backfills a proven approval and exact historical responses once", function () {
  var approval = ingress(281, { text: "ok set it to implement..." });
  var missed = ingress(283, { text: "what now?" });
  var response = { type: "delta_replace", text: "The missed request is now answered.", _ts: 300000 };
  var history = [approval, { type: "delta", text: "Approved" }, { type: "done", code: 0 },
    missed, response];
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-startup-backfill-"));
  var file = path.join(dir, "r.json");
  var session = { storageId: COOP, coopHome: true, history: history };
  var sm = { sessions: new Map([[1, session]]) };
  var migrations = [{
    migrationId: "test-proven-history",
    sessionStorageId: COOP,
    requests: [{ sequence: 281, eventIndex: 0, digest: digestEvent(approval) },
      { sequence: 283, eventIndex: 3, digest: digestEvent(missed) }],
    evidence: { answered: [{ sequence: 283, responseEventIndex: 4,
      responseDigest: digestEvent(response) }] },
  }];

  var firstLedger = ownerRequests.attachCoopOwnerRequests({ file: file });
  var first = backfill.migrateOwnerRequestHistory(firstLedger, sm, { migrations: migrations });
  var persistedOnce = fs.readFileSync(file, "utf8");
  var restartedLedger = ownerRequests.attachCoopOwnerRequests({ file: file });
  var replayed = backfill.migrateOwnerRequestHistory(restartedLedger, sm, { migrations: migrations });

  assert.equal(first.ok, true);
  assert.equal(replayed.ok, true);
  assert.equal(firstLedger.get(approval.coopIngressId).implementationDecision.intent, "implement");
  assert.equal(restartedLedger.get(approval.coopIngressId).implementationDecision.intent, "implement");
  assert.equal(restartedLedger.get(missed.coopIngressId).response.state, "answered");
  assert.equal(restartedLedger.get(missed.coopIngressId).response.responseRef.eventIndex, 4);
  assert.equal(restartedLedger.list().length, 2);
  assert.equal(fs.readFileSync(file, "utf8"), persistedOnce,
    "restart replay must not restamp already migrated facts");
  assert.deepEqual(replayed.migrations[0].counts,
    { answered: 0, superseded: 0, informational: 0, unchanged: 1 });
});

test("startup migration can prove two old requests from one exact finalized response range", function () {
  var first = ingress(292, { text: "first old request" });
  var second = ingress(295, { text: "second old request" });
  var history = [first, second,
    { type: "delta", text: "Answered the first exact request.", _ts: 300000 },
    { type: "delta", text: " Answered the second exact request.", _ts: 300001 },
    { type: "done", code: 0, _ts: 300002 }];
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-startup-range-backfill-"));
  var file = path.join(dir, "r.json");
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: file });
  var migrations = [{
    migrationId: "test-proven-response-range",
    sessionStorageId: COOP,
    requestReplay: false,
    requests: [
      { ingressId: first.coopIngressId, sequence: 292, eventIndex: 0, digest: digestEvent(first) },
      { ingressId: second.coopIngressId, sequence: 295, eventIndex: 1, digest: digestEvent(second) },
    ],
    evidence: { answered: [
      { sequence: 292, responseStartEventIndex: 2, responseEventIndex: 4,
        responseDigest: digestRange(history, 2, 4) },
      { sequence: 295, responseStartEventIndex: 2, responseEventIndex: 4,
        responseDigest: digestRange(history, 2, 4) },
    ] },
  }];
  var sm = { sessions: new Map([[1, { storageId: COOP, coopHome: true, history: history }]]) };

  var migrated = backfill.migrateOwnerRequestHistory(ledger, sm, { migrations: migrations });
  var once = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  var replayed = backfill.migrateOwnerRequestHistory(
    ownerRequests.attachCoopOwnerRequests({ file: file }), sm, { migrations: migrations });

  assert.equal(migrated.ok, true);
  assert.equal(ledger.get(first.coopIngressId).response.responseRef.eventIndex, 4);
  assert.equal(ledger.get(second.coopIngressId).response.responseRef.eventIndex, 4);
  assert.equal(replayed.ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), once);
});

test("startup exact-range migration rejects a changed ingress id before writing", function () {
  var request = ingress(292, { text: "old request" });
  var changed = Object.assign({}, request, { coopIngressId: "coop:" + COOP + ":999" });
  var ledger = ledgerFor();
  var result = backfill.migrateOwnerRequestHistory(ledger,
    { sessions: new Map([[1, { storageId: COOP, coopHome: true, history: [changed] }]]) },
    { migrations: [{
      migrationId: "changed-exact-ingress",
      sessionStorageId: COOP,
      requestReplay: false,
      requests: [{ ingressId: request.coopIngressId, sequence: 292,
        eventIndex: 0, digest: digestEvent(request) }],
      evidence: {},
    }] });

  assert.equal(result.ok, false);
  assert.equal(result.migrations[0].reason, "request_evidence_changed");
  assert.equal(ledger.list().length, 0);
});

test("startup response migration fails closed when canonical evidence changed", function () {
  var request = ingress(283, { text: "what now?" });
  var response = { type: "delta_replace", text: "A response.", _ts: 300000 };
  var ledger = ledgerFor();
  var session = { storageId: COOP, coopHome: true, history: [request, response] };
  var result = backfill.migrateOwnerRequestHistory(ledger,
    { sessions: new Map([[1, session]]) }, { migrations: [{
      migrationId: "changed-evidence",
      sessionStorageId: COOP,
      requests: [{ sequence: 283, eventIndex: 0, digest: digestEvent(request) }],
      evidence: { answered: [{ sequence: 283, responseEventIndex: 1,
        responseDigest: "not-the-canonical-digest" }] },
    }] });

  assert.equal(result.ok, false);
  assert.equal(result.migrations[0].reason, "response_evidence_changed");
  assert.equal(ledger.get(request.coopIngressId), null);
});

test("startup migration validates request evidence before recording approval facts", function () {
  var approval = ingress(281, { text: "ok set it to implement..." });
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-startup-backfill-invalid-"));
  var file = path.join(dir, "r.json");
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: file });
  var before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  var result = backfill.migrateOwnerRequestHistory(ledger,
    { sessions: new Map([[1, { storageId: COOP, coopHome: true, history: [approval] }]]) },
    { migrations: [{
      migrationId: "changed-request-evidence",
      sessionStorageId: COOP,
      requests: [{ sequence: 281, eventIndex: 0, digest: "not-the-canonical-digest" }],
      evidence: {},
    }] });

  assert.equal(result.ok, false);
  assert.equal(result.migrations[0].reason, "request_evidence_changed");
  assert.equal(ledger.get(approval.coopIngressId), null);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null, before);
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

// Delta coalescing (cf7f197ee1) joins contiguous `delta` runs when a transcript
// is serialized, so the history reloaded on the next boot is shorter than the
// one a migration's absolute eventIndex values were pinned against. That is what
// wedged the two 2026-08-15 owner-request migrations: indices 147824..152906
// pinned against a ~218k-item transcript, reloaded as 37,831 items. These tests
// pin the fail-closed behaviour for both shapes of that drift.
function coalesceDeltas(history) {
  var out = [];
  var pending = null;
  for (var i = 0; i < history.length; i++) {
    var entry = history[i];
    if (entry.type === "delta" && typeof entry.text === "string") {
      if (pending) pending.text += entry.text;
      else { pending = { type: "delta", text: entry.text, _ts: entry._ts }; out.push(pending); }
      continue;
    }
    pending = null;
    out.push(entry);
  }
  return out;
}

test("startup migration fails closed when coalescing shifts pinned indices onto other events",
  function () {
    var request = ingress(283, { text: "what now?" });
    var response = { type: "delta_replace", text: "Answered.", _ts: 300000 };
    // Pre-coalescing shape: a three-chunk delta run ahead of the request.
    var uncoalesced = [
      { type: "delta", text: "a", _ts: 1 }, { type: "delta", text: "b", _ts: 2 },
      { type: "delta", text: "c", _ts: 3 }, request, response,
    ];
    var migrations = [{
      migrationId: "coalescing-shifted-indices",
      sessionStorageId: COOP,
      requests: [{ sequence: 283, eventIndex: 3, digest: digestEvent(request) }],
      evidence: { answered: [{ sequence: 283, responseEventIndex: 4,
        responseDigest: digestEvent(response) }] },
    }];
    // Sanity: the evidence verifies against the transcript it was pinned against.
    var okLedger = ledgerFor();
    assert.equal(backfill.migrateOwnerRequestHistory(okLedger,
      { sessions: new Map([[1, { storageId: COOP, coopHome: true, history: uncoalesced }]]) },
      { migrations: migrations }).ok, true);

    // After coalescing the run collapses to one entry, so index 3 is now the
    // response and index 4 is off the end. The request is still present at
    // index 1 with an unchanged digest -- only the coordinate moved.
    var coalesced = coalesceDeltas(uncoalesced);
    assert.equal(coalesced.length, 3);
    assert.equal(digestEvent(coalesced[1]), digestEvent(request));

    var ledger = ledgerFor();
    var result = backfill.migrateOwnerRequestHistory(ledger,
      { sessions: new Map([[1, { storageId: COOP, coopHome: true, history: coalesced }]]) },
      { migrations: migrations });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "migration_evidence_changed");
    assert.equal(result.migrations[0].reason, "request_evidence_changed");
    assert.equal(result.migrations[0].migrationId, "coalescing-shifted-indices");
    assert.equal(ledger.get(request.coopIngressId), null,
      "a migration that cannot verify its coordinates must not touch the ledger");
  });

test("startup migration fails closed when pinned indices run past a shortened transcript",
  function () {
    var request = ingress(281, { text: "ok set it to implement..." });
    var ledger = ledgerFor();
    var result = backfill.migrateOwnerRequestHistory(ledger,
      { sessions: new Map([[1, { storageId: COOP, coopHome: true, history: [request] }]]) },
      { migrations: [{
        migrationId: "2026-08-15-coop-bootstrap-responses",
        sessionStorageId: COOP,
        // The exact live coordinate that coalescing invalidated.
        requests: [{ sequence: 281, eventIndex: 147824, digest: digestEvent(request) }],
        evidence: {},
      }] });

    assert.equal(result.ok, false);
    assert.equal(result.migrations[0].reason, "request_evidence_changed");
    assert.equal(ledger.get(request.coopIngressId), null);
  });

test("retired defaults leave startup migration clean instead of wedged", function () {
  // Both 2026-08-15 owner-request migrations are retired: they had already
  // applied, and their pinned coordinates cannot verify after coalescing.
  // Shipping zero defaults must report ok rather than failing closed forever.
  assert.deepEqual(require("../lib/coop-owner-request-migrations").defaults, []);

  var request = ingress(281, { text: "ok set it to implement..." });
  var ledger = ledgerFor();
  var result = backfill.migrateOwnerRequestHistory(ledger,
    { sessions: new Map([[1, { storageId: COOP, coopHome: true, history: [request] }]]) },
    { sessionStorageId: COOP });

  assert.equal(result.ok, true);
  assert.deepEqual(result.migrations, []);
  assert.equal(backfill.describeMigrationFailure(result), null);
});

test("already-answered requests make the retired migrations a provable no-op", function () {
  // The retirement argument rests on markAnswered's "first answer wins" rule:
  // whatever coordinate a re-run would supply, an answered record is untouched.
  var request = ingress(283, { text: "what now?" });
  var response = { type: "delta_replace", text: "Answered.", _ts: 300000 };
  var history = [request, response];
  var ledger = ledgerFor();
  var session = { storageId: COOP, coopHome: true, history: history };
  var evidence = { answered: [{ sequence: 283, responseEventIndex: 1,
    responseDigest: digestEvent(response) }] };
  recordAuditPopulation(ledger, history);
  assert.equal(ledger.get(request.coopIngressId).response.state, "unanswered");

  assert.equal(backfill.reconcileOwnerRequestEvidence(ledger, session, evidence).ok, true);
  var answeredAt = ledger.get(request.coopIngressId).response.answeredAt;
  assert.equal(ledger.get(request.coopIngressId).response.responseRef.eventIndex, 1);

  var again = backfill.reconcileOwnerRequestEvidence(ledger, session, evidence);
  assert.equal(again.ok, true);
  assert.deepEqual(again.counts, { answered: 0, superseded: 0, informational: 0, unchanged: 1 });
  assert.equal(ledger.get(request.coopIngressId).response.answeredAt, answeredAt);
  assert.equal(ledger.get(request.coopIngressId).response.responseRef.eventIndex, 1);
});

// The wedged migration reported only the generic "migration_evidence_changed" to
// ~/.clay/recovery-events-dev.log for two boots, so the discriminating inner
// reason had to be re-derived by hand against the live store. It must reach the
// canary from now on.
test("failure detail carries the discriminating inner reason to the canary", function () {
  var detail = backfill.describeMigrationFailure({
    ok: false, reason: "migration_evidence_changed",
    backfill: { ok: false, reason: "migration_evidence_changed", counts: {} },
    migrations: [{ migrationId: "2026-08-15-lead-tick-response-linkage",
      ok: false, reason: "response_evidence_changed" }],
  });

  assert.deepEqual(detail, { reason: "migration_evidence_changed",
    migrations: [{ migrationId: "2026-08-15-lead-tick-response-linkage",
      reason: "response_evidence_changed" }] });
  assert.ok(JSON.stringify(detail).indexOf("response_evidence_changed") !== -1);
});

test("failure detail keeps reporting backfill-only causes and drops passing entries", function () {
  assert.equal(backfill.describeMigrationFailure({
    ok: false, backfill: { ok: false, reason: "coop_session_missing" }, migrations: [],
  }), "coop_session_missing");

  assert.equal(backfill.describeMigrationFailure({
    ok: false, reason: "coop_session_missing", migrations: [],
  }), "coop_session_missing");

  var mixed = backfill.describeMigrationFailure({
    ok: false, reason: "migration_evidence_changed",
    migrations: [{ migrationId: "applied", ok: true, counts: {} },
      { migrationId: "wedged", ok: false, reason: "request_evidence_changed" }],
  });
  assert.deepEqual(mixed.migrations,
    [{ migrationId: "wedged", reason: "request_evidence_changed" }]);
});
