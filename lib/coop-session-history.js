// Read-only display history across Coop compaction continuations.
//
// Compaction deliberately starts a fresh provider session, but the owner still
// owns one conversation. Keep provider session history untouched and build a
// transient ordered view for replay, pagination, and reference-only lenses.

var sessionLineage = require("./coop-session-lineage");

function storageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}

function predecessorOf(session, sessionsByStorage) {
  var predecessorId = session && session.compactedFromStorageId || "";
  if (!predecessorId) return null;
  return sessionsByStorage && sessionsByStorage[predecessorId] || null;
}

function lineageFor(session, sessions) {
  var sessionsByStorage = sessionLineage.indexSessions(sessions);
  var newestFirst = [];
  var current = session || null;
  var seen = {};
  while (current) {
    var currentStorageId = storageId(current);
    if (currentStorageId && seen[currentStorageId]) break;
    if (currentStorageId) seen[currentStorageId] = true;
    newestFirst.push(current);
    current = predecessorOf(current, sessionsByStorage);
  }
  newestFirst.reverse();
  return newestFirst;
}

function forSession(session, sessions) {
  var chain = lineageFor(session, sessions);
  if (chain.length === 0 && session) chain = [session];
  var history = [];
  var entries = [];
  for (var si = 0; si < chain.length; si++) {
    var source = chain[si];
    var sourceStorageId = storageId(source);
    var sourceHistory = Array.isArray(source.history) ? source.history : [];
    for (var hi = 0; hi < sourceHistory.length; hi++) {
      history.push(sourceHistory[hi]);
      entries.push({
        historyIndex: history.length - 1,
        sessionStorageId: sourceStorageId,
        eventIndex: hi,
      });
    }
  }
  return {
    history: history,
    entries: entries,
    sessions: chain,
    hasLineage: chain.length > 1,
  };
}

function historyIndexFor(view, sessionStorageId, eventIndex) {
  var entries = view && Array.isArray(view.entries) ? view.entries : [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.sessionStorageId === sessionStorageId && entry.eventIndex === eventIndex) {
      return entry.historyIndex;
    }
  }
  return null;
}

function indexesForTopic(view, topic) {
  var entries = view && Array.isArray(view.entries) ? view.entries : [];
  var values = [];
  var seen = {};
  function add(index) {
    if (!Number.isInteger(index) || index < 0 || seen[index]) return;
    seen[index] = true;
    values.push(index);
  }
  var turns = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  for (var ti = 0; ti < turns.length; ti++) {
    var turn = turns[ti] || {};
    if (!turn.sessionStorageId || !Number.isInteger(turn.startEventIndex) ||
        !Number.isInteger(turn.endEventIndex)) continue;
    for (var ei = 0; ei < entries.length; ei++) {
      var turnEntry = entries[ei];
      if (turnEntry.sessionStorageId === turn.sessionStorageId &&
          turnEntry.eventIndex >= turn.startEventIndex &&
          turnEntry.eventIndex <= turn.endEventIndex) add(turnEntry.historyIndex);
    }
  }
  var refs = Array.isArray(topic && topic.eventRefs) ? topic.eventRefs : [];
  for (var ri = 0; ri < refs.length; ri++) {
    var ref = refs[ri] || {};
    add(historyIndexFor(view, ref.sessionStorageId, ref.eventIndex));
  }
  values.sort(function (a, b) { return a - b; });
  return values;
}

module.exports = {
  forSession: forSession,
  historyIndexFor: historyIndexFor,
  indexesForTopic: indexesForTopic,
  storageId: storageId,
};
