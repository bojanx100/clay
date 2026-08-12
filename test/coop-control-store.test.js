var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var controlStore = require("../lib/coop-control-store");

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-store-"));
  return {
    dir: dir,
    dbPath: path.join(dir, "coop-control.sqlite"),
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function availableTest(name, fn) {
  test(name, { skip: !controlStore.isControlStoreAvailable() }, fn);
}

test("the default-off gate is a strict no-op and an explicit false is a kill switch", function () {
  var h = harness();
  try {
    var called = false;
    var store = controlStore.createControlStore({ dbPath: h.dbPath });
    assert.equal(store.enabled, false);
    assert.equal(store.transaction(function () { called = true; }), false);
    assert.equal(called, false);
    assert.equal(fs.existsSync(h.dbPath), false);
    assert.equal(controlStore.isControlStoreEnabled({
      enabled: false,
      env: { CLAY_COOP_CONTROL_STORE: "1" },
    }), false);
    assert.equal(controlStore.isControlStoreEnabled({
      env: { CLAY_COOP_CONTROL_STORE: "1" },
    }), true);
  } finally {
    h.cleanup();
  }
});

test("activation fails explicitly when node:sqlite is unavailable", function () {
  var h = harness();
  try {
    assert.throws(function () {
      controlStore.openControlStore({ dbPath: h.dbPath, sqliteModule: {} });
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_UNAVAILABLE";
    });
    assert.equal(fs.existsSync(h.dbPath), false);
  } finally {
    h.cleanup();
  }
});

availableTest("an activated ControlStore uses WAL and applies migrations in order", function () {
  var h = harness();
  try {
    var store = controlStore.openControlStore({ dbPath: h.dbPath, now: function () { return 1000; } });
    assert.equal(store.enabled, true);
    assert.equal(store.journalMode, "wal");
    assert.equal(store.schemaVersion, controlStore.LATEST_SCHEMA_VERSION);
    assert.deepEqual(store.listMigrations().map(function (row) { return row.version; }), [1, 2]);
    assert.deepEqual(store.listMigrations().map(function (row) { return row.name; }), [
      "control-record-foundation",
      "shadow-comparison-foundation",
    ]);
    store.close();
  } finally {
    h.cleanup();
  }
});

availableTest("an existing database is backed up before an ordered migration", function () {
  var h = harness();
  try {
    var sqlite = require("node:sqlite");
    var db = new sqlite.DatabaseSync(h.dbPath);
    controlStore.MIGRATIONS[0].apply(db);
    db.prepare("INSERT INTO coop_control_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(1, "control-record-foundation", 900);
    db.prepare("INSERT INTO coop_control_records " +
      "(record_type, record_key, revision, canonical_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)")
      .run("owner_request", "coop:test:1", 1, "{\"state\":\"open\"}", 900, 900);
    db.exec("PRAGMA user_version = 1");
    db.close();

    var store = controlStore.openControlStore({ dbPath: h.dbPath, now: function () { return 1000; } });
    assert.ok(store.migration.backupPath);
    assert.equal(fs.existsSync(store.migration.backupPath), true);
    assert.deepEqual(store.listMigrations().map(function (row) { return row.version; }), [1, 2]);

    var backup = new sqlite.DatabaseSync(store.migration.backupPath, { readOnly: true });
    assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM coop_control_records").get().count, 1);
    backup.close();
    store.close();
  } finally {
    h.cleanup();
  }
});

availableTest("integrity checking fails closed without replacing corrupt state", function () {
  var h = harness();
  try {
    var corrupt = Buffer.from("this is durable state, but it is not sqlite\n", "utf8");
    fs.writeFileSync(h.dbPath, corrupt);
    assert.throws(function () {
      controlStore.openControlStore({ dbPath: h.dbPath });
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_INTEGRITY_FAILED";
    });
    assert.deepEqual(fs.readFileSync(h.dbPath), corrupt);
  } finally {
    h.cleanup();
  }
});

availableTest("an injected commit failure rolls back every record in the transaction", function () {
  var h = harness();
  try {
    var failCommit = false;
    var store = controlStore.openControlStore({
      dbPath: h.dbPath,
      faults: {
        beforeCommit: function () {
          if (failCommit) throw new Error("injected commit failure");
        },
      },
    });
    failCommit = true;
    assert.throws(function () {
      store.transaction(function (tx) {
        tx.putControlRecord("owner_request", "coop:test:1", { state: "open" });
        tx.putControlRecord("coordinator_claim", "topic-a:project-a", {
          topicId: "topic-a",
          projectId: "project-a",
        });
      });
    }, /injected commit failure/);
    assert.equal(store.getControlRecord("owner_request", "coop:test:1"), null);
    assert.equal(store.getControlRecord("coordinator_claim", "topic-a:project-a"), null);
    store.close();

    var reopened = controlStore.openControlStore({ dbPath: h.dbPath });
    assert.deepEqual(reopened.listControlRecords(), []);
    reopened.close();
  } finally {
    h.cleanup();
  }
});

availableTest("out-of-scope records and payloads are rejected at the store boundary", function () {
  var h = harness();
  try {
    var store = controlStore.openControlStore({ dbPath: h.dbPath });
    assert.throws(function () {
      store.putControlRecord("topic", "topic-a", { status: "open" });
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_INVALID_RECORD";
    });
    assert.throws(function () {
      store.putControlRecord("checkpoint", "checkpoint-a", {
        sessionRef: { projectId: "project-a", sessionStorageId: "session-a" },
        transcript: "must remain outside",
      });
    }, function (error) {
      return error && error.code === "COOP_CONTROL_STORE_OUT_OF_SCOPE";
    });
    assert.deepEqual(store.listControlRecords(), []);
    store.close();
  } finally {
    h.cleanup();
  }
});
