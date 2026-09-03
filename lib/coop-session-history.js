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

// How long is this session's history WITHOUT paging the transcript in? A
// resident array answers directly; a lazy one answers from the persisted
// count. Returning null means "cannot tell", which callers must treat as a
// refusal to page rather than as zero -- a wrong length silently truncates
// the owner's transcript, which is worse than being slow.
function pageableLength(session, historyStore) {
  if (!session) return null;
  if (!historyStore.isLazy(session) || historyStore.isResident(session)) {
    return Array.isArray(session.history) ? session.history.length : null;
  }
  if (!Number.isInteger(session._persistedHistoryLength)) return null;
  if (typeof session._readPersistedHistoryRange !== "function") return null;
  return session._persistedHistoryLength;
}

function readRange(session, from, to, historyStore) {
  if (!historyStore.isLazy(session) || historyStore.isResident(session)) {
    var resident = Array.isArray(session.history) ? session.history : null;
    return resident ? resident.slice(from, to) : null;
  }
  var range = session._readPersistedHistoryRange(from, to);
  return Array.isArray(range) ? range : null;
}

// The stitched view concatenates the lineage oldest-first, so its TAIL lives in
// the NEWEST sessions. A default replay only ever renders that tail, which
// means the ancestors behind it never need to be read at all: walk the chain
// backwards, take only what is still missing from each, and stop as soon as the
// page is full.
//
// Returns null on any doubt (unreadable range, unknown length). Null means
// "fall back to the full stitched view" -- correct but slow -- so every failure
// mode degrades to today's behaviour instead of to a truncated transcript.
function pagedTail(session, sessions, wanted, historyStore) {
  if (!Number.isInteger(wanted) || wanted <= 0) return null;
  var chain = lineageFor(session, sessions);
  if (chain.length === 0 && session) chain = [session];
  if (chain.length === 0) return null;

  var lengths = [];
  var canonicalTotal = 0;
  for (var i = 0; i < chain.length; i++) {
    var length = pageableLength(chain[i], historyStore);
    if (length === null) return null;
    lengths.push(length);
    canonicalTotal += length;
  }

  var remaining = wanted;
  var pages = [];
  for (var j = chain.length - 1; j >= 0 && remaining > 0; j--) {
    var length2 = lengths[j];
    if (length2 <= 0) continue;
    var from = Math.max(0, length2 - remaining);
    var events = readRange(chain[j], from, length2, historyStore);
    if (!Array.isArray(events)) return null;
    pages.unshift(events);
    remaining -= (length2 - from);
  }

  var history = [];
  for (var p = 0; p < pages.length; p++) {
    for (var e = 0; e < pages[p].length; e++) history.push(pages[p][e]);
  }
  return {
    history: history,
    canonicalTotal: canonicalTotal,
    historyOffset: Math.max(0, canonicalTotal - history.length),
  };
}

module.exports = {
  forSession: forSession,
  pagedTail: pagedTail,
  historyIndexFor: historyIndexFor,
  indexesForTopic: indexesForTopic,
  storageId: storageId,
};
