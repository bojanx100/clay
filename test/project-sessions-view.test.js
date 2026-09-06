var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var projectSessionsView = require("../lib/project-sessions-view");

function writeCodexRollout(home, cwd, threadId) {
  var rolloutDir = path.join(home, ".codex", "sessions", "2026", "07", "04");
  fs.mkdirSync(rolloutDir, { recursive: true });
  var rolloutPath = path.join(rolloutDir, "rollout-2026-07-04T10-00-00-" + threadId + ".jsonl");
  var lines = [
    JSON.stringify({
      timestamp: "2026-07-04T10:00:00.000Z",
      type: "session_meta",
      payload: { id: threadId, cwd: cwd },
    }),
    JSON.stringify({
      timestamp: "2026-07-04T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "External prompt" },
    }),
    JSON.stringify({
      timestamp: "2026-07-04T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "External answer" },
    }),
  ];
  fs.writeFileSync(rolloutPath, lines.join("\n") + "\n");
  return rolloutPath;
}

function createView(home, cwd, saves) {
  return projectSessionsView.attachProjectSessionsView({
    cwd: cwd,
    sm: {
      saveSessionFile: function (session) {
        saves.push(session);
      },
    },
    tm: null,
    resolveSessionHome: function () { return home; },
    getClaudeOpenModeForWs: function () { return "gui"; },
    tuiHandlers: {
      prepareTuiSessionForGuiView: function () {},
    },
  });
}

test("Codex rollout hydration does not flatten live rich history", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-live-view-"));
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var threadId = "019f1234-aaaa-bbbb-cccc-123456789abc";
  var saves = [];

  try {
    writeCodexRollout(home, cwd, threadId);
    var view = createView(home, cwd, saves);
    var originalHistory = [
      { type: "user_message", text: "Run tests" },
      { type: "tool_start", id: "tool-1", name: "Bash" },
      { type: "tool_result", id: "tool-1", content: "ok" },
    ];
    var session = {
      vendor: "codex",
      storageId: threadId,
      cliSessionId: threadId,
      history: originalHistory.slice(),
    };

    view.resolveSessionForView(session, null);

    assert.deepStrictEqual(session.history, originalHistory);
    assert.strictEqual(session._historyMtime, undefined);
    assert.strictEqual(saves.length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("imported session with restored historyMtime keeps refreshing after restart", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-restart-view-"));
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var threadId = "019f1234-1111-2222-3333-123456789abc";
  var saves = [];

  try {
    var rolloutPath = writeCodexRollout(home, cwd, threadId);
    var view = createView(home, cwd, saves);
    // Simulate a post-restart imported session: history was hydrated in a
    // previous daemon lifetime and the marker was RESTORED from meta
    // (sessions-loader.js maps m.historyMtime -> session._historyMtime).
    // A stale mtime marker + advanced rollout must re-hydrate; without the
    // persisted marker the live-history guard would block refreshes forever.
    var session = {
      vendor: "codex",
      storageId: threadId,
      cliSessionId: threadId,
      history: [{ type: "user_message", text: "External prompt" }],
      _historyMtime: fs.statSync(rolloutPath).mtimeMs - 1000,
    };

    view.resolveSessionForView(session, null);

    assert.strictEqual(session.history.length, 3, "rollout refresh must still run for hydrated sessions");
    assert.strictEqual(session._historyMtime, fs.statSync(rolloutPath).mtimeMs);
    assert.strictEqual(saves.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Codex rollout hydration still populates empty imported sessions", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-import-view-"));
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var threadId = "019f1234-dddd-eeee-ffff-123456789abc";
  var saves = [];

  try {
    writeCodexRollout(home, cwd, threadId);
    var view = createView(home, cwd, saves);
    var session = {
      vendor: "codex",
      storageId: threadId,
      cliSessionId: threadId,
      history: [],
    };

    view.resolveSessionForView(session, null);

    assert.strictEqual(session.history.length, 3);
    assert.strictEqual(session.history[0].type, "user_message");
    assert.strictEqual(session.history[0].text, "External prompt");
    assert.ok(session._historyMtime > 0);
    assert.strictEqual(saves.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a reader upgrade refreshes imported history once even when the rollout is unchanged", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clay-history-format-"));
  var cwd = path.join(home, "project");
  var threadId = "019f1234-aaaa-bbbb-cccc-123456789abc";
  var saves = [];
  try {
    var rollout = writeCodexRollout(home, cwd, threadId);
    var session = { vendor: "codex", cliSessionId: threadId, storageId: threadId,
      _historyMtime: fs.statSync(rollout).mtimeMs, history: [{ type: "user_message", text: "Old incomplete import" }] };
    var view = createView(home, cwd, saves);
    view.resolveSessionForView(session, null);
    assert.equal(session.history[0].text, "External prompt");
    assert.equal(session._historyFormatVersion, require("../lib/cli-sessions").HISTORY_FORMAT_VERSION);
    assert.equal(saves.length, 1);
    view.resolveSessionForView(session, null);
    assert.equal(saves.length, 1, "the upgraded cache stays fresh");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("external Codex sync replays a format upgrade even without an activity-time change", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clay-history-refresh-"));
  var cwd = path.join(home, "project");
  var threadId = "019f1234-aaaa-bbbb-cccc-123456789abc";
  var sync = require("../lib/project-external-codex-sync");
  var switches = 0;
  try {
    var rollout = writeCodexRollout(home, cwd, threadId);
    var session = { localId: 1, vendor: "codex", cliSessionId: threadId,
      _historyMtime: fs.statSync(rollout).mtimeMs, history: [{ type: "user_message", text: "Old incomplete import" }] };
    sync.startExternalCodexSync({
      clients: new Set([{ readyState: 1, _clayActiveSession: 1 }]),
      sessions: createView(home, cwd, []),
      sm: { sessions: new Map([[1, session]]), switchSession: function () { switches++; } },
      setInterval: function () { return { unref: function () {} }; }, clearInterval: function () {},
    });
    sync._tickForTests();
    assert.equal(session.history[0].text, "External prompt");
    assert.equal(switches, 1);
    sync._tickForTests();
    assert.equal(switches, 1);
  } finally { sync._resetForTests(); fs.rmSync(home, { recursive: true, force: true }); }
});
