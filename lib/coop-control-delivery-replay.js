// Bounded target-session replay evidence for external controlled messages.
// Message text remains outside ControlStore and is removed only after receipt.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");

var MAX_RECORDS = 64;
var MAX_RECORD_BYTES = 131072;

function sameRef(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId;
}

function fail(message) {
  var error = new Error(message);
  error.code = "COOP_CONTROL_DELIVERY_REPLAY_INVALID";
  throw error;
}

function copiedRef(value) {
  var ref = projectIdentity.normalizeSessionRef(value);
  if (!ref) fail("Delivery replay requires an exact SessionRef.");
  return { projectId: ref.projectId, sessionStorageId: ref.sessionStorageId };
}

function copiedEnvelope(value, validEnvelope) {
  var payload = value && value.payload || {};
  if (!value || typeof validEnvelope !== "function" || !validEnvelope(value, payload) ||
      payload.type !== "portfolio_execution_message" || !String(payload.text || "").trim()) {
    fail("Delivery replay requires a valid external execution message.");
  }
  return {
    schema: value.schema,
    schemaVersion: value.schemaVersion,
    eventId: value.eventId,
    source: copiedRef(value.source),
    destination: copiedRef(value.destination),
    payload: {
      type: payload.type,
      portfolioTaskId: payload.portfolioTaskId,
      bindingRevision: payload.bindingRevision,
      text: payload.text,
    },
  };
}

function recordBytes(record) {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function payloadDigest(payload) {
  return crypto.createHash("sha256").update(JSON.stringify([
    payload.type, payload.portfolioTaskId, payload.bindingRevision, String(payload.text || "").trim(),
  ]), "utf8").digest("hex");
}

function validPersistIdentity(value, envelope, target, requestedTarget) {
  return !!target && sameRef(target, requestedTarget) && value.messageId === envelope.eventId &&
    value.payloadReference === envelope.eventId && typeof value.payloadDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.payloadDigest) && payloadDigest(envelope.payload) === value.payloadDigest &&
    typeof value.effectId === "string" && /^effect:[A-Za-z0-9_-]{48}$/.test(value.effectId);
}

function createDeliveryReplayStore(options) {
  var opts = options || {};
  var sm = opts.sm;
  var metadataFor = opts.executionMetadata;
  if (!sm || !sm.sessions || typeof metadataFor !== "function" ||
      typeof opts.projectId !== "function") {
    fail("Delivery replay requires target SessionManager dependencies.");
  }

  function sessionRef(session) {
    return projectIdentity.sessionRef({ projectId: opts.projectId() }, session);
  }

  function records(session, create) {
    var metadata = metadataFor(session);
    if (!metadata) {
      if (!create) return [];
      fail("Delivery replay target has no controlled execution metadata.");
    }
    if (!Array.isArray(metadata.recoveryDeliveries)) {
      if (!create) return [];
      metadata.recoveryDeliveries = [];
    }
    return metadata.recoveryDeliveries;
  }

  function findSession(ref) {
    var found = null;
    sm.sessions.forEach(function (session) {
      if (!found && sameRef(sessionRef(session), ref)) found = session;
    });
    return found;
  }

  function persist(session, input) {
    var value = input || {};
    var envelope = copiedEnvelope(value.envelope, opts.validEnvelope);
    var target = sessionRef(session);
    var requestedTarget = projectIdentity.normalizeSessionRef(value.target);
    if (!validPersistIdentity(value, envelope, target, requestedTarget)) {
      fail("Delivery replay identities do not match the exact target message.");
    }
    var record = { schemaVersion: 1, messageId: value.messageId,
      payloadReference: value.payloadReference, payloadDigest: value.payloadDigest,
      effectId: value.effectId, target: requestedTarget, envelope: envelope };
    if (recordBytes(record) > MAX_RECORD_BYTES) fail("Delivery replay record exceeds its byte limit.");
    var items = records(session, true);
    for (var i = 0; i < items.length; i++) {
      if (items[i].payloadReference !== record.payloadReference) continue;
      if (JSON.stringify(items[i]) !== JSON.stringify(record)) {
        fail("Delivery replay reference resolves to different content.");
      }
      sm.saveSessionFile(session, { durable: true });
      return items[i];
    }
    if (items.length >= MAX_RECORDS) fail("Delivery replay record limit is exhausted.");
    items.push(record);
    try {
      sm.saveSessionFile(session, { durable: true });
    } catch (error) {
      items.pop();
      throw error;
    }
    return record;
  }

  function prepare(session, envelope, delivery) {
    var copied = copiedEnvelope(envelope, opts.validEnvelope);
    var target = sessionRef(session);
    var digest = payloadDigest(copied.payload);
    var stable = { messageId: copied.eventId, sender: copied.source, recipient: target,
      kind: "execution_event", referenceId: copied.eventId, payloadReference: copied.eventId,
      payloadDigest: digest };
    var effect = { kind: "execution_update", target: target };
    var effectId = delivery.effectIdentity(stable, effect);
    persist(session, { effectId: effectId, envelope: copied, messageId: copied.eventId,
      payloadDigest: digest, payloadReference: copied.eventId, target: target });
    return { effect: effect, effectId: effectId, stable: stable };
  }

  function resolve(referenceId, expected) {
    var value = expected || {};
    var target = projectIdentity.normalizeSessionRef(value.target || value.recipient);
    var session = target && findSession(target);
    if (!session) return null;
    var items = records(session, false);
    for (var i = 0; i < items.length; i++) {
      var record = items[i];
      if (record.payloadReference !== referenceId) continue;
      if (record.messageId !== value.messageId || record.payloadDigest !== value.payloadDigest ||
          record.effectId !== value.effectId || !sameRef(record.target, target) ||
          recordBytes(record) > MAX_RECORD_BYTES) return null;
      var envelope = copiedEnvelope(record.envelope, opts.validEnvelope);
      if (payloadDigest(envelope.payload) !== record.payloadDigest) return null;
      return { effectId: record.effectId, envelope: envelope, payload: envelope.payload,
        payloadDigest: record.payloadDigest, text: String(envelope.payload.text).trim() };
    }
    return null;
  }

  function cleanupReceived(delivery) {
    var effects = delivery.listEffects();
    var outbox = delivery.listOutbox();
    var received = Object.create(null);
    var outboxStates = Object.create(null);
    var changed = 0;
    for (var i = 0; i < effects.length; i++) {
      if (effects[i].state === "received") received[effects[i].effectId] = effects[i];
    }
    for (var j = 0; j < outbox.length; j++) outboxStates[outbox[j].messageId] = outbox[j].state;
    sm.sessions.forEach(function (session) {
      var items = records(session, false);
      var kept = items.filter(function (record) {
        var effect = received[record.effectId];
        var outboxState = outboxStates[record.messageId];
        var removable = effect && effect.payloadDigest === record.payloadDigest &&
          (!outboxState || outboxState === "acked");
        if (removable) changed += 1;
        return !removable;
      });
      if (kept.length !== items.length) {
        metadataFor(session).recoveryDeliveries = kept;
        sm.saveSessionFile(session);
      }
    });
    return changed;
  }

  return { cleanupReceived: cleanupReceived, persist: persist, prepare: prepare, resolve: resolve };
}

module.exports = {
  MAX_RECORD_BYTES: MAX_RECORD_BYTES,
  MAX_RECORDS: MAX_RECORDS,
  createDeliveryReplayStore: createDeliveryReplayStore,
};
