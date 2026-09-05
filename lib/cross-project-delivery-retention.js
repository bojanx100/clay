// Recover a retained predecessor even when later reports occupy every slot.
// Exchange its dead-letter slot with one successor in the same atomic state
// save. Neither report is dropped and neither bounded collection grows.
var wire = require("./cross-project-envelope");
var cursors = require("./cross-project-delivery-cursors");

function makeRoomForPredecessor(state, item, deadLetterItem) {
  var envelope = item.envelope;
  var key = cursors.sourceKey(envelope);
  var inbox = state.inbox[cursors.destinationKey(envelope)];
  var stream = inbox && inbox.streams[key];
  if (!stream || envelope.sourceSeq !== stream.cursor + 1) return false;
  var successor = null;
  Object.keys(state.outbox).forEach(function (id) {
    var record = state.outbox[id];
    if (cursors.sourceKey(record.envelope) !== key ||
        record.envelope.sourceSeq <= envelope.sourceSeq) return;
    if (!successor || record.envelope.sourceSeq > successor.envelope.sourceSeq) successor = record;
  });
  if (!successor) return false;
  var retained = state.deadLetters.some(function (entry) {
    return entry.eventId === successor.envelope.eventId && wire.isSameEnvelope(entry.envelope, successor.envelope);
  });
  state.deadLetters.splice(state.deadLetters.indexOf(item), 1);
  if (!retained) state.deadLetters.push(deadLetterItem(successor.envelope,
    "sequence_gap", successor, "deferred for retained source predecessor"));
  delete state.outbox[successor.envelope.eventId];
  return true;
}

module.exports = { makeRoomForPredecessor: makeRoomForPredecessor };
