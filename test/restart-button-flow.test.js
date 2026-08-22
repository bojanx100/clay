var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var projectSessionsConfig = require("../lib/project-sessions-config");

function createClock() {
  var now = 0;
  var nextId = 1;
  var timers = {};
  return {
    setTimeout: function (fn, delay) {
      var id = nextId++;
      timers[id] = { fn: fn, at: now + delay };
      return id;
    },
    clearTimeout: function (id) {
      delete timers[id];
    },
    advance: function (ms) {
      var target = now + ms;
      var due = Object.keys(timers).filter(function (id) {
        return timers[id].at <= target;
      }).sort(function (a, b) {
        return timers[a].at - timers[b].at;
      });
      for (var i = 0; i < due.length; i++) {
        var timer = timers[due[i]];
        delete timers[due[i]];
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

function classList(node, initial) {
  var values = String(initial || "").split(/\s+/).filter(Boolean);
  function sync() { node.className = values.join(" "); }
  return {
    add: function (name) {
      if (values.indexOf(name) === -1) values.push(name);
      sync();
    },
    remove: function (name) {
      values = values.filter(function (value) { return value !== name; });
      sync();
    },
    contains: function (name) {
      return values.indexOf(name) !== -1;
    },
  };
}

function element(id, initialClass) {
  var node = {
    id: id,
    className: initialClass || "",
    listeners: {},
    textContent: "",
    innerHTML: "",
    disabled: false,
  };
  node.classList = classList(node, initialClass);
  node.addEventListener = function (type, handler) {
    node.listeners[type] = (node.listeners[type] || []).concat(handler);
  };
  node.click = function () {
    var handlers = node.listeners.click || [];
    for (var i = 0; i < handlers.length; i++) handlers[i]({ preventDefault: function () {} });
  };
  return node;
}

function clientHarness() {
  var button = element("settings-restart-btn", "");
  button.textContent = "Restart";
  var message = element("settings-restart-error", "settings-hint settings-restart-error hidden");
  var elements = {
    "settings-restart-btn": button,
    "settings-restart-error": message,
  };
  return {
    button: button,
    message: message,
    clock: createClock(),
    sent: [],
    toasts: [],
    iconRefreshes: 0,
    document: {
      getElementById: function (id) { return elements[id] || null; },
    },
  };
}

async function loadRestartClient(state) {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules",
    "server-restart.js"), "utf8");
  source = source.replace(/^import .*;\n/gm, "");
  source = source.replace(/export /g, "");
  source = [
    "var state = globalThis.__clayRestartButtonTest;",
    "var document = state.document;",
    "var setTimeout = state.clock.setTimeout;",
    "var clearTimeout = state.clock.clearTimeout;",
    "var refreshIcons = function () { state.iconRefreshes++; };",
    "var showToast = function (message, level, detail) { state.toasts.push({ message: message, level: level, detail: detail }); };",
    source,
    "export { initRestartControls, resetRestartButton, handleRestartResult };",
  ].join("\n");
  globalThis.__clayRestartButtonTest = state;
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64") +
    "#" + Date.now() + Math.random());
}

function serverHarness(onRestart) {
  var sent = [];
  var broadcast = [];
  var handler = projectSessionsConfig.attachProjectSessionsConfig({
    currentVersion: "test",
    sm: { sessions: new Map() },
    tm: { list: function () { return []; } },
    clients: new Set(),
    send: function (message) { broadcast.push(message); },
    sendTo: function (ws, message) { sent.push({ ws: ws, message: message }); },
    sendToAdmins: function () {},
    opts: { onRestart: onRestart },
    usersModule: { isMultiUser: function () { return false; } },
    fetchVersion: function () { return Promise.resolve(null); },
    isNewer: function () { return false; },
    getUpdateChannel: function () { return "stable"; },
    setUpdateChannel: function () {},
    getLatestVersion: function () { return null; },
    setLatestVersion: function () {},
  });
  return { handler: handler, sent: sent, broadcast: broadcast };
}

test("restart button click dispatches the daemon command and shows accepted then stale-runtime failure", async function () {
  var h = clientHarness();
  var restart = await loadRestartClient(h);
  var ws = {
    readyState: 1,
    send: function (payload) { h.sent.push(JSON.parse(payload)); },
  };

  restart.initRestartControls({ get ws() { return ws; } });
  h.button.click();

  assert.deepEqual(h.sent, [{ type: "restart_server" }]);
  assert.equal(h.button.disabled, true);
  assert.equal(h.button.textContent, "Restarting...");
  assert.equal(h.message.classList.contains("hidden"), true);

  restart.handleRestartResult({ ok: true });
  assert.equal(h.button.textContent, "Server restarting...");
  assert.equal(h.message.classList.contains("hidden"), false);
  assert.match(h.message.textContent, /Waiting for this browser to reconnect/);
  assert.equal(h.message.classList.contains("settings-restart-failed"), false);

  h.clock.advance(30000);
  assert.equal(h.button.disabled, false);
  assert.match(h.button.innerHTML, /Restart/);
  assert.match(h.message.textContent, /did not reconnect to a fresh daemon/);
  assert.equal(h.message.classList.contains("settings-restart-failed"), true);
});

test("restart button surfaces a visible error when no WebSocket is open", async function () {
  var h = clientHarness();
  var restart = await loadRestartClient(h);

  restart.initRestartControls({ ws: { readyState: 3, send: function () { h.sent.push("sent"); } } });
  h.button.click();

  assert.deepEqual(h.sent, []);
  assert.equal(h.button.disabled, false);
  assert.equal(h.message.classList.contains("hidden"), false);
  assert.match(h.message.textContent, /not connected to the Clay daemon/);
  assert.equal(h.message.classList.contains("settings-restart-failed"), true);
});

test("restart button surfaces a visible error when the daemon never acknowledges", async function () {
  var h = clientHarness();
  var restart = await loadRestartClient(h);

  restart.initRestartControls({
    ws: {
      readyState: 1,
      send: function (payload) { h.sent.push(JSON.parse(payload)); },
    },
  });
  h.button.click();
  h.clock.advance(8000);

  assert.deepEqual(h.sent, [{ type: "restart_server" }]);
  assert.equal(h.button.disabled, false);
  assert.match(h.message.textContent, /did not acknowledge/);
  assert.equal(h.message.classList.contains("settings-restart-failed"), true);
});

test("restart_server handler returns the daemon restart hook refusal to the requesting UI", async function () {
  var called = 0;
  var h = serverHarness(function () {
    called++;
    return {
      ok: false,
      code: "COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
      error: "Controlled execution checkpoint is unavailable.",
    };
  });
  var ws = {};

  assert.equal(h.handler.handleConfigMessage(ws, { type: "restart_server" }), true);
  await Promise.resolve();

  assert.equal(called, 1);
  assert.deepEqual(h.sent, [{
    ws: ws,
    message: {
      type: "restart_server_result",
      ok: false,
      error: "Controlled execution checkpoint is unavailable.",
      code: "COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
    },
  }]);
  assert.deepEqual(h.broadcast, []);
});

test("restart_server handler reports accepted queued restarts instead of a bare acknowledgement", async function () {
  var called = 0;
  var h = serverHarness(function () {
    called++;
    return { ok: true, pending: true, activeProviderTools: 2 };
  });
  var ws = {};

  assert.equal(h.handler.handleConfigMessage(ws, { type: "restart_server" }), true);
  await Promise.resolve();

  assert.equal(called, 1);
  assert.deepEqual(h.sent, [{
    ws: ws,
    message: {
      type: "restart_server_result",
      ok: true,
      pending: true,
      activeProviderTools: 2,
    },
  }]);
  assert.deepEqual(h.broadcast, [{
    type: "toast",
    level: "info",
    message: "Restart queued until active provider tools finish.",
  }]);
});
