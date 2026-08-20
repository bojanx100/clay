var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

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
    setInterval: function () {
      return nextId++;
    },
    clearInterval: function () {},
    advanceTo: function (target) {
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

function FakeWebSocket(url) {
  this.url = url;
  this.readyState = 1;
  this.closeCount = 0;
  this.sent = [];
  FakeWebSocket.instances.push(this);
}

FakeWebSocket.instances = [];

FakeWebSocket.prototype.send = function (payload) {
  this.sent.push(payload);
};

FakeWebSocket.prototype.close = function () {
  this.closeCount++;
  this.readyState = 3;
  if (this.onclose) this.onclose({});
};

function loadConnection(state) {
  var source = fs.readFileSync(path.join(
    __dirname, "..", "lib", "public", "modules", "app-connection.js"), "utf8");
  source = source.replace(/^import .*;\n/gm, "");
  source = [
    "var state = globalThis.__clayConnectionTest;",
    "var store = state.store;",
    "var notifyCoopReconnect = function () { state.reconnectNotices++; };",
    "var getWs = function () { return state.ws; };",
    "var setWs = function (ws) { state.ws = ws; };",
    "var decideSocketAction = function (readyState) { return readyState === 1 ? 'send' : 'reconnect'; };",
    "var initialSessionReference = function () { return null; };",
    "var projectSessionIdForSync = function () { return null; };",
    "var shouldProbeLiveness = function () { return false; };",
    "var shouldProcessSocketMessage = function (received, current) { return received === current; };",
    "var getStatusDot = function () { return null; };",
    "var getSendBtn = function () { return null; };",
    "var setSendBtnMode = function () {};",
    "var blinkIO = function () {};",
    "var setActivity = function () {};",
    "var startLogoAnimation = function () {};",
    "var stopLogoAnimation = function () {};",
    "var hasSendableContent = function () { return false; };",
    "var processMessage = function () {};",
    "var flushPendingExtMessages = function () { state.extensionFlushes++; };",
    "var resetTerminals = function () {};",
    "var closeDmUserPicker = function () {};",
    "var openDm = function () {};",
    "var readTabSession = function () { return null; };",
    "var readUrlSessionRef = function () { return null; };",
    "var sendCorrelatedAction = function (ws, obj) { ws.send(JSON.stringify(obj)); return true; };",
    "var WebSocket = state.WebSocket;",
    "var setTimeout = state.clock.setTimeout;",
    "var clearTimeout = state.clock.clearTimeout;",
    "var setInterval = state.clock.setInterval;",
    "var clearInterval = state.clock.clearInterval;",
    source
  ].join("\n");
  globalThis.__clayConnectionTest = state;
  globalThis.window = {};
  globalThis.location = { protocol: "https:", host: "clay.test" };
  globalThis.localStorage = { removeItem: function () {} };
  return import("data:text/javascript;base64," +
    Buffer.from(source).toString("base64") + "#" + Math.random());
}

test("an OPEN socket activates instead of being retried after the handshake deadline", async function () {
  FakeWebSocket.instances = [];
  var clock = createClock();
  var values = {
    wsPath: "/p/clay/ws",
    currentSlug: "clay",
    connected: false,
    processing: false,
  };
  var state = {
    clock: clock,
    WebSocket: FakeWebSocket,
    ws: null,
    reconnectNotices: 0,
    extensionFlushes: 0,
    store: {
      get: function (key) { return values[key]; },
      set: function (partial) { Object.assign(values, partial); },
    },
  };
  var connection = await loadConnection(state);

  connection.connect();
  var socket = FakeWebSocket.instances[0];
  clock.advanceTo(3000);

  assert.equal(values.connected, true,
    "an already OPEN socket must enter the connected state at the deadline");
  assert.equal(socket.closeCount, 0,
    "the timeout must not discard an established WebSocket");
  assert.equal(state.extensionFlushes, 1,
    "connection activation re-registers the cached browser extension");
  socket.onopen();
  assert.equal(state.extensionFlushes, 1,
    "the queued native open event must not register the extension twice");
});
