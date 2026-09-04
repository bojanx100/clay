// Production adapters for Slice 3 recovery. They bind recovered capabilities
// to the target session before the orchestrator exposes its envelope intake.

var crypto = require("crypto");
var executionFence = require("./coop-control-fence");
var projectIdentity = require("./project-identity");
var rehydration = require("./coop-control-rehydration");

function sameRef(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId;
}

function then(value, next) {
  return value && typeof value.then === "function" ? value.then(next) : next(value);
}

function receiptId(effectId) {
  return "receipt:" + crypto.createHash("sha256").update(effectId, "utf8")
    .digest("hex").slice(0, 48);
}

function createTargetRecoveryHandlers(options) {
  var opts = options || {};
  var sm = opts.sm;
  var control = opts.control;
  var metadataFor = opts.executionMetadata;

  function targetSession(ref, executionId, handoffId) {
    var result = null;
    sm.sessions.forEach(function (session) {
      if (result) return;
      var current = projectIdentity.sessionRef({ projectId: opts.projectId() }, session);
      var metadata = metadataFor(session);
      var marker = metadata && metadata.recoveryPreallocation;
      var executionMatches = !executionId || metadata && metadata.control &&
        metadata.control.executionId === executionId || marker && marker.handoffId === handoffId;
      if (sameRef(current, ref) && executionMatches) result = session;
    });
    return result;
  }

  function recoveryTarget(record, recovery) {
    return recovery && recovery.target || record.to;
  }

  function rehydrate(record, checkpoint, token, recovery) {
    var session = targetSession(recoveryTarget(record, recovery), token.executionId, record.handoffId);
    var metadata = metadataFor(session);
    if (!session || !metadata || !checkpoint || !checkpoint.exam || checkpoint.exam.passed !== true) return false;
    metadata.recoveryCheckpoint = { handoffId: record.handoffId, checkpointId: checkpoint.checkpointId,
      packetDigest: record.packetDigest };
    metadata.recoveryContinuity = rehydration.restoreContinuityState(checkpoint.packet);
    metadata.updatedAt = Date.now();
    session._coopRecoveryHandoffId = record.handoffId;
    Object.defineProperty(session, "_coopRecoveryResumeInput", { configurable: true,
      enumerable: false, value: rehydration.buildResumeInput(checkpoint.packet), writable: true });
    sm.saveSessionFile(session);
    return true;
  }

  function activate(record, token, recovery) {
    var session = targetSession(recoveryTarget(record, recovery), token.executionId, record.handoffId);
    var metadata = metadataFor(session);
    if (!session || !metadata || session._coopRecoveryHandoffId !== record.handoffId) return false;
    metadata.control = executionFence.attachFence(session, control.createFence(token));
    metadata.status = "running";
    metadata.updatedAt = Date.now();
    sm.saveSessionFile(session);
    var resumeInput = session._coopRecoveryResumeInput;
    if (typeof resumeInput !== "string" || !resumeInput) return false;
    var started = opts.startQuery(session, resumeInput, false, "recovery");
    delete session._coopRecoveryResumeInput;
    if (started && typeof started.then === "function") {
      return started.then(function (result) {
        return result !== false && (!result || result.ok !== false) &&
          session._coopExecutionFence && session._coopExecutionFence.isCurrent("callback");
      });
    }
    return started !== false && (!started || started.ok !== false) &&
      session._coopExecutionFence && session._coopExecutionFence.isCurrent("callback");
  }

  function successorEvidence(record) {
    var session = targetSession(record.to, null, record.handoffId);
    var metadata = metadataFor(session);
    var marker = metadata && metadata.recoveryPreallocation;
    if (!session || !marker || marker.handoffId !== record.handoffId ||
        !sameRef(marker.sessionRef, record.to) || !marker.receiptId || session.isProcessing ||
        metadata.status !== "pending") return null;
    return { receiptId: marker.receiptId, sessionRef: record.to };
  }

  function cleanupAbortedSuccessor(record) {
    if (record.handoffClass !== "B" || record.successorState !== "created" ||
        !record.successorReceiptId) return true;
    var session = targetSession(record.to, null, record.handoffId);
    if (!session) return true;
    var metadata = metadataFor(session);
    var marker = metadata && metadata.recoveryPreallocation;
    if (!marker || marker.handoffId !== record.handoffId ||
        marker.receiptId !== record.successorReceiptId || !sameRef(marker.sessionRef, record.to) ||
        session.isProcessing || metadata.status !== "pending") return false;
    if (typeof sm.deleteSessionQuiet === "function") sm.deleteSessionQuiet(session.localId);
    if (!sm.sessions.has(session.localId)) return true;
    if (typeof sm.hideSession !== "function") return false;
    sm.hideSession(session.localId);
    metadata.status = "cancelled";
    delete metadata.recoveryPreallocation;
    sm.saveSessionFile(session);
    return session.hidden === true;
  }

  function restoreReplayFence(session, effect) {
    var metadata = metadataFor(session);
    if (!metadata || !metadata.control) return;
    var currentFence = session._coopExecutionFence;
    if (currentFence && currentFence.isCurrent("tool")) return;
    if (!control || typeof control.recoverTarget !== "function") {
      executionFence.fenceFor(session);
      return;
    }
    var token = control.recoverTarget(effect.target);
    if (!token || token.executionId !== metadata.control.executionId) {
      executionFence.fenceFor(session);
      return;
    }
    metadata.control = executionFence.attachFence(session, control.createFence(token));
    metadata.status = "running";
    metadata.updatedAt = Date.now();
    delete metadata.reason;
    delete metadata.terminalAt;
    sm.saveSessionFile(session);
  }

  function applyEffect(effect) {
    var session = targetSession(effect.target, null);
    if (!session || !Array.isArray(session.history)) {
      throw new Error("Recovered effect target is unavailable.");
    }
    restoreReplayFence(session, effect);
    if (!effect.payloadReference || typeof opts.resolveDelivery !== "function") {
      throw new Error("Recovered effect lacks a durable delivery reference.");
    }
    var delivery = opts.resolveDelivery(effect.payloadReference, effect);
    if (!delivery || delivery.payloadDigest !== effect.payloadDigest ||
        typeof delivery.apply !== "function") {
      throw new Error("Recovered effect delivery reference cannot be resolved.");
    }
    return then(delivery.apply(session, effect), function (result) {
      if (result === false || result && result.ok === false) {
        throw new Error("Recovered effect provider activation did not prove its start fence.");
      }
      return { receiptId: receiptId(effect.effectId) };
    });
  }

  return { activate: activate, applyEffect: applyEffect,
    cleanupAbortedSuccessor: cleanupAbortedSuccessor, rehydrate: rehydrate,
    successorEvidence: successorEvidence,
    send: typeof opts.send === "function" ? opts.send : function () {
      return { accepted: false };
    } };
}

module.exports = { createTargetRecoveryHandlers: createTargetRecoveryHandlers };
