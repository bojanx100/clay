// Typed, ordered events for the owner-acceptance lifecycle.
//
// The binding and task records are last-write-wins: `ownerAcceptance` holds
// only the current verdict, so an accept that follows a rejection erases any
// trace that the owner ever rejected the work. That is fine for deciding what
// to show now and useless for answering "did the owner ever look at this, and
// what did they say". These events are the durable record of each transition.
//
// They are evidence of an owner act only. Nothing here may be minted from
// technical completion, replayed transcript text, or a restored envelope --
// the same rule that governs `ownerAcceptance` itself.

var SCHEMA = "clay.owner_acceptance_event";
var VERSION = 1;

// Kept bounded because these ride along inside task and binding records, which
// are rewritten whole on every save. The tail is what matters; an owner who
// flips a verdict fifty times has already told us everything.
var MAX_EVENTS = 50;

var TYPES = {
  owner_acceptance_pending: true,
  owner_acceptance_accepted: true,
  owner_acceptance_rejected: true,
  owner_acceptance_revoked: true,
};

function cleanText(value, limit) {
  var cleaned = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, limit || 240);
}

// The event type implied by a verdict transition. Revocation is a withdrawn
// acceptance rather than its own status, so it is detected here rather than
// read off `status`.
function typeForAcceptance(acceptance) {
  if (!acceptance || typeof acceptance !== "object") return "";
  if (acceptance.status === "accepted") {
    return acceptance.withdrawnAt == null ?
      "owner_acceptance_accepted" : "owner_acceptance_revoked";
  }
  if (acceptance.status === "rejected") return "owner_acceptance_rejected";
  if (acceptance.status === "pending") return "owner_acceptance_pending";
  return "";
}

function normalizeEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schema !== SCHEMA || value.version !== VERSION) return null;
  var type = cleanText(value.type, 64);
  if (!TYPES[type]) return null;
  var at = Number(value.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  var record = { schema: SCHEMA, version: VERSION, type: type, at: at };
  var by = cleanText(value.by, 128);
  if (by) record.by = by;
  var source = cleanText(value.source, 64);
  if (source) record.source = source;
  var note = cleanText(value.note, 240);
  if (note) record.note = note;
  return record;
}

function mintEvent(type, details) {
  var input = details && typeof details === "object" ? details : {};
  return normalizeEvent({
    schema: SCHEMA,
    version: VERSION,
    type: type,
    at: input.at,
    by: input.by,
    source: input.source,
    note: input.note,
  });
}

function normalizeEvents(value) {
  if (!Array.isArray(value)) return [];
  var out = [];
  for (var i = 0; i < value.length; i++) {
    var event = normalizeEvent(value[i]);
    if (event) out.push(event);
  }
  return out.slice(-MAX_EVENTS);
}

// Appends without mutating the caller's array: these records are cloned into
// projections all over the place, and an in-place push would leak a transition
// into a snapshot that was taken before it happened.
function appendEvent(existing, event) {
  var events = normalizeEvents(existing);
  var normalized = normalizeEvent(event);
  if (!normalized) return events;
  return events.concat([normalized]).slice(-MAX_EVENTS);
}

// The one call sites use: derive the type from the verdict being written and
// append it. Returns the existing list unchanged when the verdict is not a
// recognisable transition, so a caller can apply this unconditionally.
function appendForAcceptance(existing, acceptance, details) {
  var type = typeForAcceptance(acceptance);
  if (!type) return normalizeEvents(existing);
  var input = details && typeof details === "object" ? details : {};
  return appendEvent(existing, mintEvent(type, {
    at: input.at != null ? input.at : acceptance && acceptance.at,
    by: input.by,
    source: input.source,
    note: input.note,
  }));
}

module.exports = {
  MAX_EVENTS: MAX_EVENTS,
  SCHEMA: SCHEMA,
  TYPES: TYPES,
  VERSION: VERSION,
  appendEvent: appendEvent,
  appendForAcceptance: appendForAcceptance,
  mintEvent: mintEvent,
  normalizeEvent: normalizeEvent,
  normalizeEvents: normalizeEvents,
  typeForAcceptance: typeForAcceptance,
};
