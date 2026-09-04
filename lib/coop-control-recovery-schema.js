// Slice 3 physical schema: monotonic handoffs, immutable continuity,
// transactional stable-message delivery, and visible-effect reconciliation.

var HANDOFFS_SQL = [
  "CREATE TABLE coop_control_handoffs (",
  "  handoff_id TEXT NOT NULL PRIMARY KEY,",
  "  execution_id TEXT NOT NULL,",
  "  handoff_class TEXT NOT NULL CHECK (handoff_class IN ('A', 'B')),",
  "  reason TEXT NOT NULL CHECK (reason IN ('provider_unhealthy', 'capacity_exhausted', 'context_exhausted', 'wedged_thread', 'empty_turns', 'reasoning_corruption', 'owner_stuck')),",
  "  from_project_id TEXT NOT NULL,",
  "  from_session_id TEXT NOT NULL,",
  "  to_project_id TEXT NOT NULL,",
  "  to_session_id TEXT NOT NULL,",
  "  from_incarnation_id TEXT NOT NULL,",
  "  from_epoch INTEGER NOT NULL CHECK (from_epoch > 0),",
  "  to_incarnation_id TEXT NOT NULL,",
  "  to_epoch INTEGER NOT NULL CHECK (to_epoch > from_epoch),",
  "  successor_receipt_id TEXT,",
  "  successor_capability_digest TEXT NOT NULL,",
  "  state TEXT NOT NULL CHECK (state IN ('prepared', 'cutover', 'replaying', 'completed', 'aborted')),",
  "  successor_state TEXT NOT NULL CHECK (successor_state IN ('retained', 'planned', 'created')),",
  "  packet_digest TEXT NOT NULL,",
  "  created_at INTEGER NOT NULL CHECK (created_at >= 0),",
  "  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),",
  "  cutover_at INTEGER CHECK (cutover_at IS NULL OR cutover_at >= created_at),",
  "  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),",
  "  failure_code TEXT,",
  "  CHECK (handoff_class = 'B' OR (from_project_id = to_project_id AND from_session_id = to_session_id)),",
  "  CHECK ((handoff_class = 'A' AND successor_state = 'retained') OR handoff_class = 'B'),",
  "  FOREIGN KEY (execution_id) REFERENCES coop_control_executions(execution_id) ON DELETE CASCADE",
  ") STRICT",
].join("\n");

var CHECKPOINTS_SQL = [
  "CREATE TABLE coop_control_checkpoints (",
  "  checkpoint_id TEXT NOT NULL PRIMARY KEY,",
  "  handoff_id TEXT NOT NULL UNIQUE,",
  "  packet_json TEXT NOT NULL CHECK (json_valid(packet_json)),",
  "  packet_digest TEXT NOT NULL,",
  "  created_at INTEGER NOT NULL CHECK (created_at >= 0),",
  "  FOREIGN KEY (handoff_id) REFERENCES coop_control_handoffs(handoff_id) ON DELETE CASCADE",
  ") STRICT",
].join("\n");

var OUTBOX_SQL = [
  "CREATE TABLE coop_control_outbox (",
  "  message_id TEXT NOT NULL PRIMARY KEY,",
  "  sender_project_id TEXT NOT NULL,",
  "  sender_session_id TEXT NOT NULL,",
  "  recipient_project_id TEXT NOT NULL,",
  "  recipient_session_id TEXT NOT NULL,",
  "  message_kind TEXT NOT NULL CHECK (message_kind IN ('rehydration', 'handoff_control', 'execution_event')),",
  "  reference_id TEXT NOT NULL,",
  "  payload_digest TEXT NOT NULL,",
  "  state TEXT NOT NULL CHECK (state IN ('pending', 'acked')),",
  "  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),",
  "  created_at INTEGER NOT NULL CHECK (created_at >= 0),",
  "  last_attempt_at INTEGER CHECK (last_attempt_at IS NULL OR last_attempt_at >= created_at),",
  "  acked_at INTEGER CHECK (acked_at IS NULL OR acked_at >= created_at)",
  ") STRICT",
].join("\n");

var INBOX_SQL = [
  "CREATE TABLE coop_control_inbox (",
  "  message_id TEXT NOT NULL PRIMARY KEY,",
  "  sender_project_id TEXT NOT NULL,",
  "  sender_session_id TEXT NOT NULL,",
  "  recipient_project_id TEXT NOT NULL,",
  "  recipient_session_id TEXT NOT NULL,",
  "  message_kind TEXT NOT NULL CHECK (message_kind IN ('rehydration', 'handoff_control', 'execution_event')),",
  "  reference_id TEXT NOT NULL,",
  "  payload_digest TEXT NOT NULL,",
  "  effect_id TEXT NOT NULL UNIQUE,",
  "  received_at INTEGER NOT NULL CHECK (received_at >= 0)",
  ") STRICT",
].join("\n");

var EFFECTS_SQL = [
  "CREATE TABLE coop_control_effects (",
  "  effect_id TEXT NOT NULL PRIMARY KEY,",
  "  message_id TEXT NOT NULL UNIQUE,",
  "  effect_kind TEXT NOT NULL CHECK (effect_kind IN ('rehydrate', 'handoff_cutover', 'execution_update')),",
  "  target_project_id TEXT NOT NULL,",
  "  target_session_id TEXT NOT NULL,",
  "  state TEXT NOT NULL CHECK (state IN ('intended', 'received')),",
  "  intent_at INTEGER NOT NULL CHECK (intent_at >= 0),",
  "  receipt_at INTEGER CHECK (receipt_at IS NULL OR receipt_at >= intent_at),",
  "  receipt_id TEXT,",
  "  FOREIGN KEY (message_id) REFERENCES coop_control_inbox(message_id) ON DELETE CASCADE",
  ") STRICT",
].join("\n");

var DELIVERY_PAYLOADS_SQL = [
  "CREATE TABLE coop_control_delivery_payloads (",
  "  message_id TEXT NOT NULL PRIMARY KEY,",
  "  payload_reference TEXT NOT NULL,",
  "  created_at INTEGER NOT NULL CHECK (created_at >= 0)",
  ") STRICT",
].join("\n");

var SUCCESSOR_RECEIPTS_SQL = [
  "CREATE TABLE coop_control_successor_receipts (",
  "  handoff_id TEXT NOT NULL PRIMARY KEY,",
  "  session_project_id TEXT NOT NULL,",
  "  session_storage_id TEXT NOT NULL,",
  "  receipt_id TEXT NOT NULL,",
  "  created_at INTEGER NOT NULL CHECK (created_at >= 0),",
  "  FOREIGN KEY (handoff_id) REFERENCES coop_control_handoffs(handoff_id) ON DELETE CASCADE",
  ") STRICT",
].join("\n");

function index(name, columns, unique, origin) {
  return [name, unique, origin, 0, columns];
}

var TABLE_SHAPES = Object.freeze({
  coop_control_handoffs: Object.freeze({ version: 4, columns: [
    ["handoff_id", "TEXT", 1, 1], ["execution_id", "TEXT", 1, 0],
    ["handoff_class", "TEXT", 1, 0], ["reason", "TEXT", 1, 0],
    ["from_project_id", "TEXT", 1, 0], ["from_session_id", "TEXT", 1, 0],
    ["to_project_id", "TEXT", 1, 0], ["to_session_id", "TEXT", 1, 0],
    ["from_incarnation_id", "TEXT", 1, 0], ["from_epoch", "INTEGER", 1, 0],
    ["to_incarnation_id", "TEXT", 1, 0], ["to_epoch", "INTEGER", 1, 0],
    ["successor_receipt_id", "TEXT", 0, 0], ["successor_capability_digest", "TEXT", 1, 0], ["state", "TEXT", 1, 0],
    ["successor_state", "TEXT", 1, 0], ["packet_digest", "TEXT", 1, 0],
    ["created_at", "INTEGER", 1, 0], ["updated_at", "INTEGER", 1, 0],
    ["cutover_at", "INTEGER", 0, 0], ["completed_at", "INTEGER", 0, 0],
    ["failure_code", "TEXT", 0, 0],
  ], indexes: [
    index("sqlite_autoindex_coop_control_handoffs_1", ["handoff_id"], 1, "pk"),
  ], foreignKeys: [["coop_control_executions", "execution_id", "execution_id", "NO ACTION", "CASCADE", "NONE"]] }),
  coop_control_checkpoints: Object.freeze({ version: 4, columns: [
    ["checkpoint_id", "TEXT", 1, 1], ["handoff_id", "TEXT", 1, 0],
    ["packet_json", "TEXT", 1, 0], ["packet_digest", "TEXT", 1, 0],
    ["created_at", "INTEGER", 1, 0],
  ], indexes: [
    index("sqlite_autoindex_coop_control_checkpoints_1", ["checkpoint_id"], 1, "pk"),
    index("sqlite_autoindex_coop_control_checkpoints_2", ["handoff_id"], 1, "u"),
  ], foreignKeys: [["coop_control_handoffs", "handoff_id", "handoff_id", "NO ACTION", "CASCADE", "NONE"]] }),
  coop_control_outbox: Object.freeze({ version: 4, columns: [
    ["message_id", "TEXT", 1, 1], ["sender_project_id", "TEXT", 1, 0],
    ["sender_session_id", "TEXT", 1, 0], ["recipient_project_id", "TEXT", 1, 0],
    ["recipient_session_id", "TEXT", 1, 0], ["message_kind", "TEXT", 1, 0],
    ["reference_id", "TEXT", 1, 0], ["payload_digest", "TEXT", 1, 0],
    ["state", "TEXT", 1, 0], ["attempt_count", "INTEGER", 1, 0],
    ["created_at", "INTEGER", 1, 0], ["last_attempt_at", "INTEGER", 0, 0],
    ["acked_at", "INTEGER", 0, 0],
  ], indexes: [index("sqlite_autoindex_coop_control_outbox_1", ["message_id"], 1, "pk")], foreignKeys: [] }),
  coop_control_inbox: Object.freeze({ version: 4, columns: [
    ["message_id", "TEXT", 1, 1], ["sender_project_id", "TEXT", 1, 0],
    ["sender_session_id", "TEXT", 1, 0], ["recipient_project_id", "TEXT", 1, 0],
    ["recipient_session_id", "TEXT", 1, 0], ["message_kind", "TEXT", 1, 0],
    ["reference_id", "TEXT", 1, 0], ["payload_digest", "TEXT", 1, 0],
    ["effect_id", "TEXT", 1, 0], ["received_at", "INTEGER", 1, 0],
  ], indexes: [
    index("sqlite_autoindex_coop_control_inbox_1", ["message_id"], 1, "pk"),
    index("sqlite_autoindex_coop_control_inbox_2", ["effect_id"], 1, "u"),
  ], foreignKeys: [] }),
  coop_control_effects: Object.freeze({ version: 4, columns: [
    ["effect_id", "TEXT", 1, 1], ["message_id", "TEXT", 1, 0],
    ["effect_kind", "TEXT", 1, 0], ["target_project_id", "TEXT", 1, 0],
    ["target_session_id", "TEXT", 1, 0], ["state", "TEXT", 1, 0],
    ["intent_at", "INTEGER", 1, 0], ["receipt_at", "INTEGER", 0, 0],
    ["receipt_id", "TEXT", 0, 0],
  ], indexes: [
    index("sqlite_autoindex_coop_control_effects_1", ["effect_id"], 1, "pk"),
    index("sqlite_autoindex_coop_control_effects_2", ["message_id"], 1, "u"),
  ], foreignKeys: [["coop_control_inbox", "message_id", "message_id", "NO ACTION", "CASCADE", "NONE"]] }),
  coop_control_delivery_payloads: Object.freeze({ version: 5, columns: [
    ["message_id", "TEXT", 1, 1], ["payload_reference", "TEXT", 1, 0],
    ["created_at", "INTEGER", 1, 0],
  ], indexes: [index("sqlite_autoindex_coop_control_delivery_payloads_1", ["message_id"], 1, "pk")], foreignKeys: [] }),
  coop_control_successor_receipts: Object.freeze({ version: 5, columns: [
    ["handoff_id", "TEXT", 1, 1], ["session_project_id", "TEXT", 1, 0],
    ["session_storage_id", "TEXT", 1, 0], ["receipt_id", "TEXT", 1, 0],
    ["created_at", "INTEGER", 1, 0],
  ], indexes: [index("sqlite_autoindex_coop_control_successor_receipts_1", ["handoff_id"], 1, "pk")],
  foreignKeys: [["coop_control_handoffs", "handoff_id", "handoff_id", "NO ACTION", "CASCADE", "NONE"]] }),
});

function apply(db) {
  db.exec(HANDOFFS_SQL + ";\n" + CHECKPOINTS_SQL + ";\n" + OUTBOX_SQL + ";\n" +
    INBOX_SQL + ";\n" + EFFECTS_SQL + ";");
}

function applyPayloadReceipts(db) {
  db.exec(DELIVERY_PAYLOADS_SQL + ";\n" + SUCCESSOR_RECEIPTS_SQL + ";");
  db.exec("INSERT INTO coop_control_delivery_payloads (message_id, payload_reference, created_at) " +
    "SELECT message_id, reference_id, created_at FROM coop_control_outbox " +
    "WHERE message_id NOT IN (SELECT message_id FROM coop_control_delivery_payloads);");
  db.exec("INSERT INTO coop_control_delivery_payloads (message_id, payload_reference, created_at) " +
    "SELECT message_id, reference_id, received_at FROM coop_control_inbox " +
    "WHERE message_id NOT IN (SELECT message_id FROM coop_control_delivery_payloads);");
  db.exec("INSERT INTO coop_control_successor_receipts " +
    "(handoff_id, session_project_id, session_storage_id, receipt_id, created_at) " +
    "SELECT handoff_id, to_project_id, to_session_id, successor_receipt_id, updated_at " +
    "FROM coop_control_handoffs WHERE handoff_class = 'B' AND successor_state = 'created' " +
    "AND successor_receipt_id IS NOT NULL;");
}

module.exports = {
  CHECKPOINTS_SQL: CHECKPOINTS_SQL, DELIVERY_PAYLOADS_SQL: DELIVERY_PAYLOADS_SQL, EFFECTS_SQL: EFFECTS_SQL,
  HANDOFFS_SQL: HANDOFFS_SQL, INBOX_SQL: INBOX_SQL, OUTBOX_SQL: OUTBOX_SQL,
  SUCCESSOR_RECEIPTS_SQL: SUCCESSOR_RECEIPTS_SQL,
  TABLE_SHAPES: TABLE_SHAPES, apply: apply, applyPayloadReceipts: applyPayloadReceipts,
};
