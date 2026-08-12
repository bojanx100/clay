// Fail-closed logical audit for Slice 2 execution, authority, incarnation, and
// lease rows. Physical schema validation lives in the migration module.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var validation = require("./coop-control-store-validation");

var ROLES = { coordinator: true, worker: true };
var MODES = { project_coordinator: "coordinator", direct_leaf: "worker" };
var EXECUTION_STATUSES = { pending: true, running: true, completed: true, failed: true, cancelled: true };
var START_STATES = { reserved: true, bound: true, ready: true, started: true, completed: true, failed: true };
var TERMINAL_EXECUTIONS = { completed: true, failed: true, cancelled: true };
var CURRENT_START_STATES = {
  pending: { reserved: true, bound: true, ready: true },
  running: { started: true },
  completed: { completed: true },
  failed: { failed: true },
  cancelled: { failed: true },
};

function logicalError(message) {
  throw validation.taggedError("COOP_CONTROL_STORE_LOGICAL_CORRUPTION",
    "ControlStore execution audit failed: " + message);
}

function safeTime(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function validId(value) {
  return typeof value === "string" && validation.IDENTIFIER_RE.test(value);
}

function validDigest(value) {
  return typeof value === "string" && validation.DIGEST_RE.test(value);
}

function deterministicId(prefix, fields) {
  var hash = crypto.createHash("sha256").update(fields.join("\u0000"), "utf8").digest("hex");
  return prefix + ":" + hash.slice(0, 48);
}

function expectedAuthorityId(row) {
  return deterministicId("auth", [row.source_project_id, row.source_session_id,
    row.portfolio_task_id, Number(row.binding_revision), row.target_project_id,
    row.role, Number(row.action_mask)]);
}

function expectedExecutionId(row) {
  return deterministicId("exec", [row.portfolio_task_id, Number(row.binding_revision),
    row.target_project_id, row.mode]);
}

function validateAuthority(row) {
  if (!validId(row.authority_id) || row.authority_id !== expectedAuthorityId(row) ||
      row.source_project_id !== projectIdentity.LEAD_PROJECT_ID ||
      !projectIdentity.isSessionStorageId(row.source_session_id) ||
      !projectIdentity.isTaskId(row.portfolio_task_id) ||
      !Number.isSafeInteger(Number(row.binding_revision)) || Number(row.binding_revision) <= 0 ||
      !projectIdentity.isProjectId(row.target_project_id) || !ROLES[row.role] ||
      Number(row.action_mask) !== 31 || !safeTime(row.issued_at) ||
      (row.revoked_at !== null && (!safeTime(row.revoked_at) ||
        Number(row.revoked_at) < Number(row.issued_at)))) {
    logicalError("an authority row is invalid.");
  }
}

function validExecutionIdentity(row) {
  return validId(row.execution_id) && projectIdentity.isTaskId(row.portfolio_task_id) &&
    Number.isSafeInteger(Number(row.binding_revision)) && Number(row.binding_revision) > 0 &&
    validId(row.idempotency_key) && projectIdentity.isProjectId(row.target_project_id) &&
    !!MODES[row.mode] && !!EXECUTION_STATUSES[row.status];
}

function validExecutionTimeline(row) {
  return Number.isSafeInteger(Number(row.current_epoch)) && Number(row.current_epoch) > 0 &&
    safeTime(row.created_at) && safeTime(row.updated_at) &&
    Number(row.updated_at) >= Number(row.created_at) &&
    (row.finished_at === null || safeTime(row.finished_at) &&
      Number(row.finished_at) >= Number(row.created_at) &&
      Number(row.finished_at) <= Number(row.updated_at));
}

function validateExecution(row, authority) {
  if (!validExecutionIdentity(row) || row.execution_id !== expectedExecutionId(row) ||
      !validExecutionTimeline(row) || !authority) {
    logicalError("an execution row is invalid.");
  }
  if (authority.portfolio_task_id !== row.portfolio_task_id ||
      Number(authority.binding_revision) !== Number(row.binding_revision) ||
      authority.target_project_id !== row.target_project_id ||
      authority.role !== MODES[row.mode] || authority.revoked_at !== null) {
    logicalError("execution authority does not match its logical execution.");
  }
  if (!!TERMINAL_EXECUTIONS[row.status] !== (row.finished_at !== null)) {
    logicalError("execution terminal metadata is inconsistent.");
  }
}

function validIncarnationIdentity(row, execution) {
  var hasProject = row.session_project_id !== null;
  var hasSession = row.session_storage_id !== null;
  return validId(row.incarnation_id) && !!execution &&
    Number.isSafeInteger(Number(row.epoch)) && Number(row.epoch) > 0 &&
    hasProject === hasSession && (!hasProject ||
      projectIdentity.isProjectId(row.session_project_id) &&
      projectIdentity.isSessionStorageId(row.session_storage_id)) &&
    validDigest(row.capability_digest) && !!START_STATES[row.start_state] &&
    (row.failure_code === null || validId(row.failure_code));
}

function validIncarnationTimeline(row) {
  return safeTime(row.created_at) && safeTime(row.updated_at) &&
    Number(row.updated_at) >= Number(row.created_at) &&
    (row.started_at === null || safeTime(row.started_at) &&
      Number(row.started_at) >= Number(row.created_at));
}

function validateIncarnationBinding(row, execution) {
  var hasProject = row.session_project_id !== null;
  if (row.start_state !== "reserved" && row.start_state !== "failed" && !hasProject) {
    logicalError("a started incarnation has no bound SessionRef.");
  }
  if (hasProject && row.session_project_id !== execution.target_project_id) {
    logicalError("an incarnation is bound outside its authorized target project.");
  }
  if ((row.start_state === "started" || row.start_state === "completed") && row.started_at === null) {
    logicalError("a started incarnation has no start timestamp.");
  }
}

function validateIncarnationState(row, execution) {
  if ((row.start_state === "failed") !== (row.failure_code !== null)) {
    logicalError("an incarnation failure marker is inconsistent.");
  }
  var current = Number(row.epoch) === Number(execution.current_epoch);
  if (!current && row.start_state !== "failed") {
    logicalError("a superseded incarnation is not terminal.");
  }
  if (current && (!CURRENT_START_STATES[execution.status] ||
      !CURRENT_START_STATES[execution.status][row.start_state])) {
    logicalError("an execution has an impossible current start state.");
  }
}

function validateIncarnation(row, execution) {
  if (!validIncarnationIdentity(row, execution) || !validIncarnationTimeline(row)) {
    logicalError("an incarnation row is invalid.");
  }
  validateIncarnationBinding(row, execution);
  validateIncarnationState(row, execution);
}

function validateLease(row, execution, incarnation, authority) {
  if (!execution || !incarnation || !authority || !ROLES[row.role] ||
      row.role !== MODES[execution.mode] || row.incarnation_id !== incarnation.incarnation_id ||
      Number(row.epoch) !== Number(incarnation.epoch) ||
      Number(row.epoch) !== Number(execution.current_epoch) ||
      row.authority_id !== execution.authority_id || !safeTime(row.acquired_at) ||
      !safeTime(row.updated_at) || Number(row.updated_at) < Number(row.acquired_at)) {
    logicalError("an active role lease is inconsistent.");
  }
}

function indexed(rows, key) {
  var result = Object.create(null);
  for (var i = 0; i < rows.length; i++) {
    var value = rows[i][key];
    if (result[value]) logicalError("a supposedly unique execution identity is duplicated.");
    result[value] = rows[i];
  }
  return result;
}

function recordIncarnationEpoch(nextEpochs, row) {
  var expected = nextEpochs[row.execution_id] || 1;
  if (Number(row.epoch) !== expected) {
    logicalError("an execution incarnation history has an epoch gap.");
  }
  nextEpochs[row.execution_id] = expected + 1;
}

function auditExecutionState(db) {
  var authorityRows = db.prepare("SELECT * FROM coop_control_authorities ORDER BY authority_id").all();
  var executionRows = db.prepare("SELECT * FROM coop_control_executions ORDER BY execution_id").all();
  var incarnationRows = db.prepare("SELECT * FROM coop_control_incarnations ORDER BY execution_id, epoch").all();
  var leaseRows = db.prepare("SELECT * FROM coop_control_role_leases ORDER BY execution_id, role").all();
  var authorities = indexed(authorityRows, "authority_id");
  var executions = indexed(executionRows, "execution_id");
  var incarnations = indexed(incarnationRows, "incarnation_id");
  var leasesByExecution = Object.create(null);
  var maxEpoch = Object.create(null);
  var nextEpochs = Object.create(null);
  var authorityUses = Object.create(null);
  for (var i = 0; i < authorityRows.length; i++) validateAuthority(authorityRows[i]);
  for (var j = 0; j < executionRows.length; j++) {
    validateExecution(executionRows[j], authorities[executionRows[j].authority_id]);
    authorityUses[executionRows[j].authority_id] = true;
  }
  for (var k = 0; k < incarnationRows.length; k++) {
    var incarnation = incarnationRows[k];
    validateIncarnation(incarnation, executions[incarnation.execution_id]);
    recordIncarnationEpoch(nextEpochs, incarnation);
    maxEpoch[incarnation.execution_id] = Number(incarnation.epoch);
  }
  for (var l = 0; l < leaseRows.length; l++) {
    var lease = leaseRows[l];
    if (leasesByExecution[lease.execution_id]) logicalError("an execution has more than one active role lease.");
    leasesByExecution[lease.execution_id] = lease;
    validateLease(lease, executions[lease.execution_id], incarnations[lease.incarnation_id],
      authorities[lease.authority_id]);
  }
  for (var m = 0; m < executionRows.length; m++) {
    var execution = executionRows[m];
    if (Number(execution.current_epoch) !== maxEpoch[execution.execution_id]) {
      logicalError("execution epoch does not match its newest incarnation.");
    }
    var leasePresent = !!leasesByExecution[execution.execution_id];
    if (leasePresent === !!TERMINAL_EXECUTIONS[execution.status]) {
      logicalError("execution lease presence does not match terminal state.");
    }
  }
  for (var n = 0; n < authorityRows.length; n++) {
    if (!authorityUses[authorityRows[n].authority_id]) {
      logicalError("an authority exists without its logical execution.");
    }
  }
}

module.exports = { auditExecutionState: auditExecutionState };
