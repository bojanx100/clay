// Typed, reference-only schemas for Slice 1 ControlStore records. Unknown
// fields fail closed so prose cannot enter through a newly invented alias.

var projectIdentity = require("./project-identity");

var CONTROL_RECORD_TYPES = Object.freeze({
  approval: true,
  checkpoint: true,
  coordinator_claim: true,
  execution_binding: true,
  handoff: true,
  learning: true,
  owner_request: true,
  task: true,
});
var WRITABLE_RECORD_TYPES = Object.freeze({ coordinator_claim: true, owner_request: true });
var IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
var INGRESS_ID_RE = /^coop:[A-Za-z0-9._-]{1,128}:[0-9]{1,12}$/;
var CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var DIGEST_RE = /^[a-f0-9]{64}$/;
var REQUEST_STATES = { open: true, working: true, needs_input: true, done: true, attention: true };
var CLASSIFICATIONS = { conversational: true, existing_topic: true, new_topic: true };
var RESPONSE_STATES = { unanswered: true, answered: true, superseded: true };

function taggedError(code, message, cause) {
  var error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function privacyAlias(key) {
  var normalized = String(key || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  var topicContent = normalized === "topic" || normalized === "topics" ||
    (normalized.indexOf("topic") !== -1 &&
      /body|content|text|title|summary|description|record|index|membership|members|payload/.test(normalized));
  return /transcript|prompt|reasoning|message|conversation|chainofthought|analysis|history|runtimecontext|projection/.test(normalized) ||
    topicContent;
}

function invalidField(key) {
  if (privacyAlias(key)) {
    throw taggedError("COOP_CONTROL_STORE_OUT_OF_SCOPE",
      "ControlStore records cannot contain private or topic-content field " + key + ".");
  }
  throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "Unknown ControlStore field: " + key + ".");
}

function assertControlPayload(value, ancestors) {
  if (!value || typeof value !== "object") return;
  var stack = ancestors || [];
  if (stack.indexOf(value) !== -1) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "Control records cannot contain circular values.");
  }
  stack.push(value);
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    if (privacyAlias(keys[i])) invalidField(keys[i]);
    assertControlPayload(value[keys[i]], stack);
  }
  stack.pop();
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " must be a plain object.");
  }
  return value;
}

function allowedFields(value, names, label) {
  var source = plainObject(value, label);
  var allowed = {};
  for (var i = 0; i < names.length; i++) allowed[names[i]] = true;
  var keys = Object.keys(source);
  for (var j = 0; j < keys.length; j++) {
    if (!allowed[keys[j]]) invalidField(keys[j]);
  }
  for (var k = 0; k < names.length; k++) {
    if (!Object.prototype.hasOwnProperty.call(source, names[k])) {
      throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD",
        label + " is missing required field " + names[k] + ".");
    }
  }
  return source;
}

function boundedIdentifier(value, label, expression) {
  var pattern = expression || IDENTIFIER_RE;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " must be a bounded identifier.");
  }
  return value;
}

function nullableNumber(value, label) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " must be a non-negative finite number or null.");
  }
  return value;
}

function exactProjectRef(value, label) {
  var source = allowedFields(value, ["projectId"], label);
  var normalized = projectIdentity.normalizeProjectRef(source);
  if (!normalized) throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " is invalid.");
  return normalized;
}

function exactSessionRef(value, label) {
  var source = allowedFields(value, ["projectId", "sessionStorageId"], label);
  if (typeof source.sessionStorageId !== "string" || source.sessionStorageId.length > 256) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " is invalid.");
  }
  var normalized = projectIdentity.normalizeSessionRef(source);
  if (!normalized) throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " is invalid.");
  return normalized;
}

function exactEventRef(value, label) {
  if (value === null || value === undefined) return null;
  var source = allowedFields(value, ["projectId", "sessionStorageId", "eventIndex"], label);
  var session = projectIdentity.normalizeSessionRef(source);
  if (!session || !Number.isInteger(source.eventIndex) || source.eventIndex < 0) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " is invalid.");
  }
  return { projectId: session.projectId, sessionStorageId: session.sessionStorageId, eventIndex: source.eventIndex };
}

function exactTaskRef(value, label) {
  var source = allowedFields(value,
    ["projectId", "coordinatorSessionStorageId", "taskId"], label);
  if (typeof source.coordinatorSessionStorageId !== "string" ||
      source.coordinatorSessionStorageId.length > 256) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " is invalid.");
  }
  var normalized = projectIdentity.normalizeTaskRef(source);
  if (!normalized) throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " is invalid.");
  return normalized;
}

function exactTopicRef(value, label) {
  if (value === null || value === undefined) return null;
  var source = allowedFields(value, ["topicId"], label);
  return { topicId: boundedIdentifier(source.topicId, label + ".topicId") };
}

function compareJson(left, right) {
  var a = JSON.stringify(left);
  var b = JSON.stringify(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function normalizedSet(values, normalizer, label) {
  if (!Array.isArray(values)) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", label + " must be an array.");
  }
  var byValue = {};
  for (var i = 0; i < values.length; i++) {
    var normalized = normalizer(values[i], label + "[" + i + "]");
    byValue[JSON.stringify(normalized)] = normalized;
  }
  return Object.keys(byValue).map(function (key) { return byValue[key]; }).sort(compareJson);
}

function normalizeResponse(value) {
  var source = allowedFields(value,
    ["state", "answeredAt", "responseRef", "supersededAt", "supersededBy"], "response");
  if (!RESPONSE_STATES[source.state]) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "response.state is invalid.");
  }
  var answeredAt = nullableNumber(source.answeredAt, "response.answeredAt");
  var responseRef = exactEventRef(source.responseRef, "response.responseRef");
  var supersededAt = nullableNumber(source.supersededAt, "response.supersededAt");
  var supersededBy = source.supersededBy;
  if (typeof supersededBy !== "string" || supersededBy.length > 40 ||
      (supersededBy && !INGRESS_ID_RE.test(supersededBy))) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "response.supersededBy is invalid.");
  }
  validateResponseReferences(source.state, answeredAt, responseRef, supersededAt, supersededBy);
  return {
    state: source.state,
    answeredAt: answeredAt,
    responseRef: responseRef,
    supersededAt: supersededAt,
    supersededBy: supersededBy,
  };
}

function validateResponseReferences(state, answeredAt, responseRef, supersededAt, supersededBy) {
  if (state === "answered") {
    if (answeredAt === null || !responseRef) {
      throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "An answered response requires answer references.");
    }
  } else if (answeredAt !== null || responseRef) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "Only answered responses may carry answer references.");
  }
  if (state !== "superseded" && (supersededAt !== null || supersededBy)) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "Only superseded responses may carry supersession references.");
  }
}

function normalizeClassification(value) {
  if (value === null || value === undefined) return null;
  var source = allowedFields(value, ["kind", "source", "at"], "classification");
  if (!CLASSIFICATIONS[source.kind] || (source.source !== "" && !CODE_RE.test(source.source))) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "classification contains an invalid code.");
  }
  return { kind: source.kind, source: source.source, at: nullableNumber(source.at, "classification.at") };
}

function normalizeLinks(value) {
  var source = allowedFields(value, ["coordinators", "tasks", "sessions"], "links");
  return {
    coordinators: normalizedSet(source.coordinators, exactSessionRef, "links.coordinators"),
    tasks: normalizedSet(source.tasks, exactTaskRef, "links.tasks"),
    sessions: normalizedSet(source.sessions, exactSessionRef, "links.sessions"),
  };
}

function normalizeOutcome(value) {
  if (value === null || value === undefined) return null;
  var source = allowedFields(value, ["status", "at"], "outcome");
  boundedIdentifier(source.status, "outcome.status", CODE_RE);
  return { status: source.status, at: nullableNumber(source.at, "outcome.at") };
}

function normalizeOwnerRequest(value, recordKey) {
  var source = allowedFields(value, [
    "ingressId", "ingressSequence", "ingressKind", "sessionRef", "requestRef",
    "receivedAt", "updatedAt", "response", "classification", "topicRef",
    "projectRefs", "expectsExecution", "links", "state", "attention", "outcome",
  ], "owner_request");
  var ingressId = boundedIdentifier(source.ingressId, "owner_request.ingressId", INGRESS_ID_RE);
  if (ingressId !== recordKey || !Number.isInteger(source.ingressSequence) || source.ingressSequence <= 0 ||
      (source.ingressKind !== "text" && source.ingressKind !== "voice") ||
      typeof source.expectsExecution !== "boolean" || !REQUEST_STATES[source.state]) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "owner_request identity or typed fields are invalid.");
  }
  var attention = source.attention;
  if (attention !== null) boundedIdentifier(attention, "owner_request.attention", CODE_RE);
  var classification = normalizeClassification(source.classification);
  var expectedExecution = !!(classification && classification.kind !== "conversational");
  if (source.expectsExecution !== expectedExecution) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "owner_request execution classification is inconsistent.");
  }
  return {
    ingressId: ingressId,
    ingressSequence: source.ingressSequence,
    ingressKind: source.ingressKind,
    sessionRef: exactSessionRef(source.sessionRef, "owner_request.sessionRef"),
    requestRef: exactEventRef(source.requestRef, "owner_request.requestRef"),
    receivedAt: nullableNumber(source.receivedAt, "owner_request.receivedAt"),
    updatedAt: nullableNumber(source.updatedAt, "owner_request.updatedAt"),
    response: normalizeResponse(source.response),
    classification: classification,
    topicRef: exactTopicRef(source.topicRef, "owner_request.topicRef"),
    projectRefs: normalizedSet(source.projectRefs, exactProjectRef, "owner_request.projectRefs"),
    expectsExecution: source.expectsExecution,
    links: normalizeLinks(source.links),
    state: source.state,
    attention: attention,
    outcome: normalizeOutcome(source.outcome),
  };
}

function normalizeClaim(value, recordKey) {
  var source = allowedFields(value,
    ["topicId", "projectId", "coordinator", "claimedAt", "ingressIds"], "coordinator_claim");
  var topicId = boundedIdentifier(source.topicId, "coordinator_claim.topicId");
  var project = exactProjectRef({ projectId: source.projectId }, "coordinator_claim.projectId");
  var coordinator = exactSessionRef(source.coordinator, "coordinator_claim.coordinator");
  if (coordinator.projectId !== project.projectId || recordKey !== topicId + ":" + project.projectId) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "coordinator_claim identity is inconsistent.");
  }
  return {
    topicId: topicId,
    projectId: project.projectId,
    coordinator: coordinator,
    claimedAt: nullableNumber(source.claimedAt, "coordinator_claim.claimedAt"),
    ingressIds: normalizedSet(source.ingressIds, function (item, label) {
      return boundedIdentifier(item, label, INGRESS_ID_RE);
    }, "coordinator_claim.ingressIds"),
  };
}

function validateRecordIdentity(recordType, recordKey) {
  if (!CONTROL_RECORD_TYPES[recordType]) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD", "Unsupported control record type: " + recordType + ".");
  }
  boundedIdentifier(recordKey, "Control record key");
}

function normalizeWritableRecord(recordType, recordKey, value) {
  validateRecordIdentity(recordType, recordKey);
  if (!WRITABLE_RECORD_TYPES[recordType]) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_RECORD",
      "Control record type " + recordType + " is reserved until its typed schema lands.");
  }
  if (recordType === "owner_request") return normalizeOwnerRequest(value, recordKey);
  return normalizeClaim(value, recordKey);
}

function validateSourceId(sourceId) {
  if (typeof sourceId !== "string" || !IDENTIFIER_RE.test(sourceId)) {
    throw taggedError("COOP_CONTROL_STORE_INVALID_SHADOW", "Shadow source ids must be bounded identifiers.");
  }
  return sourceId;
}

module.exports = {
  CODE_RE: CODE_RE,
  CONTROL_RECORD_TYPES: CONTROL_RECORD_TYPES,
  DIGEST_RE: DIGEST_RE,
  IDENTIFIER_RE: IDENTIFIER_RE,
  WRITABLE_RECORD_TYPES: WRITABLE_RECORD_TYPES,
  assertControlPayload: assertControlPayload,
  normalizeWritableRecord: normalizeWritableRecord,
  privacyAlias: privacyAlias,
  taggedError: taggedError,
  validateRecordIdentity: validateRecordIdentity,
  validateSourceId: validateSourceId,
};
