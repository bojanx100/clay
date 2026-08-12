// Activation-time logical audit for every persisted ControlStore row.

var crypto = require("crypto");
var validation = require("./coop-control-store-validation");
var executionAudit = require("./coop-control-execution-audit");

function logicalError(message, cause) {
  return validation.taggedError("COOP_CONTROL_STORE_LOGICAL_CORRUPTION",
    "ControlStore logical audit failed: " + message, cause);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch (error) { throw logicalError("a canonical JSON row is unreadable.", error); }
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw logicalError("a record contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw logicalError("a record contains a non-JSON value.");
  }
  var result = {};
  var keys = Object.keys(value).sort();
  for (var i = 0; i < keys.length; i++) result[keys[i]] = canonicalJson(value[keys[i]]);
  return result;
}

function stringify(value) {
  return JSON.stringify(canonicalJson(value));
}

function safeInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function invalidShadow(message) {
  return validation.taggedError("COOP_CONTROL_STORE_INVALID_SHADOW", message);
}

function exactShadowObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidShadow(label + " must be a plain object.");
  }
  var allowed = {};
  for (var i = 0; i < fields.length; i++) allowed[fields[i]] = true;
  var keys = Object.keys(value);
  for (var j = 0; j < keys.length; j++) {
    if (!allowed[keys[j]]) {
      if (validation.privacyAlias(keys[j])) {
        throw validation.taggedError("COOP_CONTROL_STORE_OUT_OF_SCOPE",
          label + " cannot contain private field " + keys[j] + ".");
      }
      throw invalidShadow(label + " contains unknown field " + keys[j] + ".");
    }
  }
  for (var k = 0; k < fields.length; k++) {
    if (!Object.prototype.hasOwnProperty.call(value, fields[k])) {
      throw invalidShadow(label + " is missing field " + fields[k] + ".");
    }
  }
  return value;
}

function normalizeShadowInput(value) {
  var source = exactShadowObject(value, ["projectionDigest", "records"], "Shadow projection");
  if (!Array.isArray(source.records)) throw invalidShadow("Shadow projection records must be an array.");
  return {
    projectionDigest: source.projectionDigest,
    records: source.records.map(function (record, index) {
      return exactShadowObject(record,
        ["recordType", "recordKey", "canonicalJson", "recordDigest"],
        "Shadow record " + index);
    }),
  };
}

function validateCanonicalRecord(recordType, recordKey, text) {
  var value = parseJson(text);
  var normalized;
  try { normalized = validation.normalizeWritableRecord(recordType, recordKey, value); }
  catch (error) { throw logicalError("a persisted record violates its typed schema.", error); }
  if (stringify(normalized) !== text) {
    throw logicalError("a persisted record is not canonical typed JSON.");
  }
  return value;
}

function auditControlRows(db) {
  var rows = db.prepare("SELECT record_type, record_key, revision, canonical_json, created_at, updated_at " +
    "FROM coop_control_records ORDER BY record_type, record_key").all();
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!Number.isSafeInteger(Number(row.revision)) || Number(row.revision) <= 0 ||
        !safeInteger(row.created_at) || !safeInteger(row.updated_at) ||
        Number(row.updated_at) < Number(row.created_at)) {
      throw logicalError("a control row has invalid revision or timestamp metadata.");
    }
    validateCanonicalRecord(row.record_type, row.record_key, row.canonical_json);
  }
}

function auditForeignKeys(db) {
  var enabled = db.prepare("PRAGMA foreign_keys").get();
  if (!enabled || Number(enabled.foreign_keys) !== 1) {
    throw logicalError("foreign-key enforcement is disabled.");
  }
  var failures = db.prepare("PRAGMA foreign_key_check").all();
  if (failures.length) throw logicalError("foreign-key consistency check failed.");
}

function shadowProjection(rows) {
  return rows.map(function (row) {
    return {
      recordType: row.record_type,
      recordKey: row.record_key,
      value: parseJson(row.canonical_json),
    };
  });
}

function auditShadowRecords(rows) {
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    try { validation.validateSourceId(row.source_id); }
    catch (error) { throw logicalError("a shadow source id is invalid.", error); }
    var value = validateCanonicalRecord(row.record_type, row.record_key, row.canonical_json);
    if (!validation.DIGEST_RE.test(row.record_digest) || sha256(row.canonical_json) !== row.record_digest ||
        stringify(value) !== row.canonical_json) {
      throw logicalError("a shadow record digest is inconsistent.");
    }
  }
}

function recordsBySource(rows) {
  var result = Object.create(null);
  for (var i = 0; i < rows.length; i++) {
    if (!result[rows[i].source_id]) result[rows[i].source_id] = [];
    result[rows[i].source_id].push(rows[i]);
  }
  return result;
}

function auditMigrationRows(db, version) {
  if (version < 1) return;
  var rows = db.prepare("SELECT version, name, applied_at FROM coop_control_migrations ORDER BY version").all();
  if (rows.length !== version) throw logicalError("migration metadata count is inconsistent.");
  for (var i = 0; i < rows.length; i++) {
    if (!safeInteger(rows[i].applied_at) || Number(rows[i].version) !== i + 1 ||
        typeof rows[i].name !== "string" || !rows[i].name) {
      throw logicalError("migration metadata is invalid.");
    }
  }
}

function auditShadowMetadata(db) {
  var imports = db.prepare("SELECT source_id, projection_digest, record_count, imported_at " +
    "FROM coop_control_shadow_imports ORDER BY source_id").all();
  var rows = db.prepare("SELECT source_id, record_type, record_key, canonical_json, record_digest " +
    "FROM coop_control_shadow_records ORDER BY source_id, record_type, record_key").all();
  auditShadowRecords(rows);
  var grouped = recordsBySource(rows);
  for (var i = 0; i < imports.length; i++) {
    var meta = imports[i];
    try { validation.validateSourceId(meta.source_id); }
    catch (error) { throw logicalError("shadow metadata has an invalid source id.", error); }
    var sourceRows = grouped[meta.source_id] || [];
    if (!validation.DIGEST_RE.test(meta.projection_digest) || !safeInteger(meta.record_count) ||
        !safeInteger(meta.imported_at) || Number(meta.record_count) !== sourceRows.length ||
        sha256(stringify(shadowProjection(sourceRows))) !== meta.projection_digest) {
      throw logicalError("shadow metadata count or digest is inconsistent.");
    }
    delete grouped[meta.source_id];
  }
  if (Object.keys(grouped).length) throw logicalError("shadow rows exist without import metadata.");
}

function auditStoredState(db, version) {
  auditForeignKeys(db);
  auditMigrationRows(db, version);
  if (version >= 1) auditControlRows(db);
  if (version >= 2) auditShadowMetadata(db);
  if (version >= 3) executionAudit.auditExecutionState(db);
}

module.exports = {
  auditStoredState: auditStoredState,
  normalizeShadowInput: normalizeShadowInput,
};
