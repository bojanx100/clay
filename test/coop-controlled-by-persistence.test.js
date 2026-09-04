// Proves session.coopControlledBy survives the REAL save/load round trip
// (sessions-persistence.js -> disk -> sessions-loader.js) and is accepted by
// the REAL buildNewSession (sessions-lifecycle.js), not a test-local fake.
// Earlier coverage faked createSessionRaw directly, which hid a real bug:
// sessions-persistence.js's metaObj whitelist dropped the field entirely, so
// it never reached disk, and sessions-loader.js never restored it — meaning
// a daemon restart silently erased Coop-control provenance for every
// compacted or previously-persisted worker/coordinator session.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

function clearSessionModuleCache() {
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/tombstones")];
  delete require.cache[require.resolve("../lib/sessions")];
}

function makeSessionHarness(managerOverrides) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-session-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;
  clearSessionModuleCache();

  var utils = require("../lib/utils");
  var sessionsDir = path.join(tmpHome, "sessions", utils.encodeCwd(projectDir));
  var managerOptions = Object.assign({
    cwd: projectDir,
    send: function () {},
  }, managerOverrides || {});
  var sm = require("../lib/sessions").createSessionManager(managerOptions);

  return {
    tmpHome: tmpHome,
    projectDir: projectDir,
    oldClayHome: oldClayHome,
    sessionsDir: sessionsDir,
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

function sessionFile(h, storageId) {
  return path.join(h.sessionsDir, storageId + ".jsonl");
}

function readSessionMeta(h, storageId) {
  return JSON.parse(fs.readFileSync(sessionFile(h, storageId), "utf8").split("\n")[0]);
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

test("coopControlledBy is accepted by the real buildNewSession via sessionOpts", function () {
  var h = makeSessionHarness();
  try {
    var worker = h.sm.createSessionRaw({
      storageId: "worker-1",
      coopControlledBy: { coopSessionStorageId: "coop-home", since: 111 },
    });
    assert.deepEqual(worker.coopControlledBy, {
      coopSessionStorageId: "coop-home",
      since: 111,
    });
  } finally {
    h.cleanup();
  }
});

test("buildNewSession rejects a malformed coopControlledBy passed via sessionOpts", function () {
  var h = makeSessionHarness();
  try {
    var missingSince = h.sm.createSessionRaw({
      storageId: "worker-bad-1",
      coopControlledBy: { coopSessionStorageId: "coop-home" },
    });
    assert.strictEqual(missingSince.coopControlledBy, null);

    var wrongType = h.sm.createSessionRaw({
      storageId: "worker-bad-2",
      coopControlledBy: "coop-home",
    });
    assert.strictEqual(wrongType.coopControlledBy, null);
  } finally {
    h.cleanup();
  }
});

test("coopControlledBy survives a real save-to-disk and daemon-restart reload", async function () {
  var h = makeSessionHarness();
  try {
    var worker = h.sm.createSessionRaw({
      storageId: "worker-restart",
      coopControlledBy: { coopSessionStorageId: "coop-home", since: 222 },
    });
    h.sm.saveSessionFile(worker);

    var persistedMeta = readSessionMeta(h, "worker-restart");
    assert.deepEqual(persistedMeta.coopControlledBy, {
      coopSessionStorageId: "coop-home",
      since: 222,
    }, "the field must actually reach the on-disk meta line, not just memory");

    clearSessionModuleCache();
    var restored = require("../lib/sessions").createSessionManager({
      cwd: h.projectDir,
      send: function () {},
    });
    var restoredWorker = null;
    restored.sessions.forEach(function (session) {
      if (session.storageId === "worker-restart") restoredWorker = session;
    });
    assert.ok(restoredWorker, "worker session must reload after restart");
    assert.deepEqual(restoredWorker.coopControlledBy, {
      coopSessionStorageId: "coop-home",
      since: 222,
    }, "provenance must survive the full save -> disk -> restart -> load cycle");
  } finally {
    await wait(20);
    h.cleanup();
  }
});

test("a malformed persisted coopControlledBy is dropped, never trusted, on load", async function () {
  var h = makeSessionHarness();
  try {
    var worker = h.sm.createSessionRaw({ storageId: "worker-corrupt" });
    h.sm.saveSessionFile(worker);
    var filePath = sessionFile(h, "worker-corrupt");
    var lines = fs.readFileSync(filePath, "utf8").split("\n");
    var meta = JSON.parse(lines[0]);
    meta.coopControlledBy = { coopSessionStorageId: "coop-home" }; // missing `since`
    lines[0] = JSON.stringify(meta);
    fs.writeFileSync(filePath, lines.join("\n"));

    clearSessionModuleCache();
    var restored = require("../lib/sessions").createSessionManager({
      cwd: h.projectDir,
      send: function () {},
    });
    var restoredWorker = null;
    restored.sessions.forEach(function (session) {
      if (session.storageId === "worker-corrupt") restoredWorker = session;
    });
    assert.ok(restoredWorker);
    assert.strictEqual(restoredWorker.coopControlledBy, undefined,
      "malformed on-disk provenance must not be restored as trusted state");
  } finally {
    await wait(20);
    h.cleanup();
  }
});

test("the real Coop home creation path never stamps an ownerId (single-admin reality)", function () {
  // This is the load-bearing assumption behind coop-control-provenance.js's
  // resolveSessionOwnerId fallback: ensureCoopHomeSession (lib/sessions.js)
  // creates the Lead's canonical home via createSession({coopHome: true})
  // with no ownerId in sessionOpts, and Clay is always internally
  // multi-user (migrate-single-user.js), so a session.ownerId truthiness
  // check alone would make Lead-mode suppression permanently dead for the
  // Lead's own home conversation and anything it delegates directly.
  var h = makeSessionHarness({ isLead: true });
  try {
    var home = [...h.sm.sessions.values()].find(function (session) { return session.coopHome; });
    assert.ok(home, "Lead session manager creates a Coop home on first boot");
    assert.strictEqual(home.ownerId, null,
      "the real creation path does not stamp ownerId on the Coop home session");
  } finally {
    h.cleanup();
  }
});
