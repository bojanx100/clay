var test = require("node:test");
var assert = require("node:assert");
var os = require("os");
var path = require("path");

process.env.CLAY_HOME = path.join(os.tmpdir(), "clay-test-deletion-cascade-" + process.pid);

var sessionsDeletion = require("../lib/sessions-deletion");

function makeCtx(sessions, saved) {
  return {
    cwd: null,
    sessions: sessions,
    send: function () {},
    sendTo: function () {},
    sendEach: null,
    getSingleUserUnread: function () { return {}; },
    getSessionStorageId: function (s) { return s.storageId || null; },
    sessionFilePath: function (id) { return path.join(os.tmpdir(), id + ".jsonl"); },
    saveSessionFile: function (s) { saved.push(s); },
    getActiveSessionId: function () { return null; },
    setActiveSessionId: function () {},
    switchSession: function () {},
    createSession: function () {},
    broadcastSessionList: function () {},
    mostRecentVisibleSessionForWs: function () { return null; },
  };
}

test("hiding a coordinator cascades hidden to its worker sessions", function () {
  var sessions = new Map();
  var coordinator = {
    localId: 1,
    storageId: "coord-1",
    coordinationMode: true,
    orchestrationTasks: [
      { workerSessionId: 2, workerStorageId: "worker-2", status: "completed" },
      { workerSessionId: 3, workerStorageId: "worker-3", status: "completed" },
    ],
  };
  var workerA = { localId: 2, storageId: "worker-2" };
  var workerB = { localId: 3, storageId: "worker-3" };
  sessions.set(1, coordinator);
  sessions.set(2, workerA);
  sessions.set(3, workerB);

  var saved = [];
  var api = sessionsDeletion.attachSessionDeletion(makeCtx(sessions, saved));
  api.hideSession(1, null);

  assert.strictEqual(coordinator.hidden, true);
  assert.strictEqual(workerA.hidden, true);
  assert.strictEqual(workerB.hidden, true);
  assert.ok(saved.indexOf(workerA) !== -1, "worker A persisted");
  assert.ok(saved.indexOf(workerB) !== -1, "worker B persisted");
});

test("cascade resolves workers by storage id when localId is stale", function () {
  var sessions = new Map();
  var coordinator = {
    localId: 1,
    storageId: "coord-1",
    coordinationMode: true,
    // Stale localId (99) from a previous daemon run; storage id still valid.
    orchestrationTasks: [{ workerSessionId: 99, workerStorageId: "worker-2", status: "completed" }],
  };
  var worker = { localId: 7, storageId: "worker-2" };
  sessions.set(1, coordinator);
  sessions.set(7, worker);

  var saved = [];
  var api = sessionsDeletion.attachSessionDeletion(makeCtx(sessions, saved));
  api.hideSession(1, null);

  assert.strictEqual(worker.hidden, true);
});

test("hiding a plain session does not touch other sessions", function () {
  var sessions = new Map();
  var plain = { localId: 1, storageId: "plain-1" };
  var other = { localId: 2, storageId: "other-2" };
  sessions.set(1, plain);
  sessions.set(2, other);

  var saved = [];
  var api = sessionsDeletion.attachSessionDeletion(makeCtx(sessions, saved));
  api.hideSession(1, null);

  assert.strictEqual(plain.hidden, true);
  assert.strictEqual(other.hidden, undefined);
});

test("the Coop home cannot be hidden or deleted through deletion APIs", function () {
  var sessions = new Map();
  var home = { localId: 1, storageId: "coop-home", coopHome: true };
  var ordinary = { localId: 2, storageId: "ordinary" };
  sessions.set(home.localId, home);
  sessions.set(ordinary.localId, ordinary);

  var saved = [];
  var api = sessionsDeletion.attachSessionDeletion(makeCtx(sessions, saved));
  api.hideSession(home.localId, null);
  api.hideSessionForActiveClients(home.localId);
  api.deleteSession(home.localId, null);
  api.deleteSessionQuiet(home.localId);
  api.deleteSessionsBulk([home.localId, ordinary.localId], null);

  assert.strictEqual(home.hidden, undefined);
  assert.strictEqual(sessions.get(home.localId), home);
  assert.strictEqual(sessions.has(ordinary.localId), false);
  assert.strictEqual(saved.indexOf(home), -1);
});
