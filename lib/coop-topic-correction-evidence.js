// Replays owner corrections as exact-turn classification evidence. This never
// generalizes from text: it only restores the membership snapshots the owner
// explicitly changed, and an undone correction contributes no positive signal.

function topicId(value) {
  var ref = value && (value.threadRef || value.topicRef) || {};
  return ref.threadId || ref.topicId || "";
}

function sameTurn(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId &&
    left.startEventIndex === right.startEventIndex &&
    left.endEventIndex === right.endEventIndex;
}

function snapshotHasTurn(snapshot, turnRef) {
  var refs = snapshot && Array.isArray(snapshot.turnRefs) ? snapshot.turnRefs : [];
  for (var i = 0; i < refs.length; i++) if (sameTurn(refs[i], turnRef)) return true;
  return false;
}

function recordHasTurn(record, turnRef) {
  var direct = record && Array.isArray(record.turnRefs) ? record.turnRefs : [];
  for (var i = 0; i < direct.length; i++) if (sameTurn(direct[i], turnRef)) return true;
  var snapshots = [].concat(record && record.before || [], record && record.after || []);
  for (var j = 0; j < snapshots.length; j++) {
    if (snapshotHasTurn(snapshots[j], turnRef)) return true;
  }
  return false;
}

function idsWithTurn(snapshots, turnRef) {
  var ids = {};
  var list = Array.isArray(snapshots) ? snapshots : [];
  for (var i = 0; i < list.length; i++) {
    var id = topicId(list[i]);
    if (id && snapshotHasTurn(list[i], turnRef)) ids[id] = true;
  }
  return ids;
}

function affectedIds(record) {
  var ids = {};
  var snapshots = [].concat(record && record.before || [], record && record.after || []);
  for (var i = 0; i < snapshots.length; i++) {
    var id = topicId(snapshots[i]);
    if (id) ids[id] = true;
  }
  return ids;
}

function isUndone(record) {
  return record && record.undoneAt !== null && record.undoneAt !== undefined;
}

function apply(index, turn, matched) {
  var turnRef = {
    projectId: "system-lead",
    sessionStorageId: index && index.canonicalSessionStorageId,
    startEventIndex: turn && turn.startEventIndex,
    endEventIndex: turn && turn.endEventIndex,
  };
  if (!turnRef.sessionStorageId || !Number.isInteger(turnRef.startEventIndex) ||
      !Number.isInteger(turnRef.endEventIndex)) return matched;
  var records = index && Array.isArray(index.threadCorrections) ? index.threadCorrections : [];
  var evidence = null;
  var affected = {};
  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    if (!recordHasTurn(record, turnRef)) continue;
    var recordIds = affectedIds(record);
    Object.keys(recordIds).forEach(function (id) { affected[id] = true; });
    if (!evidence) evidence = idsWithTurn(record.before, turnRef);
    if (isUndone(record)) continue;
    Object.keys(recordIds).forEach(function (id) { delete evidence[id]; });
    var after = idsWithTurn(record.after, turnRef);
    Object.keys(after).forEach(function (id) { evidence[id] = true; });
  }
  if (!evidence) return matched;
  var result = (Array.isArray(matched) ? matched : []).filter(function (topic) {
    return !affected[topicId(topic)];
  });
  Object.keys(evidence).forEach(function (id) {
    if (index.topics[id] && result.indexOf(index.topics[id]) === -1) result.push(index.topics[id]);
  });
  return result;
}

module.exports = { apply: apply };
