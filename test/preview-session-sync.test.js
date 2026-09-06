var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var sync = require("../scripts/sync-preview-sessions").syncPreviewSessions;
var DatabaseSync = require("node:sqlite").DatabaseSync;

function fixture(t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-session-snapshot-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var source = path.join(root, "original"); var target = path.join(root, "preview");
  function write(dir, name, content) {
    var file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    return file;
  }
  function session(dir, name, owner, hidden) {
    return write(dir, "sessions/project/" + name + ".jsonl", JSON.stringify({ type: "meta", storageId: name,
      cliSessionId: name, ownerId: owner, hidden: !!hidden, title: name }) + "\n" +
      JSON.stringify({ type: "user_message", text: "Keep this exact conversation " + name }) + "\n");
  }
  write(source, "daemon-dev.json", { port: 7292 });
  write(target, "daemon-dev.json", { port: 7392, projects: [{ slug: "project", ownerId: "preview-owner" }], coop: { leadMode: { enabled: false } } });
  write(source, "users.json", { users: [{ id: "owner", role: "admin", pinHash: "original-auth" }] });
  write(target, "users.json", { users: [{ id: "preview-owner", role: "admin", pinHash: "preview-auth" }] });
  var visible = session(source, "visible", "owner", false);
  var hidden = session(source, "hidden", "owner", true);
  var extra = session(target, "extra", "preview-owner", false);
  var keep = session(target, "this-conversation", "preview-owner", false);
  return { source: source, target: target, visible: visible, hidden: hidden, extra: extra, keep: keep,
    write: write, session: session };
}

test("session snapshot replaces extras, preserves visibility and transcript bytes, and keeps the requested addition", function (t) {
  var f = fixture(t);
  var before = fs.readFileSync(f.visible);
  var result = sync({ source: f.source, target: f.target, keepSession: f.keep, apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.sessionCount, 3);
  assert.deepEqual(fs.readdirSync(path.join(f.target, "sessions/project")).sort(), ["hidden.jsonl", "this-conversation.jsonl", "visible.jsonl"]);
  assert.deepEqual(fs.readFileSync(path.join(f.target, "sessions/project/visible.jsonl")), before);
  assert.deepEqual(fs.readFileSync(path.join(f.target, "sessions/project/hidden.jsonl")), fs.readFileSync(f.hidden));
  assert.deepEqual(fs.readFileSync(f.visible), before);
  assert.equal(fs.existsSync(path.join(result.rollback, "sessions/project/extra.jsonl")), true);
  var retained = JSON.parse(fs.readFileSync(f.keep, "utf8").split("\n")[0]);
  assert.equal(retained.ownerId, "owner");
  var user = JSON.parse(fs.readFileSync(path.join(f.target, "users.json"))).users[0];
  assert.equal(user.id, "owner"); assert.equal(user.pinHash, "preview-auth");
  var config = JSON.parse(fs.readFileSync(path.join(f.target, "daemon-dev.json")));
  assert.equal(config.nativeSessionDiscovery, false);
  assert.equal(config.restoreWorkOnStartup, false);
  assert.equal(config.scheduledExecutionPaused, true);
  assert.equal(config.manageClaudeSettings, false);
  assert.equal(config.coop.leadMode.enabled, false);
  assert.equal(config.projects[0].ownerId, "owner");
});

test("snapshot includes committed WAL rows and does not duplicate an already saved provider conversation", function (t) {
  var f = fixture(t);
  f.session(f.source, "this-conversation", "owner", false);
  fs.mkdirSync(path.join(f.source, "lead"));
  var db = new DatabaseSync(path.join(f.source, "lead/coop-control.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE coop_control_executions(id TEXT); INSERT INTO coop_control_executions VALUES ('committed-in-wal')");
    var result = sync({ source: f.source, target: f.target, keepSession: f.keep, apply: true });
    assert.equal(result.retained, null);
    assert.equal(result.sessionCount, 3);
    var copied = new DatabaseSync(path.join(f.target, "lead/coop-control.sqlite"), { readOnly: true });
    try { assert.equal(copied.prepare("SELECT id FROM coop_control_executions").get().id, "committed-in-wal"); }
    finally { copied.close(); }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coop_control_executions").get().n, 1);
  } finally { db.close(); }
});

test("snapshot preserves orphaned transcript fragments without turning them into additional sessions", function (t) {
  var f = fixture(t);
  var content = JSON.stringify({ type: "result", text: "Original orphaned completion" }) + "\n";
  f.write(f.source, "sessions/project/orphan.jsonl", content);
  var result = sync({ source: f.source, target: f.target, apply: true });
  assert.equal(result.sessionCount, 2);
  assert.deepEqual(result.historyFragments, ["sessions/project/orphan.jsonl"]);
  assert.equal(fs.readFileSync(path.join(f.target, "sessions/project/orphan.jsonl"), "utf8"), content);
  assert.equal(fs.readFileSync(path.join(f.source, "sessions/project/orphan.jsonl"), "utf8"), content);
});

test("preview sync prevents daemon startup until the snapshot writer releases its lock", function (t) {
  var f = fixture(t);
  var lock = require("../lib/preview-sync-lock");
  lock.withLock(f.target, function () {
    assert.throws(function () { lock.assertUnlocked(f.target); }, /snapshot is being prepared/);
    assert.throws(function () { sync({ source: f.source, target: f.target }); }, /EEXIST/);
  });
  assert.doesNotThrow(function () { lock.assertUnlocked(f.target); });
  assert.throws(function () { lock.withLock(f.target, function () { throw new Error("failed copy"); }); }, /failed copy/);
  assert.doesNotThrow(function () { lock.assertUnlocked(f.target); });
});
