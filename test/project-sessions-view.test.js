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
