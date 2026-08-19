var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var snapshot = require("../scripts/snapshot-control-store");

var sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch (loadError) {
  sqlite = null;
}

var DatabaseSync = sqlite ? sqlite.DatabaseSync : null;

function availableTest(name, fn) {
  test(name, { skip: !DatabaseSync }, fn);
}

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-snapshot-"));
  return {
    dir: dir,
    dbPath: path.join(dir, "coop-control.sqlite"),
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// Builds a WAL-mode store whose committed rows live in an uncheckpointed WAL,
// which is precisely the shape the live control store is in. The returned
// handle stays open so the WAL is never checkpointed out from under the test.
function openWalStore(dbPath, rowCount) {
  var db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = wal;");
  db.exec("CREATE TABLE coop_control_executions (execution_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);");
  db.exec("CREATE TABLE coop_control_incarnations (incarnation_id TEXT PRIMARY KEY);");
  var insert = db.prepare("INSERT INTO coop_control_executions VALUES (?, ?)");
  for (var i = 0; i < rowCount; i++) insert.run("exec:" + i, 1000 + i);
  return db;
}

availableTest("a main-file-only copy of a WAL store loses committed rows", function (t) {
  var h = harness();
  t.after(h.cleanup);
  var live = openWalStore(h.dbPath, 150);
  t.after(function () { live.close(); });

  assert.ok(fs.existsSync(h.dbPath + "-wal"), "the WAL sidecar should exist");
  assert.ok(fs.statSync(h.dbPath + "-wal").size > 0, "the WAL should hold uncheckpointed frames");

  // This is exactly what every `coop-control.sqlite.pre-*.bak` did.
  var naivePath = path.join(h.dir, "naive.bak");
  fs.copyFileSync(h.dbPath, naivePath);

  var naive = new DatabaseSync(naivePath, { readOnly: true });
  t.after(function () { naive.close(); });
  var recovered = 0;
  try {
    recovered = naive.prepare("SELECT COUNT(*) AS total FROM coop_control_executions").get().total;
  } catch (missingTable) {
    recovered = -1; // main file so stale the table is not even present
  }
  assert.notEqual(recovered, 150, "a main-file-only copy must not be mistaken for a complete backup");
});

availableTest("snapshotControlStore captures every committed row from the WAL", function (t) {
  var h = harness();
  t.after(h.cleanup);
  var live = openWalStore(h.dbPath, 150);
  t.after(function () { live.close(); });

  var result = snapshot.snapshotControlStore({
    source: h.dbPath,
    out: path.join(h.dir, "snapshots", "snap.sqlite"),
  });

  assert.equal(result.journalMode, "wal");
  assert.equal(result.liveExecutions, 150);
  assert.equal(result.snapshotExecutions, 150, "the snapshot must contain all committed rows");
  assert.equal(result.tables, 2);
  assert.ok(result.bytes > 0);

  // The snapshot is self-contained: no sidecars, and readable on its own.
  assert.ok(!fs.existsSync(result.destPath + "-wal"), "snapshot must not need a -wal sidecar");
  var reopened = new DatabaseSync(result.destPath, { readOnly: true });
  t.after(function () { reopened.close(); });
  assert.equal(reopened.prepare("SELECT COUNT(*) AS total FROM coop_control_executions").get().total, 150);

  // And it demonstrates the delta it just avoided.
  assert.ok(result.mainFileOnly.ok === false || result.mainFileOnly.executions < 150,
    "the reported main-file-only count should show the rows a .bak would have lost");
});

availableTest("the source store is left untouched by a snapshot", function (t) {
  var h = harness();
  t.after(h.cleanup);
  var live = openWalStore(h.dbPath, 20);
  t.after(function () { live.close(); });

  var before = fs.statSync(h.dbPath);
  snapshot.snapshotControlStore({ source: h.dbPath, out: path.join(h.dir, "out", "snap.sqlite") });
  var after = fs.statSync(h.dbPath);

  assert.equal(after.size, before.size, "snapshotting must not rewrite the live main file");
  assert.equal(live.prepare("SELECT COUNT(*) AS total FROM coop_control_executions").get().total, 20);
});

availableTest("snapshots refuse to land beside the live store or clobber a file", function (t) {
  var h = harness();
  t.after(h.cleanup);
  var live = openWalStore(h.dbPath, 5);
  t.after(function () { live.close(); });

  assert.throws(function () {
    snapshot.snapshotControlStore({ source: h.dbPath, out: path.join(h.dir, "beside.sqlite") });
  }, /Refusing to write a snapshot into the live store directory/);

  var out = path.join(h.dir, "snapshots", "snap.sqlite");
  snapshot.snapshotControlStore({ source: h.dbPath, out: out });
  assert.throws(function () {
    snapshot.snapshotControlStore({ source: h.dbPath, out: out });
  }, /already exists/);
});

availableTest("the audit flags legacy main-file-only .bak files as behind the live store", function (t) {
  var h = harness();
  t.after(h.cleanup);
  var live = openWalStore(h.dbPath, 150);
  t.after(function () { live.close(); });

  // A stale hand-made backup: main file only, taken with rows still in the WAL.
  fs.copyFileSync(h.dbPath, h.dbPath + ".pre-something-20260819T184100Z.bak");

  var report = snapshot.auditLegacyBackups({ source: h.dbPath });
  assert.equal(report.liveExecutions, 150);
  assert.equal(report.backups.length, 1);

  var row = report.backups[0];
  assert.equal(row.name, "coop-control.sqlite.pre-something-20260819T184100Z.bak");
  // Either the table is missing outright or it is short: both mean "do not restore".
  assert.ok(row.error !== null || row.behind > 0,
    "a main-file-only .bak must be reported as unreadable or behind the live store");
});

availableTest("a default snapshot path is derived from CLAY_HOME", function () {
  var previous = process.env.CLAY_HOME;
  process.env.CLAY_HOME = path.join(os.tmpdir(), "clay-home-fixture");
  try {
    assert.equal(snapshot.defaultSourcePath(),
      path.join(process.env.CLAY_HOME, "lead", "coop-control.sqlite"));
    assert.equal(snapshot.defaultSnapshotDir(),
      path.join(process.env.CLAY_HOME, "control-store-snapshots"));
  } finally {
    if (previous === undefined) delete process.env.CLAY_HOME;
    else process.env.CLAY_HOME = previous;
  }
});
