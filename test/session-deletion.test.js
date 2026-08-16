var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createSessionManager = require("../lib/sessions").createSessionManager;

test("a deleted Claude CLI session is not adopted again after restart", function (t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-session-delete-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });

  var sessionsBase = path.join(root, "sessions");
  var cliSessionsDir = path.join(root, "claude-sessions");
  fs.mkdirSync(cliSessionsDir, { recursive: true });
  var cliSessionId = "11111111-2222-4333-8444-555555555555";
  var transcriptPath = path.join(cliSessionsDir, cliSessionId + ".jsonl");
  var transcript = [
    { type: "user", timestamp: "2026-08-16T00:00:00.000Z", message: { role: "user", content: "keep the source transcript" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
  ];
  fs.writeFileSync(transcriptPath, transcript.map(JSON.stringify).join("\n") + "\n");

  function manager() {
    return createSessionManager({
      cwd: path.join(root, "project"),
      sessionsBase: sessionsBase,
      cliSessionsDir: cliSessionsDir,
      send: function () {},
    });
  }

  var first = manager();
  assert.strictEqual(first.sessions.size, 1);
  var adopted = Array.from(first.sessions.values())[0];
  assert.strictEqual(adopted.adopted, true);
  first.deleteSession(adopted.localId);
  assert.strictEqual(fs.existsSync(transcriptPath), true);

  var second = manager();
  var resumedIds = Array.from(second.sessions.values()).map(function (session) { return session.cliSessionId; });
  assert.strictEqual(resumedIds.indexOf(cliSessionId), -1);
});

test("an adopted warmup row from an older version is removed on startup", function (t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-warmup-sweep-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });

  var sessionsBase = path.join(root, "sessions");
  var cliSessionsDir = path.join(root, "claude-sessions");
  var cwd = path.join(root, "project");
  var encoded = require("../lib/utils").encodeCwd(cwd);
  var sessionsDir = path.join(sessionsBase, encoded);
  var cliSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(cliSessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, cliSessionId + ".jsonl"), JSON.stringify({
    type: "meta",
    localId: 9,
    cliSessionId: cliSessionId,
    title: "hi",
    createdAt: Date.now() - 60000,
    vendor: "claude",
    mode: "tui",
    adopted: true,
  }) + "\n");
  var warmup = [
    { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  ];
  fs.writeFileSync(path.join(cliSessionsDir, cliSessionId + ".jsonl"), warmup.map(JSON.stringify).join("\n") + "\n");

  var manager = createSessionManager({
    cwd: cwd,
    sessionsBase: sessionsBase,
    cliSessionsDir: cliSessionsDir,
    send: function () {},
  });
  var ids = Array.from(manager.sessions.values()).map(function (session) { return session.cliSessionId; });
  assert.strictEqual(ids.indexOf(cliSessionId), -1);
});

test("an empty adopted row is removed after daemon cleanup deleted its source", function (t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-missing-adopted-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });

  var cwd = path.join(root, "project");
  var sessionsBase = path.join(root, "sessions");
  var sessionsDir = path.join(sessionsBase, require("../lib/utils").encodeCwd(cwd));
  var cliSessionsDir = path.join(root, "claude-sessions");
  var cliSessionId = "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb";
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(cliSessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, cliSessionId + ".jsonl"), JSON.stringify({
    type: "meta",
    localId: 4,
    cliSessionId: cliSessionId,
    title: "hi",
    createdAt: Date.now() - 60000,
    vendor: "claude",
    mode: "tui",
    adopted: true,
  }) + "\n");

  var manager = createSessionManager({
    cwd: cwd,
    sessionsBase: sessionsBase,
    cliSessionsDir: cliSessionsDir,
    send: function () {},
  });
  var ids = Array.from(manager.sessions.values()).map(function (session) { return session.cliSessionId; });
  assert.strictEqual(ids.indexOf(cliSessionId), -1);
});
