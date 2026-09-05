// Reserve the sequence and its retryable envelope in the same durable write.
// A caller's separate acknowledgement may fail without leaving a stream gap.
var wire = require("./cross-project-envelope");
var sourceKey = require("./cross-project-delivery-cursors").sourceKey;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createOutboxQueue(options) {
  return function (input) {
    var state = options.state;
    var spec = clone(input || {});
    var existing = options.knownEvent(spec.eventId);
    if (existing) return clone(existing);
    if (Object.keys(state.outbox).length >= options.maxOutbox) return null;
    spec.schema = spec.schema || wire.SCHEMA;
    spec.schemaVersion = spec.schemaVersion || wire.SCHEMA_VERSION;
    spec.createdAt = wire.isFiniteNumber(spec.createdAt) ? spec.createdAt : options.now();
    if (!spec.source || !spec.destination) return null;
    var key = sourceKey(spec);
    spec.sourceSeq = (state.sequences[key] || 0) + 1;
    if (wire.validationReason(spec)) return null;
    var priorSequences = clone(state.sequences);
    var priorInbox = clone(state.inbox);
    if (!options.ensureSourceCursor(spec, true)) return null;
    state.outbox[spec.eventId] = { envelope: clone(spec), attempts: 0, nextRetryAt: 0, lastError: null };
    try { options.save(); }
    catch (error) {
      delete state.outbox[spec.eventId];
      state.sequences = priorSequences;
      state.inbox = priorInbox;
      throw error;
    }
    return spec;
  };
}

module.exports = { createOutboxQueue: createOutboxQueue };
