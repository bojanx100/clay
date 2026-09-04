var projectIdentity = require("./project-identity");

function storageIdOf(session) {
  return projectIdentity.sessionStorageId(session);
}

function currentHistoryOf(session) {
  if (session && Array.isArray(session._coopCurrentHistory)) return session._coopCurrentHistory;
  return Array.isArray(session && session.history) ? session.history : [];
}

function sessionsByStorage(sessions) {
  var indexed = {};
  if (!sessions || typeof sessions.forEach !== "function") return indexed;
  sessions.forEach(function (session) {
    var storageId = storageIdOf(session);
    if (storageId) indexed[storageId] = session;
  });
  return indexed;
}

function lineageSessions(session, indexed) {
  var current = session || null;
  var seen = {};
  var chain = [];
  while (current) {
    var storageId = storageIdOf(current);
    if (!storageId || seen[storageId]) break;
    seen[storageId] = true;
    chain.unshift(current);
    var predecessorId = current.compactedFromStorageId || "";
    current = predecessorId && indexed ? indexed[predecessorId] || null : null;
  }
  return chain;
}

function buildReplaySession(session, sessions) {
  var current = session || null;
  if (!current) return null;
  var indexed = sessionsByStorage(sessions);
  var chain = lineageSessions(current, indexed);
  if (chain.length <= 1) return current;
  var history = [];
  var segments = {};
  for (var i = 0; i < chain.length; i++) {
    var item = chain[i];
    var storageId = storageIdOf(item);
    var segmentHistory = Array.isArray(item.history) ? item.history : [];
    segments[storageId] = {
      session: item,
      startOffset: history.length,
      length: segmentHistory.length,
    };
    history = history.concat(segmentHistory);
  }
  var replay = Object.assign({}, current, { history: history });
  Object.defineProperty(replay, "_coopHistorySegments", {
    value: segments,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(replay, "_coopCurrentHistory", {
    value: Array.isArray(current.history) ? current.history : [],
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return replay;
}

function segmentFor(session, storageId) {
  if (!session || !storageId) return null;
  var segments = session._coopHistorySegments;
  if (segments && segments[storageId]) return segments[storageId];
  if (storageIdOf(session) === storageId) {
    var history = Array.isArray(session.history) ? session.history : [];
    return {
      session: session,
      startOffset: 0,
      length: history.length,
    };
  }
  return null;
}

function absoluteIndexFor(session, storageId, eventIndex) {
  var segment = segmentFor(session, storageId);
  if (!segment || !Number.isInteger(eventIndex) || eventIndex < 0 || eventIndex >= segment.length) return null;
  return segment.startOffset + eventIndex;
}

function recordAt(sessionOrHistory, storageId, eventIndex) {
  if (Array.isArray(sessionOrHistory)) {
    if (!Number.isInteger(eventIndex) || eventIndex < 0 || eventIndex >= sessionOrHistory.length) return null;
    return {
      record: sessionOrHistory[eventIndex],
      absoluteIndex: eventIndex,
      sessionStorageId: storageId || "",
      eventIndex: eventIndex,
    };
  }
  var session = sessionOrHistory || null;
  var absoluteIndex = absoluteIndexFor(session, storageId || storageIdOf(session), eventIndex);
  if (absoluteIndex == null) return null;
  var history = Array.isArray(session && session.history) ? session.history : [];
  return {
    record: history[absoluteIndex],
    absoluteIndex: absoluteIndex,
    sessionStorageId: storageId || storageIdOf(session) || "",
    eventIndex: eventIndex,
  };
}

function locationForAbsoluteIndex(session, absoluteIndex) {
  if (!session || !Number.isInteger(absoluteIndex) || absoluteIndex < 0) return null;
  var segments = session._coopHistorySegments;
  if (!segments) {
    if (absoluteIndex >= (Array.isArray(session.history) ? session.history.length : 0)) return null;
    return {
      sessionStorageId: storageIdOf(session) || "",
      eventIndex: absoluteIndex,
      record: session.history[absoluteIndex],
    };
  }
  var keys = Object.keys(segments);
  for (var i = 0; i < keys.length; i++) {
    var segment = segments[keys[i]];
    if (absoluteIndex < segment.startOffset || absoluteIndex >= segment.startOffset + segment.length) continue;
    var localIndex = absoluteIndex - segment.startOffset;
    var segmentHistory = Array.isArray(segment.session && segment.session.history)
      ? segment.session.history : [];
    return {
      sessionStorageId: keys[i],
      eventIndex: localIndex,
      record: segmentHistory[localIndex],
    };
  }
  return null;
}

function sessionExtendsCanonical(session, canonicalStorageId) {
  var wanted = String(canonicalStorageId || "");
  if (!wanted) return false;
  if (storageIdOf(session) === wanted) return true;
  if (session && session._coopHistorySegments) return !!session._coopHistorySegments[wanted];
  return false;
}

function allowedStorageIds(session, canonicalStorageId) {
  var ids = {};
  if (canonicalStorageId) ids[canonicalStorageId] = true;
  if (session && session._coopHistorySegments) {
    var keys = Object.keys(session._coopHistorySegments);
    for (var i = 0; i < keys.length; i++) ids[keys[i]] = true;
  } else {
    var current = storageIdOf(session);
    if (current) ids[current] = true;
  }
  return ids;
}

module.exports = {
  absoluteIndexFor: absoluteIndexFor,
  allowedStorageIds: allowedStorageIds,
  buildReplaySession: buildReplaySession,
  currentHistoryOf: currentHistoryOf,
  lineageSessions: lineageSessions,
  locationForAbsoluteIndex: locationForAbsoluteIndex,
  recordAt: recordAt,
  segmentFor: segmentFor,
  sessionExtendsCanonical: sessionExtendsCanonical,
  sessionsByStorage: sessionsByStorage,
  storageIdOf: storageIdOf,
};
