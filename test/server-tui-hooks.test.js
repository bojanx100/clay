var test = require("node:test");
var assert = require("node:assert");
var serverTuiHooks = require("../lib/server-tui-hooks");

function createInstaller(calls) {
  return {
    CLAY_MANAGED_ALLOW: ["managed"],
    installNotificationHook: function (opts) {
      calls.notification.push(opts);
      return { installed: [], errors: [] };
    },
    installAllowList: function (opts) {
      calls.allow.push(opts);
      return { installed: [], errors: [] };
    },
  };
}

test("installTuiHooks uses local HTTP notify URL and single-user allow list", function () {
  var calls = { notification: [], allow: [] };
  var users = {
    getAllUsers: function () {
      return [{ id: "u1" }];
    },
    getClaudeUserAllowList: function () {
      return ["custom"];
    },
  };

  serverTuiHooks.installTuiHooks({
    portNum: 2633,
    users: users,
    claudeHookInstaller: createInstaller(calls),
    osModule: { homedir: function () { return "/home/me"; } },
  });

  assert.strictEqual(calls.notification[0].notifyUrl, "http://127.0.0.1:2633/api/tui-notify");
  assert.deepStrictEqual(calls.notification[0].homeDirs, ["/home/me"]);
  assert.deepStrictEqual(calls.allow[0].homeDirs, ["/home/me"]);
  assert.deepStrictEqual(calls.allow[0].patterns, ["managed", "custom"]);
});

test("installTuiHooks installs per-linux-user hooks when OS users are enabled", function () {
  var calls = { notification: [], allow: [] };
  var users = {
    getAllUsers: function () {
      return [
        { id: "u1", linuxUser: "alice" },
        { id: "u2", linuxUser: "bob" },
      ];
    },
    getClaudeUserAllowList: function (userId) {
      return [userId + "-custom"];
    },
  };
  var osUsersModule = {
    resolveOsUserInfo: function (name) {
      return { home: "/home/" + name };
    },
  };

  serverTuiHooks.installTuiHooks({
    tlsOptions: { key: "x" },
    portNum: 9443,
    osUsers: true,
    users: users,
    claudeHookInstaller: createInstaller(calls),
    osUsersModule: osUsersModule,
    osModule: { homedir: function () { return "/home/fallback"; } },
  });

  assert.strictEqual(calls.notification[0].notifyUrl, "https://127.0.0.1:9443/api/tui-notify");
  assert.deepStrictEqual(calls.notification[0].homeDirs, ["/home/alice", "/home/bob"]);
  assert.deepStrictEqual(calls.allow[0].homeDirs, ["/home/alice"]);
  assert.deepStrictEqual(calls.allow[0].patterns, ["managed", "u1-custom"]);
  assert.deepStrictEqual(calls.allow[1].homeDirs, ["/home/bob"]);
  assert.deepStrictEqual(calls.allow[1].patterns, ["managed", "u2-custom"]);
});
