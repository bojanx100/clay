// Deterministic, privacy-safe shadow projection of the existing Coop owner
// request ledger. This is comparison evidence only; it does not activate the
// ControlStore or make the SQLite copy authoritative.

var crypto = require("crypto");
var fs = require("fs");
var ownerRecords = require("./coop-owner-request-records");
var controlStore = require("./coop-control-store");
var validation = require("./coop-control-store-validation");

var DEFAULT_SOURCE_ID = "coop-reference-stores";
var OWNER_REQUEST_SCHEMA = "clay.coop_owner_requests";
var OWNER_REQUEST_VERSION = 1;
var CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var NON_CODE_PREFIX = "noncode.";
var CODE_LIMIT = 64;
var OUTCOME_STATUS_LIMIT = validation.OUTCOME_STATUS_LIMIT;
var CLASSIFICATION_SOURCE_LIMIT = 64;

function taggedError(code, message, cause) {
  var error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function stableJson(value) {
  return controlStore.canonicalStringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function code(value) {
  return typeof value === "string" && CODE_RE.test(value) ? value : "";
}

// The adjacent owner ledger bounds several fields by LENGTH only, so a caller
// reason, a classification source, or an execution status can arrive as prose.
// Prose must never become projected data, but blanking it destroys the only
// evidence that two records differ. A bounded code is kept verbatim; anything
// else becomes a stable one-way stand-in that is deterministic and unreadable.
//
// The stand-in spends the field's whole remaining budget on digest, so it is as
// collision-resistant as the bound allows: the 8-character prefix leaves 32 hex
// characters (128 bits) at a 40-character bound and 56 (224 bits) at 64. Every
// call site must therefore pass a limit comfortably above the prefix length, or
// the digest would be truncated toward collision.
function boundedCode(value, limit) {
  if (typeof value !== "string" || value === "") return "";
  var max = limit || CODE_LIMIT;
  if (value.length <= max && CODE_RE.test(value)) return value;
  return (NON_CODE_PREFIX + sha256(value)).slice(0, max);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareCanonical(left, right) {
  return compareText(stableJson(left), stableJson(right));
}

function sorted(values) {
  return (Array.isArray(values) ? values.slice() : []).sort(compareCanonical);
}

function referenceOnlyResponse(response) {
  var source = response || {};
  return {
    state: source.state,
    answeredAt: source.answeredAt,
    responseRef: source.responseRef,
    supersededAt: source.supersededAt,
    supersededBy: boundedCode(source.supersededBy, validation.SUPERSEDED_BY_LIMIT),
  };
}

function referenceOnlyRequest(value) {
  var record = ownerRecords.normalizeRecord(value);
  if (!record) return null;
  return {
    ingressId: record.ingressId,
    ingressSequence: record.ingressSequence,
    ingressKind: record.ingressKind,
    sessionRef: record.sessionRef,
    requestRef: record.requestRef,
    receivedAt: record.receivedAt,
    updatedAt: record.updatedAt,
    response: referenceOnlyResponse(record.response),
    classification: record.classification ? {
      kind: record.classification.kind,
      source: boundedCode(record.classification.source, CLASSIFICATION_SOURCE_LIMIT),
      at: record.classification.at,
    } : null,
    topicRef: record.topicRef,
    projectRefs: sorted(record.projectRefs),
    expectsExecution: record.expectsExecution,
    links: {
      coordinators: sorted(record.links.coordinators),
      tasks: sorted(record.links.tasks),
      sessions: sorted(record.links.sessions),
    },
    state: record.state,
    attention: code(record.attention) || null,
    outcome: record.outcome
      ? { status: boundedCode(record.outcome.status, OUTCOME_STATUS_LIMIT), at: record.outcome.at }
      : null,
  };
}

function referenceOnlyClaim(value) {
  var claim = ownerRecords.normalizeClaim(value);
  if (!claim) return null;
  return {
    topicId: claim.topicId,
    projectId: claim.projectId,
    coordinator: claim.coordinator,
    claimedAt: claim.claimedAt,
    ingressIds: claim.ingressIds.slice().sort(),
  };
}

function readSourceFile(file, fsImpl) {
  var raw;
  try { raw = fsImpl.readFileSync(file, "utf8"); }
  catch (error) {
    throw taggedError("COOP_CONTROL_SHADOW_SOURCE_UNREADABLE",
      "Shadow source could not be read: " + file + ".", error);
  }
  try { return JSON.parse(raw); }
  catch (error) {
    throw taggedError("COOP_CONTROL_SHADOW_SOURCE_UNREADABLE",
      "Shadow source is not valid JSON: " + file + ".", error);
  }
}

function unwrapSource(source, fsImpl) {
  if (typeof source === "string") return readSourceFile(source, fsImpl);
  if (source && typeof source.file === "string") return readSourceFile(source.file, fsImpl);
  if (source && typeof source.list === "function" && typeof source.listCoordinators === "function") {
    return {
      schema: OWNER_REQUEST_SCHEMA,
      version: OWNER_REQUEST_VERSION,
      requests: source.list(),
      coordinators: source.listCoordinators(),
    };
  }
  return source && source.state ? source.state : source;
}

function assertReferenceSource(value) {
  if (value && value.topics && Object.prototype.hasOwnProperty.call(value, "schemaVersion")) {
    throw taggedError("COOP_CONTROL_SHADOW_SOURCE_OUT_OF_SCOPE",
      "Coop topic indexes remain outside the ControlStore.");
  }
  if (!value || value.schema !== OWNER_REQUEST_SCHEMA || value.version !== OWNER_REQUEST_VERSION ||
      !Array.isArray(value.requests) || !Array.isArray(value.coordinators)) {
    throw taggedError("COOP_CONTROL_SHADOW_SOURCE_INVALID",
      "Shadow import requires a supported reference-only Coop owner-request store.");
  }
}

function sourceState(source, options) {
  var fsImpl = options && options.fs || fs;
  var value = unwrapSource(source, fsImpl);
  assertReferenceSource(value);
  return value;
}

function addRecord(byIdentity, recordType, recordKey, value) {
  var record = { recordType: recordType, recordKey: recordKey, value: value };
  var identity = recordType + "\u0000" + recordKey;
  var canonicalJson = stableJson(record);
  if (byIdentity[identity] && byIdentity[identity].canonicalJson !== canonicalJson) {
    throw taggedError("COOP_CONTROL_SHADOW_CONFLICT",
      "Shadow sources disagree about " + recordType + " " + recordKey + ".");
  }
  byIdentity[identity] = { record: record, canonicalJson: canonicalJson };
}

function isProjection(value) {
  if (!Array.isArray(value)) return false;
  for (var i = 0; i < value.length; i++) {
    if (!value[i] || typeof value[i].recordType !== "string" ||
        typeof value[i].recordKey !== "string" || !Object.prototype.hasOwnProperty.call(value[i], "value")) return false;
  }
  return true;
}

function canonicalRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw taggedError("COOP_CONTROL_SHADOW_SOURCE_INVALID", "Direct projection records must be objects.");
  }
  var keys = Object.keys(record).sort();
  var expected = { recordKey: true, recordType: true, value: true };
  for (var i = 0; i < keys.length; i++) {
    if (!expected[keys[i]]) {
      if (validation.privacyAlias(keys[i])) {
        throw taggedError("COOP_CONTROL_STORE_OUT_OF_SCOPE",
          "Direct projection records cannot contain private field " + keys[i] + ".");
      }
      throw taggedError("COOP_CONTROL_SHADOW_SOURCE_INVALID", "Direct projection records have unknown fields.");
    }
  }
  if (keys.length !== 3) {
    throw taggedError("COOP_CONTROL_SHADOW_SOURCE_INVALID", "Direct projection records are incomplete.");
  }
  var normalized = validation.normalizeWritableRecord(record.recordType, record.recordKey, record.value);
  return { recordType: record.recordType, recordKey: record.recordKey, value: normalized };
}

function directProjection(records) {
  var byIdentity = {};
  for (var i = 0; i < records.length; i++) {
    var record = canonicalRecord(records[i]);
    addRecord(byIdentity, record.recordType, record.recordKey, record.value);
  }
  return Object.keys(byIdentity).sort().map(function (identity) {
    return byIdentity[identity].record;
  });
}

function referenceProjection(sources, options) {
  var input = Array.isArray(sources) ? sources : [sources];
  var byIdentity = {};
  for (var i = 0; i < input.length; i++) addReferenceState(byIdentity, sourceState(input[i], options));
  return Object.keys(byIdentity).sort().map(function (identity) {
    return byIdentity[identity].record;
  });
}

function addReferenceState(byIdentity, state) {
  for (var i = 0; i < state.requests.length; i++) {
    var request = referenceOnlyRequest(state.requests[i]);
    if (!request) throw taggedError("COOP_CONTROL_SHADOW_SOURCE_INVALID",
      "Shadow source contains an invalid owner request at index " + i + ".");
    addRecord(byIdentity, "owner_request", request.ingressId,
      validation.normalizeWritableRecord("owner_request", request.ingressId, request));
  }
  for (var j = 0; j < state.coordinators.length; j++) {
    var claim = referenceOnlyClaim(state.coordinators[j]);
    if (!claim) throw taggedError("COOP_CONTROL_SHADOW_SOURCE_INVALID",
      "Shadow source contains an invalid coordinator claim at index " + j + ".");
    var key = claim.topicId + ":" + claim.projectId;
    addRecord(byIdentity, "coordinator_claim", key,
      validation.normalizeWritableRecord("coordinator_claim", key, claim));
  }
}

function canonicalProjection(sources, options) {
  return isProjection(sources) ? directProjection(sources) : referenceProjection(sources, options);
}

function projectionDigest(projection) {
  return sha256(stableJson(canonicalProjection(projection)));
}

function canonicalDigest(sources, options) {
  return projectionDigest(canonicalProjection(sources, options));
}

function storedRecords(projection) {
  return projection.map(function (record) {
    var canonicalJson = stableJson(record.value);
    return {
      recordType: record.recordType,
      recordKey: record.recordKey,
      canonicalJson: canonicalJson,
      recordDigest: sha256(canonicalJson),
    };
  });
}

function importShadow(store, sources, options) {
  var opts = options || {};
  var sourceId = opts.sourceId || DEFAULT_SOURCE_ID;
  if (!store || store.enabled !== true) {
    return { ok: true, enabled: false, changed: false, recordCount: 0, sourceId: sourceId };
  }
  var projection = canonicalProjection(sources, opts);
  var digest = projectionDigest(projection);
  var result = store.replaceShadowProjection(sourceId, {
    projectionDigest: digest,
    records: storedRecords(projection),
  });
  return {
    ok: true,
    enabled: true,
    changed: result.changed,
    importedAt: result.importedAt,
    projectionDigest: digest,
    recordCount: projection.length,
    sourceId: sourceId,
  };
}

function recordMap(records) {
  var result = {};
  for (var i = 0; i < records.length; i++) {
    result[records[i].recordType + "\u0000" + records[i].recordKey] = records[i];
  }
  return result;
}

// Stored rows are untrusted once the store is open: a row corrupted underneath
// the process can carry prose in any column. Comparison evidence therefore only
// ever repeats values that pass their own typed bound, and never a field name or
// message from the validator that rejected the row.
function boundedRecordType(value) {
  return validation.CONTROL_RECORD_TYPES[value] === true ? value : "";
}

function boundedRecordKey(value) {
  return typeof value === "string" && validation.IDENTIFIER_RE.test(value) ? value : "";
}

function boundedDigest(value) {
  return typeof value === "string" && validation.DIGEST_RE.test(value) ? value : null;
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mismatch(codeValue, record, expectedDigest, actualDigest) {
  return {
    code: codeValue,
    recordType: record ? boundedRecordType(record.recordType) : "",
    recordKey: record ? boundedRecordKey(record.recordKey) : "",
    expectedDigest: boundedDigest(expectedDigest),
    actualDigest: boundedDigest(actualDigest),
  };
}

function countMismatch(codeValue, expectedCount, actualCount) {
  return {
    code: codeValue,
    recordType: "",
    recordKey: "",
    expectedCount: boundedCount(expectedCount),
    actualCount: boundedCount(actualCount),
    expectedDigest: null,
    actualDigest: null,
  };
}

function compareRecords(expectedRecords, actualRecords) {
  var expected = recordMap(expectedRecords);
  var actual = recordMap(actualRecords);
  var identities = Object.keys(expected).concat(Object.keys(actual)).filter(function (identity, index, values) {
    return values.indexOf(identity) === index;
  }).sort();
  var mismatches = [];
  for (var i = 0; i < identities.length; i++) compareRecord(expected[identities[i]], actual[identities[i]], mismatches);
  return mismatches;
}

function compareRecord(wanted, stored, mismatches) {
  if (wanted && !stored) {
    mismatches.push(mismatch("missing_shadow_record", wanted, wanted.recordDigest, null));
    return;
  }
  if (!wanted && stored) {
    mismatches.push(mismatch("unexpected_shadow_record", stored, null, sha256(stored.canonicalJson)));
    return;
  }
  var actualDigest = sha256(stored.canonicalJson);
  if (wanted.recordDigest !== actualDigest || stored.recordDigest !== actualDigest ||
      wanted.canonicalJson !== stored.canonicalJson) {
    mismatches.push(mismatch("record_digest_mismatch", wanted, wanted.recordDigest, actualDigest));
  }
}

// Two independent counts, because they fail for different reasons: metadata
// that disagrees with the source means the import is stale, while metadata that
// disagrees with its own rows means rows were added or dropped underneath it.
function compareMetadata(metadata, counts, digests, mismatches) {
  if (!metadata) {
    mismatches.push(mismatch("shadow_import_missing", null, digests.source, null));
    return;
  }
  if (metadata.recordCount !== counts.expected) {
    mismatches.push(countMismatch("shadow_record_count_mismatch", counts.expected, metadata.recordCount));
  }
  if (metadata.recordCount !== counts.stored) {
    mismatches.push(countMismatch("shadow_stored_count_divergence", metadata.recordCount, counts.stored));
  }
  if (metadata.projectionDigest !== digests.shadow) {
    mismatches.push(mismatch("projection_digest_mismatch", null, digests.shadow, metadata.projectionDigest));
  }
}

// A stored row whose JSON still parses can nonetheless violate the typed schema
// or have drifted out of canonical form. That is a comparison verdict, not an
// exception: only the row's bounded identity and computed digest are reported.
function storedRowInvalid(record) {
  var canonicalJson = typeof record.canonicalJson === "string" ? record.canonicalJson : "";
  try {
    var value = validation.normalizeWritableRecord(record.recordType, record.recordKey, JSON.parse(canonicalJson));
    return stableJson(value) !== canonicalJson;
  } catch {
    return true;
  }
}

function auditStoredRecords(actualRecords, mismatches) {
  for (var i = 0; i < actualRecords.length; i++) {
    if (!storedRowInvalid(actualRecords[i])) continue;
    mismatches.push(mismatch("shadow_record_invalid", actualRecords[i], null,
      sha256(String(actualRecords[i].canonicalJson))));
  }
}

function storedProjectionJson(records) {
  return "[" + records.map(function (record) {
    return "{\"recordKey\":" + stableJson(record.recordKey) +
      ",\"recordType\":" + stableJson(record.recordType) +
      ",\"value\":" + String(record.canonicalJson) + "}";
  }).join(",") + "]";
}

function compareShadow(store, sources, options) {
  var opts = options || {};
  var sourceId = opts.sourceId || DEFAULT_SOURCE_ID;
  if (!store || store.enabled !== true) {
    return { ok: true, enabled: false, match: null, mismatches: [], sourceId: sourceId };
  }
  var expectedProjection = canonicalProjection(sources, opts);
  var expectedRecords = storedRecords(expectedProjection);
  var actualRecords = store.listShadowRecords(sourceId);
  var mismatches = compareRecords(expectedRecords, actualRecords);
  auditStoredRecords(actualRecords, mismatches);
  var sourceDigest = projectionDigest(expectedProjection);
  // Digest the stored rows exactly as they were persisted. Re-normalizing them
  // would either throw on a corrupt row or launder it into a matching digest.
  var shadowDigest = sha256(storedProjectionJson(actualRecords));
  var metadata = store.getShadowImport(sourceId);
  compareMetadata(metadata,
    { expected: expectedRecords.length, stored: actualRecords.length },
    { source: sourceDigest, shadow: shadowDigest }, mismatches);
  return {
    ok: true,
    enabled: true,
    match: mismatches.length === 0 && sourceDigest === shadowDigest,
    mismatches: mismatches,
    recordCount: expectedProjection.length,
    shadowRecordCount: actualRecords.length,
    sourceDigest: sourceDigest,
    shadowDigest: shadowDigest,
    sourceId: sourceId,
  };
}

module.exports = {
  DEFAULT_SOURCE_ID: DEFAULT_SOURCE_ID,
  OWNER_REQUEST_SCHEMA: OWNER_REQUEST_SCHEMA,
  OWNER_REQUEST_VERSION: OWNER_REQUEST_VERSION,
  buildCanonicalProjection: canonicalProjection,
  canonicalDigest: canonicalDigest,
  canonicalProjection: canonicalProjection,
  compareShadow: compareShadow,
  compareShadowProjection: compareShadow,
  importShadow: importShadow,
  importShadowFromReferenceStores: importShadow,
  projectionDigest: projectionDigest,
  referenceOnlyClaim: referenceOnlyClaim,
  referenceOnlyRequest: referenceOnlyRequest,
};
