var test = require("node:test");
var assert = require("node:assert/strict");
var historyStore = require("../lib/sessions-history-store");

// `session.history.length` looks free and is not. On a released lazy session
// the accessor re-reads and parses the entire .jsonl. Asking it for a boolean
// on the session-switch path cost 200ms and 116MB of heap on a real 75.2MB
// transcript -- and left the session resident, so the paged replay that runs
// immediately afterwards found the whole history already in memory. The paging
// work was being defeated one line before it ran.

function lazySession(recordCount, counters, key) {
  var history = [];
  for (var i = 0; i < recordCount; i++) history.push({ type: "user_message", text: key + ":" + i });
  var session = { storageId: key, _persistedHistoryLength: recordCount };
  counters[key] = 0;
  historyStore.defineLazyHistory(session, history, function () {
    counters[key] += 1;
    return history;
  });
  historyStore.release(session);
  return session;
}

test("history length is answered without paging the transcript in", function () {
  var counters = {};
  var session = lazySession(500, counters, "s1");

  assert.equal(historyStore.historyLength(session), 500);
  assert.equal(counters.s1, 0, "the transcript must not be read to answer a length");
  assert.equal(historyStore.isResident(session), false,
    "answering must not leave the whole history resident in memory");
});

test("the cheap answer matches the expensive one", function () {
  var counters = {};
  var session = lazySession(37, counters, "s2");
  var cheap = historyStore.historyLength(session);
  var expensive = session.history.length;
  assert.equal(cheap, expensive,
    "paging in the transcript must not change the answer, only the cost");
  assert.equal(counters.s2, 1, "the expensive path is the one that reads");
});

test("an empty session is reported as empty, not as unknown", function () {
  var counters = {};
  var session = lazySession(0, counters, "s3");
  assert.equal(historyStore.historyLength(session), 0);
  assert.equal(counters.s3, 0);
});

test("a resident session is measured from memory", function () {
  var counters = {};
  var session = lazySession(12, counters, "s4");
  assert.equal(session.history.length, 12, "force it resident");
  assert.equal(historyStore.isResident(session), true);
  counters.s4 = 0;
  assert.equal(historyStore.historyLength(session), 12);
  assert.equal(counters.s4, 0, "a resident array is measured, not re-read");
});

// Without a persisted length there is nothing cheap to trust, so falling back
// to the real array is correct: a wrong length would tell the client a session
// has no history and suppress its transcript entirely.
test("with no persisted length it falls back rather than guessing zero", function () {
  var counters = {};
  var session = lazySession(9, counters, "s5");
  delete session._persistedHistoryLength;
  assert.equal(historyStore.historyLength(session), 9,
    "an unknown persisted length must not be reported as an empty session");
});

test("a plain non-lazy session still works", function () {
  assert.equal(historyStore.historyLength({ history: [1, 2, 3] }), 3);
  assert.equal(historyStore.historyLength({ history: [] }), 0);
  assert.equal(historyStore.historyLength({}), 0);
  assert.equal(historyStore.historyLength(null), 0);
});
