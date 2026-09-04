var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

test("composer transport refuses a closing socket and reports the send failure", async function () {
  var wsRef = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "ws-ref.js")).href + "?transport-test=" + Date.now());
  var failures = 0;
  wsRef.setWsSendFailureHandler(function () { failures++; });
  wsRef.setWs({ readyState: 2, send: function () { throw new Error("must not send"); } });
  assert.equal(wsRef.sendWsJson({ type: "message", text: "lost" }), false);
  assert.equal(failures, 1);

  var sent = [];
  wsRef.setWs({ readyState: 1, send: function (value) { sent.push(value); } });
  assert.equal(wsRef.sendWsJson({ type: "message", text: "delivered" }), true);
  assert.deepEqual(JSON.parse(sent[0]), { type: "message", text: "delivered" });
});
