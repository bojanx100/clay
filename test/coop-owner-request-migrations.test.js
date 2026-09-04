// The standing repair for drifted requestRef offsets.
//
// requestRef.eventIndex is an absolute offset into a transcript the persistence
// layer re-indexes on every write. Delta coalescing (cf7f197ee1) rewrote the
// canonical transcript and left every stored offset pointing somewhere else;
// measured on live state, 16 of 20 unanswered owner requests no longer landed
// on their own ingress.
//
// Consumers already survive that -- they resolve by coopIngressId and treat the
// offset as a fast path -- but the stored coordinate stayed wrong, so every new
// reader inherited the same rot, and a one-shot repair of the current damage
// would rot again on the next rewrite. The pass under test therefore re-derives
// each offset from identity every time it runs, which is what makes it
// idempotent and drift-proof rather than merely correct today.
//
// What these tests pin, in order of importance:
//   1. drift is actually repaired, and the repair is idempotent;
//   2. it NEVER moves a ref it cannot prove -- unknown ingress, duplicate
//      ingress, or an unreadable transcript all leave the record untouched;
//   3. it is per-session, so a compacted lineage does not get repointed onto a
//      different session's transcript;
//   4. it only ever moves eventIndex, and only through the ledger's own locked
//      compare-and-swap write path.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var migrations = require("../lib/coop-owner-request-migrations");
var ownerRequests = require("../lib/coop-owner-requests");

var LEAD = "system-lead";
var COOP = "871a194b-8879-40f7-a1fe-656e48e722af";
var OLDER = "065eb04d-3fa1-4420-be9a-7f3b249941a1";

function ownerTurn(ingressId, text) {
  return { type: "user_message", text: text || "owner asked something",
    coopIngressId: ingressId, coopIngressSequence: Number(String(ingressId).split(":").pop()),
    _ts: 1000 + Number(String(ingressId).split(":").pop()) };
}

function noise(type) {
  return { type: type || "thinking_delta", _ts: 1 };
}

function ledgerIn(dir) {
  return ownerRequests.attachCoopOwnerRequests({
    file: path.join(dir, "requests.json"),
    now: function () { return 4242; },
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-ref-repair-"));
}

function recordWithRef(ledger, sequence, eventIndex, storageId) {
  var session = storageId || COOP;
  var ingressId = "coop:" + session + ":" + sequence;
  ledger.record({
    ingressId: ingressId,
    ingressSequence: sequence,
    sessionRef: { projectId: LEAD, sessionStorageId: session },
    requestRef: { projectId: LEAD, sessionStorageId: session, eventIndex: eventIndex },
  });
  return ingressId;
}

function storedIndex(ledger, ingressId) {
  var record = ledger.get(ingressId);
  return record && record.requestRef ? record.requestRef.eventIndex : null;
}

// A ledger stub is deliberately NOT used for the apply path: these tests drive
// the real attachCoopOwnerRequests write path, so a repair that cannot actually
// persist would fail here rather than pass against a fake.
function historyMap(map) {
  return function (storageId, use) { return use(map[storageId] || null); };
}

test("a drifted offset is repointed onto the event its ingress identifies", function () {
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var turn = ownerTurn("coop:" + COOP + ":182");
  var history = [noise(), noise("tool_start"), turn, noise("done")];
  // Recorded at 7; coalescing has since moved the turn to 2.
  var ingressId = recordWithRef(ledger, 182, 7);
  assert.equal(storedIndex(ledger, ingressId), 7);

  var drift = migrations.driftedRequestRefs(ledger.list({}),
    historyMap({ [COOP]: history }));
  assert.equal(drift.corrections.length, 1);
  assert.deepEqual(drift.corrections[0],
    { ingressId: ingressId, sessionStorageId: COOP, from: 7, eventIndex: 2 });

  var applied = ledger.repointRequestRefs(drift.corrections);
  assert.equal(applied.ok, true);
  assert.equal(applied.repointed, 1);
  assert.equal(storedIndex(ledger, ingressId), 2);

  // And it survives a reload: the repair is on disk, not just in memory.
  assert.equal(storedIndex(ledgerIn(dir), ingressId), 2);
});

test("the repair is idempotent and reports no drift on a second run", function () {
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var turn = ownerTurn("coop:" + COOP + ":182");
  var history = [noise(), turn];
  var ingressId = recordWithRef(ledger, 182, 9);

  var first = migrations.driftedRequestRefs(ledger.list({}), historyMap({ [COOP]: history }));
  ledger.repointRequestRefs(first.corrections);
  assert.equal(storedIndex(ledger, ingressId), 1);

  // Re-deriving from identity now finds nothing to move. This is the property
  // a pinned-coordinate migration cannot have.
  var second = migrations.driftedRequestRefs(ledger.list({}), historyMap({ [COOP]: history }));
  assert.deepEqual(second.corrections, []);
  var applied = ledger.repointRequestRefs(second.corrections);
  assert.equal(applied.ok, true);
  assert.equal(applied.repointed, 0);
  assert.equal(storedIndex(ledger, ingressId), 1);
});

test("drift is re-repaired after a later rewrite moves the turn again", function () {
  // The whole reason this is a standing pass rather than a one-shot repair:
  // coalescing rots the offset again on every rewrite.
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var turn = ownerTurn("coop:" + COOP + ":182");
  var ingressId = recordWithRef(ledger, 182, 40);

  var first = [noise(), noise(), turn];
  ledger.repointRequestRefs(
    migrations.driftedRequestRefs(ledger.list({}), historyMap({ [COOP]: first })).corrections);
  assert.equal(storedIndex(ledger, ingressId), 2);

  // A second coalescing pass collapses the leading noise.
  var second = [turn, noise("done")];
  ledger.repointRequestRefs(
    migrations.driftedRequestRefs(ledger.list({}), historyMap({ [COOP]: second })).corrections);
  assert.equal(storedIndex(ledger, ingressId), 0,
    "a one-shot repair would have left this at 2 forever");
});

test("refs are resolved against their own session, not the newest one", function () {
  // Owner requests accumulate across a compacted lineage. Resolving a
  // predecessor-session ref against the current transcript would repoint it
  // onto whatever happens to sit at that offset in a different conversation.
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var oldTurn = ownerTurn("coop:" + OLDER + ":10");
  var newTurn = ownerTurn("coop:" + COOP + ":182");
  var oldIngress = recordWithRef(ledger, 10, 99, OLDER);
  var newIngress = recordWithRef(ledger, 182, 99, COOP);

  var drift = migrations.driftedRequestRefs(ledger.list({}), historyMap({
    [OLDER]: [noise(), noise(), noise(), oldTurn],
    [COOP]: [newTurn],
  }));
  ledger.repointRequestRefs(drift.corrections);

  assert.equal(storedIndex(ledger, oldIngress), 3, "predecessor ref resolved in its own session");
  assert.equal(storedIndex(ledger, newIngress), 0, "canonical ref resolved in its own session");
  assert.equal(ledger.get(oldIngress).requestRef.sessionStorageId, OLDER,
    "the session a ref names must never be rewritten");
});

test("a ref whose ingress is absent from the transcript is left alone", function () {
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var ingressId = recordWithRef(ledger, 182, 7);

  var drift = migrations.driftedRequestRefs(ledger.list({}),
    historyMap({ [COOP]: [noise(), noise("done")] }));
  assert.deepEqual(drift.corrections, []);
  assert.deepEqual(drift.unresolved, [ingressId]);
  assert.equal(storedIndex(ledger, ingressId), 7,
    "an unfindable ingress is not evidence the stored offset is wrong");
});

test("a duplicated ingress fails closed rather than guessing", function () {
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var ingressId = recordWithRef(ledger, 182, 7);
  var duplicate = [ownerTurn("coop:" + COOP + ":182"), noise(), ownerTurn("coop:" + COOP + ":182")];

  var drift = migrations.driftedRequestRefs(ledger.list({}), historyMap({ [COOP]: duplicate }));
  assert.deepEqual(drift.corrections, []);
  assert.deepEqual(drift.unresolved, [ingressId]);
  assert.equal(storedIndex(ledger, ingressId), 7,
    "picking a winner among duplicate ingresses is the fail-open move");
});

test("an unreadable transcript leaves every ref in that session untouched", function () {
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var ingressId = recordWithRef(ledger, 182, 7);

  var drift = migrations.driftedRequestRefs(ledger.list({}), historyMap({}));
  assert.deepEqual(drift.corrections, []);
  assert.deepEqual(drift.unresolved, [ingressId]);
  assert.equal(storedIndex(ledger, ingressId), 7);
});

test("the repair moves eventIndex and nothing else on the record", function () {
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var turn = ownerTurn("coop:" + COOP + ":182");
  var ingressId = recordWithRef(ledger, 182, 7);
  ledger.setState(ingressId, "working");
  var before = ledger.get(ingressId);

  ledger.repointRequestRefs(migrations.driftedRequestRefs(ledger.list({}),
    historyMap({ [COOP]: [noise(), turn] })).corrections);
  var after = ledger.get(ingressId);

  assert.equal(after.requestRef.eventIndex, 1);
  assert.notEqual(before.requestRef.eventIndex, after.requestRef.eventIndex);
  // Everything except requestRef.eventIndex and updatedAt must be byte-identical.
  var strip = function (record) {
    var copy = JSON.parse(JSON.stringify(record));
    delete copy.updatedAt;
    copy.requestRef.eventIndex = null;
    return copy;
  };
  assert.deepEqual(strip(after), strip(before));
  assert.equal(after.response.state, "unanswered", "the answer state is not the repair's business");
  assert.equal(after.state, "working");
});

test("a record with no requestRef is skipped rather than given one", function () {
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var ingressId = "coop:" + COOP + ":182";
  ledger.record({
    ingressId: ingressId,
    ingressSequence: 182,
    sessionRef: { projectId: LEAD, sessionStorageId: COOP },
  });
  assert.equal(ledger.get(ingressId).requestRef, null);

  var drift = migrations.driftedRequestRefs(ledger.list({}),
    historyMap({ [COOP]: [ownerTurn(ingressId)] }));
  assert.deepEqual(drift.corrections, []);
  var applied = ledger.repointRequestRefs([
    { ingressId: ingressId, sessionStorageId: COOP, eventIndex: 0 }]);
  assert.equal(applied.repointed, 0);
  assert.equal(ledger.get(ingressId).requestRef, null,
    "minting a missing ref needs evidence this path does not have");
});

test("repointRequestRefs refuses a correction aimed at a different session", function () {
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var ingressId = recordWithRef(ledger, 182, 7, COOP);

  var applied = ledger.repointRequestRefs([
    { ingressId: ingressId, sessionStorageId: OLDER, eventIndex: 0 }]);
  assert.equal(applied.repointed, 0);
  assert.equal(storedIndex(ledger, ingressId), 7,
    "a ref naming a different session is a different claim, not a drifted one");
});

test("repairDriftedRequestRefs resolves through the session manager", function () {
  // End-to-end through the exported entry point the startup path calls,
  // including the per-session lookup, rather than the pure helper.
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var turn = ownerTurn("coop:" + COOP + ":182");
  var ingressId = recordWithRef(ledger, 182, 31);
  var sessions = [{ storageId: COOP, coopHome: true, history: [noise(), noise(), turn] }];
  var sm = { sessions: { forEach: function (fn) { sessions.forEach(fn); } } };

  var result = migrations.repairDriftedRequestRefs(ledger, sm);
  assert.equal(result.ok, true);
  assert.equal(result.repointed, 1);
  assert.deepEqual(result.corrections[0],
    { ingressId: ingressId, from: 31, to: 2, sessionStorageId: COOP });
  assert.equal(storedIndex(ledger, ingressId), 2);
});

test("a ledger without the repoint API is refused rather than half-applied", function () {
  var result = migrations.repairDriftedRequestRefs({ list: function () { return []; } }, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ledger_unavailable");
  assert.equal(result.repointed, 0);
});

test("only one transcript is borrowed at a time and each is handed back", function () {
  // Live state spans 107 sessions carrying owner refs. Holding every referenced
  // transcript at once is the pattern that exhausted the daemon heap before
  // (sessions-history-store exists because of it), and this pass runs on the
  // startup path, so the borrow has to be scoped rather than accumulated.
  var dir = tempDir();
  var ledger = ledgerIn(dir);
  var ids = [];
  for (var s = 0; s < 5; s++) {
    var storageId = "session-" + s;
    ids.push(storageId);
    recordWithRef(ledger, 100 + s, 77, storageId);
  }

  var live = 0;
  var peak = 0;
  var borrowed = [];
  var drift = migrations.driftedRequestRefs(ledger.list({}), function (storageId, use) {
    live++;
    peak = Math.max(peak, live);
    borrowed.push(storageId);
    var history = [noise(), ownerTurn("coop:" + storageId + ":" + (100 + ids.indexOf(storageId)))];
    var out = use(history);
    live--;
    return out;
  });

  assert.equal(peak, 1, "more than one transcript resident at once");
  assert.equal(live, 0, "every borrowed transcript must be handed back");
  assert.deepEqual(borrowed.slice().sort(), ids.slice().sort(),
    "each referenced session must be visited exactly once");
  assert.equal(drift.corrections.length, 5);
});
