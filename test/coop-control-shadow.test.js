var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var controlStore = require("../lib/coop-control-store");
var shadow = require("../lib/coop-control-shadow");

var PROJECT_A = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var PROJECT_B = "91a4bfca-8132-4fdc-bfc5-e44203653e47";
var SESSION_A = "871a194b-8879-40f7-a1fe-656e48e722af";
var SESSION_B = "3046a4dc-2b49-47a8-80dc-1511fb809aba";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-shadow-"));
  return {
    dir: dir,
    dbPath: path.join(dir, "coop-control.sqlite"),
    sourcePath: path.join(dir, "coop-owner-requests.json"),
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function request(sequence, state) {
  return {
    ingressId: "coop:" + SESSION_A + ":" + sequence,
    ingressSequence: sequence,
    ingressKind: "text",
    sessionRef: { projectId: PROJECT_A, sessionStorageId: SESSION_A },
    requestRef: { projectId: PROJECT_A, sessionStorageId: SESSION_A, eventIndex: sequence * 10 },
    receivedAt: sequence,
    updatedAt: sequence + 1,
    response: {
      state: state || "unanswered",
      answeredAt: state === "answered" ? sequence + 2 : null,
      responseRef: state === "answered"
        ? { projectId: PROJECT_A, sessionStorageId: SESSION_A, eventIndex: sequence * 10 + 5 }
        : null,
    },
    classification: { kind: "existing_topic", source: "keyword_overlap", at: sequence },
    topicRef: { topicId: "topic-a" },
    projectRefs: [{ projectId: PROJECT_B }, { projectId: PROJECT_A }],
    expectsExecution: true,
    links: {
      coordinators: [
        { projectId: PROJECT_B, sessionStorageId: SESSION_B },
        { projectId: PROJECT_A, sessionStorageId: SESSION_A },
      ],
      tasks: [
        { projectId: PROJECT_B, taskId: "task-b" },
        { projectId: PROJECT_A, taskId: "task-a" },
      ],
      sessions: [],
    },
    state: "working",
    attention: null,
    outcome: { status: "completed", at: sequence + 3, summary: "free-form summary must stay outside" },
    text: "transcript text must stay outside",
  };
}

function claim(topicId, projectId, coordinator, ingressIds) {
  return {
    topicId: topicId,
    projectId: projectId,
    coordinator: { projectId: projectId, sessionStorageId: coordinator },
    claimedAt: 50,
    ingressIds: ingressIds,
  };
}

function state(requests, claims) {
  return {
    schema: "clay.coop_owner_requests",
    version: 1,
    requests: requests,
    coordinators: claims,
  };
}

function availableTest(name, fn) {
  test(name, { skip: !controlStore.isControlStoreAvailable() }, fn);
}

test("canonical projection and digest ignore source and set enumeration order", function () {
  var first = request(1, "unanswered");
  var second = request(2, "answered");
  var firstClaim = claim("topic-a", PROJECT_A, SESSION_A, [first.ingressId, second.ingressId]);
  var secondClaim = claim("topic-a", PROJECT_B, SESSION_B, [second.ingressId, first.ingressId]);
  var forward = [state([first], [firstClaim]), state([second], [secondClaim])];

  var firstReordered = request(1, "unanswered");
  firstReordered.projectRefs.reverse();
  firstReordered.links.coordinators.reverse();
  firstReordered.links.tasks.reverse();
  var secondReordered = request(2, "answered");
  secondReordered.projectRefs.reverse();
  secondReordered.links.coordinators.reverse();
  secondReordered.links.tasks.reverse();
  var firstClaimReordered = claim("topic-a", PROJECT_A, SESSION_A, [second.ingressId, first.ingressId]);
  var secondClaimReordered = claim("topic-a", PROJECT_B, SESSION_B, [first.ingressId, second.ingressId]);
  var reverse = [state([secondReordered], [secondClaimReordered]), state([firstReordered], [firstClaimReordered])];

  assert.equal(shadow.canonicalDigest(forward), shadow.canonicalDigest(reverse));
  assert.deepEqual(shadow.canonicalProjection(forward), shadow.canonicalProjection(reverse));
  var serialized = JSON.stringify(shadow.canonicalProjection(forward));
  assert.equal(serialized.includes("transcript text"), false);
  assert.equal(serialized.includes("free-form summary"), false);
});

availableTest("shadow import reads an existing reference-only store and is idempotent", function () {
  var h = harness();
  try {
    var source = state(
      [request(2, "answered"), request(1, "unanswered")],
      [claim("topic-a", PROJECT_A, SESSION_A, ["coop:" + SESSION_A + ":2", "coop:" + SESSION_A + ":1"])]
    );
    fs.writeFileSync(h.sourcePath, JSON.stringify(source, null, 2) + "\n");
    var tick = 1000;
    var store = controlStore.openControlStore({ dbPath: h.dbPath, now: function () { return tick++; } });
    var imported = shadow.importShadow(store, [h.sourcePath]);
    var again = shadow.importShadow(store, [h.sourcePath]);

    assert.equal(imported.ok, true);
    assert.equal(imported.changed, true);
    assert.equal(imported.recordCount, 3);
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(again.recordCount, 3);
    assert.equal(store.listShadowRecords(shadow.DEFAULT_SOURCE_ID).length, 3);
    assert.equal(store.getShadowImport(shadow.DEFAULT_SOURCE_ID).importedAt, imported.importedAt);
    assert.equal(shadow.compareShadow(store, [h.sourcePath]).match, true);
    store.close();
  } finally {
    h.cleanup();
  }
});

availableTest("comparison reports deterministic mismatch evidence without copying payloads", function () {
  var h = harness();
  try {
    var before = state([request(1, "unanswered")], []);
    var after = state([request(1, "answered"), request(2, "unanswered")], []);
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    shadow.importShadow(store, [before]);
    var comparison = shadow.compareShadow(store, [after]);

    assert.equal(comparison.match, false);
    assert.deepEqual(comparison.mismatches.map(function (entry) { return entry.code; }), [
      "record_digest_mismatch",
      "missing_shadow_record",
    ]);
    assert.deepEqual(comparison.mismatches.map(function (entry) { return entry.recordKey; }), [
      "coop:" + SESSION_A + ":1",
      "coop:" + SESSION_A + ":2",
    ]);
    assert.ok(comparison.sourceDigest);
    assert.ok(comparison.shadowDigest);
    assert.equal(JSON.stringify(comparison).includes("canonicalJson"), false);
    assert.equal(JSON.stringify(comparison).includes("free-form"), false);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("flag-off shadow import does not enumerate or read sources", function () {
  var h = harness();
  try {
    var store = controlStore.createControlStore({ dbPath: h.dbPath, enabled: false });
    var source = {
      list: function () { throw new Error("source must not be enumerated"); },
      listCoordinators: function () { throw new Error("source must not be enumerated"); },
    };
    var result = shadow.importShadow(store, [source]);
    assert.deepEqual(result, {
      ok: true,
      enabled: false,
      changed: false,
      recordCount: 0,
      sourceId: shadow.DEFAULT_SOURCE_ID,
    });
    assert.equal(fs.existsSync(h.dbPath), false);
  } finally {
    h.cleanup();
  }
});

test("topic indexes are rejected as out of scope instead of entering the control store", function () {
  assert.throws(function () {
    shadow.canonicalProjection([{
      schemaVersion: 1,
      canonicalSessionStorageId: SESSION_A,
      topics: {},
    }]);
  }, function (error) {
    return error && error.code === "COOP_CONTROL_SHADOW_SOURCE_OUT_OF_SCOPE";
  });
});

test("direct projections are normalized, sorted, conflict-checked, and privacy-safe", function () {
  var source = state([request(1, "unanswered")], [
    claim("topic-a", PROJECT_A, SESSION_A, ["coop:" + SESSION_A + ":2", "coop:" + SESSION_A + ":1"]),
  ]);
  var projection = shadow.canonicalProjection([source]);
  var reversed = JSON.parse(JSON.stringify(projection));
  reversed.reverse();
  for (var i = 0; i < reversed.length; i++) {
    if (reversed[i].recordType === "coordinator_claim") reversed[i].value.ingressIds.reverse();
    if (reversed[i].recordType === "owner_request") {
      reversed[i].value.projectRefs.reverse();
      reversed[i].value.links.coordinators.reverse();
      reversed[i].value.links.tasks.reverse();
    }
  }
  assert.equal(shadow.projectionDigest(projection), shadow.projectionDigest(reversed));

  var conflicting = JSON.parse(JSON.stringify(projection));
  var duplicate = JSON.parse(JSON.stringify(conflicting[0]));
  duplicate.value.claimedAt += 1;
  conflicting.push(duplicate);
  assert.throws(function () {
    shadow.canonicalProjection(conflicting);
  }, function (error) { return error && error.code === "COOP_CONTROL_SHADOW_CONFLICT"; });

  var privateProjection = JSON.parse(JSON.stringify(projection));
  privateProjection[0].value.messageBody = "private";
  assert.throws(function () {
    shadow.canonicalProjection(privateProjection);
  }, function (error) { return error && error.code === "COOP_CONTROL_STORE_OUT_OF_SCOPE"; });

  var wrongKey = JSON.parse(JSON.stringify(projection));
  for (var j = 0; j < wrongKey.length; j++) {
    if (wrongKey[j].recordType === "owner_request") {
      wrongKey[j].recordKey = "coop:" + SESSION_A + ":999";
    }
  }
  assert.throws(function () {
    shadow.canonicalProjection(wrongKey);
  }, function (error) { return error && error.code === "COOP_CONTROL_STORE_INVALID_RECORD"; });
});

availableTest("comparison reports corrupt shadow metadata with typed mismatches", function () {
  var h = harness();
  try {
    var source = state([request(1, "unanswered")], []);
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    shadow.importShadow(store, [source]);
    var db = new (require("node:sqlite").DatabaseSync)(h.dbPath);
    db.prepare("UPDATE coop_control_shadow_imports SET record_count = ?, projection_digest = ?")
      .run(99, "0".repeat(64));
    db.close();
    var comparison = shadow.compareShadow(store, [source]);
    assert.equal(comparison.match, false);
    assert.deepEqual(comparison.mismatches.map(function (entry) { return entry.code; }), [
      "shadow_record_count_mismatch",
      "projection_digest_mismatch",
    ]);
    store.close();
  } finally {
    h.cleanup();
  }
});
