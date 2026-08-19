var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

test("automatic CLI adoption records provenance while explicit import does not", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-adoption-origin-"));
  var cliDir = path.join(tmpDir, "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, "auto-session.jsonl"), "\n");
  var sessions = new Map();
  var nextId = 1;
  var descriptors = {
    "auto-session": {
      cliSid: "auto-session", title: "Automatic", createdAt: 1, lastActivity: 2,
      vendor: "claude",
    },
    "manual-session": {
      cliSid: "manual-session", title: "Manual", createdAt: 3, lastActivity: 4,
      vendor: "claude",
    },
  };
  var api = require("../lib/sessions-cli-import").attachSessionCliImport({
    cwd: tmpDir,
    sessions: sessions,
    allocateLocalId: function () { return nextId++; },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    isValidCliSessionId: function () { return true; },
    cliSessionsDir: function () { return cliDir; },
    readCliSessionDescriptor: function (cliSid) { return descriptors[cliSid] || null; },
    readCodexThreadNames: function () { return new Map(); },
    listCodexRolloutFiles: function () { return []; },
    readCodexSessionDescriptor: function () { return null; },
    findCodexRolloutByThreadId: function () { return null; },
  });

  try {
    api.adoptOrphanedCliSessions();
    assert.strictEqual(sessions.get(1).adopted, true);

    var manualId = api.importCliSession("manual-session", "claude");
    assert.strictEqual(sessions.get(manualId).adopted, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Codex import keeps first user prompt even when it starts with injected instructions", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-history-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var threadId = "019edd6c-e1c7-76c0-b42d-b8a4c6a89874";
  var rolloutDir = path.join(tmpHome, ".codex", "sessions", "2026", "06", "19");
  fs.mkdirSync(rolloutDir, { recursive: true });

  var rolloutPath = path.join(rolloutDir, "rollout-2026-06-19T03-09-21-" + threadId + ".jsonl");
  var firstUser = "--- Instructions from CLAUDE.md ---\n# CLAUDE.md\n\nIssue: reproduce the auth timeout toast";
  var lines = [
    JSON.stringify({
      timestamp: "2026-06-19T01:09:23.713Z",
      type: "session_meta",
      payload: {
        id: threadId,
        cwd: projectDir,
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-19T01:09:23.714Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: firstUser,
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-19T01:09:24.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I will inspect the issue first.",
      },
    }),
  ];
  fs.writeFileSync(rolloutPath, lines.join("\n") + "\n");

  try {
    var cliSessions = require("../lib/cli-sessions");
    var history = cliSessions.readCodexHistorySync(tmpHome, threadId, projectDir);

    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[0].type, "user_message");
    assert.strictEqual(history[0].text, firstUser);
    assert.strictEqual(history[1].type, "delta");
    assert.strictEqual(history[1].text, "I will inspect the issue first.");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("hidden sessions are surfaced for import and can be restored", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-hidden-import-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;

  try {
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];

    var utils = require("../lib/utils");
    var encoded = utils.encodeCwd(projectDir);
    var sessionsDir = path.join(tmpHome, "sessions", encoded);
    fs.mkdirSync(sessionsDir, { recursive: true });

    // A closed/archived github-copilot session. Its provider id is recorded in
    // the history (session_id event), which is what made it "known" and got it
    // excluded from the import picker before the fix.
    var hidden = [
      JSON.stringify({
        type: "meta", localId: 1, cliSessionId: "copilot-hidden-1",
        storageId: "copilot-hidden-1", title: "#1975 closed early", hidden: true,
        vendor: "github-copilot", model: "gpt-5.5", createdAt: Date.now(),
      }),
      JSON.stringify({ type: "user_message", text: "fix it", _ts: Date.now() }),
      JSON.stringify({ type: "session_id", cliSessionId: "copilot-hidden-1", _ts: Date.now() }),
    ];
    fs.writeFileSync(path.join(sessionsDir, "copilot-hidden-1.jsonl"), hidden.join("\n") + "\n");

    // A compaction source — its content lives in a successor, so it must NOT
    // be surfaced as a separate importable entry.
    var source = [
      JSON.stringify({
        type: "meta", localId: 2, cliSessionId: "codex-source-1",
        storageId: "codex-source-1", title: "pre-compaction source", hidden: true,
        vendor: "codex", compactedIntoLocalId: 1, createdAt: Date.now(),
      }),
      JSON.stringify({ type: "session_id", cliSessionId: "codex-source-1", _ts: Date.now() }),
    ];
    fs.writeFileSync(path.join(sessionsDir, "codex-source-1.jsonl"), source.join("\n") + "\n");

    var createSessionManager = require("../lib/sessions").createSessionManager;
    var sm = createSessionManager({ cwd: projectDir, send: function () {} });

    // gpt-5.5 maps to the codex family, so it shows under the codex picker...
    var codexList = sm.listAdoptableCliSessions("codex");
    var found = codexList.filter(function (s) { return s.cliSessionId === "copilot-hidden-1"; });
    assert.strictEqual(found.length, 1, "hidden copilot session should be importable under codex filter");
    assert.strictEqual(found[0].hidden, true);
    assert.strictEqual(found[0].vendor, "github-copilot");

    // ...but not under the claude picker (wrong family).
    var claudeList = sm.listAdoptableCliSessions("claude");
    assert.strictEqual(claudeList.filter(function (s) { return s.cliSessionId === "copilot-hidden-1"; }).length, 0);

    // The compaction source is never offered.
    assert.strictEqual(codexList.concat(claudeList).filter(function (s) { return s.cliSessionId === "codex-source-1"; }).length, 0);

    // Importing the hidden session un-hides it.
    var localId = sm.importCliSession("copilot-hidden-1", "github-copilot");
    assert.ok(localId, "import should return the restored session's localId");
    assert.strictEqual(sm.sessions.get(localId).cliSessionId, "copilot-hidden-1");
    assert.strictEqual(sm.sessions.get(localId).hidden, false);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("orchestration workers stay out of every CLI import candidate path", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-worker-import-"));
  var cliDir = path.join(tmpDir, "claude");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, "worker-claude.jsonl"), "worker claude\n");
  fs.writeFileSync(path.join(cliDir, "direct-untracked.jsonl"), "direct session\n");

  var workerClaude = {
    cliSessionId: "worker-claude",
    storageId: "worker-claude-storage",
    hidden: true,
    history: [{ type: "session_id", cliSessionId: "worker-claude-history" }],
    orchestrationParent: { taskId: "task-claude" },
  };
  var workerCodex = {
    cliSessionId: "worker-codex",
    storageId: "worker-codex-storage",
    hidden: true,
    history: [{ type: "result", sessionId: "worker-codex-history" }],
    orchestrationParent: { taskId: "task-codex" },
  };
  var workerCopilot = {
    cliSessionId: "worker-copilot",
    storageId: "worker-copilot-storage",
    hidden: true,
    history: [{ type: "session_id", cliSessionId: "worker-copilot-history" }],
    orchestrationParent: { taskId: "task-copilot" },
  };
  var workerFallback = {
    cliSessionId: "worker-fallback",
    storageId: "worker-fallback-storage",
    title: "Worker fallback",
    hidden: true,
    history: [],
    orchestrationParent: { taskId: "task-fallback" },
  };
  var detachedWorker = {
    cliSessionId: "worker-detached",
    storageId: "worker-detached-storage",
    title: "Detached retry attempt",
    hidden: true,
    orchestrationDetachedAt: 10,
    history: [{ type: "done" }],
    orchestrationParent: { taskId: "task-detached" },
  };
  var coopControlledLeaf = {
    cliSessionId: "coop-controlled-leaf",
    storageId: "coop-controlled-leaf-storage",
    title: "Coop-controlled direct leaf",
    hidden: true,
    history: [],
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  var coordinator = {
    cliSessionId: "coordinator-hidden",
    title: "Hidden coordinator",
    hidden: true,
    coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    history: [],
  };
  var directHidden = {
    cliSessionId: "direct-hidden",
    title: "Hidden direct session",
    hidden: true,
    history: [],
  };
  var sessions = new Map([
    [1, workerClaude],
    [2, workerCodex],
    [3, workerCopilot],
    [4, workerFallback],
    [5, coopControlledLeaf],
    [6, coordinator],
    [7, directHidden],
    [8, detachedWorker],
  ]);
  var descriptors = {
    "worker-claude": {
      cliSid: "worker-claude", title: "Worker Claude", preview: "worker", createdAt: 1, lastActivity: 10,
    },
    "direct-untracked": {
      cliSid: "direct-untracked", title: "Direct untracked", preview: "direct", createdAt: 1, lastActivity: 5,
    },
  };
  var codexDescriptor = {
    cliSid: "worker-codex", title: "Worker Codex", preview: "worker", createdAt: 1, lastActivity: 9,
  };
  var copilotSessions = require("../lib/copilot-sessions");
  var originalCopilotList = copilotSessions.listCopilotSessionDescriptors;

  copilotSessions.listCopilotSessionDescriptors = function () {
    return [{
      cliSid: "worker-copilot", title: "Worker Copilot", preview: "worker",
      createdAt: 1, lastActivity: 8, copilotFamily: "codex", model: "gpt-5.5",
    }];
  };

  try {
    var cliImport = require("../lib/sessions-cli-import").attachSessionCliImport({
      cwd: tmpDir,
      sessions: sessions,
      allocateLocalId: function () { return 100; },
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
      isValidCliSessionId: function () { return true; },
      cliSessionsDir: function () { return cliDir; },
      readCliSessionDescriptor: function (cliSid) { return descriptors[cliSid] || null; },
      readCodexThreadNames: function () { return new Map(); },
      listCodexRolloutFiles: function () { return ["worker-codex-rollout"]; },
      readCodexSessionDescriptor: function () { return codexDescriptor; },
      findCodexRolloutByThreadId: function () { return null; },
    });
    var listed = cliImport.listAdoptableCliSessions();
    var workerIds = [
      "worker-claude", "worker-claude-storage", "worker-claude-history",
      "worker-codex", "worker-codex-storage", "worker-codex-history",
      "worker-copilot", "worker-copilot-storage", "worker-copilot-history",
      "worker-fallback", "worker-fallback-storage",
      "worker-detached", "worker-detached-storage",
      "coop-controlled-leaf", "coop-controlled-leaf-storage",
    ];
    var listedWorkerIds = listed.filter(function (item) {
      return workerIds.indexOf(item.cliSessionId) !== -1;
    });

    assert.deepStrictEqual(listedWorkerIds, [], "orchestration workers must not be import candidates");
    assert.ok(!listed.some(function (item) { return item.cliSessionId === "coop-controlled-leaf"; }));
    assert.ok(!listed.some(function (item) { return item.cliSessionId === "coordinator-hidden"; }));
    assert.ok(listed.some(function (item) { return item.cliSessionId === "direct-hidden"; }));
    assert.ok(listed.some(function (item) { return item.cliSessionId === "direct-untracked"; }));
  } finally {
    copilotSessions.listCopilotSessionDescriptors = originalCopilotList;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// The owner closing a Coop-owned session must be able to get it back. The
// default exclusion above protects the picker from auto-archived orchestration
// work, so recovery runs through an explicit opt-in that still refuses workers
// and Coop's own infrastructure sessions.
function coopImportFixture() {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-import-"));
  var cliDir = path.join(tmpDir, "claude");
  fs.mkdirSync(cliDir, { recursive: true });

  var coopLeaf = {
    localId: 1,
    cliSessionId: "coop-leaf",
    storageId: "coop-leaf-storage",
    title: "Coop-owned execution leaf",
    hidden: true,
    closedAt: 4242,
    history: [],
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  var coopWorker = {
    localId: 2,
    cliSessionId: "coop-worker",
    storageId: "coop-worker-storage",
    title: "Coop worker",
    hidden: true,
    history: [],
    orchestrationParent: { taskId: "task-1" },
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  var coopHome = {
    localId: 3,
    cliSessionId: "coop-home-session",
    storageId: "coop-home",
    title: "Coop",
    hidden: true,
    history: [],
    coopHome: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  var controlPlane = {
    localId: 4,
    cliSessionId: "coop-control-plane-session",
    storageId: "coop-control-plane-storage",
    title: "Coop control plane",
    hidden: true,
    history: [],
    coordinationRole: "coop_control_plane",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  var malformedProvenance = {
    localId: 5,
    cliSessionId: "malformed-provenance",
    storageId: "malformed-provenance-storage",
    title: "Corrupt provenance on disk",
    hidden: true,
    history: [],
    coopControlledBy: { coopSessionStorageId: "coop-home" },
  };

  var sessions = new Map([
    [1, coopLeaf], [2, coopWorker], [3, coopHome], [4, controlPlane], [5, malformedProvenance],
  ]);
  var saved = [];
  var cliImport = require("../lib/sessions-cli-import").attachSessionCliImport({
    cwd: tmpDir,
    sessions: sessions,
    allocateLocalId: function () { return 100; },
    saveSessionFile: function (session) { saved.push(session); },
    broadcastSessionList: function () {},
    isValidCliSessionId: function () { return true; },
    cliSessionsDir: function () { return cliDir; },
    readCliSessionDescriptor: function () { return null; },
    readCodexThreadNames: function () { return new Map(); },
    listCodexRolloutFiles: function () { return []; },
    readCodexSessionDescriptor: function () { return null; },
    findCodexRolloutByThreadId: function () { return null; },
  });

  return {
    tmpDir: tmpDir, cliImport: cliImport, sessions: sessions, saved: saved,
    coopLeaf: coopLeaf, coopWorker: coopWorker, coopHome: coopHome,
    controlPlane: controlPlane, malformedProvenance: malformedProvenance,
  };
}

test("closed Coop-owned sessions are importable only behind the explicit opt-in", function () {
  var fx = coopImportFixture();
  var copilotSessions = require("../lib/copilot-sessions");
  var originalCopilotList = copilotSessions.listCopilotSessionDescriptors;
  copilotSessions.listCopilotSessionDescriptors = function () { return []; };
  try {
    var ids = function (listed) {
      return listed.map(function (item) { return item.cliSessionId; });
    };

    var defaultListed = fx.cliImport.listAdoptableCliSessions("");
    assert.ok(ids(defaultListed).indexOf("coop-leaf") === -1,
      "Coop-owned sessions stay hidden by default");

    var optedIn = fx.cliImport.listAdoptableCliSessions("", { includeCoopManaged: true });
    var optedInIds = ids(optedIn);
    assert.ok(optedInIds.indexOf("coop-leaf") !== -1,
      "opting in must surface the closed Coop-owned session");
    assert.ok(optedInIds.indexOf("coop-worker") === -1,
      "nested orchestration workers are never importable");
    assert.ok(optedInIds.indexOf("coop-home-session") === -1,
      "the canonical Coop conversation is infrastructure, not importable history");
    assert.ok(optedInIds.indexOf("coop-control-plane-session") === -1,
      "control-plane sessions are infrastructure, not importable history");

    var leafRow = optedIn.filter(function (item) { return item.cliSessionId === "coop-leaf"; })[0];
    assert.strictEqual(leafRow.coopManaged, true, "the row must be labelled Coop-managed");
    assert.strictEqual(leafRow.hidden, true);
    assert.strictEqual(leafRow.lastActivity, 4242, "closedAt is the authoritative close time");

    // Malformed persisted provenance normalizes to null, so this session was
    // never Coop-controlled and must behave like any other closed session:
    // listed by default, and not mislabelled as Coop-managed.
    var malformedRow = defaultListed.filter(function (item) {
      return item.cliSessionId === "malformed-provenance";
    })[0];
    assert.ok(malformedRow, "a session with unusable provenance is an ordinary closed session");
    assert.strictEqual(malformedRow.coopManaged, false);
  } finally {
    copilotSessions.listCopilotSessionDescriptors = originalCopilotList;
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  }
});

test("importing a Coop-owned session releases it to the owner so it stays visible", function () {
  var fx = coopImportFixture();
  try {
    var localId = fx.cliImport.importCliSession("coop-leaf", "claude", { ownerId: "user-7" });
    assert.strictEqual(localId, 1, "the existing session is reused, not duplicated");
    assert.strictEqual(fx.coopLeaf.hidden, false);
    assert.strictEqual(fx.coopLeaf.closedAt, null);
    // Releasing provenance is the load-bearing part: while coopControlledBy is
    // set, the sidebar filters the row out and the auto-archive/self-cleanup
    // paths are free to re-hide it.
    assert.strictEqual(fx.coopLeaf.coopControlledBy, null,
      "an explicit import must release the session from Coop control");
    assert.strictEqual(fx.coopLeaf.ownerId, "user-7");
    assert.strictEqual(typeof fx.coopLeaf.coopReleasedToOwnerAt, "number",
      "the release must leave durable evidence");
    assert.ok(fx.saved.indexOf(fx.coopLeaf) !== -1, "the release must be persisted");

    // Once released it is an ordinary session, so it is no longer offered as a
    // Coop-managed import candidate.
    var relisted = fx.cliImport.listAdoptableCliSessions("", { includeCoopManaged: true });
    assert.ok(!relisted.some(function (item) {
      return item.cliSessionId === "coop-leaf" && item.coopManaged;
    }), "a released session is no longer Coop-managed");
  } finally {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  }
});

test("importing never releases Coop's own infrastructure sessions", function () {
  var fx = coopImportFixture();
  try {
    fx.cliImport.importCliSession("coop-home-session", "claude", { ownerId: "user-7" });
    assert.deepStrictEqual(fx.coopHome.coopControlledBy,
      { coopSessionStorageId: "coop-home", since: 1 },
      "the canonical Coop conversation keeps its provenance");
    assert.strictEqual(fx.coopHome.coopReleasedToOwnerAt, undefined);

    fx.cliImport.importCliSession("coop-control-plane-session", "claude", { ownerId: "user-7" });
    assert.deepStrictEqual(fx.controlPlane.coopControlledBy,
      { coopSessionStorageId: "coop-home", since: 1 },
      "control-plane sessions keep their provenance");
  } finally {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  }
});

test("CLI session import preserves original message timestamps as _ts", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cli-ts-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var cliSessions = require("../lib/cli-sessions");
  var sessionId = "bb167370-2320-4e85-9fb2-116135ea5d56";

  var encoded = cliSessions.encodeCwd(projectDir);
  var projDir = path.join(tmpHome, ".claude", "projects", encoded);
  fs.mkdirSync(projDir, { recursive: true });

  var userTs = "2026-05-28T09:42:23.729Z";
  var asstTs = "2026-05-28T09:42:27.110Z";
  var lines = [
    JSON.stringify({ type: "mode", mode: "default" }),
    JSON.stringify({
      type: "user",
      timestamp: userTs,
      message: { role: "user", content: "Hello from the past" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: asstTs,
      message: { role: "assistant", content: [{ type: "text", text: "A reply from the past" }] },
    }),
  ];
  fs.writeFileSync(path.join(projDir, sessionId + ".jsonl"), lines.join("\n") + "\n");

  try {
    var history = cliSessions.readCliSessionHistorySync(tmpHome, projectDir, sessionId);

    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].type, "user_message");
    assert.strictEqual(history[0]._ts, Date.parse(userTs));
    assert.strictEqual(history[1].type, "delta");
    assert.strictEqual(history[1]._ts, Date.parse(asstTs));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("a Claude rollout is still importable when a large pasted attachment straddles the descriptor read boundary", function () {
  // Root cause: readCliSessionDescriptor used to do one fixed-size (64KB)
  // read. Real conversations that open with a pasted screenshot embed a
  // large base64 image inline in the very first "user" JSON line; when that
  // line straddles the read cutoff, JSON.parse silently fails on it (and
  // anything after), userCount looks like 0, and the whole real session
  // vanishes from the import picker. This reproduces that shape with a
  // synthetic oversized first line, then real content further in the file.
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-large-attachment-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var oldHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions-cli-descriptors")];

    var utils = require("../lib/utils");
    var config = require("../lib/config");
    var encoded = utils.encodeCwd(projectDir);
    var cliDir = path.join(config.REAL_HOME, ".claude", "projects", encoded);
    fs.mkdirSync(cliDir, { recursive: true });

    var sessionId = "big-attachment-session-1";
    var hugeBase64 = "A".repeat(200 * 1024); // 200KB, well past the old 64KB cap
    var firstUserText = "why did I get this message in my chat ?";
    var lines = [
      JSON.stringify({ type: "mode", mode: "default" }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-16T10:00:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: hugeBase64 } },
            { type: "text", text: firstUserText },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-16T10:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Let me check that." }] },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-16T10:01:00.000Z",
        message: { role: "user", content: "Any update?" },
      }),
    ];
    fs.writeFileSync(path.join(cliDir, sessionId + ".jsonl"), lines.join("\n") + "\n");

    function isValidCliSessionId(cliSid) { return typeof cliSid === "string" && /^[A-Za-z0-9_-]+$/.test(cliSid); }
    var descriptorsMod = require("../lib/sessions-cli-descriptors");
    var descApi = descriptorsMod.attachSessionCliDescriptors({ cwd: projectDir, isValidCliSessionId: isValidCliSessionId });

    var desc = descApi.readCliSessionDescriptor(sessionId);
    assert.ok(desc, "session with a large first-line attachment must still produce a descriptor");
    assert.strictEqual(desc.cliSid, sessionId);
    assert.strictEqual(desc.preview, firstUserText);
    assert.strictEqual(desc.title, firstUserText);
  } finally {
    if (typeof oldHome === "string") process.env.HOME = oldHome;
    else delete process.env.HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions-cli-descriptors")];
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("a genuinely empty 'hi'-only Claude rollout stays excluded after the descriptor read fix", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-hi-only-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var oldHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions-cli-descriptors")];

    var utils = require("../lib/utils");
    var config = require("../lib/config");
    var encoded = utils.encodeCwd(projectDir);
    var cliDir = path.join(config.REAL_HOME, ".claude", "projects", encoded);
    fs.mkdirSync(cliDir, { recursive: true });

    var sessionId = "hi-only-session-1";
    var lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-16T10:00:00.000Z",
        message: { role: "user", content: "hi" },
      }),
    ];
    fs.writeFileSync(path.join(cliDir, sessionId + ".jsonl"), lines.join("\n") + "\n");

    function isValidCliSessionId(cliSid) { return typeof cliSid === "string" && /^[A-Za-z0-9_-]+$/.test(cliSid); }
    var descriptorsMod = require("../lib/sessions-cli-descriptors");
    var descApi = descriptorsMod.attachSessionCliDescriptors({ cwd: projectDir, isValidCliSessionId: isValidCliSessionId });

    assert.strictEqual(descApi.readCliSessionDescriptor(sessionId), null, "a lone 'hi' test session must remain excluded");
  } finally {
    if (typeof oldHome === "string") process.env.HOME = oldHome;
    else delete process.env.HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions-cli-descriptors")];
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
