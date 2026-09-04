// Hot paths must answer "how much history?" without paging the transcript in.
//
// Two sites did not, and both used sessions loaded by the real loader, so this
// test uses the real loader too rather than a stub that could fake laziness:
//
//   1. sync_external_session fires on every visibilitychange/focus/pageshow.
//      It compared syncTarget.history.length against a delivered count, which
//      on a released lazy session re-read and parsed the whole transcript.
//      Tabbing back to Clay cost a multi-megabyte read.
//
//   2. The mate activity timeline needs a title and a timestamp, never the
//      transcript -- but filtered on s.history.length, paging EVERY session in
//      the project. Measured on the real Lead workspace (263 sessions, 316MB):
//      769ms and 519MB of heap, leaving all 263 resident. That is the exact
//      heap blowup the lazy history store exists to prevent.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var historyStore = require("../lib/sessions-history-store");

function clearSessionModuleCache() {
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/tombstones")];
  delete require.cache[require.resolve("../lib/sessions")];
}

function writeSessionFile(sessionsDir, storageId, meta, history) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  var lines = [JSON.stringify(Object.assign({
    type: "meta",
    storageId: storageId,
    cliSessionId: storageId,
    createdAt: 1000,
    title: "Session " + storageId,
  }, meta || {}))];
  for (var i = 0; i < history.length; i++) lines.push(JSON.stringify(history[i]));
  fs.writeFileSync(path.join(sessionsDir, storageId + ".jsonl"), lines.join("\n") + "\n");
}

function settledHistory(n) {
  var history = [{ type: "user_message", text: "hello", _ts: 10 }];
  for (var i = 0; i < n; i++) history.push({ type: "delta", text: "chunk " + i, _ts: 11 + i });
  history.push({ type: "done", code: 0, _ts: 900 });
  return history;
}

function harness(seed) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-hot-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-hot-proj-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;
  clearSessionModuleCache();
  var utils = require("../lib/utils");
  var sessionsDir = path.join(tmpHome, "sessions", utils.encodeCwd(projectDir));
  if (seed) seed(sessionsDir);
  var sm = require("../lib/sessions").createSessionManager({
    cwd: projectDir,
    send: function () {},
  });
  return {
    sm: sm,
    cleanup: function () {
      if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
      else delete process.env.CLAY_HOME;
      clearSessionModuleCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

function residentCount(sm) {
  var count = 0;
  sm.sessions.forEach(function (s) { if (historyStore.isResident(s)) count++; });
  return count;
}

test("the focus/wake sync probe compares lengths without reading the transcript", function () {
  var h = harness(function (dir) {
    writeSessionFile(dir, "bbbbbbbb-0000-4000-8000-000000000001", null, settledHistory(30));
  });
  try {
    var session = null;
    h.sm.sessions.forEach(function (s) { session = s; });
    assert.ok(session, "the loader must produce a session");
    assert.equal(historyStore.isResident(session), false,
      "precondition: a freshly loaded session holds no transcript");

    var persisted = historyStore.historyLength(session);

    // The cheap answer must equal what actually paging the transcript in would
    // report -- not the pre-coalescing in-memory count. Deltas are merged on
    // the way to disk, so 1 user_message + 30 deltas + 1 done settles to
    // 1 + 1 + 1 records. Asserting against the real reload is what makes this
    // test catch a drift between the two, which is the whole point.
    var reloaded = session.history.length;
    assert.equal(persisted, reloaded,
      "the cheap length must match the length a full read reports");
    assert.equal(persisted, 3, "coalesced on disk: user_message + delta + done");
    historyStore.release(session);

    // What the probe now does.
    var behindWhenStale = historyStore.historyLength(session) > 1;
    var behindWhenCaughtUp = historyStore.historyLength(session) > persisted;

    assert.equal(behindWhenStale, true, "a socket behind the session must re-sync");
    assert.equal(behindWhenCaughtUp, false, "a caught-up socket must not re-sync");
    assert.equal(historyStore.isResident(session), false,
      "the probe must not page the transcript in -- this fires on every tab focus");
  } finally { h.cleanup(); }
});

test("the probe reaches the same verdict the expensive comparison did", function () {
  var h = harness(function (dir) {
    writeSessionFile(dir, "bbbbbbbb-0000-4000-8000-000000000002", null, settledHistory(12));
  });
  try {
    var session = null;
    h.sm.sessions.forEach(function (s) { session = s; });
    var cheap = historyStore.historyLength(session);
    var expensive = session.history.length;
    assert.equal(cheap, expensive,
      "the cheap comparison must not change which sockets are considered behind");
  } finally { h.cleanup(); }
});

test("scanning every session for a timeline leaves them all on disk", function () {
  var h = harness(function (dir) {
    for (var i = 1; i <= 6; i++) {
      var id = "cccccccc-0000-4000-8000-00000000000" + i;
      writeSessionFile(dir, id, { createdAt: 1000 + i }, settledHistory(20));
    }
    // A session with no history at all: it must be excluded, and excluded for
    // the same reason as before (genuinely empty), not because paging failed.
    writeSessionFile(dir, "cccccccc-0000-4000-8000-000000000009", { createdAt: 2000 }, []);
  });
  try {
    assert.equal(residentCount(h.sm), 0, "precondition: nothing resident after load");

    var entries = [];
    h.sm.sessions.forEach(function (s) {
      if (s.hidden || historyStore.historyLength(s) === 0) return;
      entries.push({ title: s.title, ts: s.lastActivity || s.createdAt || 0 });
    });

    assert.equal(entries.length, 6, "the empty session is excluded, the rest are listed");
    assert.equal(residentCount(h.sm), 0,
      "building a list of titles must not page any transcript into memory");
  } finally { h.cleanup(); }
});

test("the cheap timeline filter selects exactly what the expensive one did", function () {
  var h = harness(function (dir) {
    writeSessionFile(dir, "dddddddd-0000-4000-8000-000000000001", null, settledHistory(4));
    writeSessionFile(dir, "dddddddd-0000-4000-8000-000000000002", { createdAt: 1200 }, []);
    writeSessionFile(dir, "dddddddd-0000-4000-8000-000000000003", { createdAt: 1300 }, settledHistory(1));
  });
  try {
    var cheap = [];
    var expensive = [];
    h.sm.sessions.forEach(function (s) {
      if (!(s.hidden || historyStore.historyLength(s) === 0)) cheap.push(s.storageId);
    });
    h.sm.sessions.forEach(function (s) {
      if (!(s.hidden || !s.history || s.history.length === 0)) expensive.push(s.storageId);
    });
    cheap.sort();
    expensive.sort();
    assert.deepEqual(cheap, expensive,
      "paging must change the cost, never which sessions appear in the timeline");
  } finally { h.cleanup(); }
});
