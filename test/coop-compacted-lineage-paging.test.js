var test = require("node:test");
var assert = require("node:assert/strict");
var coopHistory = require("../lib/coop-session-history");
var historyStore = require("../lib/sessions-history-store");

// Opening a compacted Coop session used to materialise its ENTIRE lineage just
// to render the last page. Measured on a real 3-deep chain in ~/.clay/sessions:
// 139,161 events read from disk to display 120. The stitched view concatenates
// the lineage oldest-first, so that tail lives in the newest sessions and the
// ancestors behind it never needed to be read at all.

function event(label) {
  return { type: "user_message", text: label };
}

// A session shaped like the loader's: lazy history, released, with the
// persisted length and range reader the paging path depends on. Counts every
// event actually read so a test can assert on I/O, not just on output.
function makeSession(storageId, count, compactedFrom, counters) {
  var history = [];
  for (var i = 0; i < count; i++) history.push(event(storageId + ":" + i));
  var session = {
    storageId: storageId,
    compactedFromStorageId: compactedFrom || null,
    _persistedHistoryLength: history.length,
  };
  counters[storageId] = 0;
  Object.defineProperty(session, "_readPersistedHistoryRange", {
    configurable: true,
    enumerable: false,
    value: function (from, to) {
      counters[storageId] += (to - from);
      return history.slice(from, to);
    },
  });
  historyStore.defineLazyHistory(session, history, function () {
    counters[storageId] += history.length;
    return history;
  });
  historyStore.release(session);
  return session;
}

function totalRead(counters) {
  return Object.keys(counters).reduce(function (sum, k) { return sum + counters[k]; }, 0);
}

test("a compacted session pages its tail without reading its ancestors", function () {
  var counters = {};
  var oldest = makeSession("s1", 500, null, counters);
  var middle = makeSession("s2", 500, "s1", counters);
  var newest = makeSession("s3", 500, "s2", counters);
  var sessions = [oldest, middle, newest];

  var tail = coopHistory.pagedTail(newest, sessions, 120, historyStore);
  assert.ok(tail, "a fully pageable chain must not be refused");
  assert.equal(tail.history.length, 120);
  assert.equal(tail.canonicalTotal, 1500, "the total still describes the whole lineage");
  assert.equal(tail.historyOffset, 1380);
  assert.equal(counters.s1, 0, "the oldest ancestor is never touched");
  assert.equal(counters.s2, 0, "the middle ancestor is never touched");
  assert.equal(totalRead(counters), 120,
    "exactly one page is read, not 1500 events");
});

test("the paged tail is byte-identical to the tail of the full stitched view", function () {
  var counters = {};
  var oldest = makeSession("s1", 40, null, counters);
  var newest = makeSession("s2", 40, "s1", counters);
  var sessions = [oldest, newest];

  var tail = coopHistory.pagedTail(newest, sessions, 30, historyStore);
  var full = coopHistory.forSession(newest, sessions);
  var expected = full.history.slice(full.history.length - tail.history.length);
  assert.deepEqual(tail.history, expected,
    "paging must change what is read, never what is shown");
  assert.equal(tail.canonicalTotal, full.history.length);
  assert.equal(tail.historyOffset + tail.history.length, tail.canonicalTotal,
    "offset and length must address the same transcript the client indexes into");
});

// The interesting case: the newest session is SHORTER than a page, so the page
// can only be filled by reaching back. Getting this wrong shows the owner a
// truncated conversation at exactly the moment compaction just happened.
test("a page larger than the newest session is completed from its ancestor", function () {
  var counters = {};
  var oldest = makeSession("s1", 100, null, counters);
  var newest = makeSession("s2", 10, "s1", counters);
  var sessions = [oldest, newest];

  var tail = coopHistory.pagedTail(newest, sessions, 30, historyStore);
  assert.equal(tail.history.length, 30, "the page is filled across the compaction boundary");
  assert.equal(tail.history[0].text, "s1:80", "it reaches exactly 20 events back into the ancestor");
  assert.equal(tail.history[29].text, "s2:9", "and ends at the newest event");
  assert.equal(counters.s1, 20, "only the needed slice of the ancestor is read, not all 100");
  assert.equal(tail.canonicalTotal, 110);
});

test("a page larger than the whole lineage yields the whole lineage, not a short read", function () {
  var counters = {};
  var oldest = makeSession("s1", 5, null, counters);
  var newest = makeSession("s2", 5, "s1", counters);
  var tail = coopHistory.pagedTail(newest, [oldest, newest], 500, historyStore);
  assert.equal(tail.history.length, 10);
  assert.equal(tail.historyOffset, 0, "nothing is hidden when everything fits");
  assert.equal(tail.canonicalTotal, 10);
});

test("an empty ancestor is skipped without stalling the walk", function () {
  var counters = {};
  var oldest = makeSession("s1", 25, null, counters);
  var empty = makeSession("s2", 0, "s1", counters);
  var newest = makeSession("s3", 5, "s2", counters);
  var tail = coopHistory.pagedTail(newest, [oldest, empty, newest], 20, historyStore);
  assert.equal(tail.history.length, 20);
  assert.equal(tail.history[19].text, "s3:4");
  assert.equal(tail.canonicalTotal, 30);
});

// Every uncertain case must fall back to the full stitched view. Returning a
// short read instead would silently truncate the owner's transcript, which is
// far worse than being slow.
test("anything it cannot page for certain is refused rather than guessed", function () {
  var counters = {};
  var oldest = makeSession("s1", 50, null, counters);
  var newest = makeSession("s2", 50, "s1", counters);

  var unknownLength = makeSession("s3", 50, "s1", counters);
  delete unknownLength._persistedHistoryLength;
  assert.equal(coopHistory.pagedTail(unknownLength, [oldest, unknownLength], 20, historyStore), null,
    "an unknown persisted length cannot be paged");

  var unreadable = makeSession("s4", 50, "s1", counters);
  Object.defineProperty(unreadable, "_readPersistedHistoryRange", {
    configurable: true, value: function () { return null; },
  });
  assert.equal(coopHistory.pagedTail(unreadable, [oldest, unreadable], 20, historyStore), null,
    "a failed range read must fall back, not return a partial page");

  assert.equal(coopHistory.pagedTail(newest, [oldest, newest], 0, historyStore), null);
  assert.equal(coopHistory.pagedTail(newest, [oldest, newest], -1, historyStore), null);
  assert.equal(coopHistory.pagedTail(null, [], 20, historyStore), null);
});

test("an ancestor missing from the index is not silently counted as empty", function () {
  var counters = {};
  // s1 is referenced by compactedFromStorageId but absent from the session list.
  var newest = makeSession("s2", 30, "s1", counters);
  var tail = coopHistory.pagedTail(newest, [newest], 10, historyStore);
  assert.ok(tail, "an unresolvable ancestor is simply not part of the chain");
  assert.equal(tail.canonicalTotal, 30,
    "the total reflects the chain that could actually be resolved");
  assert.equal(tail.history.length, 10);
});

test("a resident (already loaded) session pages from memory without re-reading disk", function () {
  var counters = {};
  var oldest = makeSession("s1", 50, null, counters);
  var newest = makeSession("s2", 50, "s1", counters);
  assert.equal(newest.history.length, 50, "force it resident");
  counters.s2 = 0;
  var tail = coopHistory.pagedTail(newest, [oldest, newest], 20, historyStore);
  assert.equal(tail.history.length, 20);
  assert.equal(counters.s2, 0, "a resident array is sliced, not re-read");
  assert.equal(tail.history[19].text, "s2:49");
});
