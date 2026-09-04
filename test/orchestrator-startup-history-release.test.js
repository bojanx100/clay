var test = require("node:test");
var assert = require("node:assert/strict");
var historyStore = require("../lib/sessions-history-store");
var orchestrationTaskState = require("../lib/orchestration-task-state");
var orchestratorHelpers = require("../lib/project-task-orchestrator-helpers");

// A worker session as it exists right after boot: lazy, never hydrated, with a
// real transcript on "disk" that only materialises when .history is read.
function lazyWorker(history) {
  var session = { id: "w1", isProcessing: false };
  var loads = 0;
  historyStore.defineLazyHistory(session, history, function () {
  loads++;
  return history;
  });
  // defineLazyHistory stores `history || []` directly, so the session starts
  // resident. Releasing is what a real boot does after loadSessions, and it is
  // the only way to reach the lazy state this test is about.
  historyStore.release(session);
  session.__loadCount = function () { return loads; };
  return session;
}

var transcript = [
  { type: "user_message", text: "do the thing" },
  { type: "delta", text: "STATUS: " },
  { type: "delta", text: "done" },
  { type: "done" },
];

test("workerResultText still returns the worker's result", function () {
  var worker = lazyWorker(transcript);
  assert.equal(orchestrationTaskState.workerResultText(worker), "STATUS: done");
});

test("workerResultText leaves a boot-time worker non-resident", function () {
  var worker = lazyWorker(transcript);
  assert.equal(historyStore.isResident(worker), false, "precondition: starts lazy");
  orchestrationTaskState.workerResultText(worker);
  assert.equal(historyStore.isResident(worker), false,
    "startup scan must not pin the transcript in memory");
});

test("workerHasCompletedTurn still detects a completed turn", function () {
  var worker = lazyWorker(transcript);
  assert.equal(orchestratorHelpers.workerHasCompletedTurn(worker), true);
  assert.equal(orchestratorHelpers.workerHasCompletedTurn(lazyWorker([
    { type: "delta", text: "still going" },
  ])), false);
});

test("workerHasCompletedTurn leaves a boot-time worker non-resident", function () {
  var worker = lazyWorker(transcript);
  orchestratorHelpers.workerHasCompletedTurn(worker);
  assert.equal(historyStore.isResident(worker), false,
    "startup scan must not pin the transcript in memory");
});

test("an already-resident session keeps its history", function () {
  // An active session holds history deliberately. Releasing it here would
  // force a re-read on every scan, which is the opposite of the fix.
  var session = { id: "w2", isProcessing: false };
  historyStore.defineLazyHistory(session, transcript, function () { return transcript; });
  assert.equal(historyStore.isResident(session), true, "precondition: resident");
  orchestrationTaskState.workerResultText(session);
  assert.equal(historyStore.isResident(session), true,
    "must not evict history that was already resident");
});

test("a processing session is never released mid-turn", function () {
  var session = { id: "w3", isProcessing: true };
  historyStore.defineLazyHistory(session, transcript, function () { return transcript; });
  orchestrationTaskState.workerResultText(session);
  assert.equal(historyStore.isResident(session), true,
    "release() must keep refusing while the session is processing");
});

test("readTransient tolerates a missing session", function () {
  assert.equal(orchestrationTaskState.workerResultText(null), "");
  assert.equal(orchestratorHelpers.workerHasCompletedTurn(null), false);
});

