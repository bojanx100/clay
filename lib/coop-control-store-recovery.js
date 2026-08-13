// Restricted Slice 3 SQLite operations. Handoff cutover and message/effect
// acceptance are each a single BEGIN IMMEDIATE transaction.

var rehydration = require("./coop-control-rehydration");
var handoffRotation = require("./coop-control-store-handoff-rotation");
var validation = require("./coop-control-store-validation");

function error(code, message) {
  return validation.taggedError(code, message);
}

function createRecoveryStoreApi(db, options) {
  var opts = options || {};
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var faults = opts.faults || {};
  var assertOpen = opts.assertOpen || function () {};

  function timestamp() {
    var value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw error("COOP_CONTROL_RECOVERY_INVALID", "Recovery timestamps must be non-negative safe integers.");
    }
    return value;
  }

  function transaction(operation, work) {
    assertOpen();
    try {
      db.exec("BEGIN IMMEDIATE");
      var result = work();
      if (typeof faults.beforeRecoveryCommit === "function") {
        faults.beforeRecoveryCommit({ operation: operation });
      }
      db.exec("COMMIT");
      return result;
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch (rollbackError) {}
      throw cause;
    }
  }

  function handoffRow(handoffId) {
    return db.prepare("SELECT * FROM coop_control_handoffs WHERE handoff_id = ?").get(handoffId);
  }

  function checkpointRow(handoffId) {
    return db.prepare("SELECT * FROM coop_control_checkpoints WHERE handoff_id = ?").get(handoffId);
  }

  function payloadRow(messageId) {
    return db.prepare("SELECT * FROM coop_control_delivery_payloads WHERE message_id = ?").get(messageId);
  }

  function outboxRow(messageId) {
    return db.prepare("SELECT o.*, p.payload_reference FROM coop_control_outbox o " +
      "JOIN coop_control_delivery_payloads p ON p.message_id = o.message_id WHERE o.message_id = ?")
      .get(messageId);
  }

  function inboxRow(messageId) {
    return db.prepare("SELECT i.*, p.payload_reference FROM coop_control_inbox i " +
      "JOIN coop_control_delivery_payloads p ON p.message_id = i.message_id WHERE i.message_id = ?")
      .get(messageId);
  }

  function recordDeliveryPayload(spec, at) {
    var existing = payloadRow(spec.messageId);
    if (existing) {
      if (existing.payload_reference !== spec.payloadReference) {
        throw error("COOP_CONTROL_DELIVERY_CONFLICT", "Stable message identity resolves to different delivery content.");
      }
      return existing;
    }
    db.prepare("INSERT INTO coop_control_delivery_payloads (message_id, payload_reference, created_at) " +
      "VALUES (?, ?, ?)").run(spec.messageId, spec.payloadReference, at);
    return payloadRow(spec.messageId);
  }

  function executionRow(executionId) {
    return db.prepare("SELECT * FROM coop_control_executions WHERE execution_id = ?").get(executionId);
  }

  function incarnationRow(incarnationId) {
    return db.prepare("SELECT * FROM coop_control_incarnations WHERE incarnation_id = ?").get(incarnationId);
  }

  function leaseRow(executionId) {
    return db.prepare("SELECT * FROM coop_control_role_leases WHERE execution_id = ?").get(executionId);
  }

  function refMatches(row, ref) {
    return !!row && row.execution_id === ref.executionId && row.incarnation_id === ref.incarnationId &&
      Number(row.epoch) === ref.epoch && row.capability_digest === ref.capabilityDigest;
  }

  function assertCurrent(ref, requiredState) {
    var execution = executionRow(ref.executionId);
    var incarnation = incarnationRow(ref.incarnationId);
    var lease = leaseRow(ref.executionId);
    if (!execution || Number(execution.current_epoch) !== ref.epoch || execution.authority_id !== ref.authorityId ||
        !refMatches(incarnation, ref) || !lease || lease.incarnation_id !== ref.incarnationId ||
        Number(lease.epoch) !== ref.epoch || lease.role !== ref.role || lease.authority_id !== ref.authorityId ||
        (requiredState && incarnation.start_state !== requiredState)) {
      throw error("COOP_CONTROL_FENCE_REJECTED", "The handoff capability is stale or not current.");
    }
    return { execution: execution, incarnation: incarnation, lease: lease };
  }

  function sameHandoff(row, spec) {
    return row && row.execution_id === spec.executionId && row.handoff_class === spec.handoffClass &&
      row.reason === spec.reason && row.from_project_id === spec.from.projectId &&
      row.from_session_id === spec.from.sessionStorageId && row.to_project_id === spec.to.projectId &&
      row.to_session_id === spec.to.sessionStorageId && row.from_incarnation_id === spec.predecessor.incarnationId &&
      Number(row.from_epoch) === spec.predecessor.epoch && row.packet_digest === spec.packetDigest;
  }

  function prepareHandoff(spec) {
    return transaction("prepare_handoff", function () {
      var existing = handoffRow(spec.handoffId);
      if (existing) {
        if (!sameHandoff(existing, spec)) {
          throw error("COOP_CONTROL_HANDOFF_CONFLICT", "Handoff identity resolves to different durable fields.");
        }
        return existing;
      }
      var rival = db.prepare("SELECT handoff_id FROM coop_control_handoffs WHERE execution_id = ? " +
        "AND from_epoch = ? AND state IN ('prepared', 'cutover', 'replaying') LIMIT 1")
        .get(spec.executionId, spec.predecessor.epoch);
      if (rival) throw error("COOP_CONTROL_HANDOFF_ACTIVE", "The incarnation already has an active handoff.");
      var current = assertCurrent(spec.predecessor, "started");
      if (current.incarnation.session_project_id !== spec.from.projectId ||
          current.incarnation.session_storage_id !== spec.from.sessionStorageId ||
          current.execution.target_project_id !== spec.to.projectId) {
        throw error("COOP_CONTROL_HANDOFF_INVALID", "Handoff SessionRefs do not match the current execution.");
      }
      var at = timestamp();
      db.prepare("INSERT INTO coop_control_handoffs (handoff_id, execution_id, handoff_class, reason, " +
        "from_project_id, from_session_id, to_project_id, to_session_id, from_incarnation_id, from_epoch, " +
        "to_incarnation_id, to_epoch, successor_capability_digest, state, successor_state, packet_digest, " +
        "created_at, updated_at, cutover_at, completed_at, failure_code) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, NULL, NULL, NULL)")
        .run(spec.handoffId, spec.executionId, spec.handoffClass, spec.reason,
          spec.from.projectId, spec.from.sessionStorageId, spec.to.projectId, spec.to.sessionStorageId,
          spec.predecessor.incarnationId, spec.predecessor.epoch, spec.toIncarnationId,
          spec.predecessor.epoch + 1, spec.successorCapabilityDigest,
          spec.handoffClass === "A" ? "retained" : "planned", spec.packetDigest, at, at);
      db.prepare("INSERT INTO coop_control_checkpoints " +
        "(checkpoint_id, handoff_id, packet_json, packet_digest, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(spec.checkpointId, spec.handoffId, spec.packetJson, spec.packetDigest, at);
      return handoffRow(spec.handoffId);
    });
  }

  function markSuccessorCreated(handoffId, receiptId) {
    return transaction("mark_successor_created", function () {
      var row = handoffRow(handoffId);
      if (!row) throw error("COOP_CONTROL_HANDOFF_NOT_FOUND", "Handoff does not exist.");
      if (row.handoff_class === "A") return row;
      if (row.successor_state === "created") {
        if (row.successor_receipt_id !== receiptId) {
          throw error("COOP_CONTROL_HANDOFF_CONFLICT", "Successor receipt identity changed.");
        }
        return row;
      }
      if (row.state !== "prepared") throw error("COOP_CONTROL_HANDOFF_STATE_INVALID", "Successor creation is out of order.");
      var receipt = db.prepare("SELECT * FROM coop_control_successor_receipts WHERE handoff_id = ?")
        .get(handoffId);
      if (!receipt || receipt.receipt_id !== receiptId || receipt.session_project_id !== row.to_project_id ||
          receipt.session_storage_id !== row.to_session_id) {
        throw error("COOP_CONTROL_HANDOFF_RECEIPT_REQUIRED", "Successor creation requires registered durable receipt evidence.");
      }
      db.prepare("UPDATE coop_control_handoffs SET successor_state = 'created', successor_receipt_id = ?, " +
        "updated_at = ? WHERE handoff_id = ?").run(receiptId, timestamp(), handoffId);
      return handoffRow(handoffId);
    });
  }

  function insertReadyIncarnation(row, incarnationId, epoch, capabilityDigest, at) {
    db.prepare("INSERT INTO coop_control_incarnations " +
      "(incarnation_id, execution_id, epoch, session_project_id, session_storage_id, capability_digest, " +
      "start_state, failure_code, created_at, updated_at, started_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, NULL)")
      .run(incarnationId, row.execution_id, epoch, row.to_project_id, row.to_session_id,
        capabilityDigest, at, at);
  }

  function replaceLease(row, incarnationId, epoch, at) {
    var execution = executionRow(row.execution_id);
    var oldLease = leaseRow(row.execution_id);
    if (!execution || !oldLease) throw error("COOP_CONTROL_STORE_LOGICAL_CORRUPTION", "Handoff lost its execution lease.");
    db.prepare("DELETE FROM coop_control_role_leases WHERE execution_id = ?").run(row.execution_id);
    db.prepare("INSERT INTO coop_control_role_leases " +
      "(execution_id, role, incarnation_id, epoch, authority_id, acquired_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.execution_id, oldLease.role, incarnationId, epoch, execution.authority_id, at, at);
  }

  function rotatePreparedHandoff(handoffId, next) {
    return handoffRotation.rotatePreparedHandoff({ db: db, error: error,
      executionRow: executionRow, handoffRow: handoffRow, incarnationRow: incarnationRow,
      leaseRow: leaseRow, replaceLease: replaceLease, timestamp: timestamp,
      transaction: transaction }, handoffId, next);
  }

  function cutoverHandoff(handoffId, predecessorRef) {
    return transaction("cutover_handoff", function () {
      var row = handoffRow(handoffId);
      if (!row) throw error("COOP_CONTROL_HANDOFF_NOT_FOUND", "Handoff does not exist.");
      if (row.state !== "prepared") return row;
      if (row.handoff_class === "B" && (row.successor_state !== "created" || !row.successor_receipt_id)) {
        throw error("COOP_CONTROL_HANDOFF_STATE_INVALID", "Class B successor must exist before cutover.");
      }
      assertCurrent(predecessorRef, "started");
      var at = timestamp();
      db.prepare("UPDATE coop_control_incarnations SET start_state = 'failed', " +
        "failure_code = 'handoff_superseded', updated_at = ? WHERE incarnation_id = ?")
        .run(at, row.from_incarnation_id);
      insertReadyIncarnation(row, row.to_incarnation_id, Number(row.to_epoch),
        row.successor_capability_digest, at);
      replaceLease(row, row.to_incarnation_id, Number(row.to_epoch), at);
      db.prepare("UPDATE coop_control_executions SET current_epoch = ?, status = 'pending', " +
        "updated_at = ?, finished_at = NULL WHERE execution_id = ?")
        .run(row.to_epoch, at, row.execution_id);
      db.prepare("UPDATE coop_control_handoffs SET state = 'cutover', cutover_at = ?, updated_at = ? " +
        "WHERE handoff_id = ?").run(at, at, handoffId);
      return handoffRow(handoffId);
    });
  }

  function rollForwardHandoff(handoffId, next) {
    return transaction("roll_forward_handoff", function () {
      var row = handoffRow(handoffId);
      if (!row || (row.state !== "cutover" && row.state !== "replaying")) {
        throw error("COOP_CONTROL_HANDOFF_STATE_INVALID", "Only a cut-over handoff can roll forward.");
      }
      var execution = executionRow(row.execution_id);
      var current = incarnationRow(row.to_incarnation_id);
      if (!execution || !current || Number(execution.current_epoch) !== Number(row.to_epoch)) {
        throw error("COOP_CONTROL_STORE_LOGICAL_CORRUPTION", "Handoff current incarnation is inconsistent.");
      }
      var at = timestamp();
      db.prepare("UPDATE coop_control_incarnations SET start_state = 'failed', " +
        "failure_code = 'handoff_roll_forward', updated_at = ? WHERE incarnation_id = ?")
        .run(at, row.to_incarnation_id);
      var nextEpoch = Number(row.to_epoch) + 1;
      insertReadyIncarnation(row, next.incarnationId, nextEpoch, next.capabilityDigest, at);
      replaceLease(row, next.incarnationId, nextEpoch, at);
      db.prepare("UPDATE coop_control_executions SET current_epoch = ?, status = 'pending', " +
        "updated_at = ?, finished_at = NULL WHERE execution_id = ?")
        .run(nextEpoch, at, row.execution_id);
      db.prepare("UPDATE coop_control_handoffs SET to_incarnation_id = ?, to_epoch = ?, " +
        "successor_capability_digest = ?, state = 'replaying', updated_at = ?, failure_code = NULL " +
        "WHERE handoff_id = ?")
        .run(next.incarnationId, nextEpoch, next.capabilityDigest, at, handoffId);
      return handoffRow(handoffId);
    });
  }

  function abortHandoff(handoffId, reason) {
    return transaction("abort_handoff", function () {
      var row = handoffRow(handoffId);
      if (!row) throw error("COOP_CONTROL_HANDOFF_NOT_FOUND", "Handoff does not exist.");
      if (row.state === "aborted") return row;
      if (row.state !== "prepared") {
        throw error("COOP_CONTROL_HANDOFF_ROLL_FORWARD_REQUIRED", "A cut-over handoff cannot roll back.");
      }
      var at = timestamp();
      db.prepare("UPDATE coop_control_handoffs SET state = 'aborted', failure_code = ?, " +
        "completed_at = ?, updated_at = ? WHERE handoff_id = ?").run(reason, at, at, handoffId);
      return handoffRow(handoffId);
    });
  }

  function completeHandoff(handoffId, successorRef) {
    return transaction("complete_handoff", function () {
      var row = handoffRow(handoffId);
      if (!row) throw error("COOP_CONTROL_HANDOFF_NOT_FOUND", "Handoff does not exist.");
      if (row.state === "completed") return row;
      if (row.state !== "cutover" && row.state !== "replaying") {
        throw error("COOP_CONTROL_HANDOFF_STATE_INVALID", "Handoff completion is out of order.");
      }
      assertCurrent(successorRef, "started");
      var at = timestamp();
      db.prepare("UPDATE coop_control_handoffs SET state = 'completed', completed_at = ?, " +
        "updated_at = ?, failure_code = NULL WHERE handoff_id = ?").run(at, at, handoffId);
      return handoffRow(handoffId);
    });
  }

  function getCheckpoint(handoffId) {
    assertOpen();
    var row = checkpointRow(handoffId);
    if (!row) return null;
    var value = rehydration.examineStoredCheckpoint(row.packet_json, row.packet_digest);
    return { checkpointId: row.checkpoint_id, handoffId: row.handoff_id,
      createdAt: Number(row.created_at), packet: value.packet, exam: value.exam };
  }

  function enqueueOutbox(spec) {
    return transaction("enqueue_outbox", function () {
      var existing = db.prepare("SELECT * FROM coop_control_outbox WHERE message_id = ?").get(spec.messageId);
      if (existing) {
        var same = existing.sender_project_id === spec.sender.projectId &&
          existing.sender_session_id === spec.sender.sessionStorageId &&
          existing.recipient_project_id === spec.recipient.projectId &&
          existing.recipient_session_id === spec.recipient.sessionStorageId &&
          existing.message_kind === spec.kind && existing.reference_id === spec.referenceId &&
          existing.payload_digest === spec.payloadDigest;
        if (!same) {
          throw error("COOP_CONTROL_DELIVERY_CONFLICT",
            "Stable message identity resolves to different outbox content.");
        }
        recordDeliveryPayload(spec, timestamp());
        return outboxRow(spec.messageId);
      }
      var at = timestamp();
      db.prepare("INSERT INTO coop_control_outbox (message_id, sender_project_id, sender_session_id, " +
        "recipient_project_id, recipient_session_id, message_kind, reference_id, payload_digest, state, " +
        "attempt_count, created_at, last_attempt_at, acked_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL)")
        .run(spec.messageId, spec.sender.projectId, spec.sender.sessionStorageId,
          spec.recipient.projectId, spec.recipient.sessionStorageId, spec.kind,
          spec.referenceId, spec.payloadDigest, at);
      recordDeliveryPayload(spec, at);
      return outboxRow(spec.messageId);
    });
  }

  function noteOutboxAttempt(messageId) {
    return transaction("note_outbox_attempt", function () {
      db.prepare("UPDATE coop_control_outbox SET attempt_count = attempt_count + 1, last_attempt_at = ? " +
        "WHERE message_id = ? AND state = 'pending'").run(timestamp(), messageId);
      return outboxRow(messageId);
    });
  }

  function ackOutbox(messageId, payloadDigest) {
    return transaction("ack_outbox", function () {
      var row = db.prepare("SELECT * FROM coop_control_outbox WHERE message_id = ?").get(messageId);
      if (!row || row.payload_digest !== payloadDigest) {
        throw error("COOP_CONTROL_DELIVERY_CONFLICT", "Outbox acknowledgement does not match its stable message.");
      }
      if (row.state !== "acked") {
        db.prepare("UPDATE coop_control_outbox SET state = 'acked', acked_at = ? WHERE message_id = ?")
          .run(timestamp(), messageId);
      }
      return outboxRow(messageId);
    });
  }

  function sameEnvelope(row, spec) {
    return row && row.sender_project_id === spec.sender.projectId &&
      row.sender_session_id === spec.sender.sessionStorageId &&
      row.recipient_project_id === spec.recipient.projectId &&
      row.recipient_session_id === spec.recipient.sessionStorageId && row.message_kind === spec.kind &&
      row.reference_id === spec.referenceId && row.payload_digest === spec.payloadDigest;
  }

  function getInbox(messageId) {
    assertOpen();
    return inboxRow(messageId) || null;
  }

  function getEffect(effectId) {
    assertOpen();
    return db.prepare("SELECT * FROM coop_control_effects WHERE effect_id = ?").get(effectId) || null;
  }

  function getEffectWithInbox(effectId) {
    assertOpen();
    return db.prepare("SELECT e.*, i.reference_id, i.payload_digest, i.message_kind, p.payload_reference " +
      "FROM coop_control_effects e JOIN coop_control_inbox i ON i.message_id = e.message_id " +
      "JOIN coop_control_delivery_payloads p ON p.message_id = e.message_id WHERE e.effect_id = ?")
      .get(effectId) || null;
  }

  function acceptInbox(spec, effect) {
    return transaction("accept_inbox", function () {
      var existing = db.prepare("SELECT * FROM coop_control_inbox WHERE message_id = ?").get(spec.messageId);
      if (existing) {
        if (!sameEnvelope(existing, spec) || existing.effect_id !== effect.effectId) {
          throw error("COOP_CONTROL_DELIVERY_CONFLICT", "Stable message identity resolves to different content.");
        }
        recordDeliveryPayload(spec, timestamp());
        return { duplicate: true, row: inboxRow(spec.messageId) };
      }
      var at = timestamp();
      db.prepare("INSERT INTO coop_control_inbox (message_id, sender_project_id, sender_session_id, " +
        "recipient_project_id, recipient_session_id, message_kind, reference_id, payload_digest, effect_id, received_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(spec.messageId, spec.sender.projectId, spec.sender.sessionStorageId,
          spec.recipient.projectId, spec.recipient.sessionStorageId, spec.kind,
          spec.referenceId, spec.payloadDigest, effect.effectId, at);
      db.prepare("INSERT INTO coop_control_effects (effect_id, message_id, effect_kind, target_project_id, " +
        "target_session_id, state, intent_at, receipt_at, receipt_id) " +
        "VALUES (?, ?, ?, ?, ?, 'intended', ?, NULL, NULL)")
        .run(effect.effectId, spec.messageId, effect.kind, effect.target.projectId,
          effect.target.sessionStorageId, at);
      recordDeliveryPayload(spec, at);
      return { duplicate: false, row: inboxRow(spec.messageId) };
    });
  }

  function recordEffectReceipt(effectId, receiptId) {
    return transaction("record_effect_receipt", function () {
      var row = db.prepare("SELECT * FROM coop_control_effects WHERE effect_id = ?").get(effectId);
      if (!row) throw error("COOP_CONTROL_EFFECT_NOT_FOUND", "Effect intent does not exist.");
      if (row.state === "received" && row.receipt_id !== receiptId) {
        throw error("COOP_CONTROL_EFFECT_CONFLICT", "Effect receipt identity changed.");
      }
      if (row.state !== "received") {
        db.prepare("UPDATE coop_control_effects SET state = 'received', receipt_at = ?, receipt_id = ? " +
          "WHERE effect_id = ?").run(timestamp(), receiptId, effectId);
      }
      return db.prepare("SELECT * FROM coop_control_effects WHERE effect_id = ?").get(effectId);
    });
  }

  function list(table, order, where) {
    assertOpen();
    return db.prepare("SELECT * FROM " + table + (where || "") + " ORDER BY " + order).all();
  }

  function listEffectsWithInbox(pendingOnly) {
    assertOpen();
    return db.prepare("SELECT e.*, i.reference_id, i.payload_digest, i.message_kind, p.payload_reference " +
      "FROM coop_control_effects e JOIN coop_control_inbox i ON i.message_id = e.message_id " +
      "JOIN coop_control_delivery_payloads p ON p.message_id = e.message_id" +
      (pendingOnly ? " WHERE e.state = 'intended'" : "") + " ORDER BY e.effect_id").all();
  }

  function countPendingEffects() {
    assertOpen();
    return Number(db.prepare("SELECT COUNT(*) AS count FROM coop_control_effects WHERE state = 'intended'")
      .get().count);
  }

  function recordSuccessorReceipt(handoffId, ref, receiptId) {
    return transaction("record_successor_receipt", function () {
      var row = handoffRow(handoffId);
      if (!row || row.handoff_class !== "B" || row.to_project_id !== ref.projectId ||
          row.to_session_id !== ref.sessionStorageId) {
        throw error("COOP_CONTROL_HANDOFF_RECEIPT_INVALID", "Successor receipt does not match the prepared handoff.");
      }
      var existing = db.prepare("SELECT * FROM coop_control_successor_receipts WHERE handoff_id = ?")
        .get(handoffId);
      if (existing) {
        if (existing.session_project_id !== ref.projectId || existing.session_storage_id !== ref.sessionStorageId ||
            existing.receipt_id !== receiptId) {
          throw error("COOP_CONTROL_HANDOFF_CONFLICT", "Successor receipt identity changed.");
        }
        return existing;
      }
      db.prepare("INSERT INTO coop_control_successor_receipts " +
        "(handoff_id, session_project_id, session_storage_id, receipt_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(handoffId, ref.projectId, ref.sessionStorageId, receiptId, timestamp());
      return db.prepare("SELECT * FROM coop_control_successor_receipts WHERE handoff_id = ?").get(handoffId);
    });
  }

  return {
    abortHandoff: abortHandoff, acceptInbox: acceptInbox, ackOutbox: ackOutbox,
    completeHandoff: completeHandoff, cutoverHandoff: cutoverHandoff,
    enqueueOutbox: enqueueOutbox, getCheckpoint: getCheckpoint,
    countPendingEffects: countPendingEffects,
    getDeliveryPayload: function (id) { assertOpen(); return payloadRow(id) || null; },
    getEffect: getEffect,
    getEffectWithInbox: getEffectWithInbox,
    getHandoff: function (id) { assertOpen(); return handoffRow(id) || null; },
    getInbox: getInbox,
    getOutbox: function (id) { assertOpen(); return outboxRow(id) || null; },
    listEffects: function () { return list("coop_control_effects", "effect_id", ""); },
    listEffectsWithInbox: function (pendingOnly) { return listEffectsWithInbox(pendingOnly === true); },
    listHandoffs: function () { return list("coop_control_handoffs", "created_at, handoff_id", ""); },
    listInbox: function () { return db.prepare("SELECT i.*, p.payload_reference FROM coop_control_inbox i " +
      "JOIN coop_control_delivery_payloads p ON p.message_id = i.message_id ORDER BY i.message_id").all(); },
    listOutbox: function (pendingOnly) { assertOpen(); return db.prepare("SELECT o.*, p.payload_reference " +
      "FROM coop_control_outbox o JOIN coop_control_delivery_payloads p ON p.message_id = o.message_id" +
      (pendingOnly ? " WHERE o.state = 'pending'" : "") + " ORDER BY o.created_at, o.message_id").all(); },
    markSuccessorCreated: markSuccessorCreated, noteOutboxAttempt: noteOutboxAttempt,
    prepareHandoff: prepareHandoff, recordEffectReceipt: recordEffectReceipt,
    recordSuccessorReceipt: recordSuccessorReceipt,
    rollForwardHandoff: rollForwardHandoff, rotatePreparedHandoff: rotatePreparedHandoff,
  };
}

module.exports = { createRecoveryStoreApi: createRecoveryStoreApi };
