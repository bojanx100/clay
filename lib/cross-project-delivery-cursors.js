// Bounded source and inbox cursors. A pending report prevents cursor eviction.
var sessionRef = require("./project-identity").normalizeSessionRef;
var MAX_INBOXES = 128;
var MAX_STREAMS = 256;
var MAX_SEQUENCES = 512;

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

function createDeliveryCursors(state, isRetryableDeadLetter) {
  function ensureInbox(envelope) {
    var key = destinationKey(envelope);
    if (!hasRoom(state.inbox, key, MAX_INBOXES)) return null;
    if (!state.inbox[key]) state.inbox[key] = { streams: {}, applied: [] };
    return state.inbox[key];
  }

  function hasPendingSource(key) {
    var ids = Object.keys(state.outbox);
    for (var i = 0; i < ids.length; i++) {
      var record = state.outbox[ids[i]];
      if (record && record.envelope && sourceKey(record.envelope) === key) return true;
    }
    for (var j = 0; j < state.deadLetters.length; j++) {
      var item = state.deadLetters[j];
      if (isRetryableDeadLetter(item) && item.envelope &&
          sessionRef(item.envelope.source) && sessionRef(item.envelope.destination) &&
          sourceKey(item.envelope) === key) return true;
    }
    return false;
  }

  function reclaimableCursor(envelope, destinationOnly) {
    var latestBySource = {};
    var i;
    for (i = 0; i < state.delivered.length; i++) {
      var delivered = state.delivered[i] && state.delivered[i].envelope;
      if (!delivered || !sessionRef(delivered.source) || !sessionRef(delivered.destination)) continue;
      latestBySource[sourceKey(delivered)] = i;
    }
    for (i = 0; i < state.delivered.length; i++) {
      var candidate = state.delivered[i] && state.delivered[i].envelope;
      if (!candidate || !sessionRef(candidate.source) || !sessionRef(candidate.destination)) continue;
      var key = sourceKey(candidate);
      if (latestBySource[key] !== i || hasPendingSource(key)) continue;
      if (!destinationOnly && !Object.prototype.hasOwnProperty.call(state.sequences, key)) continue;
      if (destinationOnly && destinationKey(candidate) !== destinationKey(envelope)) continue;
      var inbox = state.inbox[destinationKey(candidate)];
      var stream = inbox && inbox.streams && inbox.streams[key];
      if (!stream || Object.keys(stream.buffered || {}).length > 0) continue;
      // A factory reservation can precede its outbox write. Preserve its
      // sequence until the receiver has acknowledged every reserved message.
      if ((state.sequences[key] || 0) > stream.cursor) continue;
      return candidate;
    }
    return null;
  }

  function reclaimCursor(envelope, destinationOnly) {
    var candidate = reclaimableCursor(envelope, destinationOnly);
    if (!candidate) return false;
    var key = sourceKey(candidate);
    var inbox = state.inbox[destinationKey(candidate)];
    delete state.sequences[key];
    if (inbox && inbox.streams) delete inbox.streams[key];
    return true;
  }

  function ensureSourceCursor(envelope, reconcileCapacity) {
    var key = sourceKey(envelope);
    if (!hasRoom(state.sequences, key, MAX_SEQUENCES) &&
        (!reconcileCapacity || !reclaimCursor(envelope, false))) return false;
    state.sequences[key] = Math.max(state.sequences[key] || 0, envelope.sourceSeq);
    return true;
  }

  function ensureStream(envelope, reconcileCapacity) {
    var inbox = ensureInbox(envelope);
    if (!inbox) return null;
    var key = sourceKey(envelope);
    if (!inbox.streams[key] && streamCount(inbox) >= MAX_STREAMS &&
        (!reconcileCapacity || !reclaimCursor(envelope, true))) return null;
    if (!inbox.streams[key]) inbox.streams[key] = { cursor: 0, buffered: {} };
    return inbox.streams[key];
  }

  return { ensureInbox: ensureInbox, ensureStream: ensureStream,
    ensureSourceCursor: ensureSourceCursor };
}

module.exports = { createDeliveryCursors: createDeliveryCursors,
  sourceKey: sourceKey, destinationKey: destinationKey };
