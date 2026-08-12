// Restricted SQLite operations for Slice 2. The generic ControlStore owns the
// connection and injects this API; callers never receive the raw database.

var validation = require("./coop-control-store-validation");

function error(code, message) {
  return validation.taggedError(code, message);
}

function executionMatches(execution, authority, ref) {
  return !!execution && !!authority && execution.current_epoch === ref.epoch &&
    execution.authority_id === ref.authorityId && authority.revoked_at === null;
}

function incarnationMatches(incarnation, ref) {
  return !!incarnation && incarnation.incarnation_id === ref.incarnationId &&
    incarnation.capability_digest === ref.capabilityDigest;
}

function leaseMatches(lease, ref) {
  return !!lease && lease.incarnation_id === ref.incarnationId && lease.epoch === ref.epoch &&
    lease.authority_id === ref.authorityId;
}

function createExecutionStoreApi(db, options) {
  var opts = options || {};
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var faults = opts.faults || {};
  var assertOpen = opts.assertOpen || function () {};

  function timestamp() {
    var value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw error("COOP_CONTROL_EXECUTION_INVALID", "Execution timestamps must be non-negative safe integers.");
    }
    return value;
  }

  function transaction(operation, work) {
    assertOpen();
    try {
      db.exec("BEGIN IMMEDIATE");
      var result = work();
      if (typeof faults.beforeExecutionCommit === "function") {
        faults.beforeExecutionCommit({ operation: operation });
      }
      db.exec("COMMIT");
      return result;
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch (rollbackError) {}
      throw cause;
    }
  }

  function authorityRow(authorityId) {
    return db.prepare("SELECT * FROM coop_control_authorities WHERE authority_id = ?").get(authorityId);
  }

  function executionRow(executionId) {
    return db.prepare("SELECT * FROM coop_control_executions WHERE execution_id = ?").get(executionId);
  }

  function bindingExecution(spec) {
    return db.prepare("SELECT * FROM coop_control_executions WHERE portfolio_task_id = ? " +
      "AND binding_revision = ? AND target_project_id = ?")
      .get(spec.portfolioTaskId, spec.bindingRevision, spec.targetProjectId);
  }

  function currentIncarnation(executionId, epoch) {
    return db.prepare("SELECT * FROM coop_control_incarnations WHERE execution_id = ? AND epoch = ?")
      .get(executionId, epoch);
  }

  function currentLease(executionId, role) {
    return db.prepare("SELECT * FROM coop_control_role_leases WHERE execution_id = ? AND role = ?")
      .get(executionId, role);
  }

  function sameAuthority(row, spec) {
    return row && row.source_project_id === spec.sourceProjectId &&
      row.source_session_id === spec.sourceSessionId &&
      row.portfolio_task_id === spec.portfolioTaskId &&
      Number(row.binding_revision) === spec.bindingRevision &&
      row.target_project_id === spec.targetProjectId && row.role === spec.role &&
      Number(row.action_mask) === spec.actionMask && row.revoked_at === null;
  }

  function ensureAuthority(spec, at) {
    var existing = authorityRow(spec.authorityId);
    if (existing) {
      if (!sameAuthority(existing, spec)) {
        throw error("COOP_CONTROL_AUTHORITY_CONFLICT", "Authority identity resolves to different structured fields.");
      }
      return;
    }
    db.prepare("INSERT INTO coop_control_authorities " +
      "(authority_id, source_project_id, source_session_id, portfolio_task_id, binding_revision, " +
      "target_project_id, role, action_mask, issued_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(spec.authorityId, spec.sourceProjectId, spec.sourceSessionId, spec.portfolioTaskId,
        spec.bindingRevision, spec.targetProjectId, spec.role, spec.actionMask, at);
  }

  function sameExecution(row, spec) {
    return row && row.execution_id === spec.executionId &&
      row.portfolio_task_id === spec.portfolioTaskId &&
      Number(row.binding_revision) === spec.bindingRevision &&
      row.idempotency_key === spec.idempotencyKey && row.target_project_id === spec.targetProjectId &&
      row.mode === spec.mode && row.authority_id === spec.authorityId;
  }

  function insertIncarnation(spec, epoch, at) {
    db.prepare("INSERT INTO coop_control_incarnations " +
      "(incarnation_id, execution_id, epoch, session_project_id, session_storage_id, capability_digest, " +
      "start_state, failure_code, created_at, updated_at, started_at) " +
      "VALUES (?, ?, ?, NULL, NULL, ?, 'reserved', NULL, ?, ?, NULL)")
      .run(spec.incarnationId, spec.executionId, epoch, spec.capabilityDigest, at, at);
    db.prepare("INSERT INTO coop_control_role_leases " +
      "(execution_id, role, incarnation_id, epoch, authority_id, acquired_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(spec.executionId, spec.role, spec.incarnationId, epoch, spec.authorityId, at, at);
  }

  function reserveExecution(spec) {
    return transaction("reserve_execution", function () {
      var at = timestamp();
      var existing = bindingExecution(spec);
      if (existing && !sameExecution(existing, spec)) {
        throw error("COOP_CONTROL_EXECUTION_CONFLICT", "The binding revision already names a different logical execution.");
      }
      if (existing && (existing.status === "pending" || existing.status === "running")) {
        var lease = currentLease(existing.execution_id, spec.role);
        var incarnation = currentIncarnation(existing.execution_id, Number(existing.current_epoch));
        if (!lease || !incarnation) {
          throw error("COOP_CONTROL_STORE_LOGICAL_CORRUPTION", "An active execution has no current lease or incarnation.");
        }
        return { active: true, execution: existing, incarnation: incarnation, lease: lease };
      }
      if (existing && existing.status === "completed") {
        throw error("COOP_CONTROL_EXECUTION_COMPLETE", "A completed logical execution cannot be restarted.");
      }
      ensureAuthority(spec, at);
      if (!existing) {
        db.prepare("INSERT INTO coop_control_executions " +
          "(execution_id, portfolio_task_id, binding_revision, idempotency_key, target_project_id, mode, " +
          "authority_id, current_epoch, status, created_at, updated_at, finished_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, NULL)")
          .run(spec.executionId, spec.portfolioTaskId, spec.bindingRevision, spec.idempotencyKey,
            spec.targetProjectId, spec.mode, spec.authorityId, at, at);
        insertIncarnation(spec, 1, at);
        return { active: false, epoch: 1 };
      }
      var nextEpoch = Number(existing.current_epoch) + 1;
      if (!Number.isSafeInteger(nextEpoch)) {
        throw error("COOP_CONTROL_EXECUTION_INVALID", "Execution epoch overflowed.");
      }
      db.prepare("UPDATE coop_control_executions SET current_epoch = ?, status = 'pending', " +
        "updated_at = ?, finished_at = NULL WHERE execution_id = ?")
        .run(nextEpoch, at, spec.executionId);
      insertIncarnation(spec, nextEpoch, at);
      return { active: false, epoch: nextEpoch };
    });
  }

  function assertCurrent(ref) {
    assertOpen();
    var execution = executionRow(ref.executionId);
    var incarnation = execution && currentIncarnation(ref.executionId, ref.epoch);
    var lease = execution && currentLease(ref.executionId, ref.role);
    var authority = execution && authorityRow(execution.authority_id);
    if (!executionMatches(execution, authority, ref) || !incarnationMatches(incarnation, ref) ||
        !leaseMatches(lease, ref)) {
      throw error("COOP_CONTROL_FENCE_REJECTED", "The execution capability is stale or no longer holds its role lease.");
    }
    return { execution: execution, incarnation: incarnation, lease: lease, authority: authority };
  }

  function requireState(ref, states) {
    var current = assertCurrent(ref);
    if (!states[current.incarnation.start_state]) {
      throw error("COOP_CONTROL_START_STATE_INVALID", "Execution start transition is out of order.");
    }
    return current;
  }

  function bindStart(ref, sessionRef) {
    return transaction("bind_execution_start", function () {
      var current = requireState(ref, { reserved: true });
      if (current.execution.target_project_id !== sessionRef.projectId) {
        throw error("COOP_CONTROL_EXECUTION_INVALID",
          "The execution SessionRef must belong to its authorized target project.");
      }
      var at = timestamp();
      db.prepare("UPDATE coop_control_incarnations SET session_project_id = ?, session_storage_id = ?, " +
        "start_state = 'bound', updated_at = ? WHERE incarnation_id = ?")
        .run(sessionRef.projectId, sessionRef.sessionStorageId, at, ref.incarnationId);
      return true;
    });
  }

  function openBarrier(ref) {
    return transaction("open_execution_barrier", function () {
      requireState(ref, { bound: true });
      var at = timestamp();
      db.prepare("UPDATE coop_control_incarnations SET start_state = 'ready', updated_at = ? " +
        "WHERE incarnation_id = ?").run(at, ref.incarnationId);
      return true;
    });
  }

  function markStarted(ref) {
    return transaction("mark_execution_started", function () {
      requireState(ref, { ready: true });
      var at = timestamp();
      db.prepare("UPDATE coop_control_incarnations SET start_state = 'started', started_at = ?, updated_at = ? " +
        "WHERE incarnation_id = ?").run(at, at, ref.incarnationId);
      db.prepare("UPDATE coop_control_executions SET status = 'running', updated_at = ? WHERE execution_id = ?")
        .run(at, ref.executionId);
      return true;
    });
  }

  function terminalize(ref, status, startState, reason) {
    return transaction("terminalize_execution", function () {
      var current = assertCurrent(ref);
      if (status === "completed" && current.incarnation.start_state !== "started") {
        throw error("COOP_CONTROL_START_STATE_INVALID", "Only a started execution may complete.");
      }
      var at = timestamp();
      db.prepare("UPDATE coop_control_incarnations SET start_state = ?, failure_code = ?, updated_at = ? " +
        "WHERE incarnation_id = ?")
        .run(startState, reason || null, at, ref.incarnationId);
      db.prepare("UPDATE coop_control_executions SET status = ?, updated_at = ?, finished_at = ? " +
        "WHERE execution_id = ?").run(status, at, at, ref.executionId);
      db.prepare("DELETE FROM coop_control_role_leases WHERE execution_id = ? AND role = ?")
        .run(ref.executionId, ref.role);
      return true;
    });
  }

  function recoverIncomplete() {
    return transaction("recover_incomplete_executions", function () {
      var rows = db.prepare("SELECT execution_id, current_epoch FROM coop_control_executions " +
        "WHERE status IN ('pending', 'running') ORDER BY execution_id").all();
      var at = timestamp();
      for (var i = 0; i < rows.length; i++) {
        db.prepare("UPDATE coop_control_incarnations SET start_state = 'failed', failure_code = 'restart_recovery', " +
          "updated_at = ? WHERE execution_id = ? AND epoch = ?")
          .run(at, rows[i].execution_id, rows[i].current_epoch);
        db.prepare("UPDATE coop_control_executions SET status = 'failed', updated_at = ?, finished_at = ? " +
          "WHERE execution_id = ?").run(at, at, rows[i].execution_id);
        db.prepare("DELETE FROM coop_control_role_leases WHERE execution_id = ?").run(rows[i].execution_id);
      }
      return rows.length;
    });
  }

  function inspectExecution(executionId) {
    assertOpen();
    var execution = executionRow(executionId);
    if (!execution) return null;
    return {
      authority: authorityRow(execution.authority_id),
      execution: execution,
      incarnations: db.prepare("SELECT * FROM coop_control_incarnations WHERE execution_id = ? ORDER BY epoch")
        .all(executionId),
      leases: db.prepare("SELECT * FROM coop_control_role_leases WHERE execution_id = ? ORDER BY role")
        .all(executionId),
    };
  }

  return {
    abandonExecution: function (ref, reason) { return terminalize(ref, "failed", "failed", reason); },
    assertCurrentExecution: assertCurrent,
    bindExecutionStart: bindStart,
    completeExecution: function (ref) { return terminalize(ref, "completed", "completed", null); },
    inspectExecution: inspectExecution,
    markExecutionStarted: markStarted,
    openExecutionBarrier: openBarrier,
    recoverIncompleteExecutions: recoverIncomplete,
    reserveExecution: reserveExecution,
  };
}

module.exports = { createExecutionStoreApi: createExecutionStoreApi };
