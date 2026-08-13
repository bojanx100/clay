// Transaction body for restart-safe pre-cutover predecessor rotation.

function rotatePreparedHandoff(context, handoffId, next) {
  var ctx = context;
  return ctx.transaction("rotate_prepared_handoff", function () {
    var row = ctx.handoffRow(handoffId);
    if (!row) throw ctx.error("COOP_CONTROL_HANDOFF_NOT_FOUND", "Handoff does not exist.");
    if (row.state !== "prepared") {
      throw ctx.error("COOP_CONTROL_HANDOFF_STATE_INVALID",
        "Only a prepared handoff can reactivate its predecessor.");
    }
    var execution = ctx.executionRow(row.execution_id);
    var lease = ctx.leaseRow(row.execution_id);
    var current = execution && ctx.incarnationRow(lease && lease.incarnation_id);
    if (!execution || !lease || !current || Number(execution.current_epoch) !== Number(lease.epoch) ||
        current.session_project_id !== row.from_project_id || current.session_storage_id !== row.from_session_id) {
      throw ctx.error("COOP_CONTROL_STORE_LOGICAL_CORRUPTION",
        "Prepared handoff predecessor recovery lost its current visible lease.");
    }
    var at = ctx.timestamp();
    ctx.db.prepare("UPDATE coop_control_incarnations SET start_state = 'failed', " +
      "failure_code = 'restart_pre_cutover', updated_at = ? WHERE incarnation_id = ?")
      .run(at, current.incarnation_id);
    var nextEpoch = Number(execution.current_epoch) + 1;
    ctx.db.prepare("INSERT INTO coop_control_incarnations " +
      "(incarnation_id, execution_id, epoch, session_project_id, session_storage_id, capability_digest, " +
      "start_state, failure_code, created_at, updated_at, started_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, NULL)")
      .run(next.incarnationId, row.execution_id, nextEpoch, row.from_project_id,
        row.from_session_id, next.capabilityDigest, at, at);
    ctx.replaceLease(row, next.incarnationId, nextEpoch, at);
    ctx.db.prepare("UPDATE coop_control_executions SET current_epoch = ?, status = 'pending', " +
      "updated_at = ?, finished_at = NULL WHERE execution_id = ?")
      .run(nextEpoch, at, row.execution_id);
    ctx.db.prepare("UPDATE coop_control_handoffs SET updated_at = ?, failure_code = NULL WHERE handoff_id = ?")
      .run(at, handoffId);
    return { handoff: ctx.handoffRow(handoffId), incarnationId: next.incarnationId, epoch: nextEpoch };
  });
}

module.exports = { rotatePreparedHandoff: rotatePreparedHandoff };
