// SQLite WAL foundation for durable Coop control records. Activation is
// default-off so landing this module cannot alter ordinary daemon behaviour.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var config = require("./config");
var migrations = require("./coop-control-store-migrations");
var validation = require("./coop-control-store-validation");
var shadowValidation = require("./coop-control-shadow-validation");
var executionStore = require("./coop-control-execution-store");
var recoveryStore = require("./coop-control-store-recovery");

var sqlite = null;
var availabilityError = null;
try {
  sqlite = require("node:sqlite");
} catch {
  availabilityError = "Coop ControlStore requires a Node runtime with node:sqlite available.";
}

var CONTROL_STORE_ENV = "CLAY_COOP_CONTROL_STORE";
var DEFAULT_DB_PATH = path.join(config.CONFIG_DIR, "lead", "coop-control.sqlite");
var CONTROL_RECORD_TYPES = validation.CONTROL_RECORD_TYPES;
var DIGEST_RE = validation.DIGEST_RE;

function taggedError(code, message, cause) {
  var error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function isControlStoreAvailable() {
  return !!(sqlite && sqlite.DatabaseSync) && !availabilityError;
}

function getControlStoreAvailabilityError() {
  return availabilityError;
}

function databaseConstructor(options) {
  var opts = options || {};
  var supplied = Object.prototype.hasOwnProperty.call(opts, "sqliteModule")
    ? opts.sqliteModule : sqlite;
  if (!supplied || typeof supplied.DatabaseSync !== "function") {
    throw taggedError("COOP_CONTROL_STORE_UNAVAILABLE",
      availabilityError || "Coop ControlStore requires node:sqlite; no fallback store is permitted.");
  }
  return supplied.DatabaseSync;
}

function isControlStoreEnabled(options) {
  var opts = options || {};
  if (typeof opts.enabled === "boolean") return opts.enabled;
  var env = opts.env || process.env;
  return env && env[CONTROL_STORE_ENV] === "1";
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "Control records require finite numbers.");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return item === undefined ? null : canonicalize(item);
    });
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "Control records must contain plain JSON values.");
  }
  var result = {};
  var keys = Object.keys(value).sort();
  for (var i = 0; i < keys.length; i++) {
    if (value[keys[i]] !== undefined) result[keys[i]] = canonicalize(value[keys[i]]);
  }
  return result;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function safeTimestamp(value, code, message) {
  if (!Number.isSafeInteger(value) || value < 0) throw taggedError(code, message);
  return value;
}

var assertControlPayload = validation.assertControlPayload;
var validateRecordIdentity = validation.validateRecordIdentity;
var validateSourceId = validation.validateSourceId;

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertIntegrity(db) {
  try {
    var rows = db.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || String(rows[0].integrity_check || "").toLowerCase() !== "ok") {
      var details = rows.map(function (row) { return String(row.integrity_check || "unknown"); }).join("; ");
      throw new Error(details || "integrity_check returned no result");
    }
  } catch (error) {
    throw taggedError("COOP_CONTROL_STORE_INTEGRITY_FAILED",
      "ControlStore integrity validation failed; existing state was left untouched.", error);
  }
}

function parseStoredJson(text) {
  try { return JSON.parse(text); }
  catch (error) {
    throw taggedError("COOP_CONTROL_STORE_LOGICAL_CORRUPTION",
      "ControlStore contains an unreadable canonical record.", error);
  }
}

function rowToControlRecord(row) {
  if (!row) return null;
  return {
    recordType: row.record_type,
    recordKey: row.record_key,
    revision: Number(row.revision),
    value: parseStoredJson(row.canonical_json),
    canonicalJson: row.canonical_json,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function createDisabledStore(options) {
  var opts = options || {};
  return {
    enabled: false,
    dbPath: opts.dbPath || DEFAULT_DB_PATH,
    close: function () {},
    abandonExecution: function () { return false; },
    abortHandoff: function () { return false; },
    acceptInbox: function () { return false; },
    ackOutbox: function () { return false; },
    assertCurrentExecution: function () { return false; },
    bindExecutionStart: function () { return false; },
    completeExecution: function () { return false; },
    completeHandoff: function () { return false; },
    cutoverHandoff: function () { return false; },
    enqueueOutbox: function () { return false; },
    getControlRecord: function () { return null; },
    getCheckpoint: function () { return null; },
    getEffect: function () { return null; },
    getHandoff: function () { return null; },
    getInbox: function () { return null; },
    getOutbox: function () { return null; },
    getShadowImport: function () { return null; },
    listControlRecords: function () { return []; },
    listEffects: function () { return []; },
    listHandoffs: function () { return []; },
    listInbox: function () { return []; },
    listMigrations: function () { return []; },
    listOutbox: function () { return []; },
    listShadowRecords: function () { return []; },
    inspectExecution: function () { return null; },
    markExecutionStarted: function () { return false; },
    markSuccessorCreated: function () { return false; },
    noteOutboxAttempt: function () { return false; },
    openExecutionBarrier: function () { return false; },
    putControlRecord: function () { return false; },
    prepareHandoff: function () { return false; },
    recordEffectReceipt: function () { return false; },
    recoverIncompleteExecutions: function () { return 0; },
    replaceShadowProjection: function () { return false; },
    reserveExecution: function () { return false; },
    rollForwardHandoff: function () { return false; },
    transaction: function () { return false; },
  };
}

function buildHandle(db, dbPath, options, migration, journalMode) {
  var opts = options || {};
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var faults = opts.faults || {};
  var closed = false;

  function assertOpen() {
    if (closed) throw taggedError("COOP_CONTROL_STORE_CLOSED", "ControlStore is closed.");
  }
  var executionApi = executionStore.createExecutionStoreApi(db, {
    assertOpen: assertOpen, faults: faults, now: now,
  });
  var recoveryApi = recoveryStore.createRecoveryStoreApi(db, {
    assertOpen: assertOpen, faults: faults, now: now,
  });

  function getControlRecord(recordType, recordKey) {
    assertOpen();
    validateRecordIdentity(recordType, recordKey);
    var row = db.prepare("SELECT * FROM coop_control_records WHERE record_type = ? AND record_key = ?")
      .get(recordType, recordKey);
    return rowToControlRecord(row);
  }

  function listControlRecords(recordType) {
    assertOpen();
    var rows;
    if (recordType) {
      if (!Object.prototype.hasOwnProperty.call(CONTROL_RECORD_TYPES, recordType)) {
        throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "Unsupported control record type.");
      }
      rows = db.prepare("SELECT * FROM coop_control_records WHERE record_type = ? ORDER BY record_key").all(recordType);
    } else {
      rows = db.prepare("SELECT * FROM coop_control_records ORDER BY record_type, record_key").all();
    }
    return rows.map(rowToControlRecord);
  }

  function putControlRecordDirect(recordType, recordKey, value, revision) {
    var normalized = validation.normalizeWritableRecord(recordType, recordKey, value);
    var existing = db.prepare("SELECT revision, created_at FROM coop_control_records " +
      "WHERE record_type = ? AND record_key = ?").get(recordType, recordKey);
    var nextRevision = Number.isSafeInteger(revision) && revision > 0
      ? revision : (existing ? Number(existing.revision) + 1 : 1);
    if (!Number.isSafeInteger(nextRevision) || nextRevision <= 0) {
      throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "ControlStore revisions must be positive safe integers.");
    }
    var timestamp = safeTimestamp(now(), "COOP_CONTROL_STORE_INVALID_RECORD",
      "ControlStore timestamps must be non-negative safe integers.");
    var createdAt = existing ? Number(existing.created_at) : timestamp;
    db.prepare("INSERT INTO coop_control_records " +
      "(record_type, record_key, revision, canonical_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(record_type, record_key) DO UPDATE SET " +
      "revision = excluded.revision, canonical_json = excluded.canonical_json, updated_at = excluded.updated_at")
      .run(recordType, recordKey, nextRevision, canonicalStringify(normalized), createdAt, timestamp);
    return getControlRecord(recordType, recordKey);
  }

  function listShadowRecords(sourceId) {
    assertOpen();
    validateSourceId(sourceId);
    return db.prepare("SELECT record_type AS recordType, record_key AS recordKey, " +
      "canonical_json AS canonicalJson, record_digest AS recordDigest " +
      "FROM coop_control_shadow_records WHERE source_id = ? ORDER BY record_type, record_key")
      .all(sourceId).map(function (row) {
        row.value = parseStoredJson(row.canonicalJson);
        return row;
      });
  }

  function getShadowImport(sourceId) {
    assertOpen();
    validateSourceId(sourceId);
    var row = db.prepare("SELECT source_id AS sourceId, projection_digest AS projectionDigest, " +
      "record_count AS recordCount, imported_at AS importedAt " +
      "FROM coop_control_shadow_imports WHERE source_id = ?").get(sourceId);
    if (!row) return null;
    row.recordCount = Number(row.recordCount);
    row.importedAt = Number(row.importedAt);
    return row;
  }

  function transaction(work) {
    assertOpen();
    if (typeof work !== "function") throw taggedError("COOP_CONTROL_STORE_INVALID_TRANSACTION", "A synchronous transaction callback is required.");
    var active = true;
    var tx = {
      putControlRecord: function (recordType, recordKey, value, revision) {
        if (!active) throw taggedError("COOP_CONTROL_STORE_TRANSACTION_CLOSED",
          "ControlStore transaction capabilities expire when their callback returns.");
        return putControlRecordDirect(recordType, recordKey, value, revision);
      },
    };
    try {
      db.exec("BEGIN IMMEDIATE");
      var result = work(tx);
      active = false;
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(function () {});
        throw taggedError("COOP_CONTROL_STORE_INVALID_TRANSACTION", "ControlStore transactions must be synchronous.");
      }
      if (typeof faults.beforeCommit === "function") faults.beforeCommit({ operation: "control_transaction" });
      db.exec("COMMIT");
      return result;
    } catch (error) {
      active = false;
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      active = false;
    }
  }

  function putControlRecord(recordType, recordKey, value, revision) {
    return transaction(function (tx) {
      return tx.putControlRecord(recordType, recordKey, value, revision);
    });
  }

  function sameShadow(sourceId, projectionDigest, records) {
    var meta = getShadowImport(sourceId);
    if (!meta || meta.projectionDigest !== projectionDigest || meta.recordCount !== records.length) return meta;
    var existing = listShadowRecords(sourceId);
    if (existing.length !== records.length) return meta;
    for (var i = 0; i < records.length; i++) {
      if (existing[i].recordType !== records[i].recordType || existing[i].recordKey !== records[i].recordKey ||
          existing[i].recordDigest !== records[i].recordDigest ||
          existing[i].canonicalJson !== records[i].canonicalJson) return meta;
    }
    return { unchanged: true, meta: meta };
  }

  function replaceShadowProjection(sourceId, input) {
    assertOpen();
    validateSourceId(sourceId);
    var source = shadowValidation.normalizeShadowInput(input);
    var records = source.records.slice();
    if (!DIGEST_RE.test(source.projectionDigest || "")) {
      throw taggedError("COOP_CONTROL_STORE_INVALID_SHADOW", "A SHA-256 projection digest is required.");
    }
    records.sort(function (left, right) {
      return compareText(left.recordType + "\u0000" + left.recordKey,
        right.recordType + "\u0000" + right.recordKey);
    });
    var seen = {};
    for (var i = 0; i < records.length; i++) {
      validateRecordIdentity(records[i].recordType, records[i].recordKey);
      if (!DIGEST_RE.test(records[i].recordDigest || "")) {
        throw taggedError("COOP_CONTROL_STORE_INVALID_SHADOW", "Every shadow record requires a SHA-256 digest.");
      }
      if (typeof records[i].canonicalJson !== "string" ||
          canonicalStringify(parseStoredJson(records[i].canonicalJson)) !== records[i].canonicalJson) {
        throw taggedError("COOP_CONTROL_STORE_INVALID_SHADOW", "Every shadow record must use canonical JSON.");
      }
      if (sha256(records[i].canonicalJson) !== records[i].recordDigest) {
        throw taggedError("COOP_CONTROL_STORE_INVALID_SHADOW", "Shadow record digest does not match its canonical JSON.");
      }
      var value = parseStoredJson(records[i].canonicalJson);
      var normalized = validation.normalizeWritableRecord(records[i].recordType, records[i].recordKey, value);
      if (canonicalStringify(normalized) !== records[i].canonicalJson) {
        throw taggedError("COOP_CONTROL_STORE_INVALID_SHADOW", "Every shadow record must match its typed schema.");
      }
      var key = records[i].recordType + "\u0000" + records[i].recordKey;
      if (seen[key]) throw taggedError("COOP_CONTROL_STORE_INVALID_SHADOW", "Duplicate shadow record identity.");
      seen[key] = true;
    }
    var digestProjection = records.map(function (record) {
      return {
        recordType: record.recordType,
        recordKey: record.recordKey,
        value: parseStoredJson(record.canonicalJson),
      };
    });
    if (sha256(canonicalStringify(digestProjection)) !== source.projectionDigest) {
      throw taggedError("COOP_CONTROL_STORE_INVALID_SHADOW", "Shadow projection digest does not match its records.");
    }
    return transaction(function () {
      var match = sameShadow(sourceId, source.projectionDigest, records);
      if (match && match.unchanged) {
        return { changed: false, importedAt: match.meta.importedAt, recordCount: records.length };
      }
      var importedAt = safeTimestamp(now(), "COOP_CONTROL_STORE_INVALID_SHADOW",
        "Shadow import timestamps must be non-negative safe integers.");
      db.prepare("DELETE FROM coop_control_shadow_records WHERE source_id = ?").run(sourceId);
      db.prepare("INSERT INTO coop_control_shadow_imports " +
        "(source_id, projection_digest, record_count, imported_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(source_id) DO UPDATE SET projection_digest = excluded.projection_digest, " +
        "record_count = excluded.record_count, imported_at = excluded.imported_at")
        .run(sourceId, source.projectionDigest, records.length, importedAt);
      var statement = db.prepare("INSERT INTO coop_control_shadow_records " +
        "(source_id, record_type, record_key, canonical_json, record_digest) VALUES (?, ?, ?, ?, ?)");
      for (var j = 0; j < records.length; j++) {
        statement.run(sourceId, records[j].recordType, records[j].recordKey,
          records[j].canonicalJson, records[j].recordDigest);
      }
      return { changed: true, importedAt: importedAt, recordCount: records.length };
    });
  }

  function listMigrations() {
    assertOpen();
    return db.prepare("SELECT version, name, applied_at AS appliedAt " +
      "FROM coop_control_migrations ORDER BY version").all().map(function (row) {
        row.version = Number(row.version);
        row.appliedAt = Number(row.appliedAt);
        return row;
      });
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return Object.assign({
    enabled: true,
    dbPath: dbPath,
    journalMode: journalMode,
    migration: migration,
    schemaVersion: migrations.LATEST_SCHEMA_VERSION,
    close: close,
    getControlRecord: getControlRecord,
    getShadowImport: getShadowImport,
    listControlRecords: listControlRecords,
    listMigrations: listMigrations,
    listShadowRecords: listShadowRecords,
    putControlRecord: putControlRecord,
    replaceShadowProjection: replaceShadowProjection,
    transaction: transaction,
  }, executionApi, recoveryApi);
}

function openControlStore(options) {
  var opts = options || {};
  var DatabaseSync = databaseConstructor(opts);
  var fsImpl = opts.fs || fs;
  var dbPath = String(opts.dbPath || DEFAULT_DB_PATH);
  if (!dbPath || dbPath === ":memory:") {
    throw taggedError("COOP_CONTROL_STORE_INVALID_PATH", "ControlStore requires a durable filesystem path for WAL mode.");
  }
  var existedBefore = fsImpl.existsSync(dbPath);
  fsImpl.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  var db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (error) {
    throw taggedError(existedBefore ? "COOP_CONTROL_STORE_INTEGRITY_FAILED" : "COOP_CONTROL_STORE_OPEN_FAILED",
      existedBefore ? "ControlStore could not read existing state; it was left untouched." : "ControlStore could not create its database.", error);
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    assertIntegrity(db);
    var migration = migrations.runMigrations(db, {
      dbPath: dbPath,
      existedBefore: existedBefore,
      faults: opts.faults,
      fs: fsImpl,
      now: opts.now,
      beforeMigrate: shadowValidation.auditStoredState,
    });
    assertIntegrity(db);
    shadowValidation.auditStoredState(db, migrations.LATEST_SCHEMA_VERSION);
    var modeRow = db.prepare("PRAGMA journal_mode = WAL").get();
    var journalMode = String(modeRow && modeRow.journal_mode || "").toLowerCase();
    if (journalMode !== "wal") {
      throw taggedError("COOP_CONTROL_STORE_WAL_REQUIRED", "ControlStore activation requires SQLite WAL mode.");
    }
    db.exec("PRAGMA synchronous = FULL");
    try { fsImpl.chmodSync(dbPath, 0o600); } catch {}
    return buildHandle(db, dbPath, opts, migration, journalMode);
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function createControlStore(options) {
  if (!isControlStoreEnabled(options)) return createDisabledStore(options);
  return openControlStore(options);
}

function closeControlStore(store) {
  if (store && typeof store.close === "function") store.close();
}

module.exports = {
  CONTROL_RECORD_TYPES: CONTROL_RECORD_TYPES,
  CONTROL_STORE_ENV: CONTROL_STORE_ENV,
  DEFAULT_DB_PATH: DEFAULT_DB_PATH,
  LATEST_SCHEMA_VERSION: migrations.LATEST_SCHEMA_VERSION,
  MIGRATIONS: migrations.MIGRATIONS,
  assertControlPayload: assertControlPayload,
  assertIntegrity: assertIntegrity,
  attachCoopControlStore: createControlStore,
  canonicalStringify: canonicalStringify,
  closeControlStore: closeControlStore,
  createControlStore: createControlStore,
  createCoopControlStore: createControlStore,
  getControlStoreAvailabilityError: getControlStoreAvailabilityError,
  isControlStoreAvailable: isControlStoreAvailable,
  isControlStoreEnabled: isControlStoreEnabled,
  openControlStore: openControlStore,
  openCoopControlStore: openControlStore,
};
