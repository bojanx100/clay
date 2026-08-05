var test = require("node:test");
var assert = require("node:assert/strict");

async function handlers() {
  return import("../lib/public/modules/app-messages-debate-handlers.js");
}

test("debate dispatch recognizes known messages and returns false for unknown messages", async function () {
  var client = await handlers();
  var calls = [];

  assert.equal(client.dispatchDebateMessage({ type: "debate_started" }, {
    debate_started: function () { calls.push("started"); },
  }), true);
  assert.equal(client.dispatchDebateMessage({ type: "unrelated" }, {}), false);
  assert.equal(client.dispatchDebateMessage({ type: "constructor" }, {}), false);
  assert.deepEqual(calls, ["started"]);
});

test("debate history routing selects replay rendering and preserves callback order", async function () {
  var client = await handlers();
  var events = [];
  var msg = { type: "debate_ended", id: "history-entry" };

  client.routeDebateHistory(msg, true,
    function (entry) { events.push("replay:" + entry.id); },
    function (entry) { events.push("live:" + entry.id); });
  assert.deepEqual(events, ["replay:history-entry"]);

  client.routeDebateHistory(msg, false,
    function (entry) { events.push("replay:" + entry.id); },
    function (entry) { events.push("live:" + entry.id); });
  assert.deepEqual(events, ["replay:history-entry", "live:history-entry"]);
});

test("debate live-only routing suppresses sticky and pause actions during history replay", async function () {
  var client = await handlers();
  var events = [];
  var msg = { type: "debate_pause_state", paused: true };

  client.routeDebateLive(msg, true, function () { events.push("live"); });
  assert.deepEqual(events, []);
  client.routeDebateLive(msg, false, function (entry) {
    events.push(entry.paused ? "live-paused" : "live");
  });
  assert.deepEqual(events, ["live-paused"]);
});
