// One exact receipt type for the owner-authorized stale R6 execution repair.
// This is deliberately not a generic reconciliation ledger.

var RECEIPTS_SQL = [
  "CREATE TABLE coop_control_stale_r6_reconciliation_receipts (",
  "  receipt_id TEXT NOT NULL PRIMARY KEY,",
  "  request_digest TEXT NOT NULL,",
  "  pre_digest TEXT NOT NULL,",
  "  post_digest TEXT NOT NULL,",
  "  execution_id TEXT NOT NULL,",
  "  authority_id TEXT NOT NULL,",
  "  incarnation_id TEXT NOT NULL,",
  "  epoch INTEGER NOT NULL CHECK (epoch > 0),",
  "  created_at INTEGER NOT NULL CHECK (created_at >= 0),",
  "  FOREIGN KEY (execution_id) REFERENCES coop_control_executions(execution_id) ON DELETE RESTRICT",
  ") STRICT",
].join("\n");

var TABLE_SHAPES = Object.freeze({
  coop_control_stale_r6_reconciliation_receipts: Object.freeze({
    version: 6,
    columns: [
      ["receipt_id", "TEXT", 1, 1], ["request_digest", "TEXT", 1, 0],
      ["pre_digest", "TEXT", 1, 0], ["post_digest", "TEXT", 1, 0],
      ["execution_id", "TEXT", 1, 0], ["authority_id", "TEXT", 1, 0],
      ["incarnation_id", "TEXT", 1, 0], ["epoch", "INTEGER", 1, 0],
      ["created_at", "INTEGER", 1, 0],
    ],
    indexes: [["sqlite_autoindex_coop_control_stale_r6_reconciliation_receipts_1", 1, "pk", 0,
      ["receipt_id"]]],
    foreignKeys: [["coop_control_executions", "execution_id", "execution_id", "NO ACTION", "RESTRICT", "NONE"]],
  }),
});

function apply(db) {
  db.exec(RECEIPTS_SQL + ";");
}

module.exports = { RECEIPTS_SQL: RECEIPTS_SQL, TABLE_SHAPES: TABLE_SHAPES, apply: apply };
