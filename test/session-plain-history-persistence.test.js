var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var home = require("./helpers/isolated-clay-home");
var createManager = require("../lib/sessions").createSessionManager;
var persistence = require("../lib/sessions-persistence");
var historyStore = require("../lib/sessions-history-store");

function fixture() {
  var cwd = fs.mkdtempSync(path.join(home, "plain-history-"));
  var options = { cwd: cwd, send: function () {} };
  var sm = createManager(options);
  var session = sm.getActiveSession();
  assert.equal(historyStore.isLazy(session), false, "new sessions use ordinary arrays");
  assert.equal(sm.saveSessionFile(session, { durable: true }), true);
  return { sm: sm, session: session, options: options,
    disk: function () {
      return fs.readFileSync(path.join(sm.sessionsDir, session.storageId + ".jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).filter(function (item) { return item.type !== "meta"; });
    } };
}

test("a durable save persists additions and removals from a plain history array without metadata changes", function () {
  var f = fixture();
  var first = { type: "user_message", text: "Keep this owner request", _ts: 1000 };
  var done = { type: "done", code: 0, _ts: 1001 };
  var second = { type: "user_message", text: "Remove this draft", _ts: 2000 };
  f.session.history.push(first, done, second);
  assert.equal(f.sm.saveSessionFile(f.session, { durable: true }), true);
  assert.deepEqual(f.disk(), [first, done, second]);
  f.session.history.pop();
  assert.equal(f.sm.saveSessionFile(f.session, { durable: true }), true);
  assert.deepEqual(f.disk(), [first, done]);
  var restarted = createManager(f.options);
  var restored = Array.from(restarted.sessions.values()).find(function (session) {
    return session.storageId === f.session.storageId;
  });
  assert.ok(restored);
  assert.deepEqual(restored.history, [first, done]);
});

test("shutdown flush persists a coalesced plain-array addition", function () {
  var f = fixture();
  var event = { type: "user_message", text: "Persist this queued request", _ts: 1000 };
  f.session.history.push(event);
  f.session._lastSaveDurMs = 50;
  f.session._lastSaveBytes = 600 * 1024;
  f.session._lastSaveAt = Date.now();
  assert.equal(f.sm.saveSessionFile(f.session), persistence.SAVE_QUEUED);
  assert.deepEqual(f.disk(), []);
  assert.equal(persistence.flushPendingCoalescedSaves(f.sm), 1);
  assert.deepEqual(f.disk(), [event]);
});
