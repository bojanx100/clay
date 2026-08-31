// The durable transaction for the one fenced stale-R6 terminal reconciliation.
// It is deliberately injected by the generic execution store instead of exposing
// a general-purpose terminalization API.

function createStaleR6ReconciliationStore(deps) {
  var db = deps.db;
  var validation = deps.validation;
  var error = deps.error;
  var digest = deps.digest;
  var transaction = deps.transaction;
  var timestamp = deps.timestamp;
  var assertCurrent = deps.assertCurrent;
  var authorityRow = deps.authorityRow;
  var currentIncarnation = deps.currentIncarnation;
  var currentLease = deps.currentLease;
  var executionRow = deps.executionRow;

  function receiptRow(receiptId) {
    return db.prepare("SELECT * FROM coop_control_stale_r6_reconciliation_receipts WHERE receipt_id = ?")
      .get(receiptId) || null;
  }

  function receiptValue(row) {
    if (!row) return null;
    return {
      receiptId: row.receipt_id,
      requestDigest: row.request_digest,
      preDigest: row.pre_digest,
      postDigest: row.post_digest,
      executionId: row.execution_id,
      authorityId: row.authority_id,
      incarnationId: row.incarnation_id,
      epoch: Number(row.epoch),
      createdAt: Number(row.created_at),
    };
  }

  function validReceipt(receipt, ref) {
    return !!receipt && validation.IDENTIFIER_RE.test(receipt.receiptId || "") &&
      validation.DIGEST_RE.test(receipt.requestDigest || "") &&
      receipt.executionId === ref.executionId && receipt.authorityId === ref.authorityId &&
      receipt.incarnationId === ref.incarnationId && Number(receipt.epoch) === Number(ref.epoch) &&
      receipt.role === ref.role;
  }

  function durableState(execution, authority, incarnation, lease) {
    var handoffs = db.prepare("SELECT handoff_id, state, successor_state, completed_at, failure_code " +
      "FROM coop_control_handoffs WHERE execution_id = ? ORDER BY handoff_id").all(execution.execution_id);
    var pendingOutbox = db.prepare("SELECT COUNT(*) AS count FROM coop_control_outbox " +
      "WHERE reference_id = ? AND state = 'pending'").get(execution.execution_id);
    var pendingEffects = db.prepare("SELECT COUNT(*) AS count FROM coop_control_effects e " +
      "JOIN coop_control_inbox i ON i.message_id = e.message_id " +
      "WHERE i.reference_id = ? AND e.state = 'intended'").get(execution.execution_id);
    return {
      execution: {
        authorityId: execution.authority_id,
        currentEpoch: Number(execution.current_epoch),
        executionId: execution.execution_id,
        finishedAt: execution.finished_at === null ? null : Number(execution.finished_at),
        status: execution.status,
      },
      authority: {
        authorityId: authority.authority_id,
        revokedAt: authority.revoked_at === null ? null : Number(authority.revoked_at),
      },
      incarnation: {
        failureCode: incarnation.failure_code,
        incarnationId: incarnation.incarnation_id,
        startState: incarnation.start_state,
      },
      lease: lease ? {
        authorityId: lease.authority_id,
        epoch: Number(lease.epoch),
        incarnationId: lease.incarnation_id,
        role: lease.role,
      } : null,
      handoffs: handoffs.map(function (row) {
        return { handoffId: row.handoff_id, state: row.state, successorState: row.successor_state,
          completedAt: row.completed_at === null ? null : Number(row.completed_at),
          failureCode: row.failure_code };
      }),
      pendingEffects: Number(pendingEffects.count),
      pendingOutbox: Number(pendingOutbox.count),
    };
  }

  function currentState(ref) {
    var execution = executionRow(ref.executionId);
    var authority = execution && authorityRow(execution.authority_id);
    var incarnation = execution && currentIncarnation(ref.executionId, Number(execution.current_epoch));
    var lease = execution && currentLease(ref.executionId, ref.role);
    return execution && authority && incarnation ? durableState(execution, authority, incarnation, lease) : null;
  }

  function assertReplay(receipt, spec) {
    if (receipt.request_digest !== spec.requestDigest || receipt.execution_id !== spec.executionId ||
        receipt.authority_id !== spec.authorityId || receipt.incarnation_id !== spec.incarnationId ||
        Number(receipt.epoch) !== Number(spec.epoch)) {
      throw error("COOP_CONTROL_RECONCILIATION_CONFLICT",
        "The stale R6 reconciliation receipt does not match this exact request.");
    }
    var current = currentState(spec);
    if (!current || current.execution.status !== "failed" || current.execution.finishedAt === null ||
        current.incarnation.startState !== "failed" ||
        current.incarnation.failureCode !== "terminal_binding_reconciled" || current.lease !== null ||
        digest(JSON.stringify(current)) !== receipt.post_digest) {
      throw error("COOP_CONTROL_RECONCILIATION_CONFLICT",
        "The stale R6 receipt no longer matches durable terminal state.");
    }
    return { duplicate: true, receipt: receiptValue(receipt) };
  }

  function assertPreconditions(current, ref) {
    var activeHandoff = db.prepare("SELECT handoff_id FROM coop_control_handoffs WHERE execution_id = ? " +
      "AND state IN ('prepared', 'cutover', 'replaying') LIMIT 1").get(ref.executionId);
    var pendingOutbox = db.prepare("SELECT message_id FROM coop_control_outbox WHERE reference_id = ? " +
      "AND state = 'pending' LIMIT 1").get(ref.executionId);
    var pendingEffect = db.prepare("SELECT e.effect_id FROM coop_control_effects e " +
      "JOIN coop_control_inbox i ON i.message_id = e.message_id WHERE i.reference_id = ? " +
      "AND e.state = 'intended' LIMIT 1").get(ref.executionId);
    if (current.execution.status !== "running" || current.incarnation.start_state !== "started" ||
        activeHandoff || pendingOutbox || pendingEffect) {
      throw error("COOP_CONTROL_RECONCILIATION_PRECONDITION_FAILED",
        "The stale R6 execution has an active handoff, pending delivery, or non-running terminal state.");
    }
  }

  function reconcile(ref, receipt) {
    return transaction("terminalize_execution", function () {
      if (!validReceipt(receipt, ref)) {
        throw error("COOP_CONTROL_RECONCILIATION_INVALID",
          "The stale R6 reconciliation receipt does not bind the current execution identity.");
      }
      var existingReceipt = receiptRow(receipt.receiptId);
      if (existingReceipt) return assertReplay(existingReceipt, receipt);
      var current = assertCurrent(ref);
      assertPreconditions(current, ref);
      var preDigest = digest(JSON.stringify(durableState(current.execution, current.authority,
        current.incarnation, current.lease)));
      var at = timestamp();
      db.prepare("UPDATE coop_control_incarnations SET start_state = 'failed', " +
        "failure_code = 'terminal_binding_reconciled', updated_at = ? WHERE incarnation_id = ?")
        .run(at, ref.incarnationId);
      db.prepare("UPDATE coop_control_executions SET status = 'failed', updated_at = ?, finished_at = ? " +
        "WHERE execution_id = ?").run(at, at, ref.executionId);
      db.prepare("DELETE FROM coop_control_role_leases WHERE execution_id = ? AND role = ?")
        .run(ref.executionId, ref.role);
      var post = currentState(ref);
      var postDigest = digest(JSON.stringify(post));
      db.prepare("INSERT INTO coop_control_stale_r6_reconciliation_receipts " +
        "(receipt_id, request_digest, pre_digest, post_digest, execution_id, authority_id, " +
        "incarnation_id, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(receipt.receiptId, receipt.requestDigest, preDigest, postDigest,
          ref.executionId, ref.authorityId, ref.incarnationId, ref.epoch, at);
      return { duplicate: false, receipt: receiptValue(receiptRow(receipt.receiptId)) };
    });
  }

  return { getReceipt: function (receiptId) { return receiptValue(receiptRow(receiptId)); }, reconcile: reconcile };
}

module.exports = { createStaleR6ReconciliationStore: createStaleR6ReconciliationStore };
