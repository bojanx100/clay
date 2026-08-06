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

test("default history replay includes multiple complete recent turns", function () {
  var sent = [];
  var api = sessionHistory.attachSessionHistory({
    send: function (msg) { sent.push(msg); },
    isMeaninglessUnknownError: function () { return false; },
  });
  var history = [{ type: "user_message", text: "Earlier request" }];
  for (var i = 0; i < 340; i++) history.push({ type: "delta", text: "x" });
  history.push({ type: "user_message", text: "Latest request" });
  for (var j = 0; j < 170; j++) history.push({ type: "delta", text: "y" });

  api.replayHistory({ history: history });

  assert.equal(sent[0].type, "history_meta");
  assert.equal(sent[0].from, 0, "stream deltas should not crowd the earlier complete turn out of the initial view");
  assert.equal(sent.filter(function (msg) { return msg.type === "user_message"; }).length, 2);
});

test("history replay hides model-only coordinator envelopes", function () {
  var sent = [];
  var api = sessionHistory.attachSessionHistory({
    send: function (msg) { sent.push(msg); },
    isMeaninglessUnknownError: function () { return false; },
  });
  api.replayHistory({
    history: [
      { type: "user_message", text: "Visible request" },
      { type: "user_message", text: "[Clay coordinator mode]", internalOnly: true },
      { type: "delta", text: "Visible coordinator response" },
    ],
  });

  assert.equal(sent.some(function (msg) { return msg.text === "[Clay coordinator mode]"; }), false);
  assert.equal(sent.some(function (msg) { return msg.text === "Visible request"; }), true);
  assert.equal(sent.some(function (msg) { return msg.text === "Visible coordinator response"; }), true);
});

test("indexed history replay stays bounded, addressable, and leaves canonical events immutable", function () {
  var sent = [];
  var api = sessionHistory.attachSessionHistory({
    send: function (msg) { sent.push(msg); },
    isMeaninglessUnknownError: function () { return false; },
  });
  var history = [];
  var indexes = [];
  for (var i = 0; i < 700; i++) {
    history.push({ type: i % 4 === 0 ? "user_message" : "delta", text: "event-" + i });
    if (i % 2 === 0) indexes.push(i);
  }

  api.replayHistory({ history: history }, undefined, undefined, null, {
    eventIndexes: indexes,
    scope: "topic",
    topicRef: { topicId: "topic-1" },
    projectRef: { projectId: "project-1" },
    annotateHistoryIndex: true,
  });

  assert.equal(sent[0].type, "history_meta");
  assert.equal(sent[0].scope, "topic");
  assert.equal(sent[0].total, 350);
  assert.equal(sent[0].canonicalTotal, 700);
  assert.deepEqual(sent[0].topicRef, { topicId: "topic-1" });
  var replayed = sent.filter(function (msg) { return Number.isInteger(msg._historyIndex); });
  assert.equal(replayed.length <= sessionHistory.HISTORY_PAGE_SIZE, true);
  assert.equal(replayed.every(function (msg) { return msg._historyIndex % 2 === 0; }), true);
  assert.equal(Object.prototype.hasOwnProperty.call(history[698], "_historyIndex"), false);
  assert.equal(sent[sent.length - 1].type, "history_done");
  assert.equal(sent[sent.length - 1].scope, "topic");
});

test("focused canonical replay includes and annotates the exact original event", function () {
  var sent = [];
  var api = sessionHistory.attachSessionHistory({
    send: function (msg) { sent.push(msg); },
    isMeaninglessUnknownError: function () { return false; },
  });
  var history = makeToolHeavyHistory(800);

  api.replayHistory({ history: history }, undefined, undefined, null, {
    focusEventIndex: 410,
    annotateHistoryIndex: true,
  });

  assert.equal(sent[0].focusEventIndex, 410);
  assert.equal(sent.some(function (msg) { return msg._historyIndex === 410; }), true);
  assert.equal(sent.filter(function (msg) { return Number.isInteger(msg._historyIndex); }).length <= sessionHistory.HISTORY_PAGE_SIZE, true);
});

test("indexed history pagination uses logical offsets without leaking canonical events", function () {
  var history = [];
  var indexes = [];
  for (var i = 0; i < 900; i++) {
    history.push({ type: i % 6 === 0 ? "user_message" : "delta", text: "event-" + i });
    if (i % 2 === 0) indexes.push(i);
  }
  history[100].internalOnly = true;

  var page = sessionHistory.indexedHistoryPage(history, indexes, 350, 40, null, {
    scope: "topic",
    topicRef: { topicId: "bounded-topic" },
    projectRef: { projectId: "bounded-project" },
    annotateHistoryIndex: true,
  });

  assert.equal(page.meta.scope, "topic");
  assert.equal(page.meta.to, 350);
  assert.equal(page.meta.from >= 0 && page.meta.from <= 40, true);
  assert.equal(page.meta.hasMore, true);
  assert.equal(page.meta.canonicalTotal, 900);
  assert.equal(page.items.every(function (item) { return item._historyIndex % 2 === 0; }), true);
  assert.equal(page.items.some(function (item) { return item._historyIndex === 100; }), false);
  assert.equal(Object.prototype.hasOwnProperty.call(history[100], "_historyIndex"), false);
});
