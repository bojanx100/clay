// Durable stable-message inbox/outbox and visible-effect reconciliation.
// Inbox identities are permanent, so logical dedup is not a bounded window.

var crypto = require("crypto");
var controlStore = require("./coop-control-store");
var handoffModule = require("./coop-control-handoff");
var projectIdentity = require("./project-identity");
var validation = require("./coop-control-store-validation");

var MESSAGE_KINDS = Object.freeze({ execution_event: true, handoff_control: true, rehydration: true });
var EFFECT_KINDS = Object.freeze({ execution_update: true, handoff_cutover: true, rehydrate: true });
var EFFECT_FOR_MESSAGE = Object.freeze({
  execution_event: "execution_update",
  handoff_control: "handoff_cutover",
  rehydration: "rehydrate",
});

function error(code, message) {
  return validation.taggedError(code, message);
}

function then(value, next) {
  return value && typeof value.then === "function" ? value.then(next) : next(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function identity(prefix, fields) {
  return prefix + ":" + digest(fields.join("\u0000")).slice(0, 48);
}

function isDeliveryControlEnabled(options) {
  return handoffModule.isHandoffControlEnabled(options);
}

function exactObject(value, fields, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw error("COOP_CONTROL_DELIVERY_INVALID", label + " must be a plain object.");
  }
  var allowed = Object.create(null);
  var keys = Object.keys(value);
  var i;
  for (i = 0; i < fields.length; i++) allowed[fields[i]] = true;
  for (i = 0; i < keys.length; i++) {
    if (!allowed[keys[i]]) {
      if (validation.privacyAlias(keys[i])) {
        throw error("COOP_CONTROL_CONTINUITY_OUT_OF_SCOPE", label + " cannot contain private fields.");
      }
      throw error("COOP_CONTROL_DELIVERY_INVALID", label + " contains an unknown field.");
    }
  }
  for (i = 0; i < required.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, required[i])) {
      throw error("COOP_CONTROL_DELIVERY_INVALID", label + " is missing a required field.");
    }
  }
  return value;
}

function knownKind(collection, value) {
  return Object.prototype.hasOwnProperty.call(collection, value);
}

function validIdentifier(value) {
  return typeof value === "string" && validation.IDENTIFIER_RE.test(value);
}

function validEnvelopeFields(sender, recipient, kind, messageId, referenceId, payloadDigest, payloadReference) {
  return !!sender && !!recipient && knownKind(MESSAGE_KINDS, kind) && validIdentifier(messageId) &&
    validIdentifier(referenceId) && validation.DIGEST_RE.test(payloadDigest) && validIdentifier(payloadReference);
}

function normalizeEnvelope(value) {
  var source = exactObject(value, ["messageId", "sender", "recipient", "kind", "referenceId",
    "payloadDigest", "payloadReference", "state", "attemptCount", "createdAt", "lastAttemptAt", "ackedAt"],
  ["sender", "recipient", "kind", "referenceId", "payloadDigest"], "Stable message");
  var sender = projectIdentity.normalizeSessionRef(source.sender);
  var recipient = projectIdentity.normalizeSessionRef(source.recipient);
  var messageId = source.messageId || identity("message", [sender && sender.projectId,
    sender && sender.sessionStorageId, recipient && recipient.projectId,
    recipient && recipient.sessionStorageId, source.kind, source.referenceId, source.payloadDigest]);
  var payloadReference = source.payloadReference === undefined ? source.referenceId : source.payloadReference;
  if (!validEnvelopeFields(sender, recipient, source.kind, messageId, source.referenceId,
      source.payloadDigest, payloadReference)) {
    throw error("COOP_CONTROL_DELIVERY_INVALID", "Stable message references or codes are invalid.");
  }
  return { messageId: messageId, sender: sender, recipient: recipient, kind: source.kind,
    referenceId: source.referenceId, payloadDigest: source.payloadDigest, payloadReference: payloadReference };
}

function normalizeEffect(value) {
  var source = exactObject(value, ["kind", "target"], ["kind", "target"], "Effect intent");
  var target = projectIdentity.normalizeSessionRef(source.target);
  if (!target || !knownKind(EFFECT_KINDS, source.kind)) {
    throw error("COOP_CONTROL_DELIVERY_INVALID", "Effect intent references or code are invalid.");
  }
  return { kind: source.kind, target: target };
}

function effectIdentity(value, effectValue) {
  var spec = normalizeEnvelope(value);
  var effect = normalizeEffect(effectValue);
  if (EFFECT_FOR_MESSAGE[spec.kind] !== effect.kind || effect.target.projectId !== spec.recipient.projectId ||
      effect.target.sessionStorageId !== spec.recipient.sessionStorageId) {
    throw error("COOP_CONTROL_DELIVERY_INVALID", "Effect intent must match the stable message kind and recipient.");
  }
  return identity("effect", [spec.messageId, effect.kind,
    effect.target.projectId, effect.target.sessionStorageId]);
}

function camelEnvelope(row) {
  if (!row) return null;
  return { messageId: row.message_id,
    sender: { projectId: row.sender_project_id, sessionStorageId: row.sender_session_id },
    recipient: { projectId: row.recipient_project_id, sessionStorageId: row.recipient_session_id },
    kind: row.message_kind, referenceId: row.reference_id, payloadDigest: row.payload_digest,
    payloadReference: row.payload_reference || row.reference_id,
    state: row.state, attemptCount: Number(row.attempt_count || 0),
    createdAt: Number(row.created_at),
    lastAttemptAt: row.last_attempt_at === null ? null : Number(row.last_attempt_at),
    ackedAt: row.acked_at === null ? null : Number(row.acked_at) };
}

function camelInbox(row) {
  var envelope = camelEnvelope(row);
  envelope.effectId = row.effect_id;
  envelope.receivedAt = Number(row.received_at);
  delete envelope.state;
  delete envelope.attemptCount;
  delete envelope.createdAt;
  delete envelope.lastAttemptAt;
  delete envelope.ackedAt;
  return envelope;
}

function camelEffect(row) {
  return { effectId: row.effect_id, messageId: row.message_id, kind: row.effect_kind,
    target: { projectId: row.target_project_id, sessionStorageId: row.target_session_id },
    state: row.state, intentAt: Number(row.intent_at),
    receiptAt: row.receipt_at === null ? null : Number(row.receipt_at), receiptId: row.receipt_id,
    referenceId: row.reference_id || "", payloadDigest: row.payload_digest || "",
    payloadReference: row.payload_reference || row.reference_id || "" };
}

function disabledControl() {
  return { enabled: false, ack: function () { return false; }, close: function () {},
    dispatch: function () { return 0; }, enqueue: function (value) { return value; },
    inspectOutbox: function () { return null; }, listEffects: function () { return []; },
    listPendingEffects: function () { return []; }, countPendingEffects: function () { return 0; },
    listInbox: function () { return []; }, listOutbox: function () { return []; },
    receive: function () { return { enabled: false, bypass: true }; },
    reconcile: function () { return 0; }, reconcileOne: function () { return false; } };
}

function sameEnvelope(left, right) {
  return left.messageId === right.messageId && left.sender.projectId === right.sender.projectId &&
    left.sender.sessionStorageId === right.sender.sessionStorageId &&
    left.recipient.projectId === right.recipient.projectId &&
    left.recipient.sessionStorageId === right.recipient.sessionStorageId && left.kind === right.kind &&
    left.referenceId === right.referenceId && left.payloadDigest === right.payloadDigest &&
    left.payloadReference === right.payloadReference;
}

function createDeliveryControl(options) {
  var opts = options || {};
  if (!isDeliveryControlEnabled(opts)) return disabledControl();
  var ownsStore = !opts.store;
  var storeOptions = { dbPath: opts.dbPath, faults: opts.storeFaults, fs: opts.fs, now: opts.now };
  if (Object.prototype.hasOwnProperty.call(opts, "sqliteModule")) storeOptions.sqliteModule = opts.sqliteModule;
  var store = opts.store || controlStore.openControlStore(storeOptions);
  var faults = opts.faults || {};
  var closed = false;

  function assertOpen() {
    if (closed) throw error("COOP_CONTROL_DELIVERY_CLOSED", "Delivery controller is closed.");
  }

  function enqueue(value, fence) {
    assertOpen();
    if (fence && typeof fence.assert === "function") fence.assert("progress");
    var spec = normalizeEnvelope(value);
    var existing = store.getOutbox(spec.messageId);
    if (existing && !sameEnvelope(camelEnvelope(existing), spec)) {
      throw error("COOP_CONTROL_DELIVERY_CONFLICT", "Stable message identity resolves to different content.");
    }
    return camelEnvelope(store.enqueueOutbox(spec));
  }

  function receive(value, effectValue) {
    assertOpen();
    var spec = normalizeEnvelope(value);
    var effect = normalizeEffect(effectValue);
    if (EFFECT_FOR_MESSAGE[spec.kind] !== effect.kind || effect.target.projectId !== spec.recipient.projectId ||
        effect.target.sessionStorageId !== spec.recipient.sessionStorageId) {
      throw error("COOP_CONTROL_DELIVERY_INVALID", "Effect intent must match the stable message kind and recipient.");
    }
    effect.effectId = effectIdentity(spec, effect);
    var result = store.acceptInbox(spec, effect);
    return { duplicate: result.duplicate, messageId: spec.messageId, effectId: effect.effectId };
  }

  function ack(messageId, payloadDigest) {
    assertOpen();
    return camelEnvelope(store.ackOutbox(messageId, payloadDigest));
  }

  function dispatch(send) {
    assertOpen();
    if (typeof send !== "function") throw error("COOP_CONTROL_DELIVERY_INVALID", "A delivery callback is required.");
    var rows = store.listOutbox(true);
    var acknowledged = 0;
    for (var i = 0; i < rows.length; i++) {
      var envelope = camelEnvelope(store.noteOutboxAttempt(rows[i].message_id));
      var response = send(envelope);
      if (response && response.accepted === true) {
        store.ackOutbox(envelope.messageId, envelope.payloadDigest);
        acknowledged += 1;
      }
    }
    return acknowledged;
  }

  function listEffects() {
    assertOpen();
    return store.listEffectsWithInbox().map(camelEffect);
  }

  function listPendingEffects() {
    assertOpen();
    return store.listEffectsWithInbox(true).map(camelEffect);
  }

  function reconcile(apply) {
    assertOpen();
    if (typeof apply !== "function") throw error("COOP_CONTROL_DELIVERY_INVALID", "An effect executor is required.");
    var effects = listPendingEffects();
    return reconcilePending(effects, apply);
  }

  function reconcilePending(effects, apply) {
    assertOpen();
    if (!Array.isArray(effects)) throw error("COOP_CONTROL_EFFECT_INVALID", "Pending effects must be an array.");
    function record(effect, receipt) {
      if (!receipt || !validation.IDENTIFIER_RE.test(receipt.receiptId || "")) {
        throw error("COOP_CONTROL_EFFECT_INVALID", "Effect executor must return a stable receiptId.");
      }
      if (typeof faults.afterEffect === "function") faults.afterEffect(effect, receipt);
      store.recordEffectReceipt(effect.effectId, receipt.receiptId);
    }
    function reconcileAt(index, received) {
      if (index >= effects.length) return received;
      var effect = effects[index];
      return then(apply(effect), function (receipt) {
        record(effect, receipt);
        return reconcileAt(index + 1, received + 1);
      });
    }
    return reconcileAt(0, 0);
  }

  function reconcileOne(effectId, apply) {
    assertOpen();
    if (typeof apply !== "function") throw error("COOP_CONTROL_DELIVERY_INVALID", "An effect executor is required.");
    var row = store.getEffectWithInbox(effectId);
    if (!row) throw error("COOP_CONTROL_EFFECT_NOT_FOUND", "Effect intent does not exist.");
    var effect = camelEffect(row);
    if (effect.state === "received") return false;
    return then(apply(effect), function (receipt) {
      if (!receipt || !validation.IDENTIFIER_RE.test(receipt.receiptId || "")) {
        throw error("COOP_CONTROL_EFFECT_INVALID", "Effect executor must return a stable receiptId.");
      }
      if (typeof faults.afterEffect === "function") faults.afterEffect(effect, receipt);
      store.recordEffectReceipt(effect.effectId, receipt.receiptId);
      return true;
    });
  }

  return { enabled: true, ack: ack,
    close: function () { if (closed) return; closed = true; if (ownsStore) store.close(); },
    dispatch: dispatch, effectIdentity: effectIdentity, enqueue: enqueue,
    inspectOutbox: function (id) { assertOpen(); return camelEnvelope(store.getOutbox(id)); },
    countPendingEffects: function () { assertOpen(); return store.countPendingEffects(); },
    listEffects: listEffects,
    listPendingEffects: listPendingEffects,
    listInbox: function () { assertOpen(); return store.listInbox().map(camelInbox); },
    listOutbox: function () { assertOpen(); return store.listOutbox(false).map(camelEnvelope); },
    receive: receive, reconcile: reconcile, reconcileOne: reconcileOne,
    reconcilePending: reconcilePending };
}

module.exports = {
  EFFECT_FOR_MESSAGE: EFFECT_FOR_MESSAGE, EFFECT_KINDS: EFFECT_KINDS, MESSAGE_KINDS: MESSAGE_KINDS,
  attachCoopControlDelivery: createDeliveryControl,
  createDeliveryControl: createDeliveryControl,
  createCoopControlDelivery: createDeliveryControl,
  effectIdentity: effectIdentity,
  isDeliveryControlEnabled: isDeliveryControlEnabled,
};
