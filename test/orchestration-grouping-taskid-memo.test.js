var test = require("node:test");
var assert = require("node:assert/strict");
var historyStore = require("../lib/sessions-history-store");
var orchestrationTaskState = require("../lib/orchestration-task-state");

// A released lazy session, counting how many times the transcript is actually
// re-read from "disk". groupingTaskId only inspects the first 25 records, but
// reading them used to page in and re-parse the whole transcript on every call —
// and it is called for every session on the debounced session-list broadcast.
function lazyWorker(history, persistedRecords) {
  var session = { id: "w1", isProcessing: false };
  var loads = 0;
  historyStore.defineLazyHistory(session, history, function () {
    loads++;
    return session.__disk;
  });
  session.__disk = history;
  if (Number.isInteger(persistedRecords)) {
    session._persistedDiskRecords = persistedRecords;
  }
  historyStore.release(session);
  session.__loadCount = function () { return loads; };
  return session;
}

function coordinatorMessage(taskId) {
  return {
    type: "user_message",
    text: "do the thing",
    orchestrationTaskId: taskId,
    origin: { kind: "coordinator" },
  };
}

// Pad past GROUPING_SCAN_LIMIT so the scan window is provably full.
function padded(head) {
  var out = head.slice();
  while (out.length < 40) out.push({ type: "delta", text: "x" });
  return out;
}

test("groupingTaskId still finds the coordinator task id", function () {
  var worker = lazyWorker(padded([coordinatorMessage("task-1")]), 40);
  assert.equal(orchestrationTaskState.groupingTaskId(worker), "task-1");
});

test("groupingTaskId leaves the transcript non-resident", function () {
  var worker = lazyWorker(padded([coordinatorMessage("task-1")]), 40);
  assert.equal(historyStore.isResident(worker), false, "precondition: starts lazy");
  orchestrationTaskState.groupingTaskId(worker);
  assert.equal(historyStore.isResident(worker), false,
    "a broadcast-path scan must not pin the transcript in memory");
});

test("repeated groupingTaskId calls re-read the transcript only once", function () {
  var worker = lazyWorker(padded([coordinatorMessage("task-1")]), 40);
  for (var i = 0; i < 25; i++) {
    assert.equal(orchestrationTaskState.groupingTaskId(worker), "task-1");
  }
  assert.equal(worker.__loadCount(), 1,
    "25 broadcasts must not mean 25 full transcript reads");
});

test("a settled empty answer is memoized too", function () {
  // No coordinator message anywhere in the head, and the window is full, so no
  // later append can change the answer. This is the common case for ordinary
  // sessions, and it is the one that dominated broadcast cost.
  var worker = lazyWorker(padded([{ type: "user_message", text: "hi" }]), 40);
  assert.equal(orchestrationTaskState.groupingTaskId(worker), "");
  assert.equal(orchestrationTaskState.groupingTaskId(worker), "");
  assert.equal(worker.__loadCount(), 1, "empty answers must memoize as well");
});

test("a short transcript is NOT memoized, so a later append is still seen", function () {
  // Under the scan limit a coordinator message can still arrive, so settling
  // early would strand the session in the wrong group forever.
  var history = [{ type: "user_message", text: "hi" }];
  var worker = lazyWorker(history, 1);
  assert.equal(orchestrationTaskState.groupingTaskId(worker), "");

  worker.__disk = [{ type: "user_message", text: "hi" }, coordinatorMessage("task-late")];
  worker._persistedDiskRecords = 2;
  assert.equal(orchestrationTaskState.groupingTaskId(worker), "task-late",
    "an unsettled answer must be recomputed, not served from a stale memo");
});

test("reassigning history invalidates the memo (compaction rewrites the head)", function () {
  var worker = lazyWorker(padded([coordinatorMessage("task-1")]), 40);
  assert.equal(orchestrationTaskState.groupingTaskId(worker), "task-1");

  // Compaction/recovery replaces the array outright. That is the only way the
  // head of a transcript can change, and it must not serve the old memo.
  worker.history = padded([coordinatorMessage("task-2")]);
  assert.equal(orchestrationTaskState.groupingTaskId(worker), "task-2",
    "memo must be keyed on history generation");
});

test("history generation bumps only on reassignment, not on release", function () {
  var worker = lazyWorker(padded([coordinatorMessage("task-1")]), 40);
  var before = historyStore.generation(worker);
  orchestrationTaskState.groupingTaskId(worker);
  historyStore.release(worker);
  assert.equal(historyStore.generation(worker), before,
    "releasing a resident copy does not change what a reload would produce");
  worker.history = padded([coordinatorMessage("task-2")]);
  assert.equal(historyStore.generation(worker), before + 1);
});

test("an explicit orchestrationParent never touches the transcript", function () {
  var worker = lazyWorker(padded([coordinatorMessage("task-1")]), 40);
  worker.orchestrationParent = { taskId: "parent-task" };
  assert.equal(orchestrationTaskState.groupingTaskId(worker), "parent-task");
  assert.equal(worker.__loadCount(), 0, "the fast path must not read history at all");
});
