// Proves session transcripts are not held in memory for the lifetime of the
// daemon. loadSessions() used to parse every .jsonl into an array and keep it, so
// startup memory scaled with total history volume rather than with what anyone
// was looking at -- at ~2.3GB of transcripts it exhausted the 4GB V8 heap before
// the daemon finished booting.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var historyStore = require("../lib/sessions-history-store");

function clearSessionModuleCache() {
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/tombstones")];
  delete require.cache[require.resolve("../lib/sessions")];
}

// Writes a session .jsonl the way saveSessionFile does: meta line then history.
function writeSessionFile(sessionsDir, storageId, meta, history) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  var lines = [JSON.stringify(Object.assign({
    type: "meta",
    storageId: storageId,
    cliSessionId: storageId,
    createdAt: 1000,
    title: "Restored " + storageId,
  }, meta || {}))];
  for (var i = 0; i < history.length; i++) lines.push(JSON.stringify(history[i]));
  fs.writeFileSync(path.join(sessionsDir, storageId + ".jsonl"), lines.join("\n") + "\n");
}

function harness(seed) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lazy-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lazy-proj-"));
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
    sessionsDir: sessionsDir,
    projectDir: projectDir,
    cleanup: function () {
      if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
      else delete process.env.CLAY_HOME;
      clearSessionModuleCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

function sessionByStorageId(sm, storageId) {
  var found = null;
  sm.sessions.forEach(function (s) {
    if (s.storageId === storageId) found = s;
  });
  return found;
}

// A settled transcript: the turn is closed, so hydrate has no reason to mutate it.
function settledHistory() {
  return [
    { type: "user_message", text: "hello there", _ts: 10 },
    { type: "session_id", cliSessionId: "provider-thread-a", _ts: 11 },
    { type: "delta", text: "hi back", _ts: 12 },
    { type: "result", sessionId: "provider-thread-b", _ts: 13 },
    { type: "done", code: 0, _ts: 14 },
  ];
}

test("a loaded session holds no transcript in memory until something asks for it", function () {
  var h = harness(function (dir) {
    writeSessionFile(dir, "aaaaaaaa-0000-4000-8000-000000000001", null, settledHistory());
    writeSessionFile(dir, "aaaaaaaa-0000-4000-8000-000000000002", { createdAt: 2000 }, settledHistory());
  });
  try {
    var session = sessionByStorageId(h.sm, "aaaaaaaa-0000-4000-8000-000000000001");
    assert.ok(session, "the session was loaded");
    assert.ok(historyStore.isLazy(session), "its history is lazily backed");
    assert.equal(historyStore.isResident(session), false,
      "boot released the transcript instead of retaining it");

    // Reading it pages it back in, intact.
    assert.equal(session.history.length, 5);
    assert.equal(session.history[0].text, "hello there");
    assert.equal(historyStore.isResident(session), true, "the read populated the cache");
  } finally {
    h.cleanup();
  }
});

test("releasing and re-reading a transcript yields exactly what was loaded", function () {
  var h = harness(function (dir) {
    writeSessionFile(dir, "aaaaaaaa-0000-4000-8000-000000000003", null, settledHistory());
  });
  try {
    var session = sessionByStorageId(h.sm, "aaaaaaaa-0000-4000-8000-000000000003");
    var first = JSON.parse(JSON.stringify(session.history));
    assert.equal(historyStore.release(session), true, "the transcript was released");
    assert.equal(historyStore.isResident(session), false);
    assert.deepEqual(session.history, first, "the re-read matches the original load");
  } finally {
    h.cleanup();
  }
});

test("load-time normalization survives a release, so a reload behaves like a fresh load", function () {
  var h = harness(function (dir) {
    writeSessionFile(dir, "aaaaaaaa-0000-4000-8000-000000000004", null, [
      // Legacy auto-continue: relabelled on the way in.
      { type: "scheduled_message_sent", _ts: 10 },
      { type: "user_message", text: "continue", _ts: 11 },
      // A task notification: marked internalOnly on the way in.
      {
        type: "user_message",
        text: "Worker done",
        synthetic: true,
        origin: { kind: "task-notification" },
        _ts: 12,
      },
      { type: "done", code: 0, _ts: 13 },
    ]);
  });
  try {
    var session = sessionByStorageId(h.sm, "aaaaaaaa-0000-4000-8000-000000000004");
    assert.equal(session.history[1].text, "↻ Auto-continued", "relabelled on load");
    assert.equal(session.history[2].internalOnly, true, "task notification marked on load");

    historyStore.release(session);
    assert.equal(session.history[1].text, "↻ Auto-continued", "still relabelled after reload");
    assert.equal(session.history[2].internalOnly, true, "still marked after reload");
  } finally {
    h.cleanup();
  }
});

test("provider ids used for CLI adoption are derived at load, not by rescanning", function () {
  var h = harness(function (dir) {
    writeSessionFile(dir, "aaaaaaaa-0000-4000-8000-000000000005", null, settledHistory());
  });
  try {
    var session = sessionByStorageId(h.sm, "aaaaaaaa-0000-4000-8000-000000000005");
    assert.deepEqual(session._historicalProviderIds.sort(),
      ["provider-thread-a", "provider-thread-b"],
      "both the session_id and result ids were captured at load");
    assert.equal(historyStore.isResident(session), false,
      "and capturing them did not leave the transcript resident");
  } finally {
    h.cleanup();
  }
});

test("a provider id recorded after load still counts as known, despite the load-time cache", function () {
  var fsMod = require("fs");
  var cliDir = fsMod.mkdtempSync(path.join(os.tmpdir(), "clay-lazy-cli-"));
  var projectDir = fsMod.mkdtempSync(path.join(os.tmpdir(), "clay-lazy-adopt-"));
  try {
    // A worker whose transcript is resident and has recorded a new provider
    // thread since it was loaded. The load-time cache predates that thread.
    var worker = {
      cliSessionId: "worker-original",
      title: "Worker",
      orchestrationParent: { localId: 1 },
      _historicalProviderIds: ["worker-original"],
      history: [{ type: "result", sessionId: "worker-late", _ts: 20 }],
    };
    var sessions = new Map([[1, worker]]);

    var cliImport = require("../lib/sessions-cli-import").attachSessionCliImport({
      cwd: projectDir,
      sessions: sessions,
      allocateLocalId: function () { return 100; },
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
      isValidCliSessionId: function () { return true; },
      cliSessionsDir: function () { return cliDir; },
      readCliSessionDescriptor: function (cliSid) {
        return {
          cliSid: cliSid, title: cliSid, preview: "p", createdAt: 1, lastActivity: 5,
        };
      },
      readCodexThreadNames: function () { return new Map(); },
      listCodexRolloutFiles: function () { return []; },
      readCodexSessionDescriptor: function () { return null; },
      findCodexRolloutByThreadId: function () { return null; },
    });

    // Both rollouts exist on disk as adoptable candidates.
    fsMod.writeFileSync(path.join(cliDir, "worker-original.jsonl"), "");
    fsMod.writeFileSync(path.join(cliDir, "worker-late.jsonl"), "");

    var listed = cliImport.listAdoptableCliSessions().map(function (i) { return i.cliSessionId; });
    assert.ok(listed.indexOf("worker-original") === -1,
      "the cached provider id is recognised as an existing worker");
    assert.ok(listed.indexOf("worker-late") === -1,
      "and so is the one recorded after load, rather than being offered as an orphan");
  } finally {
    fsMod.rmSync(cliDir, { recursive: true, force: true });
    fsMod.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("a session mid-turn keeps its transcript so in-flight items cannot be dropped", function () {
  var h = harness(function (dir) {
    writeSessionFile(dir, "aaaaaaaa-0000-4000-8000-000000000006", null, settledHistory());
  });
  try {
    var session = sessionByStorageId(h.sm, "aaaaaaaa-0000-4000-8000-000000000006");
    assert.equal(session.history.length, 5);
    session.isProcessing = true;
    assert.equal(historyStore.release(session), false, "a processing session is not released");
    assert.equal(historyStore.isResident(session), true);
  } finally {
    h.cleanup();
  }
});

test("a transcript that cannot be re-read is never written back over", function () {
  var h = harness(function (dir) {
    writeSessionFile(dir, "aaaaaaaa-0000-4000-8000-000000000007", null, settledHistory());
  });
  try {
    var session = sessionByStorageId(h.sm, "aaaaaaaa-0000-4000-8000-000000000007");
    var file = path.join(h.sessionsDir, "aaaaaaaa-0000-4000-8000-000000000007.jsonl");
    var before = fs.readFileSync(file, "utf8");

    // Simulate the file becoming unreadable while the transcript is released.
    fs.unlinkSync(file);
    assert.deepEqual(session.history, [], "the read falls back to empty");
    assert.equal(historyStore.isUnavailable(session), true, "and is flagged unavailable");

    // Restore the file, then confirm a save refuses rather than truncating it.
    fs.writeFileSync(file, before);
    assert.equal(h.sm.saveSessionFile(session), false, "the save is refused");
    assert.equal(fs.readFileSync(file, "utf8"), before, "the transcript on disk is untouched");
  } finally {
    h.cleanup();
  }
});

test("startup does not hold every transcript at once", function () {
  var ids = [];
  var h = harness(function (dir) {
    for (var i = 0; i < 25; i++) {
      var id = "aaaaaaaa-0000-4000-8000-1000000000" + (i < 10 ? "0" + i : i);
      ids.push(id);
      writeSessionFile(dir, id, { createdAt: 1000 + i }, settledHistory());
    }
  });
  try {
    var resident = 0;
    var lazy = 0;
    h.sm.sessions.forEach(function (s) {
      if (historyStore.isLazy(s)) lazy++;
      if (historyStore.isResident(s)) resident++;
    });
    assert.equal(h.sm.sessions.size, 25, "every session was loaded");
    assert.equal(lazy, 25, "every loaded session is lazily backed");
    assert.equal(resident, 0, "and none retained its transcript after boot");
  } finally {
    h.cleanup();
  }
});

test("viewing a loaded session releases its transcript and persists recency without rewriting it", async function () {
  var storageId = "aaaaaaaa-0000-4000-8000-000000000008";
  var h = harness(function (dir) {
    writeSessionFile(dir, storageId, {
      lastViewedAt: 10,
      sessionVisibility: "shared",
      orchestrationProjectCompletion: {
        status: "pending",
        completionRevision: 0,
        graphDigest: "",
        summary: "",
        verification: "",
        integrationVerification: "",
        escalationRequired: "",
        portfolioTaskId: "",
        bindingRevision: null,
        completedAt: null,
        revokedAt: null,
        revocationReason: "",
      },
    }, settledHistory());
  });
  try {
    var session = sessionByStorageId(h.sm, storageId);
    var file = path.join(h.sessionsDir, storageId + ".jsonl");
    var before = fs.readFileSync(file, "utf8");

    h.sm.switchSession(session.localId);
    assert.equal(historyStore.isResident(session), false,
      "replay releases the transcript before returning");
    await new Promise(function (resolve) { setImmediate(resolve); });

    assert.equal(historyStore.isResident(session), false,
      "replay does not pin the transcript in daemon memory");
    assert.equal(fs.readFileSync(file, "utf8"), before,
      "persisting view recency does not rewrite the transcript");
    var viewState = JSON.parse(fs.readFileSync(path.join(h.sessionsDir, ".last-viewed.json"), "utf8"));
    assert.equal(viewState.sessions[storageId], session.lastViewedAt,
      "the recency timestamp remains durable outside the transcript");

    clearSessionModuleCache();
    var restored = require("../lib/sessions").createSessionManager({
      cwd: h.projectDir,
      send: function () {},
    });
    var restoredSession = sessionByStorageId(restored, storageId);
    assert.equal(restoredSession.lastViewedAt, session.lastViewedAt,
      "restart ordering reads the durable view state");
  } finally {
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    h.cleanup();
  }
});

test("unchanged hidden sessions hydrate from the startup cache without reparsing transcripts", function () {
  var storageId = "aaaaaaaa-0000-4000-8000-000000000009";
  var h = harness(function (dir) {
    writeSessionFile(dir, storageId, {
      hidden: true,
      closedAt: 20,
      lastActivity: 14,
      sessionVisibility: "shared",
    }, settledHistory());
  });
  var file = path.join(h.sessionsDir, storageId + ".jsonl");
  var originalRead = fs.readFileSync;
  try {
    assert.ok(fs.existsSync(path.join(h.sessionsDir, ".startup-cache.json")),
      "the first parse records compact derived state");
    clearSessionModuleCache();
    var transcriptReads = 0;
    fs.readFileSync = function (target) {
      if (String(target) === file) {
        transcriptReads++;
        throw new Error("hidden transcript should not be parsed");
      }
      return originalRead.apply(fs, arguments);
    };

    var restored = require("../lib/sessions").createSessionManager({
      cwd: h.projectDir,
      send: function () {},
    });
    var session = sessionByStorageId(restored, storageId);
    assert.ok(session, "cached metadata restores the archived session");
    assert.deepEqual(session._historicalProviderIds.sort(),
      ["provider-thread-a", "provider-thread-b"],
      "provider identity derived by the first parse remains available");
    assert.equal(transcriptReads, 0, "the unchanged transcript was not read");
    assert.equal(historyStore.isResident(session), false);

    fs.readFileSync = originalRead;
    fs.appendFileSync(file, JSON.stringify({ type: "info", text: "changed", _ts: 15 }) + "\n");
    clearSessionModuleCache();
    transcriptReads = 0;
    fs.readFileSync = function (target) {
      if (String(target) === file) transcriptReads++;
      return originalRead.apply(fs, arguments);
    };
    var changed = require("../lib/sessions").createSessionManager({
      cwd: h.projectDir,
      send: function () {},
    });
    assert.ok(sessionByStorageId(changed, storageId));
    assert.equal(transcriptReads, 1,
      "a changed fingerprint falls back to the authoritative transcript parser");
  } finally {
    fs.readFileSync = originalRead;
    h.cleanup();
  }
});
