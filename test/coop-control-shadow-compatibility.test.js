// Compatibility repairs for the Slice 1 shadow projection. Each test pins one
// defect where the reference-only Coop owner ledger accepts a value that the
// ControlStore projection either dropped, mis-typed, or crashed on.

var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("crypto");
var fs = require("fs");
var os = require("os");
var path = require("path");
var controlStore = require("../lib/coop-control-store");
var validation = require("../lib/coop-control-store-validation");
var shadow = require("../lib/coop-control-shadow");

var PROJECT_A = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var SESSION_A = "871a194b-8879-40f7-a1fe-656e48e722af";
var INGRESS_ONE = "coop:" + SESSION_A + ":1";
var INGRESS_TWO = "coop:" + SESSION_A + ":2";
var EVIDENCE_KEYS = [
  "actualCount", "actualDigest", "code", "expectedCount", "expectedDigest", "recordKey", "recordType",
];

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-shadow-compat-"));
  return {
    dbPath: path.join(dir, "coop-control.sqlite"),
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function request(sequence, overrides) {
  var base = {
    ingressId: "coop:" + SESSION_A + ":" + sequence,
    ingressSequence: sequence,
    ingressKind: "text",
    sessionRef: { projectId: PROJECT_A, sessionStorageId: SESSION_A },
    requestRef: { projectId: PROJECT_A, sessionStorageId: SESSION_A, eventIndex: sequence },
    receivedAt: 10,
    updatedAt: 11,
    response: { state: "unanswered" },
    classification: { kind: "existing_topic", source: "keyword_overlap", at: 10 },
    topicRef: { topicId: "topic-a" },
    projectRefs: [{ projectId: PROJECT_A }],
    expectsExecution: true,
    links: { coordinators: [], tasks: [], sessions: [] },
    state: "working",
    attention: null,
    outcome: null,
  };
  return Object.assign(base, overrides || {});
}

function state(requests) {
  return {
    schema: shadow.OWNER_REQUEST_SCHEMA,
    version: shadow.OWNER_REQUEST_VERSION,
    requests: requests,
    coordinators: [],
  };
}

function firstValue(source) {
  return shadow.canonicalProjection([source])[0].value;
}

function codes(comparison) {
  return comparison.mismatches.map(function (entry) { return entry.code; });
}

function assertBoundedEvidence(comparison) {
  for (var i = 0; i < comparison.mismatches.length; i++) {
    var keys = Object.keys(comparison.mismatches[i]);
    for (var j = 0; j < keys.length; j++) {
      assert.ok(EVIDENCE_KEYS.indexOf(keys[j]) !== -1, "unexpected evidence field " + keys[j]);
    }
    assert.ok(comparison.mismatches[i].recordType === "" ||
      validation.CONTROL_RECORD_TYPES[comparison.mismatches[i].recordType] === true);
    assert.ok(comparison.mismatches[i].recordKey === "" ||
      validation.IDENTIFIER_RE.test(comparison.mismatches[i].recordKey));
  }
}

function availableTest(name, fn) {
  test(name, { skip: !controlStore.isControlStoreAvailable() }, fn);
}

// F1 -- a valid-JSON shadow row corrupted underneath an already-open store must
// produce a stable comparison verdict, not an exception, and must never echo a
// corrupt field name or payload back to the caller.
availableTest("F1: corrupt shadow payloads compare as bounded mismatches and still fail activation closed", function () {
  var h = harness();
  try {
    var source = state([request(1)]);
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    shadow.importShadow(store, [source]);
    var corruptValue = firstValue(source);
    corruptValue.promptCopy = "private prompt body";
    var corruptJson = controlStore.canonicalStringify(corruptValue);
    var db = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    db.prepare("UPDATE coop_control_shadow_records SET canonical_json = ?, record_digest = ?")
      .run(corruptJson, sha256(corruptJson));
    db.close();

    var comparison = shadow.compareShadow(store, [source]);
    assert.equal(comparison.match, false);
    assert.ok(codes(comparison).indexOf("shadow_record_invalid") !== -1);
    assert.notEqual(comparison.sourceDigest, comparison.shadowDigest);
    assertBoundedEvidence(comparison);
    var serialized = JSON.stringify(comparison);
    assert.equal(serialized.includes("promptCopy"), false);
    assert.equal(serialized.includes("private prompt"), false);
    assert.deepEqual(shadow.compareShadow(store, [source]), comparison);
    store.close();

    assert.throws(function () {
      controlStore.openControlStore({ dbPath: h.dbPath });
    }, function (error) { return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION"; });
  } finally {
    h.cleanup();
  }
});

availableTest("F1: corrupt shadow row identities are bounded out of the comparison evidence", function () {
  var h = harness();
  try {
    var source = state([request(1)]);
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    shadow.importShadow(store, [source]);
    var db = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    db.prepare("UPDATE coop_control_shadow_records SET record_type = ?, record_key = ?")
      .run("narrative record of the owner conversation", "prose key with spaces");
    db.close();

    var comparison = shadow.compareShadow(store, [source]);
    assert.equal(comparison.match, false);
    assertBoundedEvidence(comparison);
    var serialized = JSON.stringify(comparison);
    assert.equal(serialized.includes("narrative"), false);
    assert.equal(serialized.includes("prose key"), false);
    store.close();
  } finally {
    h.cleanup();
  }
});

availableTest("F1: projection digest includes the exact persisted JSON representation", function () {
  var h = harness();
  try {
    var source = state([request(1)]);
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    shadow.importShadow(store, [source]);
    var noncanonicalJson = JSON.stringify(firstValue(source), null, 2);
    assert.notEqual(noncanonicalJson, controlStore.canonicalStringify(firstValue(source)));
    var db = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    db.prepare("UPDATE coop_control_shadow_records SET canonical_json = ?, record_digest = ?")
      .run(noncanonicalJson, sha256(noncanonicalJson));
    db.close();

    var comparison = shadow.compareShadow(store, [source]);
    assert.equal(comparison.match, false);
    assert.notEqual(comparison.sourceDigest, comparison.shadowDigest);
    assert.ok(codes(comparison).indexOf("projection_digest_mismatch") !== -1);
    assert.ok(codes(comparison).indexOf("shadow_record_invalid") !== -1);
    assertBoundedEvidence(comparison);
    store.close();
  } finally {
    h.cleanup();
  }
});

// F2 -- the adjacent ledger normalizes an unknown ingress sequence to 0, so the
// projection has to accept 0 rather than abort every downstream record.
test("F2: reference requests normalized to ingressSequence 0 project deterministically", function () {
  var zero = state([request(1, { ingressSequence: 0 })]);
  var unparsable = state([request(1, { ingressSequence: "not-a-number" })]);
  assert.equal(firstValue(zero).ingressSequence, 0);
  assert.equal(shadow.canonicalDigest([zero]), shadow.canonicalDigest([unparsable]));
});

availableTest("F2: ingressSequence 0 imports and compares idempotently", function () {
  var h = harness();
  try {
    var source = state([request(1, { ingressSequence: 0 })]);
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    var imported = shadow.importShadow(store, [source]);
    var again = shadow.importShadow(store, [source]);
    assert.equal(imported.changed, true);
    assert.equal(again.changed, false);
    assert.equal(shadow.compareShadow(store, [source]).match, true);
    store.close();
  } finally {
    h.cleanup();
  }
});

// F3 -- `supersede()` writes bounded control codes such as `owner_interrupt`,
// and the adjacent ledger caps them at 40 characters. Those values are the
// evidence; silently blanking them made every superseded request look identical.
test("F3: bounded supersededBy control values survive projection exactly", function () {
  var forty = "owner_interrupt_after_coordinator_stop" + "_z";
  assert.equal(forty.length, validation.SUPERSEDED_BY_LIMIT);
  var values = ["owner_interrupt", forty.slice(0, 39), forty];
  for (var i = 0; i < values.length; i++) {
    var source = state([request(1, {
      response: { state: "superseded", supersededAt: 12, supersededBy: values[i] },
    })]);
    assert.equal(firstValue(source).response.supersededBy, values[i]);
  }
});

test("F3: unbounded supersededBy prose is represented without admitting the prose", function () {
  var prose = "owner interrupted while reading";
  var projected = firstValue(state([request(1, {
    response: { state: "superseded", supersededAt: 12, supersededBy: prose },
  })])).response.supersededBy;
  var other = firstValue(state([request(1, {
    response: { state: "superseded", supersededAt: 12, supersededBy: "coordinator stopped the reply" },
  })])).response.supersededBy;
  assert.match(projected, validation.CODE_RE);
  // The stand-in spends the whole 40-character budget on digest, not a fixed
  // short prefix: a truncated digest would collide sooner than the bound allows.
  assert.equal(projected.length, validation.SUPERSEDED_BY_LIMIT);
  assert.equal(projected.includes("interrupted"), false);
  assert.notEqual(projected, other);
  assert.equal(projected, firstValue(state([request(1, {
    response: { state: "superseded", supersededAt: 12, supersededBy: prose },
  })])).response.supersededBy);
});

// F4 -- the adjacent ledger accepts any 40-character outcome status, including
// prose. That must not abort the projection, and it must not become writable
// data either: direct writes still require a bounded code.
test("F4: non-code outcome status projects deterministically without admitting prose", function () {
  var prose = "failed (dependency missing)";
  var source = state([request(1, { outcome: { status: prose, at: 20, summary: "long prose summary" } })]);
  var value = firstValue(source);
  assert.match(value.outcome.status, validation.CODE_RE);
  assert.equal(value.outcome.at, 20);
  var serialized = JSON.stringify(value);
  assert.equal(serialized.includes("dependency"), false);
  assert.equal(serialized.includes("prose summary"), false);
  assert.equal(shadow.canonicalDigest([source]),
    shadow.canonicalDigest([state([request(1, { outcome: { status: prose, at: 20 } })])]));
  assert.equal(firstValue(state([request(1, { outcome: { status: "completed", at: 20 } })])).outcome.status,
    "completed");
});

// classification.source is length-bounded by the ledger too (64 characters), so
// it was silently blanked for exactly the same reason outcome.status aborted.
test("F4: non-code classification source stands in at full width and stays unwritable", function () {
  var prose = "keyword overlap with the previous topic";
  var projected = firstValue(state([request(1, {
    classification: { kind: "existing_topic", source: prose, at: 10 },
  })])).classification;
  assert.match(projected.source, validation.CODE_RE);
  assert.equal(projected.source.length, 64);
  assert.equal(projected.source.includes("overlap"), false);
  // Deterministic for the same prose, distinct for different prose: a blanking
  // projection satisfies neither, which is what silently hid the difference.
  assert.equal(projected.source, firstValue(state([request(1, {
    classification: { kind: "existing_topic", source: prose, at: 10 },
  })])).classification.source);
  assert.notEqual(projected.source, firstValue(state([request(1, {
    classification: { kind: "existing_topic", source: prose + " again", at: 10 },
  })])).classification.source);
  assert.equal(firstValue(state([request(1, {
    classification: { kind: "existing_topic", source: "keyword_overlap", at: 10 },
  })])).classification.source, "keyword_overlap");
  assert.equal(firstValue(state([request(1, {
    classification: { kind: "existing_topic", source: "", at: 10 },
  })])).classification.source, "");

  var value = firstValue(state([request(1)]));
  value.classification = { kind: "existing_topic", source: prose, at: 10 };
  assert.throws(function () {
    validation.normalizeWritableRecord("owner_request", INGRESS_ONE, value);
  }, function (error) { return error && error.code === "COOP_CONTROL_STORE_INVALID_RECORD"; });
});

test("F4: direct writable validation still rejects a non-code outcome status", function () {
  var value = firstValue(state([request(1, { outcome: { status: "completed", at: 20 } })]));
  value.outcome = { status: "failed (dependency missing)", at: 20 };
  assert.throws(function () {
    validation.normalizeWritableRecord("owner_request", INGRESS_ONE, value);
  }, function (error) { return error && error.code === "COOP_CONTROL_STORE_INVALID_RECORD"; });
});

test("F4: direct writable outcome status enforces the ledger's 40-character bound", function () {
  var accepted = firstValue(state([request(1, { outcome: { status: "a".repeat(40), at: 20 } })]));
  assert.equal(validation.normalizeWritableRecord("owner_request", INGRESS_ONE, accepted).outcome.status,
    "a".repeat(40));
  var rejected = firstValue(state([request(1, { outcome: { status: "completed", at: 20 } })]));
  rejected.outcome.status = "a".repeat(41);
  assert.throws(function () {
    validation.normalizeWritableRecord("owner_request", INGRESS_ONE, rejected);
  }, function (error) { return error && error.code === "COOP_CONTROL_STORE_INVALID_RECORD"; });
});

availableTest("metadata record counts compare against the source count and the stored rows", function () {
  var h = harness();
  try {
    var source = state([request(1), request(2)]);
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    shadow.importShadow(store, [source]);
    var db = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    db.prepare("DELETE FROM coop_control_shadow_records WHERE record_key = ?").run(INGRESS_TWO);
    db.close();

    var divergence = shadow.compareShadow(store, [source]);
    assert.equal(divergence.match, false);
    assert.ok(codes(divergence).indexOf("missing_shadow_record") !== -1);
    var stored = divergence.mismatches.filter(function (entry) {
      return entry.code === "shadow_stored_count_divergence";
    })[0];
    assert.deepEqual([stored.expectedCount, stored.actualCount], [2, 1]);
    assert.equal(codes(divergence).indexOf("shadow_record_count_mismatch"), -1);
    assertBoundedEvidence(divergence);

    var reopened = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    reopened.prepare("UPDATE coop_control_shadow_imports SET record_count = ?").run(5);
    reopened.close();
    var sourceCount = shadow.compareShadow(store, [source]).mismatches.filter(function (entry) {
      return entry.code === "shadow_record_count_mismatch";
    })[0];
    assert.deepEqual([sourceCount.expectedCount, sourceCount.actualCount], [2, 5]);
    store.close();
  } finally {
    h.cleanup();
  }
});
