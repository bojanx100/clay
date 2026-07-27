var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function loadAppMisc(wsRef) {
  var source = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/app-misc.js"),
    "utf8"
  );
  source = source.replace(/^import .*;\n/gm, "");
  source = [
    "var getWs = function () { return globalThis.__clayTestWs; };",
    "var refreshIcons = function () {};",
    "var iconHtml = function () { return ''; };",
    "var escapeHtml = function (value) { return value; };",
    "var copyToClipboard = function () {};",
    "var updateBrowserTabList = function () {};",
    "var setExtensionConnected = function () {};",
    source
  ].join("\n");
  globalThis.__clayTestWs = wsRef;
  return import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64") +
    "#" + Math.random()
  );
}

test("duplicate MCP advertisements send once and changed state sends again", async function () {
  var sent = [];
  var ws = {
    readyState: 1,
    send: function (payload) { sent.push(JSON.parse(payload)); }
  };
  var appMisc = await loadAppMisc(ws);
  var first = { servers: [], hostConnected: true };

  assert.equal(appMisc.handleMcpServersAdvertisement(first), true);
  assert.equal(appMisc.handleMcpServersAdvertisement({
    servers: [],
    hostConnected: true
  }), false);
  assert.equal(sent.length, 1);

  assert.equal(appMisc.handleMcpServersAdvertisement({
    servers: [],
    hostConnected: false
  }), true);
  assert.equal(sent.length, 2);
});

test("cached MCP advertisement sends once when the WebSocket reconnects", async function () {
  var sent = [];
  var ws = {
    readyState: 0,
    send: function (payload) { sent.push(JSON.parse(payload)); }
  };
  var appMisc = await loadAppMisc(ws);

  assert.equal(appMisc.handleMcpServersAdvertisement({
    servers: [{ name: "local-tools", tools: [] }],
    hostConnected: true
  }), true);
  assert.equal(sent.length, 0);

  ws.readyState = 1;
  appMisc.flushPendingExtMessages();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "mcp_servers_available");

  appMisc.flushPendingExtMessages();
  assert.equal(sent.length, 2);
});
