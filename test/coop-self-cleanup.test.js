var test = require("node:test");
var assert = require("node:assert/strict");

var cleanup = require("../lib/coop-self-cleanup");

var NOW = 1_000_000;
var THRESHOLDS = {
  workerArchiveAgeMs: 100,
  predecessorPruneAgeMs: 200,
  channelCompactAgeMs: 300,
  channelCompactMessageCount: 10,
  channelRotateDepth: 3,
};

function classify(sessions, tasks, thresholds) {
  return cleanup.classifyCoopSelfCleanup({
    sessions: sessions,
    tasks: tasks || [],
  }, {
    now: NOW,
    thresholds: thresholds || THRESHOLDS,
  });
}

function worker(id, status, age, overrides) {
  return Object.assign({
    localId: id,
    storageId: "worker-" + id,
    orchestrationParent: {
      taskId: "task-" + id,
      taskStatus: status,
    },
    resolvedAt: age == null ? undefined : NOW - age,
  }, overrides || {});
}

function home(id, overrides) {
  return Object.assign({
    localId: id,
    storageId: "session-" + id,
    coopHome: true,
    createdAt: NOW - 1,
    messageCount: 0,
    compactionDepth: 0,
  }, overrides || {});
}

function channel(id, overrides) {
  return Object.assign({
    localId: id,
    storageId: "session-" + id,
    coopChannel: { projectSlug: "project-" + id },
    createdAt: NOW - 1,
    messageCount: 0,
    compactionDepth: 0,
  }, overrides || {});
}

function predecessor(id, intoId, depth, age, overrides) {
  return Object.assign({
    localId: id,
    storageId: "session-" + id,
    compactedIntoLocalId: intoId,
    compactionDepth: depth,
    compactedAt: age == null ? undefined : NOW - age,
  }, overrides || {});
}

function reasonCodes(items) {
  return items.map(function (item) { return item.reasonCode; });
}

test("only aged completed, dismissed, and cancelled workers are archive candidates", function () {
  var terminal = ["completed", "dismissed", "cancelled"];
  var sessions = terminal.map(function (status, index) {
    return worker(index + 1, status, THRESHOLDS.workerArchiveAgeMs);
  });
  sessions.push(worker(10, "unknown", 1000));

  var result = classify(sessions);

  assert.deepEqual(result.archiveWorkerSessions.map(function (item) {
    return item.observed.status;
  }), terminal);
  assert.equal(result.keepVisible.at(-1).reasonCode, "status_not_archivable");
});

test("every active or attention worker status remains visible regardless of age", function () {
  var protectedStatuses = [
    "running", "queued", "ready", "reviewing", "blocked", "needs_input", "waiting_user", "failed",
  ];
  var result = classify(protectedStatuses.map(function (status, index) {
    return worker(index + 1, status, 10_000);
  }));

  assert.equal(result.archiveWorkerSessions.length, 0);
  assert.deepEqual(result.keepVisible.map(function (item) { return item.observed.status; }), protectedStatuses);
  assert.deepEqual(reasonCodes(result.keepVisible), [
    "work_not_terminal", "work_not_terminal", "work_not_terminal",
    "attention_status", "attention_status", "attention_status", "attention_status", "attention_status",
  ]);
});

test("worker archive age uses an inclusive boundary and rejects unknown or future ages", function () {
  var result = classify([
    worker(1, "completed", 99),
    worker(2, "completed", 100),
    worker(3, "completed", null),
    worker(4, "completed", -1),
  ]);

  assert.deepEqual(result.archiveWorkerSessions.map(function (item) { return item.target.localId; }), [2]);
  assert.deepEqual(reasonCodes(result.keepVisible), [
    "terminal_too_recent", "terminal_age_unknown", "terminal_time_in_future",
  ]);
});

test("terminal workers with runtime, active binding, unread, or attention stay visible", function () {
  var sessions = [
    worker(1, "completed", 1000, { isProcessing: true }),
    worker(2, "completed", 1000),
    worker(3, "completed", 1000, { unread: 1 }),
    worker(4, "completed", 1000, { attention: true }),
  ];
  var tasks = [{
    taskId: "task-2",
    workerSessionId: 2,
    status: "completed",
    bindingActive: true,
    resolvedAt: NOW - 1000,
  }];
  var result = classify(sessions, tasks);

  assert.equal(result.archiveWorkerSessions.length, 0);
  assert.deepEqual(reasonCodes(result.keepVisible), [
    "runtime_active", "active_binding", "unread_activity", "attention_flag",
  ]);
});

test("the current task snapshot overrides stale terminal worker state", function () {
  var session = worker(1, "completed", 1000, { status: "completed" });
  var result = classify([session], [{
    taskId: "task-1",
    workerSessionId: 1,
    status: "running",
    updatedAt: NOW - 1000,
  }]);

  assert.equal(result.archiveWorkerSessions.length, 0);
  assert.equal(result.keepVisible[0].observed.status, "running");
  assert.equal(result.keepVisible[0].reasonCode, "work_not_terminal");
});

test("a historical attempt does not inherit the current attempt's active binding", function () {
  var oldAttempt = worker(1, "completed", 1000, {
    orchestrationParent: null,
    orchestrationGroupParent: {
      taskId: "shared-task",
      taskStatus: "running",
      historical: true,
    },
    status: "completed",
  });
  var result = classify([oldAttempt], [{
    taskId: "shared-task",
    workerSessionId: 2,
    status: "running",
  }]);

  assert.equal(result.archiveWorkerSessions.length, 1);
  assert.equal(result.archiveWorkerSessions[0].target.localId, 1);
  assert.equal(result.archiveWorkerSessions[0].observed.activeBinding, false);
});

test("adopted and current grouped worker snapshot shapes retain their task identity and status", function () {
  var adopted = worker(1, "completed", 1000, {
    orchestrationParent: null,
    orchestrationAdoption: { taskId: "adopted-task" },
    workerStatus: "completed",
  });
  var grouped = worker(2, "completed", 1000, {
    orchestrationParent: null,
    orchestrationGroupParent: {
      taskId: "grouped-task",
      taskStatus: "blocked",
      historical: false,
    },
  });
  var result = classify([adopted, grouped]);

  assert.equal(result.archiveWorkerSessions[0].target.taskId, "adopted-task");
  assert.equal(result.keepVisible[0].target.taskId, "grouped-task");
  assert.equal(result.keepVisible[0].observed.status, "blocked");
});

test("old compacted Coop predecessors prune only from projection at the inclusive age boundary", function () {
  var sessions = [
    predecessor(1, 2, 0, 500),
    predecessor(2, 3, 1, THRESHOLDS.predecessorPruneAgeMs),
    home(3, { compactionDepth: 2 }),
  ];
  var result = classify(sessions);

  assert.deepEqual(result.pruneProjection.map(function (item) { return item.target.localId; }), [1, 2]);
  assert.deepEqual(result.pruneProjection.map(function (item) {
    return [item.observed.continuationHops, item.observed.continuationDepth];
  }), [[2, 2], [1, 2]]);
  result.pruneProjection.forEach(function (item) {
    assert.equal(item.operation, "prune_compacted_predecessor_projection");
    assert.equal(item.effect.scope, "ui_projection");
    assert.equal(item.effect.destructive, false);
    assert.equal(item.effect.canonicalTranscript, "preserve");
    assert.equal(item.effect.fileDeletion, "never");
  });
});

test("project-channel lineage is eligible but unresolved, cyclic, or invalid-depth lineage is retained", function () {
  var projectChannel = channel(20, { compactionDepth: 2 });
  var unresolved = predecessor(1, 99, 0, 1000);
  var invalidDepth = predecessor(2, 20, 2, 1000);
  var cyclicA = predecessor(3, 4, 0, 1000);
  var cyclicB = predecessor(4, 3, 1, 1000);
  var eligible = predecessor(5, 20, 1, 1000);
  var result = classify([unresolved, invalidDepth, cyclicA, cyclicB, eligible, projectChannel]);

  assert.deepEqual(result.pruneProjection.map(function (item) { return item.target.localId; }), [5]);
  assert.deepEqual(reasonCodes(result.keepVisible.filter(function (item) {
    return item.category === "coop_predecessor";
  })), [
    "compacted_lineage_unresolved", "compaction_depth_not_advanced",
    "compacted_lineage_cycle", "compacted_lineage_cycle",
  ]);
});

test("active, attention, unread, recent, and undated predecessors remain visible", function () {
  var target = home(20, { compactionDepth: 2 });
  var sessions = [
    predecessor(1, 20, 1, 1000, { isProcessing: true }),
    predecessor(2, 20, 1, 1000, { status: "needs_input" }),
    predecessor(3, 20, 1, 1000, { attention: true }),
    predecessor(4, 20, 1, 1000, { unreadCount: 2 }),
    predecessor(5, 20, 1, 199),
    predecessor(6, 20, 1, null),
    predecessor(7, 20, 1, -1),
    target,
  ];
  var result = classify(sessions);
  var predecessorKeeps = result.keepVisible.filter(function (item) {
    return item.category === "coop_predecessor";
  });

  assert.equal(result.pruneProjection.length, 0);
  assert.deepEqual(reasonCodes(predecessorKeeps), [
    "predecessor_still_active", "predecessor_needs_attention", "predecessor_needs_attention",
    "predecessor_unread", "predecessor_too_recent", "compaction_age_unknown", "compaction_time_in_future",
  ]);
});

test("an explicitly active terminal predecessor binding prevents projection pruning", function () {
  var source = predecessor(1, 2, 0, 1000, {
    orchestrationParent: { taskId: "task-1", taskStatus: "completed" },
  });
  var result = classify([source, home(2, { compactionDepth: 1 })], [{
    taskId: "task-1",
    workerSessionId: 1,
    status: "completed",
    activeBinding: true,
  }]);

  assert.equal(result.pruneProjection.length, 0);
  assert.equal(result.keepVisible[0].reasonCode, "predecessor_still_active");
});

test("permanent Coop roots are never archive or prune targets", function () {
  var currentHome = home(1, {
    orchestrationParent: { taskId: "task-1", taskStatus: "completed" },
    resolvedAt: NOW - 1000,
  });
  var currentChannel = channel(2, {
    workerSession: true,
    status: "completed",
    resolvedAt: NOW - 1000,
  });
  var result = classify([currentHome, currentChannel]);

  assert.equal(result.archiveWorkerSessions.length, 0);
  assert.equal(result.pruneProjection.length, 0);
  assert.equal(result.channelDecisions.length, 2);
  assert.deepEqual(reasonCodes(result.keepVisible), [
    "permanent_coop_conversation", "permanent_coop_conversation",
  ]);
});

test("idle home and project channels request compaction at exact message or age boundaries", function () {
  var result = classify([
    home(1, { messageCount: 9, createdAt: NOW - 299 }),
    home(2, { messageCount: 10, createdAt: NOW - 1 }),
    channel(3, { messageCount: 0, createdAt: NOW - 300 }),
  ]);

  assert.deepEqual(result.channelDecisions.map(function (item) { return item.operation; }), [
    "no_maintenance", "request_compaction", "request_compaction",
  ]);
  assert.deepEqual(result.maintenanceRequests.map(function (item) { return item.target.localId; }), [2, 3]);
});

test("channel message counts accept bounded projection and transcript snapshot shapes", function () {
  var result = classify([
    home(1, { messageCount: undefined, historyEntryCount: 10 }),
    home(2, { messageCount: undefined, history: new Array(10) }),
    home(3, { messageCount: undefined, turnCount: 10 }),
  ]);

  assert.deepEqual(result.channelDecisions.map(function (item) { return item.observed.messageCount; }), [10, 10, 10]);
  assert.deepEqual(result.channelDecisions.map(function (item) { return item.operation; }), [
    "request_compaction", "request_compaction", "request_compaction",
  ]);
});

test("rotation wins at the exact compaction-depth boundary", function () {
  var result = classify([
    home(1, { compactionDepth: 2, messageCount: 10 }),
    channel(2, { compactionDepth: 3, messageCount: 10 }),
  ]);

  assert.equal(result.channelDecisions[0].operation, "request_compaction");
  assert.equal(result.channelDecisions[1].operation, "request_rotation");
  assert.equal(result.channelDecisions[1].reasonCode, "rotation_depth_reached");
});

test("due channel maintenance defers for every protected task status", function () {
  var protectedStatuses = [
    "running", "queued", "ready", "reviewing", "blocked", "needs_input", "waiting_user", "failed",
  ];
  var sessions = protectedStatuses.map(function (status, index) {
    return home(index + 1, {
      messageCount: 10,
      orchestrationTasks: [{ status: status }],
    });
  });
  var result = classify(sessions);

  assert.deepEqual(result.channelDecisions.map(function (item) { return item.operation; }),
    protectedStatuses.map(function () { return "defer_maintenance"; }));
  assert.equal(result.maintenanceRequests.length, 0);
});

test("processing, binding, unread, and attention defer maintenance while terminal tasks do not", function () {
  var result = classify([
    home(1, { messageCount: 10, isProcessing: true }),
    home(2, { messageCount: 10, activeBinding: true }),
    home(3, { messageCount: 10, unread: 1 }),
    home(4, { messageCount: 10, needsAttention: true }),
    home(5, { messageCount: 10, orchestrationTasks: [{ status: "completed" }] }),
  ]);

  assert.deepEqual(result.channelDecisions.map(function (item) { return item.operation; }), [
    "defer_maintenance", "defer_maintenance", "defer_maintenance", "defer_maintenance",
    "request_compaction",
  ]);
});

test("all emitted decisions carry explicit non-destructive audit metadata", function () {
  var result = classify([
    worker(1, "completed", 1000),
    worker(2, "blocked", 1000),
    predecessor(3, 4, 0, 1000),
    home(4, { compactionDepth: 1, messageCount: 10 }),
  ]);

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.evaluatedAt, NOW);
  assert.ok(result.audit.length > 0);
  result.audit.forEach(function (item) {
    assert.equal(item.policy, "coop-self-cleanup/v1");
    assert.ok(item.operation);
    assert.ok(item.reasonCode);
    assert.ok(item.reason);
    assert.ok(item.target);
    assert.equal(item.effect.destructive, false);
    assert.equal(item.effect.canonicalTranscript, "preserve");
    assert.equal(item.effect.fileDeletion, "never");
    assert.doesNotMatch(item.operation, /delete|destroy/);
  });
});

test("classification is deterministic and does not mutate snapshots or threshold input", function () {
  var snapshot = {
    sessions: [worker(1, "completed", 1000), home(2, { messageCount: 10 })],
    tasks: [],
  };
  var thresholds = Object.assign({}, THRESHOLDS);
  var beforeSnapshot = structuredClone(snapshot);
  var beforeThresholds = structuredClone(thresholds);

  var first = cleanup.classifyCoopSelfCleanup(snapshot, { now: NOW, thresholds: thresholds });
  var second = cleanup.classifyCoopSelfCleanup(snapshot, { now: NOW, thresholds: thresholds });

  assert.deepEqual(first, second);
  assert.deepEqual(snapshot, beforeSnapshot);
  assert.deepEqual(thresholds, beforeThresholds);
});

test("now and every threshold must be finite and non-negative", function () {
  assert.throws(function () {
    cleanup.classifyCoopSelfCleanup({}, {});
  }, /injected finite now/);
  assert.throws(function () {
    cleanup.classifyCoopSelfCleanup({}, { now: Infinity });
  }, /injected finite now/);

  Object.keys(THRESHOLDS).forEach(function (name) {
    var invalid = Object.assign({}, THRESHOLDS);
    invalid[name] = -1;
    assert.throws(function () {
      cleanup.classifyCoopSelfCleanup({}, { now: NOW, thresholds: invalid });
    }, new RegExp(name));
  });
});
