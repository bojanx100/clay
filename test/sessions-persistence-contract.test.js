// saveSessionFile's return value is a data-loss signal: truthy means the turn
// is written or durably queued, false means it is gone. These tests pin that
// contract, the [SAVE-FAIL] diag marker that makes failures visible, and the
// shutdown flush that completes coalesced saves an unref'd timer would drop.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var sessionPersistence = require("../lib/sessions-persistence");
var config = require("../lib/config");

function makeSession(overrides) {
  return Object.assign({
    localId: 1,
    storageId: "contract-session",
    title: "Contract session",
    createdAt: 1000,
    history: [],
  }, overrides || {});
}

function attach(sessionPath) {
  return sessionPersistence.attachSessionPersistence({
    getSessionStorageId: function (session) { return session.storageId; },
    sessionFilePath: function () { return sessionPath; },
  });
}

function makeHeavy(session) {
  // Mimic a session whose previous save was heavy and recent, which is the
  // exact state that makes the next non-durable save coalesce.
  session._lastSaveDurMs = 50;
  session._lastSaveBytes = 600 * 1024;
  session._lastSaveAt = Date.now();
  return session;
}

function withTmpDir(fn) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-persist-contract-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Captures diag output in-process. It must never reach the real ~/.clay diag
// log, so the stub replaces config.diagLog for the duration of the callback.
function captureDiag(fn) {
  var lines = [];
  var originalDiagLog = config.diagLog;
  var originalError = console.error;
  config.diagLog = function (line) { lines.push(line); };
  console.error = function () {};
  try {
    fn(lines);
  } finally {
    config.diagLog = originalDiagLog;
    console.error = originalError;
  }
  return lines;
}

test("saveSessionFile returns truthy for a written save and for a coalesced save", function () {
  withTmpDir(function (dir) {
    var sessionPath = path.join(dir, "written.jsonl");
    var persistence = attach(sessionPath);
    var session = makeSession({});

    assert.strictEqual(persistence.saveSessionFile(session), true,
      "an inline write returns true");

    makeHeavy(session);
    var queued = persistence.saveSessionFile(session);
    assert.ok(queued, "a coalesced save is durably queued, so it must be truthy");
    assert.strictEqual(queued, sessionPersistence.SAVE_QUEUED);
    assert.ok(session._saveCoalesceTimer, "the coalesced save is owned by a timer");

    // A second burst call joins the same timer and is still queued, not lost.
    assert.ok(persistence.saveSessionFile(session), "a repeat burst save stays truthy");

    clearTimeout(session._saveCoalesceTimer);
    session._saveCoalesceTimer = null;
  });
});

test("saveSessionFile returns false only when the save will not happen", function () {
  withTmpDir(function (dir) {
    // Skip cases: no live session, deleted session, no storage id.
    var persistence = attach(path.join(dir, "skip.jsonl"));
    assert.strictEqual(persistence.saveSessionFile(null), false, "no session");
    assert.strictEqual(persistence.saveSessionFile(makeSession({ _deleted: true })), false,
      "deleted session");
    assert.strictEqual(persistence.saveSessionFile(makeSession({ storageId: null })), false,
      "no storage id yet");

    // Genuine write failure: the target directory does not exist, so the
    // temp-file open throws exactly like a full or read-only disk.
    var failing = attach(path.join(dir, "missing-dir", "boom.jsonl"));
    captureDiag(function () {
      assert.strictEqual(failing.saveSessionFile(makeSession({})), false,
        "a failed write must report false");
    });
  });
});

test("a failed session write emits exactly one [SAVE-FAIL] diag line", function () {
  withTmpDir(function (dir) {
    var persistence = attach(path.join(dir, "missing-dir", "fail.jsonl"));
    var session = makeSession({ localId: 7, history: [{ type: "delta", text: "work" }] });

    var lines = captureDiag(function () {
      assert.strictEqual(persistence.saveSessionFile(session), false);
    });

    assert.strictEqual(lines.length, 1, "exactly one diag line per failed save");
    var line = lines[0];
    assert.ok(line.indexOf("[SAVE-FAIL] ") === 0, "marker leads the line: " + line);
    assert.ok(/^\[SAVE-FAIL\] \d{4}-\d{2}-\d{2}T[\d:.]+Z saveSessionFile /.test(line),
      "matches the [SAVE-SLOW] shape (marker, ISO timestamp, function): " + line);
    assert.ok(line.indexOf(" localId=7") !== -1, "names the session: " + line);
    assert.ok(line.indexOf(" items=1") !== -1, "reports the item count: " + line);
    assert.ok(/ bytes=\d+/.test(line), "reports a byte size: " + line);
    assert.ok(/ err=.+/.test(line), "reports the underlying error: " + line);
  });
});

test("a failed history append emits a [SAVE-FAIL] diag line", function () {
  withTmpDir(function (dir) {
    var persistence = attach(path.join(dir, "missing-dir", "append.jsonl"));
    var session = makeSession({ localId: 9 });

    var lines = captureDiag(function () {
      persistence.appendToSessionFile(session, { type: "delta", text: "lost turn" });
    });

    assert.strictEqual(lines.length, 1);
    assert.ok(/^\[SAVE-FAIL\] \d{4}-\d{2}-\d{2}T[\d:.]+Z appendToSessionFile localId=9 /
      .test(lines[0]), lines[0]);
  });
});

test("a successful save writes no [SAVE-FAIL] line", function () {
  withTmpDir(function (dir) {
    var persistence = attach(path.join(dir, "ok.jsonl"));
    var lines = captureDiag(function () {
      assert.strictEqual(persistence.saveSessionFile(makeSession({})), true);
    });
    assert.deepStrictEqual(lines, []);
  });
});

test("flushPendingCoalescedSaves writes pending saves, clears timers and counts them", function () {
  withTmpDir(function (dir) {
    var pathA = path.join(dir, "a.jsonl");
    var pathB = path.join(dir, "b.jsonl");
    var persistenceA = attach(pathA);
    var persistenceB = attach(pathB);
    var a = makeSession({ localId: 1, storageId: "a", title: "A first" });
    var b = makeSession({ localId: 2, storageId: "b", title: "B first" });

    assert.strictEqual(persistenceA.saveSessionFile(a), true);
    assert.strictEqual(persistenceB.saveSessionFile(b), true);

    makeHeavy(a);
    makeHeavy(b);
    a.title = "A final";
    b.title = "B final";
    assert.ok(persistenceA.saveSessionFile(a));
    assert.ok(persistenceB.saveSessionFile(b));
    assert.ok(a._saveCoalesceTimer && b._saveCoalesceTimer);
    assert.strictEqual(readMeta(pathA).title, "A first",
      "the coalesced title is not on disk yet");

    var sm = { sessions: new Map([[1, a], [2, b]]) };
    var flushed = sessionPersistence.flushPendingCoalescedSaves(sm);

    assert.strictEqual(flushed, 2, "both pending saves are counted");
    assert.strictEqual(readMeta(pathA).title, "A final", "pending save reached disk");
    assert.strictEqual(readMeta(pathB).title, "B final", "pending save reached disk");
    assert.strictEqual(a._saveCoalesceTimer, null, "timer cleared");
    assert.strictEqual(b._saveCoalesceTimer, null, "timer cleared");
    assert.strictEqual(sessionPersistence.flushPendingCoalescedSaves(sm), 0,
      "a second flush has nothing left to do");
  });
});

test("flushPendingCoalescedSaves skips deleted sessions but still clears their timers", function () {
  withTmpDir(function (dir) {
    var sessionPath = path.join(dir, "deleted.jsonl");
    var persistence = attach(sessionPath);
    var session = makeSession({ storageId: "deleted", title: "Before delete" });

    assert.strictEqual(persistence.saveSessionFile(session), true);
    makeHeavy(session);
    session.title = "Must not be resurrected";
    assert.ok(persistence.saveSessionFile(session));
    assert.ok(session._saveCoalesceTimer);

    // deleteSession removes the file and marks the session; the pending timer
    // must not write it back on shutdown.
    session._deleted = true;
    fs.rmSync(sessionPath);

    var flushed = sessionPersistence.flushPendingCoalescedSaves([session]);

    assert.strictEqual(flushed, 0, "a deleted session is not flushed");
    assert.strictEqual(fs.existsSync(sessionPath), false, "the deleted file stays deleted");
    assert.strictEqual(session._saveCoalesceTimer, null, "its timer is still cleared");
  });
});

test("flushPendingCoalescedSaves tolerates empty and session-free inputs", function () {
  assert.strictEqual(sessionPersistence.flushPendingCoalescedSaves(null), 0);
  assert.strictEqual(sessionPersistence.flushPendingCoalescedSaves([]), 0);
  assert.strictEqual(sessionPersistence.flushPendingCoalescedSaves({ sessions: new Map() }), 0);
  assert.strictEqual(sessionPersistence.flushPendingCoalescedSaves([{ localId: 1 }]), 0);
});

function readMeta(sessionPath) {
  return JSON.parse(fs.readFileSync(sessionPath, "utf8").split("\n")[0]);
}

// Deltas are coalesced into one line on the way to disk, deliberately, so that
// indices held by connected clients stay valid against session.history. That
// makes the in-memory history length a WRONG answer to "how many records are in
// the file", and the range reader indexes backward from EOF using exactly that
// number. When the two disagreed it computed a negative start, refused the read,
// and the paged replay silently fell back to reading the whole transcript --
// for every session saved during the process run.
test("a save records how many records reached the file, not how many are in memory", function () {
  withTmpDir(function (dir) {
    var sessionPath = path.join(dir, "coalesce.jsonl");
    var persistence = attach(sessionPath);
    var history = [{ type: "user_message", text: "hi" }];
    for (var i = 0; i < 12; i++) history.push({ type: "delta", text: "chunk" + i });
    history.push({ type: "done" });

    var session = makeSession({ history: history });
    assert.ok(persistence.saveSessionFile(session, { durable: true }),
      "the save must report success");

    var lines = fs.readFileSync(sessionPath, "utf8").split("\n")
      .filter(function (l) { return l.trim() !== ""; });
    var records = lines.length - 1; // the meta header is line 1

    assert.equal(session._persistedHistoryLength, history.length,
      "the in-memory count is kept, because the rewrite check compares against it");
    assert.equal(session._persistedDiskRecords, records,
      "the disk count must match the records actually written");
    assert.ok(session._persistedDiskRecords < session._persistedHistoryLength,
      "precondition: this history really did coalesce, or the test proves nothing");
  });
});

// The regression this guards: a truthful count only helps if the backward index
// math the range reader performs now lands inside the file. It computes
// start = lines - (total - from); with an overcounted total that went negative
// and the read was refused, which is what disabled paging.
test("a coalesced session's backward range math lands inside the file", function () {
  withTmpDir(function (dir) {
    var sessionPath = path.join(dir, "range.jsonl");
    var persistence = attach(sessionPath);
    var history = [{ type: "user_message", text: "hi" }];
    for (var i = 0; i < 12; i++) history.push({ type: "delta", text: "chunk" + i });
    history.push({ type: "done" });

    var session = makeSession({ storageId: "range-session", history: history });
    persistence.saveSessionFile(session, { durable: true });

    var records = fs.readFileSync(sessionPath, "utf8").split("\n")
      .filter(function (l) { return l.trim() !== ""; }).length - 1;

    var total = session._persistedDiskRecords;
    var from = 0;
    var startWithDiskCount = records - (total - from);
    assert.ok(startWithDiskCount >= 0,
      "the recorded disk count must index inside the file");

    var startWithMemoryCount = records - (session._persistedHistoryLength - from);
    assert.ok(startWithMemoryCount < 0,
      "precondition: the in-memory count really would have gone negative here");
  });
});
