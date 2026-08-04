var test = require("node:test");
var assert = require("node:assert/strict");
var taskGraph = require("../lib/orchestration-task-graph");
var orchestrationMcp = require("../lib/orchestration-mcp-server");
var attachCompletionGate =
  require("../lib/project-task-orchestrator-completion").attachCompletionGate;

function task(taskId, status, extra) {
  return Object.assign({
    taskId: taskId,
    title: taskId,
    status: status,
    updatedAt: 1,
  }, extra || {});
}

function gateHarness(tasks) {
  var updates = [];
  var states = [];
  var saves = 0;
  var broadcasts = 0;
  var session = {
    localId: 1,
    storageId: "coordinator-stable",
    coordinationMode: true,
    orchestrationGraphId: "graph-stable",
    orchestrationTasks: tasks,
    orchestrationEvents: [],
    history: [],
    isProcessing: false,
  };
  var gate = attachCompletionGate({
    sm: {
      saveSessionFile: function () { saves++; },
      broadcastSessionList: function () { broadcasts++; },
    },
    flushCoordinatorUpdates: function () { return false; },
    queueCoordinatorUpdate: function (target, text) {
      updates.push(text);
      target.isProcessing = true;
    },
    sendState: function (target) {
      states.push(taskGraph.graphResolutionState(target));
    },
  });
  return {
    broadcasts: function () { return broadcasts; },
    gate: gate,
    saves: function () { return saves; },
    session: session,
    states: states,
    updates: updates,
  };
}

test("orchestration MCP exposes explicit dismissal and user-decision operations", function () {
  var noop = function () {};
  var names = orchestrationMcp.getToolDefs(
    noop, noop, noop, noop, noop, noop, noop, noop, noop
  ).map(function (definition) { return definition.name; });

  assert.ok(names.indexOf("dismiss_task") !== -1);
  assert.ok(names.indexOf("request_task_input") !== -1);
});

test("graph resolution separates execution, attention, user decisions, and resolved work", function () {
  var session = {
    orchestrationTasks: [
      task("running", "running"),
      task("review", "needs_input"),
      task("decision", "waiting_user", { userQuestion: "Use A or B?" }),
      task("done", "completed"),
      task("obsolete", "dismissed", { resolutionReason: "Duplicate" }),
    ],
  };

  var state = taskGraph.graphResolutionState(session);

  assert.equal(state.phase, "reconciling");
  assert.deepEqual(state.metrics, {
    total: 5,
    active: 1,
    attention: 1,
    waitingUser: 1,
    completed: 1,
    dismissed: 1,
    resolved: 2,
    unresolved: 3,
  });
});

test("waiting-user status requires a recorded question", function () {
  var valid = { orchestrationTasks: [task("decision", "waiting_user", { userQuestion: "Ship now?" })] };
  var invalid = { orchestrationTasks: [task("decision", "waiting_user")] };

  assert.equal(taskGraph.graphResolutionState(valid).phase, "waiting_user");
  assert.equal(taskGraph.graphResolutionState(invalid).phase, "reconciling");
});

test("graph progress digest includes the durable event sequence", function () {
  var session = {
    orchestrationGraphId: "graph-stable",
    orchestrationTasks: [task("review", "needs_input")],
    orchestrationEvents: [],
  };
  var before = taskGraph.graphResolutionDigest(session);

  taskGraph.appendEvent(session, "coordinator_followup_sent", session.orchestrationTasks[0]);

  assert.notEqual(taskGraph.graphResolutionDigest(session), before);
});

test("completed, dismissed, and legacy cancelled tasks settle the graph", function () {
  var session = {
    orchestrationTasks: [
      task("done", "completed"),
      task("obsolete", "dismissed"),
      task("legacy", "cancelled"),
    ],
  };

  var state = taskGraph.graphResolutionState(session);

  assert.equal(state.phase, "complete");
  assert.equal(state.metrics.resolved, 3);
  assert.equal(state.metrics.unresolved, 0);
});

test("attention-needed tasks trigger bounded reconciliation and then stall", function () {
  var h = gateHarness([task("review", "needs_input")]);

  assert.equal(h.gate.handleTurnDone(h.session), true);
  assert.equal(h.updates.length, 1);
  assert.match(h.updates[0], /reconcile/i);
  assert.equal(h.session.orchestrationReconciliation.noProgressTurns, 1);

  h.session.isProcessing = false;
  assert.equal(h.gate.handleTurnDone(h.session), true);
  assert.equal(h.updates.length, 2);
  assert.equal(h.session.orchestrationReconciliation.noProgressTurns, 2);

  h.session.isProcessing = false;
  assert.equal(h.gate.handleTurnDone(h.session), false);
  assert.equal(h.updates.length, 2);
  assert.equal(h.session.orchestrationReconciliation.noProgressTurns, 3);
  assert.equal(taskGraph.graphResolutionState(h.session).phase, "stalled");
});

test("graph progress clears a stalled reconciliation state", function () {
  var h = gateHarness([task("review", "needs_input")]);
  h.gate.handleTurnDone(h.session);
  h.session.isProcessing = false;
  h.gate.handleTurnDone(h.session);
  h.session.isProcessing = false;
  h.gate.handleTurnDone(h.session);
  assert.equal(taskGraph.graphResolutionState(h.session).phase, "stalled");

  h.session.orchestrationTasks[0].status = "completed";
  h.session.orchestrationTasks[0].updatedAt++;
  h.session.isProcessing = false;
  h.gate.handleTurnDone(h.session);

  assert.equal(taskGraph.graphResolutionState(h.session).phase, "complete");
  assert.equal(h.session.orchestrationReconciliation.stalled, false);
  assert.equal(h.session.orchestrationReconciliation.noProgressTurns, 0);
});

test("a recorded user decision pauses and resumes without an automatic loop", function () {
  var h = gateHarness([task("decision", "waiting_user", {
    userQuestion: "Use the legacy or replacement API?",
  })]);

  assert.equal(h.gate.handleTurnDone(h.session), false);
  assert.equal(h.updates.length, 0);
  assert.equal(taskGraph.graphResolutionState(h.session).phase, "waiting_user");

  var directive = h.gate.resumeWaitingFromUser(h.session, "Use the replacement API.");

  assert.match(directive, /Use the legacy or replacement API/);
  assert.equal(h.session.orchestrationTasks[0].status, "reviewing");
  assert.ok(h.session.orchestrationTasks[0].userAnsweredAt);
  assert.equal(taskGraph.graphResolutionState(h.session).phase, "reconciling");
});

test("retrying a stalled reconciliation starts one fresh bounded pass", function () {
  var h = gateHarness([task("review", "needs_input")]);
  h.session.orchestrationReconciliation = {
    lastDigest: taskGraph.graphResolutionDigest(h.session),
    stalledDigest: taskGraph.graphResolutionDigest(h.session),
    noProgressTurns: 3,
    stalled: true,
  };

  assert.equal(h.gate.retry(h.session), true);
  assert.equal(h.updates.length, 1);
  assert.equal(h.session.orchestrationReconciliation.noProgressTurns, 0);
  assert.equal(h.session.orchestrationReconciliation.stalled, false);
});
