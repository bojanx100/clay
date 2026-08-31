var test = require("node:test");
var assert = require("node:assert/strict");

var finalizeStream = require("../lib/sdk-bridge-stream-finalize").finalizeStream;
var queue = require("../lib/project-user-message-queue");

function query(name) {
  return {
    name: name,
    close: function () {},
  };
}

function finalize(session, activeQuery, recorded, reconciled) {
  finalizeStream({
    session: session,
    query: activeQuery,
    abortController: session.abortController,
    clearInteractiveToolWaits: function () {},
    sm: {
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
    },
    sendAndRecord: function (target, item) {
      recorded.push(item);
      target.history.push(item);
    },
    opts: {
      getAutoContinueSetting: function () { return false; },
      reconcileQueuedUserMessages: function (target) {
        reconciled.push(queue.hasQueuedUserMessageDispatchBlocker(target));
      },
    },
    rateLimitResumeLabel: "auto-continue",
  });
}

function sessionFor(activeQuery) {
  return {
    localId: 17,
    history: [],
    queryInstance: activeQuery,
    abortController: { abort: function () {} },
    compacting: true,
    isProcessing: true,
    pendingAskUser: {},
    _turnDoneSent: true,
  };
}

test("an interrupted owned stream unlatches compaction before queued messages reconcile", function () {
  var activeQuery = query("interrupted-compaction");
  var session = sessionFor(activeQuery);
  var recorded = [];
  var reconciled = [];

  finalize(session, activeQuery, recorded, reconciled);

  assert.equal(session.compacting, false);
  assert.deepEqual(recorded, [{ type: "compacting", active: false }]);
  assert.deepEqual(reconciled, [false], "the durable message queue must be dispatchable");
});

test("a stale stream cannot unlatch compaction owned by a newer query", function () {
  var staleQuery = query("stale");
  var currentQuery = query("current");
  var session = sessionFor(currentQuery);
  var recorded = [];
  var reconciled = [];

  finalize(session, staleQuery, recorded, reconciled);

  assert.equal(session.compacting, true);
  assert.deepEqual(recorded, []);
  assert.deepEqual(reconciled, [true]);
});
