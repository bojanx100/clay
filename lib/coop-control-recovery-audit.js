// Fail-closed logical audit for Slice 3 recovery rows.

var projectIdentity = require("./project-identity");
var rehydration = require("./coop-control-rehydration");
var validation = require("./coop-control-store-validation");
var EFFECT_FOR_MESSAGE = { execution_event: "execution_update", handoff_control: "handoff_cutover",
  rehydration: "rehydrate" };

function logicalError(message, cause) {
  throw validation.taggedError("COOP_CONTROL_STORE_LOGICAL_CORRUPTION",
    "ControlStore recovery audit failed: " + message, cause);
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

function indexRows(rows, field) {
  var result = Object.create(null);
  for (var i = 0; i < rows.length; i++) {
    if (result[rows[i][field]]) logicalError("a supposedly unique recovery identity is duplicated.");
    result[rows[i][field]] = rows[i];
  }
  return result;
}

function validSession(projectId, sessionId) {
  return projectIdentity.isProjectId(projectId) && projectIdentity.isSessionStorageId(sessionId);
}

function validHandoffIdentity(row, execution) {
  return validId(row.handoff_id) && !!execution && validId(row.to_incarnation_id) &&
    Number.isSafeInteger(Number(row.to_epoch)) && Number(row.to_epoch) > Number(row.from_epoch) &&
    validDigest(row.successor_capability_digest) && validDigest(row.packet_digest);
}

function validHandoffRefs(row, execution, from) {
  return validSession(row.from_project_id, row.from_session_id) &&
    validSession(row.to_project_id, row.to_session_id) && row.to_project_id === execution.target_project_id &&
    !!from && from.execution_id === row.execution_id && Number(from.epoch) === Number(row.from_epoch) &&
    from.session_project_id === row.from_project_id && from.session_storage_id === row.from_session_id;
}

function validHandoffClass(row) {
  if (row.handoff_class === "A") {
    return row.from_project_id === row.to_project_id && row.from_session_id === row.to_session_id &&
      row.successor_state === "retained" && row.successor_receipt_id === null;
  }
  return row.handoff_class === "B" && row.from_session_id !== row.to_session_id &&
    ((row.successor_state === "planned" && row.successor_receipt_id === null) ||
    (row.successor_state === "created" && validId(row.successor_receipt_id)));
}

function validHandoffTimeline(row, postCutover) {
  var terminal = row.state === "completed" || row.state === "aborted";
  var cutoverTimeValid = row.cutover_at === null || safeTime(row.cutover_at) &&
    Number(row.cutover_at) <= Number(row.updated_at);
  var completedTimeValid = row.completed_at === null || safeTime(row.completed_at) &&
    Number(row.completed_at) <= Number(row.updated_at);
  return safeTime(row.created_at) && safeTime(row.updated_at) &&
    Number(row.updated_at) >= Number(row.created_at) &&
    (row.cutover_at !== null) === postCutover &&
    cutoverTimeValid &&
    (row.completed_at !== null) === terminal &&
    completedTimeValid &&
    (row.failure_code === null || validId(row.failure_code));
}

function validHandoffState(row, postCutover) {
  if (row.handoff_class === "B" && postCutover &&
      (row.successor_state !== "created" || !validId(row.successor_receipt_id))) return false;
  if (row.state === "aborted") return row.failure_code !== null;
  return row.failure_code === null;
}

function isPostCutover(state) {
  return state === "cutover" || state === "replaying" || state === "completed";
}

function validateSuccessor(row, from, to, postCutover) {
  if (!postCutover) {
    if (to) logicalError("a pre-cutover handoff already has a successor incarnation.");
    return;
  }
  var matches = to && to.execution_id === row.execution_id &&
    Number(to.epoch) === Number(row.to_epoch) && to.session_project_id === row.to_project_id &&
    to.session_storage_id === row.to_session_id &&
    to.capability_digest === row.successor_capability_digest && from.start_state === "failed";
  if (!matches) logicalError("a cut-over handoff does not match its incarnations.");
}

function validateActiveLease(row, execution, leases) {
  if (row.state !== "cutover" && row.state !== "replaying") return;
  var lease = leases[row.execution_id];
  if (Number(execution.current_epoch) !== Number(row.to_epoch) || !lease ||
      lease.incarnation_id !== row.to_incarnation_id) {
    logicalError("an active handoff does not hold the current role lease.");
  }
}

function validateHandoff(row, executions, incarnations, leases, receipts, requireReceipt) {
  var execution = executions[row.execution_id];
  var from = incarnations[row.from_incarnation_id];
  var to = incarnations[row.to_incarnation_id];
  var postCutover = isPostCutover(row.state);
  if (!validHandoffIdentity(row, execution) || !validHandoffRefs(row, execution, from) ||
      !validHandoffClass(row)) logicalError("a handoff row is invalid.");
  if (!validHandoffTimeline(row, postCutover)) logicalError("a handoff timeline is inconsistent.");
  if (!validHandoffState(row, postCutover)) logicalError("a handoff state marker is inconsistent.");
  validateSuccessor(row, from, to, postCutover);
  validateActiveLease(row, execution, leases);
  if (requireReceipt && row.handoff_class === "B" && row.successor_state === "created") {
    var receipt = receipts[row.handoff_id];
    if (!receipt || receipt.session_project_id !== row.to_project_id ||
        receipt.session_storage_id !== row.to_session_id || receipt.receipt_id !== row.successor_receipt_id ||
        !safeTime(receipt.created_at)) {
      logicalError("a created successor lacks exact durable receipt evidence.");
    }
  }
}

function validateCheckpoint(row, handoffs) {
  var handoff = handoffs[row.handoff_id];
  if (!validId(row.checkpoint_id) || !handoff || !validDigest(row.packet_digest) ||
      row.packet_digest !== handoff.packet_digest || !safeTime(row.created_at)) {
    logicalError("a checkpoint row is invalid.");
  }
  try { rehydration.examineStoredCheckpoint(row.packet_json, row.packet_digest); }
  catch (cause) { logicalError("a checkpoint failed its transcript-free exam.", cause); }
}

function validateEnvelope(row, prefix) {
  if (!validId(row.message_id) || !validSession(row.sender_project_id, row.sender_session_id) ||
      !validSession(row.recipient_project_id, row.recipient_session_id) ||
      !validId(row.reference_id) || !validDigest(row.payload_digest)) {
    logicalError("a " + prefix + " envelope is invalid.");
  }
}

function validatePayload(row) {
  if (!validId(row.message_id) || !validId(row.payload_reference) || !safeTime(row.created_at)) {
    logicalError("a delivery payload reference is invalid.");
  }
}

function validateOutbox(row, payloads, requirePayload) {
  validateEnvelope(row, "outbox");
  if (requirePayload && !payloads[row.message_id]) {
    logicalError("an outbox row lacks actionable delivery evidence.");
  }
  if (!Number.isSafeInteger(Number(row.attempt_count)) || Number(row.attempt_count) < 0 ||
      !safeTime(row.created_at) || row.last_attempt_at !== null && !safeTime(row.last_attempt_at) ||
      (row.state === "acked") !== (row.acked_at !== null) ||
      row.acked_at !== null && !safeTime(row.acked_at)) {
    logicalError("an outbox timeline is invalid.");
  }
}

function validateInbox(row, payloads, requirePayload) {
  validateEnvelope(row, "inbox");
  if (requirePayload && !payloads[row.message_id]) {
    logicalError("an inbox row lacks actionable delivery evidence.");
  }
  if (!validId(row.effect_id) || !safeTime(row.received_at)) logicalError("an inbox row is invalid.");
}

function validateEffect(row, inboxByMessage) {
  var inbox = inboxByMessage[row.message_id];
  if (!validId(row.effect_id) || !inbox || inbox.effect_id !== row.effect_id ||
      !validSession(row.target_project_id, row.target_session_id) || !safeTime(row.intent_at) ||
      EFFECT_FOR_MESSAGE[inbox.message_kind] !== row.effect_kind ||
      row.target_project_id !== inbox.recipient_project_id || row.target_session_id !== inbox.recipient_session_id ||
      (row.state === "received") !== (row.receipt_at !== null && row.receipt_id !== null) ||
      row.receipt_at !== null && !safeTime(row.receipt_at) || row.receipt_id !== null && !validId(row.receipt_id)) {
    logicalError("an effect intent or receipt is invalid.");
  }
}

function evidenceRows(db, available, table, order) {
  if (!available) return [];
  return db.prepare("SELECT * FROM " + table + " ORDER BY " + order).all();
}

function auditRecoveryState(db, version) {
  var hasPayloadEvidence = Number(version) >= 5;
  var executionRows = db.prepare("SELECT * FROM coop_control_executions ORDER BY execution_id").all();
  var incarnationRows = db.prepare("SELECT * FROM coop_control_incarnations ORDER BY incarnation_id").all();
  var leaseRows = db.prepare("SELECT * FROM coop_control_role_leases ORDER BY execution_id").all();
  var handoffRows = db.prepare("SELECT * FROM coop_control_handoffs ORDER BY handoff_id").all();
  var checkpointRows = db.prepare("SELECT * FROM coop_control_checkpoints ORDER BY checkpoint_id").all();
  var outboxRows = db.prepare("SELECT * FROM coop_control_outbox ORDER BY message_id").all();
  var inboxRows = db.prepare("SELECT * FROM coop_control_inbox ORDER BY message_id").all();
  var effectRows = db.prepare("SELECT * FROM coop_control_effects ORDER BY effect_id").all();
  var payloadRows = evidenceRows(db, hasPayloadEvidence, "coop_control_delivery_payloads", "message_id");
  var receiptRows = evidenceRows(db, hasPayloadEvidence, "coop_control_successor_receipts", "handoff_id");
  var executions = indexRows(executionRows, "execution_id");
  var incarnations = indexRows(incarnationRows, "incarnation_id");
  var leases = indexRows(leaseRows, "execution_id");
  var handoffs = indexRows(handoffRows, "handoff_id");
  var inbox = indexRows(inboxRows, "message_id");
  var payloads = indexRows(payloadRows, "message_id");
  var receipts = indexRows(receiptRows, "handoff_id");
  var checkpointsByHandoff = Object.create(null);
  var effectsByMessage = Object.create(null);
  var i;
  for (i = 0; i < handoffRows.length; i++) {
    validateHandoff(handoffRows[i], executions, incarnations, leases, receipts, hasPayloadEvidence);
  }
  for (i = 0; i < checkpointRows.length; i++) {
    validateCheckpoint(checkpointRows[i], handoffs);
    if (checkpointsByHandoff[checkpointRows[i].handoff_id]) logicalError("a handoff has duplicate checkpoints.");
    checkpointsByHandoff[checkpointRows[i].handoff_id] = true;
  }
  for (i = 0; i < handoffRows.length; i++) {
    if (!checkpointsByHandoff[handoffRows[i].handoff_id]) logicalError("a handoff has no continuity checkpoint.");
  }
  for (i = 0; i < payloadRows.length; i++) validatePayload(payloadRows[i]);
  for (i = 0; i < outboxRows.length; i++) validateOutbox(outboxRows[i], payloads, hasPayloadEvidence);
  for (i = 0; i < inboxRows.length; i++) validateInbox(inboxRows[i], payloads, hasPayloadEvidence);
  for (i = 0; i < effectRows.length; i++) {
    validateEffect(effectRows[i], inbox);
    effectsByMessage[effectRows[i].message_id] = true;
  }
  for (i = 0; i < inboxRows.length; i++) {
    if (!effectsByMessage[inboxRows[i].message_id]) logicalError("an inbox message has no effect intent.");
  }
  for (i = 0; i < payloadRows.length; i++) {
    if (!outboxRows.some(function (row) { return row.message_id === payloadRows[i].message_id; }) &&
        !inboxRows.some(function (row) { return row.message_id === payloadRows[i].message_id; })) {
      logicalError("a delivery payload is orphaned.");
    }
  }
}

module.exports = { auditRecoveryState: auditRecoveryState };
