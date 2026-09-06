// Durable typed delivery for daemon-local cross-project messages.
//
// The router owns the outbox, per-destination inbox cursors, and dead-letter
// queue. It deliberately persists only bounded envelopes and metadata: the
// canonical session/transcript stays with the receiving project.
var fs = require("fs");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");
var cursorState = require("./cross-project-delivery-cursors");
var sourceKey = cursorState.sourceKey;
var makeRoomForPredecessor = require("./cross-project-delivery-retention").makeRoomForPredecessor;
var wire = require("./cross-project-envelope");
var boundedEnvelope = wire.boundedEnvelope;
var boundedPayload = wire.boundedPayload;
var validationReason = wire.validationReason;
var isSameEnvelope = wire.isSameEnvelope;
var isFiniteNumber = wire.isFiniteNumber;
var isPositiveInteger = wire.isPositiveInteger;

var SCHEMA = wire.SCHEMA;
var SCHEMA_VERSION = wire.SCHEMA_VERSION;
var MAX_OUTBOX = 256;
var MAX_DELIVERED = 512;
var MAX_DEAD_LETTERS = 256;
var MAX_APPLIED = 256;
var MAX_BUFFERED = 64;
var MAX_ATTEMPTS = 6;
var EVENT_ID_RE = wire.EVENT_ID_RE;
var SOURCE_CURSOR_CAPACITY = "source cursor capacity reached";
var INBOX_CURSOR_CAPACITY = "inbox cursor capacity reached";

function defaultState() {
  return { version: 1, outbox: {}, delivered: [], inbox: {}, sequences: {}, deadLetters: [] };
}

function deliveryFile() {
  return path.join(config.CONFIG_DIR, "cross-project-delivery.json");
}

function sessionRef(value) {
  return projectIdentity.normalizeSessionRef(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

  var cursors = cursorState.createDeliveryCursors(state, isRetryableDeadLetter);
  var ensureInbox = cursors.ensureInbox;
  var ensureStream = cursors.ensureStream;
  var ensureSourceCursor = cursors.ensureSourceCursor;

  function previousDeadLetter(eventId, envelope) {
    for (var i = 0; i < state.deadLetters.length; i++) {
      if (state.deadLetters[i].eventId === eventId &&
          isSameEnvelope(state.deadLetters[i].envelope, envelope)) return state.deadLetters[i];
    }
    return null;
  }

  function deadLetterItem(envelope, reason, record, error) {
    var eventId = envelope && envelope.eventId || null;
    var source = envelope && sessionRef(envelope.source);
    var destination = envelope && sessionRef(envelope.destination);
    var attempts = record && record.attempts || 0;
    var createdAt = envelope && envelope.createdAt || now();
    var nextRetryAt = record && record.nextRetryAt || null;
    return {
      eventId: eventId,
      envelope: boundedEnvelope(envelope),
      source: source,
      destination: destination,
      bindingRevision: envelope && envelope.bindingRevision,
      reason: reason,
      attempts: attempts,
      createdAt: createdAt,
      failedAt: now(),
      nextRetryAt: nextRetryAt,
      lastError: error || null,
    };
  }

  function reportDeadLetter(item) {
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
  }

  function recordDeadLetter(envelope, reason, record, error) {
    var eventId = envelope && envelope.eventId || null;
    var previous = previousDeadLetter(eventId, envelope);
    if (previous) return previous;
    var item = deadLetterItem(envelope, reason, record, error);
    state.deadLetters.push(item);
    trim(state.deadLetters, MAX_DEAD_LETTERS);
    reportDeadLetter(item);
    return item;
  }

  function isRetryableCapacityDeadLetter(item) {
    return !!item && item.reason === "delivery_error" &&
      (item.lastError === SOURCE_CURSOR_CAPACITY || item.lastError === INBOX_CURSOR_CAPACITY);
  }

  function isRetryableDeadLetter(item) {
    return !!item && (item.reason === "delivery_error" ||
      item.reason === "project_unavailable" || item.reason === "sequence_gap");
  }

  function removeRetryableDeadLetter(eventId) {
    for (var i = state.deadLetters.length - 1; i >= 0; i--) {
      var item = state.deadLetters[i];
      if (item.eventId === eventId && isRetryableDeadLetter(item)) {
        state.deadLetters.splice(i, 1);
      }
    }
  }

  function retryableCapacity(record, error) {
    record.lastError = error;
    record.lastReason = "delivery_error";
    record.nextRetryAt = now() + retryDelay(Math.max(1, record.attempts), retryBaseMs, retryMaxMs);
    var item = recordDeadLetter(record.envelope, "delivery_error", record, error);
    save();
    return { ok: false, reason: "delivery_error", deadLettered: true, pending: true,
      retryable: true, nextRetryAt: record.nextRetryAt, deadLetter: clone(item) };
  }

  function deadLetter(record, reason, error) {
    var envelope = record && record.envelope;
    var owned = !!(envelope && state.outbox[envelope.eventId] === record);
    if (owned) removeRetryableDeadLetter(envelope.eventId);
    var item = recordDeadLetter(envelope, reason, record, error);
    if (owned) {
      delete state.outbox[envelope.eventId];
      // The exact queued report was terminally refused, not lost. Account for
      // that sequence without pretending the receiver applied it. Unknown gaps
      // and rejected caller payloads never advance an accepted stream.
      var stream = ensureStream(envelope, false);
      if (stream && envelope.sourceSeq === stream.cursor + 1 && isTerminal(reason)) {
        stream.cursor = envelope.sourceSeq;
        stream.lastRejection = { eventId: envelope.eventId, sourceSeq: envelope.sourceSeq,
          reason: reason, at: now() };
        delete stream.buffered[String(envelope.sourceSeq)];
      }
    }
    save();
    if (owned) drain(envelope);
    return { ok: false, reason: reason, deadLettered: true, deadLetter: clone(item) };
  }

  function markDelivered(record) {
    var envelope = record.envelope;
    var inbox = ensureInbox(envelope);
    if (!inbox) return false;
    removeRetryableDeadLetter(envelope.eventId);
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
    if (record.attempts >= maxAttempts) {
      // Exhaust the fast retry budget, not the durable report. Keep its place
      // in the stream and retry at the capped interval with one visible alert.
      record.nextRetryAt = now() + retryMaxMs;
      recordDeadLetter(record.envelope, reason, record, error);
    }
    save();
    return pendingResult(record);
  }

  function pendingResult(record) {
    var result = { ok: false, reason: record.lastReason || "delivery_error", pending: true,
      nextRetryAt: record.nextRetryAt };
    if (record.attempts >= maxAttempts) {
      result.deadLettered = true;
      result.retryable = true;
    }
    return result;
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

  function attempt(eventId, force, reconcileCapacity) {
    var record = state.outbox[eventId];
    if (!record) return { ok: true, duplicate: true };
    if (!force && record.nextRetryAt && record.nextRetryAt > now()) {
      return pendingResult(record);
    }
    var envelope = record.envelope;
    if (!ensureSourceCursor(envelope, reconcileCapacity)) {
      return retryableCapacity(record, SOURCE_CURSOR_CAPACITY);
    }
    var stream = ensureStream(envelope, reconcileCapacity);
    if (!stream) return retryableCapacity(record, INBOX_CURSOR_CAPACITY);
    if (envelope.sourceSeq <= stream.cursor) {
      markDelivered(record);
      save();
      return { ok: true, duplicate: true, acknowledged: true };
    }
    if (envelope.sourceSeq > stream.cursor + 1) {
      if (!stream.buffered[String(envelope.sourceSeq)] &&
          Object.keys(stream.buffered).length >= MAX_BUFFERED) {
        return scheduleRetry(record, "sequence_gap", "sequence buffer capacity reached");
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
    var stream = ensureStream(envelope, false);
    if (!stream) return;
    var nextId = stream.buffered[String(stream.cursor + 1)];
    while (nextId) {
      delete stream.buffered[String(stream.cursor + 1)];
      var result = attempt(nextId, true, false);
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
    if (!ensureSourceCursor(spec, false)) return spec;
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
    // Reclaim acknowledged idle cursors before deferring to the watchdog.
    return attempt(input.eventId, false, true);
  }

  function restoreRetryableDeadLetters() {
    var restored = false;
    for (var i = state.deadLetters.length - 1; i >= 0; i--) {
      var item = state.deadLetters[i];
      if (!isRetryableDeadLetter(item) || state.outbox[item.eventId]) continue;
      if (!isRetryableCapacityDeadLetter(item) && Number(item.nextRetryAt) > now()) continue;
      var envelope = boundedEnvelope(item.envelope);
      if (!envelope || validationReason(envelope) || knownEvent(item.eventId) !== item.envelope) continue;
      if (Object.keys(state.outbox).length >= MAX_OUTBOX &&
          !makeRoomForPredecessor(state, item, deadLetterItem)) continue;
      state.outbox[item.eventId] = {
        envelope: clone(envelope),
        attempts: Number(item.attempts || 0),
        nextRetryAt: 0,
        lastError: item.lastError || null,
        lastReason: item.reason || null,
      };
      restored = true;
    }
    if (restored) save();
  }

  function retryPending() {
    restoreRetryableDeadLetters();
    settleHistoricalRefusals();
    var ids = Object.keys(state.outbox).sort(function (left, right) {
      var a = state.outbox[left].envelope;
      var b = state.outbox[right].envelope;
      return sourceKey(a).localeCompare(sourceKey(b)) || a.sourceSeq - b.sourceSeq;
    });
    var delivered = [];
    for (var i = 0; i < ids.length; i++) {
      var result = attempt(ids[i], false, true);
      if (result && result.delivered) delivered.push(ids[i]);
    }
    return delivered;
  }

  // Older versions removed a terminally refused report without consuming its
  // sequence. Only a valid retained refusal can close that exact gap; malformed
  // envelopes and event-id collisions are not evidence of an accepted report.
  function settleHistoricalRefusals() {
    var settled = [];
    var pendingSources = {};
    Object.keys(state.outbox).forEach(function (id) {
      pendingSources[sourceKey(state.outbox[id].envelope)] = true;
    });
    state.deadLetters.slice().sort(function (left, right) {
      return (left.envelope && left.envelope.sourceSeq || 0) -
        (right.envelope && right.envelope.sourceSeq || 0);
    }).forEach(function (item) {
      if (["session_not_found", "session_archived", "access_denied",
          "stale_binding_revision", "target_not_capable"].indexOf(item.reason) === -1) return;
      var envelope = item.envelope;
      if (!envelope || validationReason(envelope) || state.outbox[item.eventId] ||
          knownEvent(item.eventId) !== envelope || !pendingSources[sourceKey(envelope)]) return;
      if (!ensureSourceCursor(envelope, true)) return;
      var stream = ensureStream(envelope, true);
      if (!stream || envelope.sourceSeq !== stream.cursor + 1) return;
      stream.cursor = envelope.sourceSeq;
      stream.lastRejection = { eventId: item.eventId, sourceSeq: envelope.sourceSeq,
        reason: item.reason, at: item.failedAt };
      delete stream.buffered[String(envelope.sourceSeq)];
      settled.push(envelope);
    });
    if (settled.length) save();
    settled.forEach(drain);
  }

  function pendingEventIds() {
    var ids = Object.keys(state.outbox);
    state.deadLetters.forEach(function (item) {
      if (isRetryableDeadLetter(item) && item.envelope && !validationReason(item.envelope) &&
          ids.indexOf(item.eventId) === -1 && knownEvent(item.eventId) === item.envelope) ids.push(item.eventId);
    });
    return ids;
  }

  return {
    queueEnvelope: require("./cross-project-outbox-queue").createOutboxQueue({
      state: state, knownEvent: knownEvent, maxOutbox: MAX_OUTBOX, now: now,
      ensureSourceCursor: ensureSourceCursor, save: save,
    }),
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
  // Exported for tests: envelope identity is a replay/idempotency guarantee,
  // and it is defined by the exact bytes these two produce.
  boundedPayload: boundedPayload,
  isSameEnvelope: isSameEnvelope,
  validationReason: validationReason,
};
