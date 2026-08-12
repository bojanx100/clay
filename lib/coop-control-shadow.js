// Deterministic, privacy-safe shadow projection of the existing Coop owner
// request ledger. This is comparison evidence only; it does not activate the
// ControlStore or make the SQLite copy authoritative.

var crypto = require("crypto");
var fs = require("fs");
var ownerRecords = require("./coop-owner-request-records");
var controlStore = require("./coop-control-store");

var DEFAULT_SOURCE_ID = "coop-reference-stores";
var OWNER_REQUEST_SCHEMA = "clay.coop_owner_requests";
var OWNER_REQUEST_VERSION = 1;
var CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function taggedError(code, message, cause) {
  var error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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
    supersededBy: ownerRecords.ingressId(source.supersededBy) || "",
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
      source: code(record.classification.source),
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
    outcome: record.outcome ? { status: code(record.outcome.status), at: record.outcome.at } : null,
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

function sourceState(source, options) {
  var fsImpl = options && options.fs || fs;
  var value = source;
  if (typeof value === "string") value = readSourceFile(value, fsImpl);
  else if (value && typeof value.file === "string") value = readSourceFile(value.file, fsImpl);
  else if (value && typeof value.list === "function" && typeof value.listCoordinators === "function") {
    value = {
      schema: OWNER_REQUEST_SCHEMA,
      version: OWNER_REQUEST_VERSION,
      requests: value.list(),
      coordinators: value.listCoordinators(),
    };
  } else if (value && value.state) value = value.state;

  if (value && value.topics && Object.prototype.hasOwnProperty.call(value, "schemaVersion")) {
    throw taggedError("COOP_CONTROL_SHADOW_SOURCE_OUT_OF_SCOPE",
      "Coop topic indexes remain outside the ControlStore.");
  }
  if (!value || value.schema !== OWNER_REQUEST_SCHEMA || value.version !== OWNER_REQUEST_VERSION ||
      !Array.isArray(value.requests) || !Array.isArray(value.coordinators)) {
    throw taggedError("COOP_CONTROL_SHADOW_SOURCE_INVALID",
      "Shadow import requires a supported reference-only Coop owner-request store.");
  }
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

function canonicalProjection(sources, options) {
  if (isProjection(sources)) {
    return sources.map(function (record) {
      return { recordType: record.recordType, recordKey: record.recordKey, value: clone(record.value) };
    }).sort(function (left, right) {
      return compareText(left.recordType + "\u0000" + left.recordKey,
        right.recordType + "\u0000" + right.recordKey);
    });
  }
  var input = Array.isArray(sources) ? sources : [sources];
  var byIdentity = {};
  for (var i = 0; i < input.length; i++) {
    var state = sourceState(input[i], options);
    for (var j = 0; j < state.requests.length; j++) {
      var request = referenceOnlyRequest(state.requests[j]);
      if (!request) {
        throw taggedError("COOP_CONTROL_SHADOW_SOURCE_INVALID",
          "Shadow source contains an invalid owner request at index " + j + ".");
      }
      addRecord(byIdentity, "owner_request", request.ingressId, request);
    }
    for (var k = 0; k < state.coordinators.length; k++) {
      var claim = referenceOnlyClaim(state.coordinators[k]);
      if (!claim) {
        throw taggedError("COOP_CONTROL_SHADOW_SOURCE_INVALID",
          "Shadow source contains an invalid coordinator claim at index " + k + ".");
      }
      addRecord(byIdentity, "coordinator_claim", claim.topicId + ":" + claim.projectId, claim);
    }
  }
  return Object.keys(byIdentity).sort().map(function (identity) {
    return byIdentity[identity].record;
  });
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

function mismatch(codeValue, record, expectedDigest, actualDigest) {
  return {
    code: codeValue,
    recordType: record ? record.recordType : "",
    recordKey: record ? record.recordKey : "",
    expectedDigest: expectedDigest || null,
    actualDigest: actualDigest || null,
  };
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
  var expected = recordMap(expectedRecords);
  var actual = recordMap(actualRecords);
  var identities = Object.keys(expected).concat(Object.keys(actual)).filter(function (identity, index, values) {
    return values.indexOf(identity) === index;
  }).sort();
  var mismatches = [];
  for (var i = 0; i < identities.length; i++) {
    var wanted = expected[identities[i]];
    var stored = actual[identities[i]];
    if (wanted && !stored) mismatches.push(mismatch("missing_shadow_record", wanted, wanted.recordDigest, null));
    else if (!wanted && stored) mismatches.push(mismatch("unexpected_shadow_record", stored, null,
      sha256(stored.canonicalJson)));
    else if (wanted.recordDigest !== sha256(stored.canonicalJson) ||
        stored.recordDigest !== sha256(stored.canonicalJson) || wanted.canonicalJson !== stored.canonicalJson) {
      mismatches.push(mismatch("record_digest_mismatch", wanted, wanted.recordDigest,
        sha256(stored.canonicalJson)));
    }
  }
  var sourceDigest = projectionDigest(expectedProjection);
  var actualProjection = actualRecords.map(function (record) {
    return { recordType: record.recordType, recordKey: record.recordKey, value: record.value };
  });
  var shadowDigest = projectionDigest(actualProjection);
  var metadata = store.getShadowImport(sourceId);
  if (!metadata) mismatches.push(mismatch("shadow_import_missing", null, sourceDigest, null));
  else if (metadata.projectionDigest !== shadowDigest) {
    mismatches.push(mismatch("projection_digest_mismatch", null, shadowDigest, metadata.projectionDigest));
  }
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
