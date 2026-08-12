// Ordered SQLite schema migrations for the recoverable Coop control kernel.
// This database is intentionally narrow: it reserves durable control-record
// slots and shadow-comparison evidence, never topics, transcripts, projections,
// runtime context, or model reasoning.

var fs = require("fs");
var path = require("path");

function taggedError(code, message, cause) {
  var error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function applyControlRecordFoundation(db) {
  db.exec([
    "CREATE TABLE coop_control_migrations (",
    "  version INTEGER PRIMARY KEY CHECK (version > 0),",
    "  name TEXT NOT NULL,",
    "  applied_at INTEGER NOT NULL",
    ") STRICT;",
    "CREATE TABLE coop_control_records (",
    "  record_type TEXT NOT NULL,",
    "  record_key TEXT NOT NULL,",
    "  revision INTEGER NOT NULL CHECK (revision > 0),",
    "  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),",
    "  created_at INTEGER NOT NULL,",
    "  updated_at INTEGER NOT NULL,",
    "  PRIMARY KEY (record_type, record_key)",
    ") STRICT;",
  ].join("\n"));
}

function applyShadowComparisonFoundation(db) {
  db.exec([
    "CREATE TABLE coop_control_shadow_imports (",
    "  source_id TEXT PRIMARY KEY,",
    "  projection_digest TEXT NOT NULL,",
    "  record_count INTEGER NOT NULL CHECK (record_count >= 0),",
    "  imported_at INTEGER NOT NULL",
    ") STRICT;",
    "CREATE TABLE coop_control_shadow_records (",
    "  source_id TEXT NOT NULL,",
    "  record_type TEXT NOT NULL,",
    "  record_key TEXT NOT NULL,",
    "  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),",
    "  record_digest TEXT NOT NULL,",
    "  PRIMARY KEY (source_id, record_type, record_key),",
    "  FOREIGN KEY (source_id) REFERENCES coop_control_shadow_imports(source_id) ON DELETE CASCADE",
    ") STRICT;",
    "CREATE INDEX coop_control_shadow_records_type_idx",
    "  ON coop_control_shadow_records(source_id, record_type, record_key);",
  ].join("\n"));
}

var MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: "control-record-foundation", apply: applyControlRecordFoundation }),
  Object.freeze({ version: 2, name: "shadow-comparison-foundation", apply: applyShadowComparisonFoundation }),
]);
var LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function getUserVersion(db) {
  var row = db.prepare("PRAGMA user_version").get();
  var version = row && Number(row.user_version);
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

function sqlString(value) {
  var text = String(value || "");
  if (text.indexOf("\u0000") !== -1) {
    throw taggedError("COOP_CONTROL_STORE_BACKUP_FAILED", "ControlStore backup path contains a null byte.");
  }
  return "'" + text.replace(/'/g, "''") + "'";
}

function uniqueBackupPath(fsImpl, dbPath, fromVersion, toVersion, timestamp) {
  var base = dbPath + ".backup-v" + fromVersion + "-to-v" + toVersion + "-" + timestamp + ".sqlite";
  var candidate = base;
  var suffix = 1;
  while (fsImpl.existsSync(candidate)) {
    candidate = base + "." + suffix;
    suffix += 1;
  }
  return candidate;
}

function createMigrationBackup(db, options, fromVersion, toVersion) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var dbPath = String(opts.dbPath || "");
  if (!opts.existedBefore || !dbPath || dbPath === ":memory:") return null;
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var backupPath = uniqueBackupPath(fsImpl, dbPath, fromVersion, toVersion, now());
  try {
    fsImpl.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    db.exec("VACUUM INTO " + sqlString(backupPath));
    try { fsImpl.chmodSync(backupPath, 0o600); } catch {}
    return backupPath;
  } catch (error) {
    throw taggedError("COOP_CONTROL_STORE_BACKUP_FAILED",
      "ControlStore could not create its pre-migration backup.", error);
  }
}

function rollback(db) {
  try { db.exec("ROLLBACK"); } catch {}
}

function applyOne(db, migration, options) {
  var opts = options || {};
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  try {
    db.exec("BEGIN IMMEDIATE");
    migration.apply(db);
    db.prepare("INSERT INTO coop_control_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, now());
    db.exec("PRAGMA user_version = " + migration.version);
    if (opts.faults && typeof opts.faults.beforeMigrationCommit === "function") {
      opts.faults.beforeMigrationCommit({ version: migration.version, name: migration.name });
    }
    db.exec("COMMIT");
  } catch (error) {
    rollback(db);
    if (error && error.code && String(error.code).indexOf("COOP_CONTROL_STORE_") === 0) throw error;
    throw taggedError("COOP_CONTROL_STORE_MIGRATION_FAILED",
      "ControlStore migration " + migration.version + " (" + migration.name + ") failed.", error);
  }
}

function validateMigrationHistory(db, expectedVersion) {
  if (expectedVersion === 0) return;
  var table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' " +
    "AND name = 'coop_control_migrations'").get();
  if (!table) {
    throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID",
      "ControlStore has a schema version without migration history.");
  }
  var history = db.prepare("SELECT version, name FROM coop_control_migrations ORDER BY version").all();
  if (history.length !== expectedVersion) {
    throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID",
      "ControlStore migration history does not match schema version " + expectedVersion + ".");
  }
  for (var i = 0; i < history.length; i++) {
    if (!MIGRATIONS[i] || Number(history[i].version) !== MIGRATIONS[i].version ||
        history[i].name !== MIGRATIONS[i].name) {
      throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID",
        "ControlStore migration history is not the supported ordered sequence.");
    }
  }
  var required = ["coop_control_records"];
  if (expectedVersion >= 2) {
    required.push("coop_control_shadow_imports", "coop_control_shadow_records");
  }
  var rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  var names = rows.map(function (row) { return row.name; });
  for (var j = 0; j < required.length; j++) {
    if (names.indexOf(required[j]) === -1) {
      throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID",
        "ControlStore schema version " + expectedVersion + " is missing " + required[j] + ".");
    }
  }
}

function validateSchema(db, expectedVersion) {
  var required = [
    "coop_control_migrations",
    "coop_control_records",
    "coop_control_shadow_imports",
    "coop_control_shadow_records",
  ];
  var rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  var names = rows.map(function (row) { return row.name; });
  for (var i = 0; i < required.length; i++) {
    if (names.indexOf(required[i]) === -1) {
      throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID",
        "ControlStore schema version " + expectedVersion + " is missing " + required[i] + ".");
    }
  }
  validateMigrationHistory(db, expectedVersion);
}

function runMigrations(db, options) {
  var current = getUserVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw taggedError("COOP_CONTROL_STORE_SCHEMA_TOO_NEW",
      "ControlStore schema version " + current + " is newer than supported version " +
      LATEST_SCHEMA_VERSION + ".");
  }
  validateMigrationHistory(db, current);
  var backupPath = null;
  if (current < LATEST_SCHEMA_VERSION) {
    backupPath = createMigrationBackup(db, options, current, LATEST_SCHEMA_VERSION);
    for (var i = 0; i < MIGRATIONS.length; i++) {
      if (MIGRATIONS[i].version > current) applyOne(db, MIGRATIONS[i], options);
    }
  }
  validateSchema(db, LATEST_SCHEMA_VERSION);
  return {
    fromVersion: current,
    toVersion: LATEST_SCHEMA_VERSION,
    migrated: current !== LATEST_SCHEMA_VERSION,
    backupPath: backupPath,
  };
}

module.exports = {
  LATEST_SCHEMA_VERSION: LATEST_SCHEMA_VERSION,
  MIGRATIONS: MIGRATIONS,
  createMigrationBackup: createMigrationBackup,
  getUserVersion: getUserVersion,
  runMigrations: runMigrations,
  validateMigrationHistory: validateMigrationHistory,
  validateSchema: validateSchema,
};
