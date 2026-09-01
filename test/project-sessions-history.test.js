var test = require("node:test");
var assert = require("node:assert/strict");

var attachProjectSessionsHistory =
  require("../lib/project-sessions-history").attachProjectSessionsHistory;
var findTurnBoundary = require("../lib/sessions-history").findTurnBoundary;

test("regular history pagination reads a bounded disk range", function () {
  var rangeReads = [];
  var session = {
    _persistedHistoryLength: 1000,
    _readPersistedHistoryRange: function (from, to) {
      rangeReads.push({ from: from, to: to });
      var items = [];
      for (var i = from; i < to; i++) {
        items.push({
          type: i === 700 ? "user_message" : "delta",
          text: "event-" + i,
        });
      }
      return items;
    },
  };
  Object.defineProperty(session, "history", {
    get: function () { throw new Error("full history must stay unread"); },
  });
  var sent = [];
  var api = attachProjectSessionsHistory({
    sm: {
      HISTORY_PAGE_SIZE: 300,
      findTurnBoundary: findTurnBoundary,
    },
    sendTo: function (ws, message) { sent.push(message); },
    getSessionForWs: function () { return session; },
    hydrateImageRefs: function (item) { return item; },
  });

  assert.equal(api.handleHistoryMessage({}, {
    type: "load_more_history",
    before: 1000,
    target: 700,
  }), true);
  assert.deepEqual(rangeReads, [{ from: 400, to: 1000 }]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].meta, { from: 700, to: 1000, hasMore: true });
  assert.equal(sent[0].items.length, 300);
  assert.equal(sent[0].items[0].text, "event-700");
  assert.equal(sent[0].items[299].text, "event-999");
});
