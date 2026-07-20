var test = require("node:test");
var assert = require("node:assert/strict");
var sessionHistory = require("../lib/sessions-history");

function makeToolHeavyHistory(eventCount) {
  var history = [
    { type: "user_message", text: "Do the work" },
  ];
  for (var i = 0; i < eventCount; i++) {
    history.push({
      type: i % 2 === 0 ? "tool_start" : "tool_result",
      id: "tool-" + Math.floor(i / 2),
    });
  }
  return history;
}

test("history boundary preserves a nearby user turn", function () {
  var history = makeToolHeavyHistory(40);
  history.push({ type: "user_message", text: "Latest request" });
  for (var i = 0; i < 20; i++) history.push({ type: "delta", text: "x" });

  assert.equal(sessionHistory.findTurnBoundary(history, history.length - 10), 41);
});

test("history boundary does not expand a page across an unbounded tool-heavy turn", function () {
  var history = makeToolHeavyHistory(1605);
  var targetIndex = history.length - sessionHistory.HISTORY_PAGE_SIZE;

  assert.equal(sessionHistory.findTurnBoundary(history, targetIndex), targetIndex);
});

test("default history replay stays bounded for a tool-heavy turn", function () {
  var sent = [];
  var api = sessionHistory.attachSessionHistory({
    send: function (msg) { sent.push(msg); },
    isMeaninglessUnknownError: function () { return false; },
  });
  var history = makeToolHeavyHistory(1605);

  api.replayHistory({ history: history });

  var meta = sent[0];
  assert.equal(meta.type, "history_meta");
  assert.equal(meta.from, history.length - sessionHistory.HISTORY_PAGE_SIZE);
  assert.equal(sent.length, sessionHistory.HISTORY_PAGE_SIZE + 2);
  assert.equal(sent[sent.length - 1].type, "history_done");
});
