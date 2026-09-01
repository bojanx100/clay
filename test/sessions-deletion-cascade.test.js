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

test("hiding a session stops its live runtime immediately without deleting it", function () {
  var sessions = new Map();
  var aborted = false;
  var queryClosed = false;
  var queueEnded = false;
  var workerKilled = false;
  var session = {
    localId: 1,
    storageId: "live-1",
    isProcessing: true,
    autoContinueTimer: setTimeout(function () {}, 100000),
    scheduledMessage: { timer: setTimeout(function () {}, 100000) },
    _providerFailoverTimer: setTimeout(function () {}, 100000),
    abortController: { abort: function () { aborted = true; } },
    queryInstance: { close: function () { queryClosed = true; } },
    messageQueue: { end: function () { queueEnded = true; } },
    worker: { kill: function () { workerKilled = true; } },
  };
  sessions.set(1, session);

  var saved = [];
  var api = sessionsDeletion.attachSessionDeletion(makeCtx(sessions, saved));
  api.hideSession(1, null);

  // Runtime is fully stopped.
  assert.strictEqual(aborted, true, "in-flight turn aborted");
  assert.strictEqual(queryClosed, true, "query stream closed");
  assert.strictEqual(queueEnded, true, "message queue ended");
  assert.strictEqual(workerKilled, true, "worker process killed");
  assert.strictEqual(session.taskStopRequested, true);
  assert.strictEqual(session.isProcessing, false);
  assert.strictEqual(session.queryInstance, null);
  assert.strictEqual(session.worker, null);
  assert.strictEqual(session.autoContinueTimer, null);
  assert.strictEqual(session.scheduledMessage, null);
  assert.strictEqual(session._providerFailoverTimer, null);

  // But the session survives and stays resumable (not deleted, not tombstoned).
  assert.strictEqual(session.hidden, true);
  assert.strictEqual(sessions.get(1), session);
  assert.strictEqual(session._deleted, undefined);
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

test("Coop home and project channels cannot be hidden or deleted through deletion APIs", function () {
  var sessions = new Map();
  var home = { localId: 1, storageId: "coop-home", coopHome: true };
  var channel = { localId: 2, storageId: "coop-webapp", coopChannel: { projectSlug: "webapp" } };
  var ordinary = { localId: 3, storageId: "ordinary" };
  sessions.set(home.localId, home);
  sessions.set(channel.localId, channel);
  sessions.set(ordinary.localId, ordinary);

  var saved = [];
  var api = sessionsDeletion.attachSessionDeletion(makeCtx(sessions, saved));
  api.hideSession(home.localId, null);
  api.hideSessionForActiveClients(home.localId);
  api.deleteSession(home.localId, null);
  api.deleteSessionQuiet(home.localId);
  api.hideSession(channel.localId, null);
  api.deleteSession(channel.localId, null);
  api.deleteSessionsBulk([home.localId, channel.localId, ordinary.localId], null);

  assert.strictEqual(home.hidden, undefined);
  assert.strictEqual(sessions.get(home.localId), home);
  assert.strictEqual(channel.hidden, undefined);
  assert.strictEqual(sessions.get(channel.localId), channel);
  assert.strictEqual(sessions.has(ordinary.localId), false);
  assert.strictEqual(saved.indexOf(home), -1);
});

test("deleting a Coop-controlled worker archives it without removing its transcript", function () {
  var sessions = new Map();
  var worker = {
    localId: 11,
    storageId: "controlled-worker",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1000 },
    history: [{ type: "user_message", text: "delegated work" }],
  };
  var bulkWorker = {
    localId: 12,
    storageId: "bulk-controlled-worker",
    orchestrationParent: { taskId: "task-12", sessionStorageId: "coordinator" },
    history: [{ type: "delta", text: "worker answer" }],
  };
  sessions.set(worker.localId, worker);
  sessions.set(bulkWorker.localId, bulkWorker);

  var saved = [];
  var api = sessionsDeletion.attachSessionDeletion(makeCtx(sessions, saved));
  api.deleteSession(worker.localId, null);
  api.deleteSessionsBulk([bulkWorker.localId], null);

  assert.strictEqual(sessions.get(worker.localId), worker);
  assert.strictEqual(worker.hidden, true);
  assert.strictEqual(sessions.get(bulkWorker.localId), bulkWorker);
  assert.strictEqual(bulkWorker.hidden, true);
  assert.ok(saved.indexOf(worker) !== -1, "the individually archived worker is persisted");
  assert.ok(saved.indexOf(bulkWorker) !== -1, "the bulk-archived worker is persisted");
});

test("background projection hide closes clients viewing the now-hidden session", function () {
  var sessions = new Map();
  var aborted = false;
  var hidden = {
    localId: 7,
    storageId: "hidden-projection",
    abortController: { abort: function () { aborted = true; } },
  };
  sessions.set(hidden.localId, hidden);

  var activeClient = { readyState: 1, _clayActiveSession: hidden.localId };
  var otherClient = { readyState: 1, _clayActiveSession: 9 };
  var clients = [activeClient, otherClient];
  var messages = [];
  var broadcasts = 0;
  var saved = [];
  var ctx = makeCtx(sessions, saved);
  ctx.sendTo = function (ws, message) { messages.push({ ws: ws, message: message }); };
  ctx.sendEach = function (callback) {
    for (var i = 0; i < clients.length; i++) callback(clients[i]);
  };
  ctx.broadcastSessionList = function () { broadcasts++; };

  var api = sessionsDeletion.attachSessionDeletion(ctx);
  api.hideSession(hidden.localId, null, { projectionOnly: true });

  assert.strictEqual(hidden.hidden, true);
  assert.strictEqual(aborted, false, "projection cleanup does not stop the session runtime");
  assert.strictEqual(activeClient._clayActiveSession, null,
    "a client cannot remain attached to a session removed from its sidebar");
  assert.strictEqual(otherClient._clayActiveSession, 9);
  assert.deepStrictEqual(messages, [{
    ws: activeClient,
    message: { type: "session_closed", id: hidden.localId },
  }]);
  assert.strictEqual(broadcasts, 1);
});
