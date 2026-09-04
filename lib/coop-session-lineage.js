// Resolves exact session-scoped evidence across Clay compaction continuations.
// Bindings keep their original SessionRef while execution moves to a new one.
function storageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}

function keyFor(projectId, sessionStorageId) {
  return String(projectId || "") + ":" + String(sessionStorageId || "");
}

function indexSessions(sessions) {
  var indexed = {};
  if (!sessions || typeof sessions.forEach !== "function") return indexed;
  sessions.forEach(function (session) {
    var id = storageId(session);
    if (id) indexed[id] = session;
  });
  return indexed;
}

function distanceFrom(session, ancestorStorageId, sessionsByStorage) {
  var wanted = String(ancestorStorageId || "");
  var current = session || null;
  var currentId = storageId(current);
  var seen = {};
  var distance = 0;
  if (!wanted) return null;
  while (currentId && !seen[currentId]) {
    if (currentId === wanted) return distance;
    seen[currentId] = true;
    var predecessorId = current && current.compactedFromStorageId || "";
    if (!predecessorId) break;
    currentId = predecessorId;
    current = sessionsByStorage && sessionsByStorage[predecessorId] || null;
    distance++;
  }
  return null;
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

module.exports = {
  distanceFrom: distanceFrom,
  indexSessions: indexSessions,
  valuesFor: valuesFor,
};
