// Durable typed delivery for daemon-local cross-project messages.
//
// The router owns the outbox, per-destination inbox cursors, and dead-letter
// queue. It deliberately persists only bounded envelopes and metadata: the
// canonical session/transcript stays with the receiving project.
var fs = require("fs");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");

var SCHEMA = "clay.cross_project_delivery";
var SCHEMA_VERSION = 1;
var MAX_OUTBOX = 256;
var MAX_DELIVERED = 512;
var MAX_DEAD_LETTERS = 256;
var MAX_APPLIED = 256;
var MAX_BUFFERED = 64;
var MAX_INBOXES = 128;
var MAX_STREAMS = 256;
var MAX_SEQUENCES = 512;
var MAX_ATTEMPTS = 6;
var MAX_TEXT_BYTES = 65536;
var EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function defaultState() {
  return { version: 1, outbox: {}, delivered: [], inbox: {}, sequences: {}, deadLetters: [] };
}

function deliveryFile() {
  return path.join(config.CONFIG_DIR, "cross-project-delivery.json");
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isRevision(value) {
  return Number.isInteger(value) && value >= 0;
}

function sessionRef(value) {
  return projectIdentity.normalizeSessionRef(value);
}

function sourceKey(envelope) {
  return envelope.source.projectId + ":" + envelope.source.sessionStorageId + ">" +
    envelope.destination.projectId + ":" + envelope.destination.sessionStorageId;
}

function destinationKey(envelope) {
  return envelope.destination.projectId + ":" + envelope.destination.sessionStorageId;
}

function hasRoom(index, key, maximum) {
  return !!index[key] || Object.keys(index).length < maximum;
}

function streamCount(inbox) {
  var sources = inbox && inbox.streams || {};
  return Object.keys(sources).length;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validPayload(payload) {
  return !!(payload && typeof payload === "object" && !Array.isArray(payload) &&
    payload.type === "coordinator_update" && typeof payload.text === "string" &&
    payload.text.length > 0 && Buffer.byteLength(payload.text, "utf8") <= MAX_TEXT_BYTES);
}

function validationReason(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return "invalid_payload";
  if (envelope.schema !== SCHEMA || envelope.schemaVersion !== SCHEMA_VERSION) return "unsupported_schema";
  if (!EVENT_ID_RE.test(String(envelope.eventId || ""))) return "invalid_payload";
  if (!sessionRef(envelope.source) || !sessionRef(envelope.destination)) return "invalid_payload";
  if (!isRevision(envelope.bindingRevision) || !isPositiveInteger(envelope.sourceSeq) ||
      !isFiniteNumber(envelope.createdAt) || !validPayload(envelope.payload)) return "invalid_payload";
  return "";
}

function boundedEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  return {
    schema: envelope.schema,
    schemaVersion: envelope.schemaVersion,
    eventId: envelope.eventId,
    source: sessionRef(envelope.source),
    destination: sessionRef(envelope.destination),
    bindingRevision: envelope.bindingRevision,
    sourceSeq: envelope.sourceSeq,
    createdAt: envelope.createdAt,
    payload: validPayload(envelope.payload) ? {
      type: envelope.payload.type,
      text: envelope.payload.text,
    } : null,
  };
}

function isSameEnvelope(left, right) {
  return JSON.stringify(boundedEnvelope(left)) === JSON.stringify(boundedEnvelope(right));
}

function isTerminal(reason) {
  return reason === "session_not_found" || reason === "session_archived" ||
    reason === "access_denied" || reason === "stale_binding_revision" ||
    reason === "unsupported_schema" || reason === "invalid_payload" ||
    reason === "target_not_capable";
}

function retryDelay(attempt, base, maximum) {
  return Math.min(maximum, base * Math.pow(2, Math.max(0, attempt - 1)));
}

function createDurableDelivery(opts) {
  var options = opts || {};
  var now = options.now || Date.now;
  var file = options.deliveryFile || deliveryFile();
  var getProjectContextById = options.getProjectContextById || function () { return null; };
  var canDeliverEnvelope = options.canDeliverEnvelope || function () { return true; };
  var recordRecoveryEvent = options.recordRecoveryEvent || function () {};
  var maxAttempts = options.maxAttempts || MAX_ATTEMPTS;
  var retryBaseMs = options.retryBaseMs || 1000;
  var retryMaxMs = options.retryMaxMs || 60000;
  var state = loadState(file);

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var tmp = file + "." + process.pid + "." + now() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  function knownEvent(eventId) {
    if (state.outbox[eventId]) return state.outbox[eventId].envelope;
    for (var i = state.delivered.length - 1; i >= 0; i--) {
      if (state.delivered[i].eventId === eventId) return state.delivered[i].envelope;
    }
    for (var j = state.deadLetters.length - 1; j >= 0; j--) {
      if (state.deadLetters[j].eventId === eventId) return state.deadLetters[j].envelope;
    }
    return null;
  }

  function knownDeadLetter(eventId) {
    for (var i = state.deadLetters.length - 1; i >= 0; i--) {
      if (state.deadLetters[i].eventId === eventId) return state.deadLetters[i];
    }
    return null;
  }

  function ensureInbox(envelope) {
    var key = destinationKey(envelope);
    if (!hasRoom(state.inbox, key, MAX_INBOXES)) return null;
    if (!state.inbox[key]) state.inbox[key] = { streams: {}, applied: [] };
    return state.inbox[key];
  }

  function ensureStream(envelope) {
    var inbox = ensureInbox(envelope);
    if (!inbox) return null;
    var key = sourceKey(envelope);
    if (!inbox.streams[key] && streamCount(inbox) >= MAX_STREAMS) return null;
    if (!inbox.streams[key]) inbox.streams[key] = { cursor: 0, buffered: {} };
    return inbox.streams[key];
  }

  function recordDeadLetter(envelope, reason, record, error) {
    var eventId = envelope && envelope.eventId || null;
    for (var i = 0; i < state.deadLetters.length; i++) {
      if (state.deadLetters[i].eventId === eventId) return state.deadLetters[i];
    }
    var item = {
      eventId: eventId,
      envelope: boundedEnvelope(envelope),
      source: envelope && sessionRef(envelope.source),
      destination: envelope && sessionRef(envelope.destination),
      bindingRevision: envelope && envelope.bindingRevision,
      reason: reason,
      attempts: record && record.attempts || 0,
      createdAt: envelope && envelope.createdAt || now(),
      failedAt: now(),
      nextRetryAt: record && record.nextRetryAt || null,
      lastError: error || null,
    };
    state.deadLetters.push(item);
    trim(state.deadLetters, MAX_DEAD_LETTERS);
    try {
      recordRecoveryEvent({
        kind: "cross_project_dead_letter",
        eventId: item.eventId,
        source: item.source,
        destination: item.destination,
        bindingRevision: item.bindingRevision,
        reason: item.reason,
        attempts: item.attempts,
        lastError: item.lastError,
      });
    } catch (e) {}
    return item;
  }

  function deadLetter(record, reason, error) {
    var envelope = record && record.envelope;
    var item = recordDeadLetter(envelope, reason, record, error);
    if (record && envelope) delete state.outbox[envelope.eventId];
    save();
    return { ok: false, reason: reason, deadLettered: true, deadLetter: clone(item) };
  }

  function markDelivered(record) {
    var envelope = record.envelope;
    var inbox = ensureInbox(envelope);
    if (!inbox) return false;
    inbox.applied.push({
      eventId: envelope.eventId,
      source: sourceKey(envelope),
      sourceSeq: envelope.sourceSeq,
      appliedAt: now(),
    });
    trim(inbox.applied, MAX_APPLIED);
    state.delivered.push({ eventId: envelope.eventId, envelope: envelope, acknowledgedAt: now() });
    trim(state.delivered, MAX_DELIVERED);
    delete state.outbox[envelope.eventId];
    return true;
  }

  function scheduleRetry(record, reason, error) {
    record.attempts += 1;
    record.lastError = error || reason;
    record.lastReason = reason;
    record.nextRetryAt = now() + retryDelay(record.attempts, retryBaseMs, retryMaxMs);
    if (record.attempts >= maxAttempts) return deadLetter(record, reason, error);
    save();
    return { ok: false, reason: reason, pending: true, nextRetryAt: record.nextRetryAt };
  }

  function deliveryResult(context, envelope) {
    if (!context) return { ok: false, reason: "project_unavailable" };
    if (typeof context.deliverCrossProjectEnvelope !== "function") {
      return { ok: false, reason: "target_not_capable" };
    }
    try {
      var result = context.deliverCrossProjectEnvelope(envelope);
      if (result === true) return { ok: true };
      if (!result || result.ok !== true) {
        return { ok: false, reason: result && result.reason || "delivery_error" };
      }
      return result;
    } catch (e) {
      return { ok: false, reason: "delivery_error", error: e && e.message || "delivery exception" };
    }
  }

  function attempt(eventId, force) {
    var record = state.outbox[eventId];
    if (!record) return { ok: true, duplicate: true };
    if (!force && record.nextRetryAt && record.nextRetryAt > now()) {
      return { ok: false, reason: record.lastReason || "delivery_error", pending: true,
        nextRetryAt: record.nextRetryAt };
    }
    var envelope = record.envelope;
    var stream = ensureStream(envelope);
    if (!stream) return deadLetter(record, "delivery_error", "inbox cursor capacity reached");
    if (envelope.sourceSeq <= stream.cursor) {
      markDelivered(record);
      save();
      return { ok: true, duplicate: true, acknowledged: true };
    }
    if (envelope.sourceSeq > stream.cursor + 1) {
      if (!stream.buffered[String(envelope.sourceSeq)] &&
          Object.keys(stream.buffered).length >= MAX_BUFFERED) {
        return deadLetter(record, "sequence_gap", "sequence buffer capacity reached");
      }
      stream.buffered[String(envelope.sourceSeq)] = eventId;
      return scheduleRetry(record, "sequence_gap", "waiting for source sequence " + (stream.cursor + 1));
    }
    if (!canDeliverEnvelope(envelope)) return deadLetter(record, "access_denied", "delivery policy denied envelope");
    var result = deliveryResult(getProjectContextById(envelope.destination.projectId), envelope);
    if (!result.ok) {
      if (isTerminal(result.reason)) return deadLetter(record, result.reason, result.error);
      return scheduleRetry(record, result.reason || "delivery_error", result.error);
    }
    stream.cursor = envelope.sourceSeq;
    delete stream.buffered[String(envelope.sourceSeq)];
    markDelivered(record);
    save();
    drain(envelope);
    return { ok: true, delivered: true, acknowledged: true, duplicate: !!result.duplicate };
  }

  function drain(envelope) {
    var stream = ensureStream(envelope);
    var nextId = stream.buffered[String(stream.cursor + 1)];
    while (nextId) {
      delete stream.buffered[String(stream.cursor + 1)];
      var result = attempt(nextId, true);
      if (!result.ok) break;
      nextId = stream.buffered[String(stream.cursor + 1)];
    }
  }

  function createEnvelope(input) {
    var spec = clone(input || {});
    var existing = knownEvent(spec.eventId);
    if (existing) return clone(existing);
    spec.schema = spec.schema || SCHEMA;
    spec.schemaVersion = spec.schemaVersion || SCHEMA_VERSION;
    spec.createdAt = isFiniteNumber(spec.createdAt) ? spec.createdAt : now();
    if (!spec.source || !spec.destination || !EVENT_ID_RE.test(String(spec.eventId || ""))) return spec;
    var key = spec.source.projectId + ":" + spec.source.sessionStorageId + ">" +
      spec.destination.projectId + ":" + spec.destination.sessionStorageId;
    spec.sourceSeq = isPositiveInteger(spec.sourceSeq) ? spec.sourceSeq : (state.sequences[key] || 0) + 1;
    if (validationReason(spec)) return spec;
    if (!hasRoom(state.sequences, key, MAX_SEQUENCES)) return spec;
    state.sequences[key] = Math.max(state.sequences[key] || 0, spec.sourceSeq);
    save();
    return spec;
  }

  function deliverEnvelope(input) {
    var envelope = boundedEnvelope(input);
    var reason = validationReason(input);
    if (reason) {
      var invalid = { envelope: envelope || input, attempts: 0 };
      return deadLetter(invalid, reason, "typed envelope validation failed");
    }
    var existing = knownEvent(input.eventId);
    if (existing && !isSameEnvelope(existing, input)) {
      return deadLetter({ envelope: input, attempts: 0 }, "invalid_payload", "eventId reused with different envelope");
    }
    if (!state.outbox[input.eventId] && !existing) {
      if (Object.keys(state.outbox).length >= MAX_OUTBOX) {
        return deadLetter({ envelope: input, attempts: 0 }, "delivery_error", "outbox capacity reached");
      }
      var key = sourceKey(input);
      if (!hasRoom(state.sequences, key, MAX_SEQUENCES)) {
        return deadLetter({ envelope: input, attempts: 0 }, "delivery_error", "source cursor capacity reached");
      }
      state.sequences[key] = Math.max(state.sequences[key] || 0, input.sourceSeq);
      state.outbox[input.eventId] = { envelope: clone(input), attempts: 0, nextRetryAt: 0, lastError: null };
      save();
    }
    if (existing && !state.outbox[input.eventId]) {
      var priorDeadLetter = knownDeadLetter(input.eventId);
      if (priorDeadLetter && isSameEnvelope(priorDeadLetter.envelope, input)) {
        return { ok: false, reason: priorDeadLetter.reason, deadLettered: true,
          deadLetter: clone(priorDeadLetter) };
      }
      return { ok: true, duplicate: true, acknowledged: true };
    }
    return attempt(input.eventId, false);
  }

  function retryPending() {
    var ids = Object.keys(state.outbox).sort(function (left, right) {
      return state.outbox[left].envelope.createdAt - state.outbox[right].envelope.createdAt;
    });
    var delivered = [];
    for (var i = 0; i < ids.length; i++) {
      var result = attempt(ids[i], false);
      if (result && result.delivered) delivered.push(ids[i]);
    }
    return delivered;
  }

  function pendingEventIds() {
    return Object.keys(state.outbox);
  }

  return {
    createEnvelope: createEnvelope,
    deliverEnvelope: deliverEnvelope,
    retryPending: retryPending,
    getPendingEventIds: pendingEventIds,
    getDeadLetters: function () { return clone(state.deadLetters); },
    getState: function () { return clone(state); },
  };
}

function loadState(file) {
  try {
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== 1 || typeof parsed.outbox !== "object" ||
        !Array.isArray(parsed.delivered) || typeof parsed.inbox !== "object" ||
        typeof parsed.sequences !== "object" || !Array.isArray(parsed.deadLetters)) return defaultState();
    return parsed;
  } catch (e) {
    return defaultState();
  }
}

function trim(list, maximum) {
  if (list.length > maximum) list.splice(0, list.length - maximum);
}

module.exports = {
  SCHEMA: SCHEMA,
  SCHEMA_VERSION: SCHEMA_VERSION,
  createDurableDelivery: createDurableDelivery,
  validationReason: validationReason,
};
