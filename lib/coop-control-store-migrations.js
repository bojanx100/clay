// Ordered SQLite schema migrations for the recoverable Coop control kernel.
// This database is intentionally narrow: it reserves durable control-record
// slots and shadow-comparison evidence, never topics, transcripts, projections,
// runtime context, or model reasoning.

var fs = require("fs");
var path = require("path");
var executionSchema = require("./coop-control-execution-schema");

function taggedError(code, message, cause) {
  var error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

var CONTROL_MIGRATIONS_SQL = [
  "CREATE TABLE coop_control_migrations (",
  "  version INTEGER PRIMARY KEY CHECK (version > 0),",
  "  name TEXT NOT NULL,",
  "  applied_at INTEGER NOT NULL",
  ") STRICT",
].join("\n");
var CONTROL_RECORDS_SQL = [
  "CREATE TABLE coop_control_records (",
  "  record_type TEXT NOT NULL,",
  "  record_key TEXT NOT NULL,",
  "  revision INTEGER NOT NULL CHECK (revision > 0),",
  "  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),",
  "  created_at INTEGER NOT NULL,",
  "  updated_at INTEGER NOT NULL,",
  "  PRIMARY KEY (record_type, record_key)",
  ") STRICT",
].join("\n");
var SHADOW_IMPORTS_SQL = [
  "CREATE TABLE coop_control_shadow_imports (",
  "  source_id TEXT PRIMARY KEY,",
  "  projection_digest TEXT NOT NULL,",
  "  record_count INTEGER NOT NULL CHECK (record_count >= 0),",
  "  imported_at INTEGER NOT NULL",
  ") STRICT",
].join("\n");
var SHADOW_RECORDS_SQL = [
  "CREATE TABLE coop_control_shadow_records (",
  "  source_id TEXT NOT NULL,",
  "  record_type TEXT NOT NULL,",
  "  record_key TEXT NOT NULL,",
  "  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),",
  "  record_digest TEXT NOT NULL,",
  "  PRIMARY KEY (source_id, record_type, record_key),",
  "  FOREIGN KEY (source_id) REFERENCES coop_control_shadow_imports(source_id) ON DELETE CASCADE",
  ") STRICT",
].join("\n");
var SHADOW_INDEX_SQL = "CREATE INDEX coop_control_shadow_records_type_idx\n" +
  "  ON coop_control_shadow_records(source_id, record_type, record_key)";
var TABLE_SHAPES = Object.freeze({
  coop_control_migrations: Object.freeze({
    version: 1,
    columns: [
      ["version", "INTEGER", 0, 1], ["name", "TEXT", 1, 0], ["applied_at", "INTEGER", 1, 0],
    ],
    indexes: [],
    foreignKeys: [],
  }),
  coop_control_records: Object.freeze({
    version: 1,
    columns: [
      ["record_type", "TEXT", 1, 1], ["record_key", "TEXT", 1, 2],
      ["revision", "INTEGER", 1, 0], ["canonical_json", "TEXT", 1, 0],
      ["created_at", "INTEGER", 1, 0], ["updated_at", "INTEGER", 1, 0],
    ],
    indexes: [
      ["sqlite_autoindex_coop_control_records_1", 1, "pk", 0, ["record_type", "record_key"]],
    ],
    foreignKeys: [],
  }),
  coop_control_shadow_imports: Object.freeze({
    version: 2,
    columns: [
      ["source_id", "TEXT", 1, 1], ["projection_digest", "TEXT", 1, 0],
      ["record_count", "INTEGER", 1, 0], ["imported_at", "INTEGER", 1, 0],
    ],
    indexes: [
      ["sqlite_autoindex_coop_control_shadow_imports_1", 1, "pk", 0, ["source_id"]],
    ],
    foreignKeys: [],
  }),
  coop_control_shadow_records: Object.freeze({
    version: 2,
    columns: [
      ["source_id", "TEXT", 1, 1], ["record_type", "TEXT", 1, 2],
      ["record_key", "TEXT", 1, 3], ["canonical_json", "TEXT", 1, 0],
      ["record_digest", "TEXT", 1, 0],
    ],
    indexes: [
      ["coop_control_shadow_records_type_idx", 0, "c", 0,
        ["source_id", "record_type", "record_key"]],
      ["sqlite_autoindex_coop_control_shadow_records_1", 1, "pk", 0,
        ["source_id", "record_type", "record_key"]],
    ],
    foreignKeys: [
      ["coop_control_shadow_imports", "source_id", "source_id", "NO ACTION", "CASCADE", "NONE"],
    ],
  }),
  coop_control_authorities: executionSchema.TABLE_SHAPES.coop_control_authorities,
  coop_control_executions: executionSchema.TABLE_SHAPES.coop_control_executions,
  coop_control_incarnations: executionSchema.TABLE_SHAPES.coop_control_incarnations,
  coop_control_role_leases: executionSchema.TABLE_SHAPES.coop_control_role_leases,
});

function applyControlRecordFoundation(db) {
  db.exec(CONTROL_MIGRATIONS_SQL + ";\n" + CONTROL_RECORDS_SQL + ";");
}

function applyShadowComparisonFoundation(db) {
  db.exec(SHADOW_IMPORTS_SQL + ";\n" + SHADOW_RECORDS_SQL + ";\n" + SHADOW_INDEX_SQL + ";");
}

function applyExecutionControlFoundation(db) {
  executionSchema.apply(db);
}

var MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: "control-record-foundation", apply: applyControlRecordFoundation }),
  Object.freeze({ version: 2, name: "shadow-comparison-foundation", apply: applyShadowComparisonFoundation }),
  Object.freeze({ version: 3, name: "execution-control-foundation", apply: applyExecutionControlFoundation }),
]);
var LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function getUserVersion(db) {
  var row = db.prepare("PRAGMA user_version").get();
  var version = row && Number(row.user_version);
  if (!Number.isInteger(version) || version < 0) {
    throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID", "ControlStore has an invalid schema version.");
  }
  return version;
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

function migrationTimestamp(now) {
  var value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw taggedError("COOP_CONTROL_STORE_MIGRATION_FAILED",
      "ControlStore migration timestamps must be non-negative safe integers.");
  }
  return value;
}

function applyOne(db, migration, options) {
  var opts = options || {};
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  try {
    db.exec("BEGIN IMMEDIATE");
    migration.apply(db);
    db.prepare("INSERT INTO coop_control_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, migrationTimestamp(now));
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
}

function normalizedSql(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1")
    .replace(/;$/, "").trim().toLowerCase();
}

function expectedSchema(version) {
  var objects = [
    { type: "table", name: "coop_control_migrations", table: "coop_control_migrations", sql: CONTROL_MIGRATIONS_SQL },
    { type: "table", name: "coop_control_records", table: "coop_control_records", sql: CONTROL_RECORDS_SQL },
  ];
  if (version >= 2) {
    objects.push({ type: "index", name: "coop_control_shadow_records_type_idx",
      table: "coop_control_shadow_records", sql: SHADOW_INDEX_SQL });
    objects.push({ type: "table", name: "coop_control_shadow_imports",
      table: "coop_control_shadow_imports", sql: SHADOW_IMPORTS_SQL });
    objects.push({ type: "table", name: "coop_control_shadow_records",
      table: "coop_control_shadow_records", sql: SHADOW_RECORDS_SQL });
  }
  if (version >= 3) {
    objects.push({ type: "table", name: "coop_control_authorities",
      table: "coop_control_authorities", sql: executionSchema.AUTHORITIES_SQL });
    objects.push({ type: "table", name: "coop_control_executions",
      table: "coop_control_executions", sql: executionSchema.EXECUTIONS_SQL });
    objects.push({ type: "table", name: "coop_control_incarnations",
      table: "coop_control_incarnations", sql: executionSchema.INCARNATIONS_SQL });
    objects.push({ type: "table", name: "coop_control_role_leases",
      table: "coop_control_role_leases", sql: executionSchema.LEASES_SQL });
  }
  return objects.sort(function (left, right) {
    var a = left.type + ":" + left.name;
    var b = right.type + ":" + right.name;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
}

function schemaObjects(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master " +
    "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}

function schemaInvalid(message) {
  throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID", message);
}

function validateColumns(db, tableName, shape) {
  var rows = db.prepare("PRAGMA table_xinfo(" + tableName + ")").all();
  if (rows.length !== shape.columns.length) schemaInvalid("ControlStore table " + tableName + " has unexpected columns.");
  for (var i = 0; i < rows.length; i++) {
    var expected = shape.columns[i];
    if (Number(rows[i].cid) !== i || rows[i].name !== expected[0] || rows[i].type !== expected[1] ||
        Number(rows[i].notnull) !== expected[2] || Number(rows[i].pk) !== expected[3] ||
        rows[i].dflt_value !== null || Number(rows[i].hidden) !== 0) {
      schemaInvalid("ControlStore column " + tableName + "." + String(rows[i].name || i) + " has an unsupported shape.");
    }
  }
}

function indexColumns(db, indexName) {
  return db.prepare("PRAGMA index_info(" + indexName + ")").all().map(function (row) {
    return row.name;
  });
}

function validateIndexes(db, tableName, shape) {
  var rows = db.prepare("PRAGMA index_list(" + tableName + ")").all();
  if (rows.length !== shape.indexes.length) schemaInvalid("ControlStore table " + tableName + " has unexpected indexes.");
  var byName = {};
  for (var i = 0; i < rows.length; i++) byName[rows[i].name] = rows[i];
  for (var j = 0; j < shape.indexes.length; j++) {
    var expected = shape.indexes[j];
    var actual = byName[expected[0]];
    if (!actual || Number(actual.unique) !== expected[1] || actual.origin !== expected[2] ||
        Number(actual.partial) !== expected[3] ||
        JSON.stringify(indexColumns(db, expected[0])) !== JSON.stringify(expected[4])) {
      schemaInvalid("ControlStore index " + expected[0] + " has an unsupported shape.");
    }
  }
}

function validateForeignKeys(db, tableName, shape) {
  var rows = db.prepare("PRAGMA foreign_key_list(" + tableName + ")").all();
  if (rows.length !== shape.foreignKeys.length) {
    schemaInvalid("ControlStore table " + tableName + " has unexpected foreign keys.");
  }
  for (var i = 0; i < rows.length; i++) {
    var expected = shape.foreignKeys[i];
    if (Number(rows[i].id) !== i || Number(rows[i].seq) !== 0 || rows[i].table !== expected[0] ||
        rows[i].from !== expected[1] || rows[i].to !== expected[2] || rows[i].on_update !== expected[3] ||
        rows[i].on_delete !== expected[4] || rows[i].match !== expected[5]) {
      schemaInvalid("ControlStore foreign key on " + tableName + " has an unsupported shape.");
    }
  }
}

function validateTableShape(db, tableName, shape) {
  var rows = db.prepare("PRAGMA table_list('" + tableName + "')").all();
  if (rows.length !== 1 || rows[0].schema !== "main" || rows[0].name !== tableName ||
      rows[0].type !== "table" || Number(rows[0].ncol) !== shape.columns.length ||
      Number(rows[0].wr) !== 0 || Number(rows[0].strict) !== 1) {
    schemaInvalid("ControlStore table " + tableName + " is not the required strict rowid table.");
  }
  validateColumns(db, tableName, shape);
  validateIndexes(db, tableName, shape);
  validateForeignKeys(db, tableName, shape);
}

function validatePhysicalSchema(db, version) {
  var names = Object.keys(TABLE_SHAPES).sort();
  for (var i = 0; i < names.length; i++) {
    if (TABLE_SHAPES[names[i]].version <= version) validateTableShape(db, names[i], TABLE_SHAPES[names[i]]);
  }
}

function validateSchema(db, expectedVersion) {
  var rows = schemaObjects(db);
  if (expectedVersion === 0) {
    if (rows.length) throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID",
      "A version-zero ControlStore database must be empty.");
    return;
  }
  var expected = expectedSchema(expectedVersion);
  if (rows.length !== expected.length) {
    throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID",
      "ControlStore schema version " + expectedVersion + " has unexpected objects.");
  }
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type !== expected[i].type || rows[i].name !== expected[i].name ||
        rows[i].tbl_name !== expected[i].table || normalizedSql(rows[i].sql) !== normalizedSql(expected[i].sql)) {
      throw taggedError("COOP_CONTROL_STORE_SCHEMA_INVALID",
        "ControlStore schema object " + String(rows[i].name || "unknown") + " has an unsupported shape.");
    }
  }
  validatePhysicalSchema(db, expectedVersion);
  validateMigrationHistory(db, expectedVersion);
}

function runMigrations(db, options) {
  var opts = options || {};
  var current = getUserVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw taggedError("COOP_CONTROL_STORE_SCHEMA_TOO_NEW",
      "ControlStore schema version " + current + " is newer than supported version " +
      LATEST_SCHEMA_VERSION + ".");
  }
  validateSchema(db, current);
  if (typeof opts.beforeMigrate === "function") opts.beforeMigrate(db, current);
  var backupPath = null;
  if (current < LATEST_SCHEMA_VERSION) {
    backupPath = createMigrationBackup(db, opts, current, LATEST_SCHEMA_VERSION);
    for (var i = 0; i < MIGRATIONS.length; i++) {
      if (MIGRATIONS[i].version > current) applyOne(db, MIGRATIONS[i], opts);
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
