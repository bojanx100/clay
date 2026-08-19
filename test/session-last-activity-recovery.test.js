var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var HOUR = 60 * 60 * 1000;
var DAY = 24 * HOUR;

function clearSessionModuleCache() {
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/tombstones")];
  delete require.cache[require.resolve("../lib/sessions")];
}

// Writes raw session files, then boots a real session manager over them so the
// assertions run against the actual loader/persistence pair rather than a stub.
function loaderHarness(sessionFiles) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-activity-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-activity-project-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;
  clearSessionModuleCache();

  var utils = require("../lib/utils");
  var sessionsDir = path.join(tmpHome, "sessions", utils.encodeCwd(projectDir));
  fs.mkdirSync(sessionsDir, { recursive: true });

  Object.keys(sessionFiles).forEach(function (storageId) {
    var spec = sessionFiles[storageId];
    var lines = [JSON.stringify(spec.meta)].concat(
      (spec.history || []).map(function (item) { return JSON.stringify(item); }));
    var filePath = path.join(sessionsDir, storageId + ".jsonl");
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    // The whole bug is that this mtime is a scan artifact rather than a real
    // close time, so the fixture has to control it explicitly.
    if (typeof spec.mtime === "number") {
      fs.utimesSync(filePath, new Date(spec.mtime), new Date(spec.mtime));
    }
  });

  function boot() {
    clearSessionModuleCache();
    return require("../lib/sessions").createSessionManager({
      cwd: projectDir,
      send: function () {},
    });
  }

  function metaOnDisk(storageId) {
    var raw = fs.readFileSync(path.join(sessionsDir, storageId + ".jsonl"), "utf8");
    return JSON.parse(raw.split("\n")[0]);
  }

  function sessionFor(sm, storageId) {
    var found = null;
    sm.sessions.forEach(function (s) {
      if (!found && (s.storageId === storageId || s.cliSessionId === storageId)) found = s;
    });
    return found;
  }

  return {
    sessionsDir: sessionsDir,
    boot: boot,
    metaOnDisk: metaOnDisk,
    sessionFor: sessionFor,
    cleanup: function () {
      if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
      else delete process.env.CLAY_HOME;
      clearSessionModuleCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

function meta(extra) {
  return Object.assign({
    type: "meta",
    title: "Legacy conversation",
    createdAt: Date.parse("2026-06-01T09:00:00Z"),
  }, extra);
}

function transcript(lastTs) {
  return [
    { type: "user_message", text: "hello", _ts: lastTs - 2000 },
    { type: "delta", text: "hi", _ts: lastTs - 1000 },
    { type: "done", code: 0, _ts: lastTs },
  ];
}

test("a legacy session with no persisted lastActivity recovers it from its transcript", function () {
  var realEnd = Date.parse("2026-06-19T01:34:00Z");
  var scanArtifact = Date.parse("2026-08-19T10:14:46Z");
  var h = loaderHarness({
    "legacy-no-activity": {
      meta: meta({ storageId: "legacy-no-activity", hidden: true }),
      history: transcript(realEnd),
      mtime: scanArtifact,
    },
  });
  try {
    var sm = h.boot();
    var session = h.sessionFor(sm, "legacy-no-activity");
    assert.strictEqual(session.lastActivity, realEnd,
      "the transcript's own last timestamp is the real end of the conversation");
    assert.notStrictEqual(session.lastActivity, scanArtifact,
      "a bulk-save mtime must never stand in for a close time");

    // Persisted on this boot, so the recovery happens once rather than being
    // re-derived (and re-displayed differently) on every restart.
    assert.strictEqual(h.metaOnDisk("legacy-no-activity").lastActivity, realEnd);
    var again = h.boot();
    assert.strictEqual(h.sessionFor(again, "legacy-no-activity").lastActivity, realEnd,
      "the recovered value survives the next restart");
  } finally {
    h.cleanup();
  }
});

test("a laundered lastActivity on a closed session is corrected from its transcript", function () {
  var realEnd = Date.parse("2026-06-19T01:34:00Z");
  // The 2026-08-09 fix persisted lastActivity, but its bulk save wrote whatever
  // the mtime fallback had already fabricated -- so the wrong value now looks
  // authoritative and only the transcript disproves it.
  var laundered = Date.parse("2026-08-09T11:03:00Z");
  var h = loaderHarness({
    "laundered": {
      meta: meta({ storageId: "laundered", hidden: true, lastActivity: laundered }),
      history: transcript(realEnd),
    },
  });
  try {
    var sm = h.boot();
    assert.strictEqual(h.sessionFor(sm, "laundered").lastActivity, realEnd,
      "a closed session cannot have been active 51 days after its transcript ended");
    assert.strictEqual(h.metaOnDisk("laundered").lastActivity, realEnd,
      "the correction must be persisted, not recomputed every boot");
  } finally {
    h.cleanup();
  }
});

test("plausible and live-session timestamps are left alone", function () {
  var realEnd = Date.parse("2026-07-01T12:00:00Z");
  var h = loaderHarness({
    // Measured on real data: legitimate gaps sit under an hour, where the final
    // entries simply carried no _ts. Nothing legitimate reached 6h.
    "small-gap": {
      meta: meta({ storageId: "small-gap", hidden: true, lastActivity: realEnd + 30 * 60 * 1000 }),
      history: transcript(realEnd),
    },
    // A live session can legitimately be active now with no history entry yet,
    // so the correction is restricted to closed sessions.
    "live-wide-gap": {
      meta: meta({ storageId: "live-wide-gap", lastActivity: realEnd + 40 * DAY }),
      history: transcript(realEnd),
    },
  });
  try {
    var sm = h.boot();
    assert.strictEqual(h.sessionFor(sm, "small-gap").lastActivity, realEnd + 30 * 60 * 1000,
      "a sub-hour gap is ordinary and must not be rewritten");
    assert.strictEqual(h.sessionFor(sm, "live-wide-gap").lastActivity, realEnd + 40 * DAY,
      "an open session's timestamp is never second-guessed");
  } finally {
    h.cleanup();
  }
});

test("a transcript with no timestamps keeps its guess out of authoritative storage", function () {
  var scanArtifact = Date.parse("2026-08-19T10:14:46Z");
  var h = loaderHarness({
    "no-timestamps": {
      meta: meta({ storageId: "no-timestamps", hidden: true }),
      history: [{ type: "user_message", text: "no timestamps here" }],
      mtime: scanArtifact,
    },
  });
  try {
    var sm = h.boot();
    var session = h.sessionFor(sm, "no-timestamps");
    assert.strictEqual(session.lastActivity, scanArtifact,
      "with nothing better available the mtime is still the best guess");
    assert.strictEqual(session._lastActivityDerived, true, "but it is flagged as a guess");
    // Persisting it would launder the guess into permanent truth -- exactly how
    // the 75 already-corrupted sessions got that way.
    assert.strictEqual(h.metaOnDisk("no-timestamps").lastActivity, undefined,
      "a guessed timestamp must never be written as authoritative");
  } finally {
    h.cleanup();
  }
});

test("real activity makes a previously guessed timestamp authoritative again", function () {
  var scanArtifact = Date.parse("2026-08-19T10:14:46Z");
  var h = loaderHarness({
    "guessed-then-used": {
      meta: meta({ storageId: "guessed-then-used", hidden: true }),
      history: [{ type: "user_message", text: "no timestamps here" }],
      mtime: scanArtifact,
    },
  });
  try {
    var sm = h.boot();
    var session = h.sessionFor(sm, "guessed-then-used");
    assert.strictEqual(session._lastActivityDerived, true);

    sm.appendToSessionFile(session, { type: "user_message", text: "back in use" });

    assert.strictEqual(session._lastActivityDerived, undefined,
      "a real append supersedes the guess");
    assert.ok(session.lastActivity > scanArtifact);

    // appendToSessionFile only appends a history line; the meta line is rewritten
    // by the next full save, which is where the flag decides what gets written.
    sm.saveSessionFile(session);
    assert.strictEqual(h.metaOnDisk("guessed-then-used").lastActivity, session.lastActivity,
      "and the now-authoritative value is persisted");
  } finally {
    h.cleanup();
  }
});
