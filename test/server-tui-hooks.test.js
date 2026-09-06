var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");
var serverTuiHooks = require("../lib/server-tui-hooks");

test("a comparison daemon preserves real native settings in single-user and OS-user modes", function (t) {
  var root = fs.mkdtempSync(path.join(require("os").tmpdir(), "clay-native-settings-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var settingsFiles = ["alice", "bob"].map(function (name) {
    var file = path.join(root, name, ".claude/settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ theme: "dark", permissions: { allow: ["Read", "owner-custom"] },
      hooks: { Notification: [{ matcher: "", hooks: [{ type: "command", command: "owner hook" },
        { type: "command", command: "curl https://127.0.0.1:7292/api/tui-notify # clay:tui-notify" }] }] } }));
    return file;
  });
  var before = settingsFiles.map(function (file) { return fs.readFileSync(file, "utf8"); });
  var stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir);
  var configFile = path.join(stateDir, "daemon-dev.json");
  fs.writeFileSync(configFile, JSON.stringify({ manageClaudeSettings: false }));
  function boot(osUsers) {
    require("child_process").execFileSync(process.execPath, ["-e",
      "require('./lib/server-tui-hooks').installTuiHooks({ portNum:7392, osUsers:" + osUsers + "," +
      "osModule:{homedir:function(){return process.env.CLAY_FIXTURE_HOME+'/alice';}}," +
      "users:{getAllUsers:function(){return [{linuxUser:'alice'},{linuxUser:'bob'}];}}," +
      "osUsersModule:{resolveOsUserInfo:function(name){return {home:process.env.CLAY_FIXTURE_HOME+'/'+name};}}});"],
    { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { CLAY_CONFIG: configFile,
      CLAY_HOME: stateDir, CLAY_DEV: "1", CLAY_FIXTURE_HOME: root }), stdio: "pipe" });
  }
  [false, true].forEach(function (osUsers) {
    boot(osUsers);
    settingsFiles.forEach(function (file, index) { assert.equal(fs.readFileSync(file, "utf8"), before[index]); });
  });
  fs.writeFileSync(configFile, "{}");
  boot(false);
  var active = JSON.parse(fs.readFileSync(settingsFiles[0]));
  var commands = active.hooks.Notification.flatMap(function (group) { return group.hooks.map(function (hook) { return hook.command; }); });
  assert.ok(commands.indexOf("owner hook") !== -1);
  assert.ok(commands.some(function (command) { return command.indexOf("http://127.0.0.1:7392/api/tui-notify") !== -1; }));
  assert.ok(active.permissions.allow.indexOf("owner-custom") !== -1);
  assert.equal(fs.readFileSync(settingsFiles[1], "utf8"), before[1]);
});

test("detached adopted sessions are suppressed until Clay attaches a terminal", function () {
  assert.strictEqual(serverTuiHooks.shouldSuppressDetachedAdoptedSession({
    adopted: true,
    terminalId: null,
    runtimeTerminalId: null,
  }), true);
  assert.strictEqual(serverTuiHooks.shouldSuppressDetachedAdoptedSession({
    adopted: true,
    terminalId: null,
    runtimeTerminalId: 7,
  }), false);
  assert.strictEqual(serverTuiHooks.shouldSuppressDetachedAdoptedSession({
    adopted: false,
    terminalId: null,
    runtimeTerminalId: null,
  }), false);
});

test("both TUI notification emitters apply the adopted-session suppression policy", function () {
  var projectSource = fs.readFileSync(path.join(__dirname, "../lib/project-sessions-tui.js"), "utf8");
  var serverSource = fs.readFileSync(path.join(__dirname, "../lib/server.js"), "utf8");
  assert.match(projectSource, /shouldSuppressDetachedAdoptedSession\(s\)/);
  assert.match(serverSource, /shouldSuppressDetachedAdoptedSession\(s\)/);
});

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
