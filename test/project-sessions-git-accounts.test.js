var test = require("node:test");
var assert = require("node:assert");

var { attachSessions } = require("../lib/project-sessions");

function flushPromises() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function makeHarness(opts) {
  var sent = [];
  var sessions = attachSessions({
    cwd: process.cwd(),
    slug: "test",
    isMate: false,
    osUsers: null,
    currentVersion: "0.0.0",
    sm: {},
    sdk: {},
    tm: null,
    clients: new Set(),
    send: function () {},
    sendTo: function (ws, msg) { sent.push(msg); },
    sendToAdmins: function () {},
    sendToSession: function () {},
    sendToSessionOthers: function () {},
    opts: opts || {},
    usersModule: {},
    userPresence: {},
    pushModule: null,
    getSessionForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return null; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (items) { return items || []; },
    onProcessingChanged: function () {},
    broadcastPresence: function () {},
    adapter: null,
    adapters: {},
    getProjectList: function () { return []; },
    getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; },
    moveScheduleToProject: function () {},
    moveAllSchedulesToProject: function () {},
    getHubSchedules: function () { return []; },
    fetchVersion: function () {},
    isNewer: function () { return false; },
    onCreateWorktree: function () {},
    IGNORED_DIRS: [],
    scheduleMessage: function () {},
    cancelScheduledMessage: function () {},
    getProjectOwnerId: function () { return null; },
    setProjectOwnerId: function () {},
    getUpdateChannel: function () { return "stable"; },
    setUpdateChannel: function () {},
    getLatestVersion: function () { return null; },
    setLatestVersion: function () {},
  });
  return { sessions: sessions, sent: sent, ws: {} };
}

test("list_git_accounts handler accepts a plain object callback result", async function () {
  var h = makeHarness({
    onListGitAccounts: function () {
      return { ok: true, accounts: ["bojantv"] };
    },
  });

  assert.strictEqual(h.sessions.handleSessionsMessage(h.ws, { type: "list_git_accounts" }), true);
  await flushPromises();

  assert.deepStrictEqual(h.sent, [{
    type: "git_accounts_list",
    ok: true,
    accounts: ["bojantv"],
  }]);
});

test("list_git_accounts handler accepts a promise callback result", async function () {
  var h = makeHarness({
    onListGitAccounts: function () {
      return Promise.resolve({ ok: true, accounts: ["one", "two"] });
    },
  });

  assert.strictEqual(h.sessions.handleSessionsMessage(h.ws, { type: "list_git_accounts" }), true);
  await flushPromises();

  assert.deepStrictEqual(h.sent, [{
    type: "git_accounts_list",
    ok: true,
    accounts: ["one", "two"],
  }]);
});

test("list_git_accounts handler converts callback rejection to ok false", async function () {
  var h = makeHarness({
    onListGitAccounts: function () {
      return Promise.reject(new Error("gh failed"));
    },
  });

  assert.strictEqual(h.sessions.handleSessionsMessage(h.ws, { type: "list_git_accounts" }), true);
  await flushPromises();

  assert.deepStrictEqual(h.sent, [{
    type: "git_accounts_list",
    ok: false,
    accounts: [],
  }]);
});

test("list_git_accounts handler reports unsupported when callback is missing", function () {
  var h = makeHarness({});

  assert.strictEqual(h.sessions.handleSessionsMessage(h.ws, { type: "list_git_accounts" }), true);

  assert.deepStrictEqual(h.sent, [{
    type: "git_accounts_list",
    ok: false,
    accounts: [],
  }]);
});
