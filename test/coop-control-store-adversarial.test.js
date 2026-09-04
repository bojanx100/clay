var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("crypto");
var fs = require("fs");
var os = require("os");
var path = require("path");
var Worker = require("node:worker_threads").Worker;
var controlStore = require("../lib/coop-control-store");
var shadow = require("../lib/coop-control-shadow");

var PROJECT_A = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var SESSION_A = "871a194b-8879-40f7-a1fe-656e48e722af";
var INGRESS_A = "coop:" + SESSION_A + ":1";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-adversarial-"));
  return {
    dir: dir,
    dbPath: path.join(dir, "coop-control.sqlite"),
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function availableTest(name, fn) {
  test(name, { skip: !controlStore.isControlStoreAvailable() }, fn);
}

function ownerRequest() {
  return {
    ingressId: INGRESS_A,
    ingressSequence: 1,
    ingressKind: "text",
    sessionRef: { projectId: PROJECT_A, sessionStorageId: SESSION_A },
    requestRef: { projectId: PROJECT_A, sessionStorageId: SESSION_A, eventIndex: 10 },
    receivedAt: 100,
    updatedAt: 101,
    response: {
      state: "unanswered",
      answeredAt: null,
      responseRef: null,
      supersededAt: null,
      supersededBy: "",
    },
    classification: { kind: "existing_topic", source: "keyword_overlap", at: 100 },
    topicRef: { topicId: "topic-a" },
    projectRefs: [{ projectId: PROJECT_A }],
    expectsExecution: true,
    links: { coordinators: [], tasks: [], sessions: [] },
    state: "working",
    attention: null,
    outcome: null,
  };
}

function coordinatorClaim() {
  return {
    topicId: "topic-a",
    projectId: PROJECT_A,
    coordinator: { projectId: PROJECT_A, sessionStorageId: SESSION_A },
    claimedAt: 102,
    ingressIds: [INGRESS_A],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function storedProjectionInput() {
  var projection = [
    { recordType: "owner_request", recordKey: INGRESS_A, value: ownerRequest() },
  ];
  var canonicalJson = controlStore.canonicalStringify(projection[0].value);
  return {
    projectionDigest: shadow.projectionDigest(projection),
    records: [{
      recordType: "owner_request",
      recordKey: INGRESS_A,
      canonicalJson: canonicalJson,
      recordDigest: sha256(canonicalJson),
    }],
  };
}

function assertFileUnchanged(file, before) {
  assert.deepEqual(fs.readFileSync(file), before);
}

availableTest("typed record schemas reject aliases, unknown fields, and reserved future writes", function () {
  var h = harness();
  try {
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    var privateAliases = [
      "responseMessage", "transcript_copy", "hiddenPrompt", "reasoningTrace",
      "chainOfThought", "topicContent", "titleForTopic",
    ];
    for (var i = 0; i < privateAliases.length; i++) {
      var privateAlias = ownerRequest();
      privateAlias[privateAliases[i]] = "private content";
      assert.throws(function () {
        store.putControlRecord("owner_request", INGRESS_A, privateAlias);
      }, function (error) {
        return error && error.code === "COOP_CONTROL_STORE_OUT_OF_SCOPE";
      }, privateAliases[i]);
    }

    var unknown = ownerRequest();
    unknown.extraFlag = true;
    assert.throws(function () {
      store.putControlRecord("owner_request", INGRESS_A, unknown);
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_INVALID_RECORD";
    });
    var reserved = ["approval", "checkpoint", "execution_binding", "handoff", "learning", "task"];
    for (var j = 0; j < reserved.length; j++) {
      (function (recordType) {
        assert.throws(function () {
          store.putControlRecord(recordType, recordType + "-a", {});
        }, function (error) {
          return error && error.code === "COOP_CONTROL_STORE_INVALID_RECORD";
        }, recordType);
      })(reserved[j]);
    }

    var written = store.putControlRecord("owner_request", INGRESS_A, ownerRequest());
    assert.deepEqual(written.value.topicRef, { topicId: "topic-a" });
    assert.equal(store.listControlRecords().length, 1);
    store.close();
  } finally {
    h.cleanup();
  }
});

availableTest("shadow replacement rejects malformed wrappers before touching SQLite", function () {
  var h = harness();
  try {
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    var input = storedProjectionInput();
    input.promptCopy = "private prompt";
    assert.throws(function () {
      store.replaceShadowProjection("strict-source", input);
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_OUT_OF_SCOPE";
    });

    input = storedProjectionInput();
    input.records[0].messageBody = "private message";
    assert.throws(function () {
      store.replaceShadowProjection("strict-source", input);
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_OUT_OF_SCOPE";
    });
    assert.throws(function () {
      store.replaceShadowProjection("strict-source", { projectionDigest: input.projectionDigest });
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_INVALID_SHADOW";
    });
    assert.equal(store.getShadowImport("strict-source"), null);
    store.close();
  } finally {
    h.cleanup();
  }
});

availableTest("activation rejects persisted logical privacy corruption without mutation", function () {
  var h = harness();
  try {
    var sqlite = require("node:sqlite");
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    store.putControlRecord("owner_request", INGRESS_A, ownerRequest());
    store.close();

    var corruptValue = ownerRequest();
    corruptValue.reasoningTrace = "private reasoning";
    var db = new sqlite.DatabaseSync(h.dbPath);
    db.prepare("UPDATE coop_control_records SET canonical_json = ? WHERE record_type = ? AND record_key = ?")
      .run(JSON.stringify(corruptValue), "owner_request", INGRESS_A);
    db.close();
    var before = fs.readFileSync(h.dbPath);

    assert.throws(function () {
      controlStore.openControlStore({ dbPath: h.dbPath });
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION";
    });
    assertFileUnchanged(h.dbPath, before);
  } finally {
    h.cleanup();
  }
});

availableTest("activation audits migration and control-row metadata without mutation", function () {
  var corruptions = [
    {
      name: "migration timestamp",
      apply: function (db) { db.exec("UPDATE coop_control_migrations SET applied_at = -1 WHERE version = 1"); },
    },
    {
      name: "control timestamps",
      seed: true,
      apply: function (db) {
        db.exec("UPDATE coop_control_records SET created_at = 200, updated_at = 100");
      },
    },
    {
      name: "reserved record",
      apply: function (db) {
        db.prepare("INSERT INTO coop_control_records VALUES (?, ?, ?, ?, ?, ?)")
          .run("checkpoint", "checkpoint-a", 1, "{}", 100, 100);
      },
    },
  ];
  for (var i = 0; i < corruptions.length; i++) {
    var h = harness();
    try {
      var sqlite = require("node:sqlite");
      var store = controlStore.openControlStore({ dbPath: h.dbPath });
      if (corruptions[i].seed) store.putControlRecord("owner_request", INGRESS_A, ownerRequest());
      store.close();
      var db = new sqlite.DatabaseSync(h.dbPath);
      corruptions[i].apply(db);
      db.close();
      var before = fs.readFileSync(h.dbPath);
      assert.throws(function () {
        controlStore.openControlStore({ dbPath: h.dbPath });
      }, function (error) {
        return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION";
      }, corruptions[i].name);
      assertFileUnchanged(h.dbPath, before);
    } finally {
      h.cleanup();
    }
  }
});

availableTest("fabricated current schemas fail exact validation without mutation", function () {
  var h = harness();
  try {
    var sqlite = require("node:sqlite");
    var db = new sqlite.DatabaseSync(h.dbPath);
    db.exec([
      "CREATE TABLE coop_control_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER);",
      "CREATE TABLE coop_control_records (record_type TEXT, record_key TEXT, revision INTEGER, canonical_json TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (record_type, record_key));",
      "CREATE TABLE coop_control_shadow_imports (source_id TEXT PRIMARY KEY, projection_digest TEXT, record_count INTEGER, imported_at INTEGER);",
      "CREATE TABLE coop_control_shadow_records (source_id TEXT, record_type TEXT, record_key TEXT, canonical_json TEXT, record_digest TEXT, PRIMARY KEY (source_id, record_type, record_key));",
      "CREATE INDEX coop_control_shadow_records_type_idx ON coop_control_shadow_records(source_id, record_type, record_key);",
      "INSERT INTO coop_control_migrations VALUES (1, 'control-record-foundation', 1);",
      "INSERT INTO coop_control_migrations VALUES (2, 'shadow-comparison-foundation', 2);",
      "PRAGMA user_version = 2;",
    ].join("\n"));
    db.close();
    var before = fs.readFileSync(h.dbPath);

    assert.throws(function () {
      controlStore.openControlStore({ dbPath: h.dbPath });
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_SCHEMA_INVALID";
    });
    assertFileUnchanged(h.dbPath, before);
  } finally {
    h.cleanup();
  }
});

availableTest("unexpected nonempty version-zero databases fail closed without mutation", function () {
  var h = harness();
  try {
    var sqlite = require("node:sqlite");
    var db = new sqlite.DatabaseSync(h.dbPath);
    db.exec("CREATE TABLE unrelated_state (value TEXT); INSERT INTO unrelated_state VALUES ('keep me');");
    db.close();
    var before = fs.readFileSync(h.dbPath);

    assert.throws(function () {
      controlStore.openControlStore({ dbPath: h.dbPath });
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_SCHEMA_INVALID";
    });
    assertFileUnchanged(h.dbPath, before);
  } finally {
    h.cleanup();
  }
});

availableTest("transaction capabilities expire after return, throw, and async rejection", async function () {
  var h = harness();
  try {
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    var returnedTx;
    store.transaction(function (tx) { returnedTx = tx; });
    assert.throws(function () {
      returnedTx.putControlRecord("owner_request", INGRESS_A, ownerRequest());
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_TRANSACTION_CLOSED";
    });

    var thrownTx;
    assert.throws(function () {
      store.transaction(function (tx) {
        thrownTx = tx;
        throw new Error("callback failed");
      });
    }, /callback failed/);
    assert.throws(function () {
      thrownTx.putControlRecord("owner_request", INGRESS_A, ownerRequest());
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_TRANSACTION_CLOSED";
    });

    var asyncTx;
    var pending;
    assert.throws(function () {
      store.transaction(function (tx) {
        asyncTx = tx;
        pending = (async function () {
          await new Promise(function (resolve) { setImmediate(resolve); });
          return asyncTx.putControlRecord("owner_request", INGRESS_A, ownerRequest());
        })();
        return pending;
      });
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_INVALID_TRANSACTION";
    });
    await assert.rejects(pending, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_TRANSACTION_CLOSED";
    });
    assert.equal(store.getControlRecord("owner_request", INGRESS_A), null);
    store.close();
  } finally {
    h.cleanup();
  }
});

function concurrentImportWorker(modulePath, dbPath, input, barrierBuffer, importedAt) {
  var source = [
    "var workerThreads = require('node:worker_threads');",
    "var workerData = workerThreads.workerData;",
    "var parentPort = workerThreads.parentPort;",
    "var controlStore = require(workerData.modulePath);",
    "var barrier = new Int32Array(workerData.barrierBuffer);",
    "function now() {",
    "  var prior = Atomics.add(barrier, 0, 1);",
    "  if (prior === 0) Atomics.wait(barrier, 0, 1, 1000);",
    "  else Atomics.notify(barrier, 0);",
    "  return workerData.importedAt;",
    "}",
    "var store = controlStore.openControlStore({ dbPath: workerData.dbPath, now: now });",
    "parentPort.postMessage({ type: 'ready' });",
    "parentPort.once('message', function () {",
    "  try {",
    "    var result = store.replaceShadowProjection('race-source', workerData.input);",
    "    parentPort.postMessage({ type: 'result', result: result });",
    "  } catch (error) {",
    "    parentPort.postMessage({ type: 'error', message: error.message, code: error.code });",
    "  } finally { store.close(); }",
    "});",
  ].join("\n");
  return new Worker(source, {
    eval: true,
    workerData: {
      modulePath: modulePath,
      dbPath: dbPath,
      input: input,
      barrierBuffer: barrierBuffer,
      importedAt: importedAt,
    },
  });
}

availableTest("concurrent identical imports have one winner and preserve its importedAt", async function () {
  var h = harness();
  var workers = [];
  try {
    var initial = controlStore.openControlStore({ dbPath: h.dbPath });
    initial.close();
    var barrierBuffer = new SharedArrayBuffer(4);
    var modulePath = require.resolve("../lib/coop-control-store");
    workers = [
      concurrentImportWorker(modulePath, h.dbPath, storedProjectionInput(), barrierBuffer, 1100),
      concurrentImportWorker(modulePath, h.dbPath, storedProjectionInput(), barrierBuffer, 2200),
    ];
    var ready = 0;
    var results = [];
    await new Promise(function (resolve, reject) {
      function onMessage(worker, message) {
        if (message.type === "ready") {
          ready += 1;
          if (ready === workers.length) {
            for (var i = 0; i < workers.length; i++) workers[i].postMessage({ type: "start" });
          }
          return;
        }
        if (message.type === "error") {
          reject(new Error(message.code + ": " + message.message));
          return;
        }
        results.push(message.result);
        if (results.length === workers.length) resolve();
      }
      for (var i = 0; i < workers.length; i++) {
        (function (worker) {
          worker.on("message", function (message) { onMessage(worker, message); });
          worker.on("error", reject);
        })(workers[i]);
      }
    });

    assert.equal(results.filter(function (result) { return result.changed; }).length, 1);
    var winner = results.filter(function (result) { return result.changed; })[0];
    assert.deepEqual(results.map(function (result) { return result.importedAt; }), [
      winner.importedAt,
      winner.importedAt,
    ]);
    var reopened = controlStore.openControlStore({ dbPath: h.dbPath });
    assert.equal(reopened.getShadowImport("race-source").importedAt, winner.importedAt);
    reopened.close();
  } finally {
    for (var i = 0; i < workers.length; i++) await workers[i].terminate();
    h.cleanup();
  }
});

availableTest("activation audits shadow metadata, foreign keys, and row payloads", function () {
  var corruptions = [
    {
      name: "record count",
      apply: function (db) {
        db.exec("UPDATE coop_control_shadow_imports SET record_count = record_count + 1");
      },
    },
    {
      name: "projection digest",
      apply: function (db) {
        db.exec("UPDATE coop_control_shadow_imports SET projection_digest = '" + "0".repeat(64) + "'");
      },
    },
    {
      name: "foreign key",
      apply: function (db) {
        var input = storedProjectionInput().records[0];
        db.exec("PRAGMA foreign_keys = OFF");
        db.prepare("INSERT INTO coop_control_shadow_records VALUES (?, ?, ?, ?, ?)")
          .run("missing-source", input.recordType, input.recordKey, input.canonicalJson, input.recordDigest);
      },
    },
    {
      name: "record digest",
      apply: function (db) {
        db.exec("UPDATE coop_control_shadow_records SET record_digest = '" + "0".repeat(64) + "'");
      },
    },
    {
      name: "private row payload",
      apply: function (db) {
        var value = ownerRequest();
        value.promptCopy = "private prompt";
        var canonicalJson = controlStore.canonicalStringify(value);
        db.prepare("UPDATE coop_control_shadow_records SET canonical_json = ?, record_digest = ?")
          .run(canonicalJson, sha256(canonicalJson));
      },
    },
  ];

  for (var i = 0; i < corruptions.length; i++) {
    var h = harness();
    try {
      var sqlite = require("node:sqlite");
      var store = controlStore.openControlStore({ dbPath: h.dbPath });
      store.replaceShadowProjection("audit-source", storedProjectionInput());
      store.close();
      var db = new sqlite.DatabaseSync(h.dbPath);
      corruptions[i].apply(db);
      db.close();
      var before = fs.readFileSync(h.dbPath);
      assert.throws(function () {
        controlStore.openControlStore({ dbPath: h.dbPath });
      }, function (error) {
        return error && error.code === "COOP_CONTROL_STORE_LOGICAL_CORRUPTION";
      }, corruptions[i].name);
      assertFileUnchanged(h.dbPath, before);
    } finally {
      h.cleanup();
    }
  }
});
