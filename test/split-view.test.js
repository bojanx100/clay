var test = require("node:test");
var assert = require("node:assert");
var { parseWsRequestUrl } = require("../lib/ws-request");
var fs = require("fs");
var path = require("path");

var paneHelperPromise = null;
function loadPaneHelpers() {
  if (!paneHelperPromise) {
    var file = path.join(__dirname, "../lib/public/modules/pane-session.js");
    var source = fs.readFileSync(file, "utf8");
    paneHelperPromise = import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  }
  return paneHelperPromise;
}

test("pane websocket URL separates path and pane metadata", function () {
  assert.deepStrictEqual(parseWsRequestUrl("/p/clay/ws?pane=1&session=42"), {
    path: "/p/clay/ws",
    pane: true,
    paneSession: 42,
  });
});

test("normal websocket URL stays non-pane", function () {
  assert.deepStrictEqual(parseWsRequestUrl("/p/clay/ws"), {
    path: "/p/clay/ws",
    pane: false,
    paneSession: null,
  });
});

test("invalid pane session metadata is ignored", function () {
  assert.strictEqual(parseWsRequestUrl("/ws?pane=1&session=deleted").paneSession, null);
  assert.strictEqual(parseWsRequestUrl("/ws?pane=1&session=-2").paneSession, null);
  assert.strictEqual(parseWsRequestUrl("/ws?pane=1&session=42x").paneSession, null);
});

test("pane session pin resolves once when the session is accessible", async function () {
  var helpers = await loadPaneHelpers();
  assert.deepStrictEqual(helpers.resolvePaneSession(true, true, 42, [{ id: 41 }, { id: 42 }]), {
    consumed: true,
    sessionId: 42,
  });
});

test("missing pane session is consumed without a fallback", async function () {
  var helpers = await loadPaneHelpers();
  assert.deepStrictEqual(helpers.resolvePaneSession(true, true, 42, [{ id: 41 }]), {
    consumed: true,
    sessionId: null,
  });
});

test("pane session pin waits until the current websocket marks it pending", async function () {
  var helpers = await loadPaneHelpers();
  assert.deepStrictEqual(helpers.resolvePaneSession(true, false, 42, [{ id: 42 }]), {
    consumed: false,
    sessionId: null,
  });
});
