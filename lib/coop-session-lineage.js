// Resolves exact session-scoped evidence across Clay compaction continuations.
// Bindings keep their original SessionRef while execution moves to a new one.
function storageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}

function keyFor(projectId, sessionStorageId) {
  return String(projectId || "") + ":" + String(sessionStorageId || "");
}

function valuesFor(index, projectId, session, sessionsByStorage) {
  var values = [];
  var current = session || null;
  var currentId = storageId(current);
  var seen = {};
  while (currentId && !seen[currentId]) {
    seen[currentId] = true;
    var indexed = index[keyFor(projectId, currentId)] || [];
    for (var i = 0; i < indexed.length; i++) values.push(indexed[i]);
    var predecessorId = current && current.compactedFromStorageId || "";
    if (!predecessorId) break;
    currentId = predecessorId;
    current = sessionsByStorage[predecessorId] || null;
  }
  return values;
}

module.exports = { valuesFor: valuesFor };
