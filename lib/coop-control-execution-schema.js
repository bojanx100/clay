// Physical Slice 2 schema. These tables contain control identities and state
// only: never prompts, transcripts, topic content, or runtime context.

var AUTHORITIES_SQL = [
  "CREATE TABLE coop_control_authorities (",
  "  authority_id TEXT NOT NULL PRIMARY KEY,",
  "  source_project_id TEXT NOT NULL,",
  "  source_session_id TEXT NOT NULL,",
  "  portfolio_task_id TEXT NOT NULL,",
  "  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),",
  "  target_project_id TEXT NOT NULL,",
  "  role TEXT NOT NULL CHECK (role IN ('coordinator', 'worker')),",
  "  action_mask INTEGER NOT NULL CHECK (action_mask = 31),",
  "  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),",
  "  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= issued_at)",
  ") STRICT",
].join("\n");

var EXECUTIONS_SQL = [
  "CREATE TABLE coop_control_executions (",
  "  execution_id TEXT NOT NULL PRIMARY KEY,",
  "  portfolio_task_id TEXT NOT NULL,",
  "  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),",
  "  idempotency_key TEXT NOT NULL,",
  "  target_project_id TEXT NOT NULL,",
  "  mode TEXT NOT NULL CHECK (mode IN ('project_coordinator', 'direct_leaf')),",
  "  authority_id TEXT NOT NULL,",
  "  current_epoch INTEGER NOT NULL CHECK (current_epoch >= 0),",
  "  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),",
  "  created_at INTEGER NOT NULL CHECK (created_at >= 0),",
  "  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),",
  "  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= created_at),",
  "  UNIQUE (portfolio_task_id, binding_revision, target_project_id),",
  "  FOREIGN KEY (authority_id) REFERENCES coop_control_authorities(authority_id) ON DELETE RESTRICT",
  ") STRICT",
].join("\n");

var INCARNATIONS_SQL = [
  "CREATE TABLE coop_control_incarnations (",
  "  incarnation_id TEXT NOT NULL PRIMARY KEY,",
  "  execution_id TEXT NOT NULL,",
  "  epoch INTEGER NOT NULL CHECK (epoch > 0),",
  "  session_project_id TEXT,",
  "  session_storage_id TEXT,",
  "  capability_digest TEXT NOT NULL,",
  "  start_state TEXT NOT NULL CHECK (start_state IN ('reserved', 'bound', 'ready', 'started', 'completed', 'failed')),",
  "  failure_code TEXT,",
  "  created_at INTEGER NOT NULL CHECK (created_at >= 0),",
  "  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),",
  "  started_at INTEGER CHECK (started_at IS NULL OR started_at >= created_at),",
  "  UNIQUE (execution_id, epoch),",
  "  CHECK ((session_project_id IS NULL) = (session_storage_id IS NULL)),",
  "  CHECK (start_state IN ('reserved', 'failed') OR session_project_id IS NOT NULL),",
  "  FOREIGN KEY (execution_id) REFERENCES coop_control_executions(execution_id) ON DELETE CASCADE",
  ") STRICT",
].join("\n");

var LEASES_SQL = [
  "CREATE TABLE coop_control_role_leases (",
  "  execution_id TEXT NOT NULL,",
  "  role TEXT NOT NULL CHECK (role IN ('coordinator', 'worker')),",
  "  incarnation_id TEXT NOT NULL UNIQUE,",
  "  epoch INTEGER NOT NULL CHECK (epoch > 0),",
  "  authority_id TEXT NOT NULL,",
  "  acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),",
  "  updated_at INTEGER NOT NULL CHECK (updated_at >= acquired_at),",
  "  PRIMARY KEY (execution_id, role),",
  "  FOREIGN KEY (execution_id) REFERENCES coop_control_executions(execution_id) ON DELETE CASCADE",
  ") STRICT",
].join("\n");

var TABLE_SHAPES = Object.freeze({
  coop_control_authorities: Object.freeze({
    version: 3,
    columns: [
      ["authority_id", "TEXT", 1, 1], ["source_project_id", "TEXT", 1, 0],
      ["source_session_id", "TEXT", 1, 0], ["portfolio_task_id", "TEXT", 1, 0],
      ["binding_revision", "INTEGER", 1, 0], ["target_project_id", "TEXT", 1, 0],
      ["role", "TEXT", 1, 0], ["action_mask", "INTEGER", 1, 0],
      ["issued_at", "INTEGER", 1, 0], ["revoked_at", "INTEGER", 0, 0],
    ],
    indexes: [["sqlite_autoindex_coop_control_authorities_1", 1, "pk", 0, ["authority_id"]]],
    foreignKeys: [],
  }),
  coop_control_executions: Object.freeze({
    version: 3,
    columns: [
      ["execution_id", "TEXT", 1, 1], ["portfolio_task_id", "TEXT", 1, 0],
      ["binding_revision", "INTEGER", 1, 0], ["idempotency_key", "TEXT", 1, 0],
      ["target_project_id", "TEXT", 1, 0], ["mode", "TEXT", 1, 0],
      ["authority_id", "TEXT", 1, 0], ["current_epoch", "INTEGER", 1, 0],
      ["status", "TEXT", 1, 0], ["created_at", "INTEGER", 1, 0],
      ["updated_at", "INTEGER", 1, 0], ["finished_at", "INTEGER", 0, 0],
    ],
    indexes: [
      ["sqlite_autoindex_coop_control_executions_1", 1, "pk", 0, ["execution_id"]],
      ["sqlite_autoindex_coop_control_executions_2", 1, "u", 0,
        ["portfolio_task_id", "binding_revision", "target_project_id"]],
    ],
    foreignKeys: [["coop_control_authorities", "authority_id", "authority_id", "NO ACTION", "RESTRICT", "NONE"]],
  }),
  coop_control_incarnations: Object.freeze({
    version: 3,
    columns: [
      ["incarnation_id", "TEXT", 1, 1], ["execution_id", "TEXT", 1, 0],
      ["epoch", "INTEGER", 1, 0], ["session_project_id", "TEXT", 0, 0],
      ["session_storage_id", "TEXT", 0, 0], ["capability_digest", "TEXT", 1, 0],
      ["start_state", "TEXT", 1, 0], ["failure_code", "TEXT", 0, 0],
      ["created_at", "INTEGER", 1, 0], ["updated_at", "INTEGER", 1, 0],
      ["started_at", "INTEGER", 0, 0],
    ],
    indexes: [
      ["sqlite_autoindex_coop_control_incarnations_1", 1, "pk", 0, ["incarnation_id"]],
      ["sqlite_autoindex_coop_control_incarnations_2", 1, "u", 0, ["execution_id", "epoch"]],
    ],
    foreignKeys: [["coop_control_executions", "execution_id", "execution_id", "NO ACTION", "CASCADE", "NONE"]],
  }),
  coop_control_role_leases: Object.freeze({
    version: 3,
    columns: [
      ["execution_id", "TEXT", 1, 1], ["role", "TEXT", 1, 2],
      ["incarnation_id", "TEXT", 1, 0], ["epoch", "INTEGER", 1, 0],
      ["authority_id", "TEXT", 1, 0], ["acquired_at", "INTEGER", 1, 0],
      ["updated_at", "INTEGER", 1, 0],
    ],
    indexes: [
      ["sqlite_autoindex_coop_control_role_leases_1", 1, "u", 0, ["incarnation_id"]],
      ["sqlite_autoindex_coop_control_role_leases_2", 1, "pk", 0, ["execution_id", "role"]],
    ],
    foreignKeys: [["coop_control_executions", "execution_id", "execution_id", "NO ACTION", "CASCADE", "NONE"]],
  }),
});

function apply(db) {
  db.exec(AUTHORITIES_SQL + ";\n" + EXECUTIONS_SQL + ";\n" +
    INCARNATIONS_SQL + ";\n" + LEASES_SQL + ";");
}

module.exports = {
  AUTHORITIES_SQL: AUTHORITIES_SQL,
  EXECUTIONS_SQL: EXECUTIONS_SQL,
  INCARNATIONS_SQL: INCARNATIONS_SQL,
  LEASES_SQL: LEASES_SQL,
  TABLE_SHAPES: TABLE_SHAPES,
  apply: apply,
};
