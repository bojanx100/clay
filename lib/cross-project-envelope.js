// Versioned bounded wire format for durable cross-project reports.
var projectIdentity = require("./project-identity");
var controlRole = require("./coop-control-role");
var SCHEMA = "clay.cross_project_delivery";
var SCHEMA_VERSION = 1;
var MAX_TEXT_BYTES = 65536;
var MAX_TOPIC_ID = 128;
var EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isRevision(value) {
  return Number.isInteger(value) && value >= 0;
}

function sessionRef(value) {
  return projectIdentity.normalizeSessionRef(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Reference-only: a topic id and nothing else. Anything with extra keys is a
// half-formed ref carrying content it must not carry, and returns null so the
// envelope dead-letters as invalid_payload rather than being delivered.
function payloadTopicRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "topicId") return null;
  if (typeof value.topicId !== "string") return null;
  var topicId = value.topicId.trim();
  if (!topicId || topicId.length > MAX_TOPIC_ID) return null;
  return { topicId: topicId };
}

// Absent means absent. `undefined` and `null` are both "no attribution", and
// stay valid so every pre-existing envelope keeps delivering; only a PRESENT
// but malformed ref is a failure.
function validTopicRefField(value) {
  return value === undefined || value === null || !!payloadTopicRef(value);
}

function validControlRoleField(value) {
  return value === undefined ||
    (typeof value === "string" && !!controlRole.normalize(value));
}

function isReviewAttention(payload) {
  return payload.executionMode === "project_coordinator" &&
    payload.terminalStatus === "needs_input" && payload.reviewOnly === true &&
    validControlRoleField(payload.controlRole);
}

function validOwnerAcceptance(value) {
  if (value === undefined || value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  var keys = Object.keys(value).sort();
  if (value.status === "pending") {
    return JSON.stringify(keys) === JSON.stringify(["source", "status"]) &&
      typeof value.source === "string" && value.source.length > 0 && value.source.length <= 64;
  }
  return value.status === "accepted" && isFiniteNumber(value.at) && value.at > 0 &&
    JSON.stringify(keys) === JSON.stringify([
      "at", "by", "phrase", "source", "status", "withdrawnAt",
    ]) && typeof value.by === "string" && value.by.length > 0 && value.by.length <= 128 &&
    typeof value.source === "string" && value.source.length > 0 && value.source.length <= 64 &&
    typeof value.phrase === "string" && value.phrase.length > 0 && value.phrase.length <= 128 &&
    value.withdrawnAt === null;
}

function isOwnerAcceptanceAttention(payload) {
  return payload.executionMode === "project_coordinator" &&
    payload.terminalStatus === "needs_input" &&
    payload.ownerAcceptanceRequired === true && validOwnerAcceptance(payload.ownerAcceptance);
}

function isVisualCanaryAttention(payload) {
  return payload.executionMode === "project_coordinator" &&
    payload.terminalStatus === "needs_input" && payload.visualCanaryUnavailable === true;
}

function validPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (payload.type === "coordinator_update") {
    return typeof payload.text === "string" && payload.text.length > 0 &&
      Buffer.byteLength(payload.text, "utf8") <= MAX_TEXT_BYTES;
  }
  if (payload.type !== "portfolio_execution_completed") return false;
  if (typeof payload.portfolioTaskId !== "string" || !payload.portfolioTaskId ||
      payload.portfolioTaskId.length > 256 || !isPositiveInteger(payload.bindingRevision) ||
      !isFiniteNumber(payload.completedAt) || typeof payload.resultEventId !== "string" ||
      !payload.resultEventId || payload.resultEventId.length > 256 ||
      (payload.executionMode && payload.executionMode !== "direct_leaf" &&
        payload.executionMode !== "project_coordinator") ||
      (payload.terminalStatus !== "completed" && payload.terminalStatus !== "failed" &&
       !(payload.executionMode === "direct_leaf" && payload.terminalStatus === "needs_input") &&
       !isReviewAttention(payload) && !isOwnerAcceptanceAttention(payload) &&
       !isVisualCanaryAttention(payload)) ||
      typeof payload.ownerNotification !== "boolean" ||
      (payload.reviewOnly !== undefined && typeof payload.reviewOnly !== "boolean") ||
      (payload.visualCanaryUnavailable !== undefined &&
        typeof payload.visualCanaryUnavailable !== "boolean") ||
      !validControlRoleField(payload.controlRole) ||
      (payload.ownerAcceptanceRequired !== undefined &&
        typeof payload.ownerAcceptanceRequired !== "boolean") ||
      !validOwnerAcceptance(payload.ownerAcceptance) ||
      (payload.implementationCompletedAt !== undefined &&
        !isFiniteNumber(payload.implementationCompletedAt)) ||
      (payload.implementationCompletionRevision !== undefined &&
        !isRevision(payload.implementationCompletionRevision)) ||
      (payload.implementationGraphDigest !== undefined &&
        typeof payload.implementationGraphDigest !== "string") ||
      !validTopicRefField(payload.coopTopicRef)) return false;
  return typeof payload.text !== "string" ||
    Buffer.byteLength(payload.text, "utf8") <= MAX_TEXT_BYTES;
}

function boundedPayload(payload) {
  if (!validPayload(payload)) return null;
  if (payload.type === "coordinator_update") {
    return { type: payload.type, text: payload.text };
  }
  var bounded = {
    type: payload.type,
    portfolioTaskId: payload.portfolioTaskId,
    bindingRevision: payload.bindingRevision,
    executionMode: payload.executionMode || "direct_leaf",
    completedAt: payload.completedAt,
    resultEventId: payload.resultEventId,
    terminalStatus: payload.terminalStatus,
    ownerNotification: payload.ownerNotification,
    text: typeof payload.text === "string" ? payload.text : "",
  };
  if (payload.reviewOnly === true) bounded.reviewOnly = true;
  if (payload.visualCanaryUnavailable === true) bounded.visualCanaryUnavailable = true;
  if (payload.ownerAcceptanceRequired === true) bounded.ownerAcceptanceRequired = true;
  if (payload.ownerAcceptance) bounded.ownerAcceptance = clone(payload.ownerAcceptance);
  if (isFiniteNumber(payload.implementationCompletedAt)) {
    bounded.implementationCompletedAt = payload.implementationCompletedAt;
  }
  if (isRevision(payload.implementationCompletionRevision)) {
    bounded.implementationCompletionRevision = payload.implementationCompletionRevision;
  }
  if (typeof payload.implementationGraphDigest === "string") {
    bounded.implementationGraphDigest = payload.implementationGraphDigest.slice(0, 256);
  }
  if (typeof payload.controlRole === "string") {
    var role = controlRole.normalize(payload.controlRole);
    if (role) bounded.controlRole = role;
  }
  // Emitted ONLY when present, and last. isSameEnvelope compares the JSON of
  // this object byte for byte, so an unconditional key would change every
  // pre-existing envelope's serialization and break replay/idempotency.
  var topicRef = payloadTopicRef(payload.coopTopicRef);
  if (topicRef) bounded.coopTopicRef = topicRef;
  return bounded;
}

function validationReason(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return "invalid_payload";
  if (envelope.schema !== SCHEMA || envelope.schemaVersion !== SCHEMA_VERSION) return "unsupported_schema";
  if (!EVENT_ID_RE.test(String(envelope.eventId || ""))) return "invalid_payload";
  if (!sessionRef(envelope.source) || !sessionRef(envelope.destination)) return "invalid_payload";
  if (!isRevision(envelope.bindingRevision) || !isPositiveInteger(envelope.sourceSeq) ||
      !isFiniteNumber(envelope.createdAt) || !validPayload(envelope.payload)) return "invalid_payload";
  return "";
}

function boundedEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  return {
    schema: envelope.schema,
    schemaVersion: envelope.schemaVersion,
    eventId: envelope.eventId,
    source: sessionRef(envelope.source),
    destination: sessionRef(envelope.destination),
    bindingRevision: envelope.bindingRevision,
    sourceSeq: envelope.sourceSeq,
    createdAt: envelope.createdAt,
    payload: boundedPayload(envelope.payload),
  };
}

function isSameEnvelope(left, right) {
  return JSON.stringify(boundedEnvelope(left)) === JSON.stringify(boundedEnvelope(right));
}

module.exports = {
  SCHEMA: SCHEMA, SCHEMA_VERSION: SCHEMA_VERSION, EVENT_ID_RE: EVENT_ID_RE,
  isFiniteNumber: isFiniteNumber, isPositiveInteger: isPositiveInteger,
  boundedPayload: boundedPayload, boundedEnvelope: boundedEnvelope,
  isSameEnvelope: isSameEnvelope, validationReason: validationReason,
};
