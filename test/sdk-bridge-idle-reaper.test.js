var test = require("node:test");
var assert = require("node:assert/strict");

var attachIdleReaper = require("../lib/sdk-bridge-idle-reaper").attachIdleReaper;

function session(localId, vendor, lastActivityAt, extra) {
  var closes = 0;
  var item = Object.assign({
    localId: localId,
    vendor: vendor,
    lastActivityAt: lastActivityAt,
    isProcessing: false,
    queryInstance: {
      close: function () { closes++; },
    },
  }, extra || {});
  item.closes = function () { return closes; };
  return item;
}

test("idle reaper caps warm Codex helpers without closing active or other-provider sessions", function () {
  var sessions = [
    session(1, "codex", 500),
    session(2, "codex", 400),
    session(3, "codex", 300),
    session(4, "codex", 200),
    session(5, "codex", 100),
    session(6, "claude", 50),
    session(7, "codex", 10, { isProcessing: true }),
  ];
  var reaper = attachIdleReaper({
    sm: { sessions: new Map(sessions.map(function (item) { return [item.localId, item]; })) },
    now: function () { return 600; },
    idleTimeoutMs: 1000,
    maxWarmCodexQueries: 2,
  });

  reaper.reapIdleSessions();

  assert.deepEqual(sessions.map(function (item) { return item.closes(); }),
    [0, 0, 1, 1, 1, 0, 0],
    "only the least-recent non-processing Codex handles exceed the warm cap");
});

test("idle timeout still closes stale handles regardless of the warm cap", function () {
  var stale = session(1, "claude", 100);
  var recent = session(2, "codex", 950);
  var singleTurn = session(3, "codex", 100, { singleTurn: true });
  var destroying = session(4, "codex", 100, { destroying: true });
  var reaper = attachIdleReaper({
    sm: { sessions: new Map([[1, stale], [2, recent], [3, singleTurn], [4, destroying]]) },
    now: function () { return 1000; },
    idleTimeoutMs: 500,
    maxWarmCodexQueries: 5,
  });

  reaper.reapIdleSessions();

  assert.equal(stale.closes(), 1);
  assert.equal(recent.closes(), 0);
  assert.equal(singleTurn.closes(), 0);
  assert.equal(destroying.closes(), 0);
});
