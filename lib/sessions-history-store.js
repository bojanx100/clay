// Lazy backing store for session.history.
//
// The daemon used to hold every session's full transcript in memory for the
// lifetime of the process: loadSessions() parsed every .jsonl into an array and
// kept it. That made startup memory a function of total transcript volume rather
// than of what anyone is actually looking at, and at ~2.3GB of history it
// exhausted the 4GB V8 heap before the daemon finished booting.
//
// A session's history is installed here as an accessor instead. Boot reads a
// transcript once to derive the session's state, then releases it; the array is
// re-read from disk on the next access. All 270-odd `session.history` call sites
// keep working unchanged, which is why this is an accessor rather than an
// explicit load() the callers would have to remember.
//
// The backing fields are Symbols so they stay out of Object.keys/JSON.stringify —
// session objects are enumerated in several places and an extra own property
// would leak into broadcasts.

var HISTORY = Symbol("clayHistory");
var LOAD = Symbol("clayHistoryLoad");

// Set when a re-read failed (file moved or removed underneath us). Callers that
// persist history must not rewrite a transcript they could not read back, or the
// save would truncate the file to whatever the empty fallback produced.
var UNAVAILABLE = Symbol("clayHistoryUnavailable");

function defineLazyHistory(session, history, load) {
  session[HISTORY] = history || [];
  session[LOAD] = load;
  Object.defineProperty(session, "history", {
    configurable: true,
    enumerable: true,
    get: function () {
      if (session[HISTORY] === null) {
        var reloaded = load(session);
        if (reloaded === null) {
          // Do not cache the fallback: a transient read failure must not become
          // a permanently empty transcript.
          session[UNAVAILABLE] = true;
          return [];
        }
        session[UNAVAILABLE] = false;
        session[HISTORY] = reloaded;
      }
      return session[HISTORY];
    },
    set: function (value) {
      session[UNAVAILABLE] = false;
      session[HISTORY] = value;
    },
  });
}

function isLazy(session) {
  return !!(session && session[LOAD]);
}

// True when the array is in memory right now. Callers that scan many sessions
// use this to release only what their own scan paged in.
function isResident(session) {
  return isLazy(session) && session[HISTORY] !== null;
}

function isUnavailable(session) {
  return !!(session && session[UNAVAILABLE]);
}

// Returns true if the history was actually dropped. A session mid-turn keeps
// its array: sendAndRecord pushes into it and appends to the file separately, so
// dropping it under an in-flight turn could lose the items in that window.
function release(session) {
  if (!isResident(session) || session.isProcessing) return false;
  session[HISTORY] = null;
  return true;
}

module.exports = {
  defineLazyHistory: defineLazyHistory,
  isLazy: isLazy,
  isResident: isResident,
  isUnavailable: isUnavailable,
  release: release,
};
