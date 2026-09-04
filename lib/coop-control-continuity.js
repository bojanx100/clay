// Exact transcript-free continuity schema for recoverable Coop handoff. The
// packet contains admitted objectives and durable control references only.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var validation = require("./coop-control-store-validation");

var SCHEMA_VERSION = 1;
var MAX_PACKET_BYTES = 131072;
var MAX_COLLECTION_ITEMS = 256;
var TASK_STATUSES = Object.freeze(Object.assign(Object.create(null), {
  blocked: true, cancelled: true, completed: true, dismissed: true, failed: true,
  in_progress: true, needs_input: true, pending: true, queued: true, ready: true,
  reviewing: true, running: true, waiting_user: true,
}));
var BINDING_STATUSES = Object.freeze(Object.assign(Object.create(null), {
  active: true, cancelled: true, completed: true, deleted: true, failed: true,
  pending: true, superseded: true, unavailable: true, unrouted: true,
}));
var MODES = Object.freeze(Object.assign(Object.create(null), {
  direct_leaf: "worker", project_coordinator: "coordinator",
}));
var TOP_LEVEL_FIELDS = ["schemaVersion", "objectives", "decisions", "ownerRequests",
  "tasks", "bindings", "authorities", "executions", "learningReferences"];
var OPTIONAL_TOP_LEVEL_FIELDS = [];

function error(code, message, cause) {
  return validation.taggedError(code, message, cause);
}

function invalid(message) {
  throw error("COOP_CONTROL_CONTINUITY_INVALID", message);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(label + " must be a plain object.");
  }
  return value;
}

function exactObject(value, fields, label, requiredFields) {
  var source = plainObject(value, label);
  var allowed = Object.create(null);
  var keys = Object.keys(source);
  var i;
  for (i = 0; i < fields.length; i++) allowed[fields[i]] = true;
  for (i = 0; i < keys.length; i++) {
    if (!allowed[keys[i]]) {
      var normalizedKey = String(keys[i]).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
      if (validation.privacyAlias(keys[i]) || normalizedKey.indexOf("topic") !== -1) {
        throw error("COOP_CONTROL_CONTINUITY_OUT_OF_SCOPE",
          label + " cannot contain private field " + keys[i] + ".");
      }
      invalid(label + " contains unknown field " + keys[i] + ".");
    }
  }
  var required = requiredFields || fields;
  for (i = 0; i < required.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(source, required[i])) {
      invalid(label + " is missing field " + required[i] + ".");
    }
  }
  return source;
}

function identifier(value, label) {
  if (typeof value !== "string" || !validation.IDENTIFIER_RE.test(value)) {
    invalid(label + " must be a bounded identifier.");
  }
  return value;
}

function boundedText(value, limit, label) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000]/.test(value)) {
    invalid(label + " must be non-empty bounded text.");
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(label + " must be a positive safe integer.");
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(label + " must be a non-negative safe integer.");
  return value;
}

function sessionRef(value, label) {
  var source = exactObject(value, ["projectId", "sessionStorageId"], label);
  var normalized = projectIdentity.normalizeSessionRef(source);
  if (!normalized) invalid(label + " must be a valid SessionRef.");
  return normalized;
}

function projectRef(value, label) {
  var source = exactObject(value, ["projectId"], label);
  var normalized = projectIdentity.normalizeProjectRef(source);
  if (!normalized) invalid(label + " must be a valid ProjectRef.");
  return normalized;
}

function optionalOwner(value, label) {
  return value === null ? null : sessionRef(value, label);
}

function normalizeObjective(value, index) {
  var label = "Objective " + index;
  var source = exactObject(value, ["objectiveId", "text"], label);
  return { objectiveId: identifier(source.objectiveId, label + ".objectiveId"),
    text: boundedText(source.text, 12000, label + ".text") };
}

function normalizeDecision(value, index) {
  var label = "Decision " + index;
  var source = exactObject(value, ["decisionId", "value", "acceptedAt"], label);
  return { decisionId: identifier(source.decisionId, label + ".decisionId"),
    value: boundedText(source.value, 4000, label + ".value"),
    acceptedAt: timestamp(source.acceptedAt, label + ".acceptedAt") };
}

function normalizeOwnerRequest(value, index) {
  var label = "Owner request " + index;
  var source = exactObject(value, ["requestId", "ingressId", "receivedAt"], label);
  return { requestId: identifier(source.requestId, label + ".requestId"),
    ingressId: identifier(source.ingressId, label + ".ingressId"),
    receivedAt: timestamp(source.receivedAt, label + ".receivedAt") };
}

function normalizeTask(value, index) {
  var label = "Task " + index;
  var source = exactObject(value, ["taskId", "objectiveId", "status", "owner"], label);
  var status = mapCanonicalTaskStatus(source.status, label);
  return { taskId: identifier(source.taskId, label + ".taskId"),
    objectiveId: identifier(source.objectiveId, label + ".objectiveId"),
    status: status, owner: optionalOwner(source.owner, label + ".owner") };
}

function normalizeBinding(value, index) {
  var label = "Binding " + index;
  var source = exactObject(value,
    ["portfolioTaskId", "bindingRevision", "targetProject", "mode", "status"], label);
  if (!Object.prototype.hasOwnProperty.call(MODES, source.mode)) {
    invalid(label + " contains an unsupported mode.");
  }
  return { portfolioTaskId: identifier(source.portfolioTaskId, label + ".portfolioTaskId"),
    bindingRevision: positiveInteger(source.bindingRevision, label + ".bindingRevision"),
    targetProject: projectRef(source.targetProject, label + ".targetProject"),
    mode: source.mode, status: mapCanonicalBindingStatus(source.status, label) };
}

function allowedStatus(values, value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(values, value) &&
    values[value] === true;
}

function mapCanonicalTaskStatus(value, label) {
  if (!allowedStatus(TASK_STATUSES, value)) invalid((label || "Task") + ".status is unsupported.");
  return value;
}

function mapCanonicalBindingStatus(value, label) {
  if (!allowedStatus(BINDING_STATUSES, value)) invalid((label || "Binding") + ".status is unsupported.");
  return value;
}

function normalizeExecution(value, index) {
  var label = "Execution " + index;
  var source = exactObject(value, ["executionId", "authorityId", "source", "portfolioTaskId",
    "bindingRevision", "targetProject", "mode", "role"], label);
  if (!Object.prototype.hasOwnProperty.call(MODES, source.mode) || source.role !== MODES[source.mode]) {
    invalid(label + " has an unsupported mode or role.");
  }
  var lead = sessionRef(source.source, label + ".source");
  if (lead.projectId !== projectIdentity.LEAD_PROJECT_ID) {
    invalid(label + ".source must be the canonical Lead SessionRef.");
  }
  return { executionId: identifier(source.executionId, label + ".executionId"),
    authorityId: identifier(source.authorityId, label + ".authorityId"), source: lead,
    portfolioTaskId: identifier(source.portfolioTaskId, label + ".portfolioTaskId"),
    bindingRevision: positiveInteger(source.bindingRevision, label + ".bindingRevision"),
    targetProject: projectRef(source.targetProject, label + ".targetProject"),
    mode: source.mode, role: source.role };
}

function normalizeAuthority(value, index) {
  var label = "Authority " + index;
  var source = exactObject(value, ["authorityId", "source", "portfolioTaskId", "bindingRevision",
    "targetProject", "role", "actionMask"], label);
  if ((source.role !== "coordinator" && source.role !== "worker") || source.actionMask !== 31) {
    invalid(label + " contains unsupported authority fields.");
  }
  var lead = sessionRef(source.source, label + ".source");
  if (lead.projectId !== projectIdentity.LEAD_PROJECT_ID) {
    invalid(label + ".source must be the canonical Lead SessionRef.");
  }
  return { authorityId: identifier(source.authorityId, label + ".authorityId"),
    source: lead,
    portfolioTaskId: identifier(source.portfolioTaskId, label + ".portfolioTaskId"),
    bindingRevision: positiveInteger(source.bindingRevision, label + ".bindingRevision"),
    targetProject: projectRef(source.targetProject, label + ".targetProject"),
    role: source.role, actionMask: source.actionMask };
}

function normalizeLearning(value, index) {
  var label = "Learning reference " + index;
  var source = exactObject(value, ["learningId", "version"], label);
  return { learningId: identifier(source.learningId, label + ".learningId"),
    version: positiveInteger(source.version, label + ".version") };
}

function normalizeList(value, normalizer, identityField, label) {
  if (!Array.isArray(value)) invalid(label + " must be an array.");
  if (value.length > MAX_COLLECTION_ITEMS) invalid(label + " exceeds the collection limit.");
  var result = value.map(normalizer);
  result.sort(function (left, right) {
    var a = typeof identityField === "function" ? identityField(left) : left[identityField];
    var b = typeof identityField === "function" ? identityField(right) : right[identityField];
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  for (var i = 1; i < result.length; i++) {
    var previous = typeof identityField === "function" ? identityField(result[i - 1]) : result[i - 1][identityField];
    var current = typeof identityField === "function" ? identityField(result[i]) : result[i][identityField];
    if (previous === current) {
      invalid(label + " contains a duplicate identity.");
    }
  }
  return result;
}

function bindingIdentity(value) {
  return value.portfolioTaskId + "\u0000" + value.bindingRevision;
}

function indexTaskIds(objectives, tasks) {
  var objectiveIds = Object.create(null);
  var taskIds = Object.create(null);
  var i;
  for (i = 0; i < objectives.length; i++) objectiveIds[objectives[i].objectiveId] = true;
  for (i = 0; i < tasks.length; i++) {
    if (!objectiveIds[tasks[i].objectiveId]) invalid("A task references an unknown objective.");
    taskIds[tasks[i].taskId] = true;
  }
  return taskIds;
}

function indexBindings(tasks, bindings) {
  var result = Object.create(null);
  for (var i = 0; i < bindings.length; i++) {
    var binding = bindings[i];
    if (!tasks[binding.portfolioTaskId]) invalid("A binding references an unknown task.");
    result[bindingIdentity(binding)] = binding;
  }
  return result;
}

function authorityMatchesBinding(authority, binding) {
  return !!binding && binding.targetProject.projectId === authority.targetProject.projectId &&
    MODES[binding.mode] === authority.role;
}

function indexAuthorities(bindings, authorities) {
  var result = Object.create(null);
  for (var i = 0; i < authorities.length; i++) {
    var authority = authorities[i];
    if (!authorityMatchesBinding(authority, bindings[bindingIdentity(authority)]) ||
        bindings[bindingIdentity(authority)].status === "unrouted") {
      invalid("An authority does not match a preserved binding.");
    }
    result[authority.authorityId] = authority;
  }
  return result;
}

function executionMatches(execution, binding, authority) {
  return !!binding && !!authority && binding.targetProject.projectId === execution.targetProject.projectId &&
    binding.mode === execution.mode && authority.portfolioTaskId === execution.portfolioTaskId &&
    authority.bindingRevision === execution.bindingRevision &&
    authority.targetProject.projectId === execution.targetProject.projectId && authority.role === execution.role &&
    authority.source.projectId === execution.source.projectId &&
    authority.source.sessionStorageId === execution.source.sessionStorageId;
}

function indexExecutions(bindings, authorities, executions) {
  var byBinding = Object.create(null);
  var byAuthority = Object.create(null);
  for (var i = 0; i < executions.length; i++) {
    var execution = executions[i];
    var key = bindingIdentity(execution);
    if (!executionMatches(execution, bindings[key], authorities[execution.authorityId])) {
      invalid("An execution does not exactly cross-link its binding and authority.");
    }
    if (byBinding[key] || byAuthority[execution.authorityId]) {
      invalid("An execution cross-link is duplicated.");
    }
    byBinding[key] = execution;
    byAuthority[execution.authorityId] = execution;
  }
  return { byAuthority: byAuthority, byBinding: byBinding };
}

function requireExecutionCoverage(bindings, authorities, executions) {
  for (var i = 0; i < bindings.length; i++) {
    var execution = executions.byBinding[bindingIdentity(bindings[i])];
    if (bindings[i].status === "unrouted") {
      if (execution) invalid("An unrouted binding cannot retain a durable execution cross-link.");
      continue;
    }
    if (!execution) {
      invalid("A binding has no exact durable execution cross-link.");
    }
  }
  for (var j = 0; j < authorities.length; j++) {
    if (!executions.byAuthority[authorities[j].authorityId]) {
      invalid("An authority has no exact durable execution cross-link.");
    }
  }
}

function validateReferences(packet) {
  var tasks = indexTaskIds(packet.objectives, packet.tasks);
  var bindings = indexBindings(tasks, packet.bindings);
  var authorities = indexAuthorities(bindings, packet.authorities);
  var executions = indexExecutions(bindings, authorities, packet.executions);
  requireExecutionCoverage(packet.bindings, packet.authorities, executions);
}

function normalizeContinuityPacket(value) {
  var source = exactObject(value, TOP_LEVEL_FIELDS.concat(OPTIONAL_TOP_LEVEL_FIELDS), "Continuity packet");
  if (source.schemaVersion !== SCHEMA_VERSION) invalid("Continuity schema version is unsupported.");
  var result = {
    schemaVersion: SCHEMA_VERSION,
    objectives: normalizeList(source.objectives, normalizeObjective, "objectiveId", "Objectives"),
    decisions: normalizeList(source.decisions, normalizeDecision, "decisionId", "Decisions"),
    ownerRequests: normalizeList(source.ownerRequests, normalizeOwnerRequest, "requestId", "Owner requests"),
    tasks: normalizeList(source.tasks, normalizeTask, "taskId", "Tasks"),
    bindings: normalizeList(source.bindings, normalizeBinding, bindingIdentity, "Bindings"),
    authorities: normalizeList(source.authorities, normalizeAuthority, "authorityId", "Authorities"),
    executions: normalizeList(source.executions, normalizeExecution, "executionId", "Executions"),
    learningReferences: normalizeList(source.learningReferences, normalizeLearning,
      "learningId", "Learning references"),
  };
  if (!result.objectives.length) invalid("At least one admitted objective is required.");
  validateReferences(result);
  return result;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  var result = {};
  var keys = Object.keys(value).sort();
  for (var i = 0; i < keys.length; i++) result[keys[i]] = canonicalize(value[keys[i]]);
  return result;
}

function canonicalPacketJson(value) {
  var text = JSON.stringify(canonicalize(normalizeContinuityPacket(value)));
  if (Buffer.byteLength(text, "utf8") > MAX_PACKET_BYTES) {
    invalid("Continuity packet exceeds the canonical byte limit.");
  }
  return text;
}

function packetDigest(value) {
  return crypto.createHash("sha256").update(canonicalPacketJson(value), "utf8").digest("hex");
}

module.exports = {
  BINDING_STATUSES: BINDING_STATUSES,
  MAX_COLLECTION_ITEMS: MAX_COLLECTION_ITEMS,
  MAX_PACKET_BYTES: MAX_PACKET_BYTES,
  SCHEMA_VERSION: SCHEMA_VERSION,
  TASK_STATUSES: TASK_STATUSES,
  bindingIdentity: bindingIdentity,
  buildContinuityPacket: normalizeContinuityPacket,
  canonicalPacketJson: canonicalPacketJson,
  createContinuityPacket: normalizeContinuityPacket,
  normalizeContinuityPacket: normalizeContinuityPacket,
  mapCanonicalBindingStatus: mapCanonicalBindingStatus,
  mapCanonicalTaskStatus: mapCanonicalTaskStatus,
  packetDigest: packetDigest,
};
