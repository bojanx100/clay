var test = require("node:test");
var assert = require("node:assert/strict");
var taskGraph = require("../lib/orchestration-task-graph");
var orchestrationMcp = require("../lib/orchestration-mcp-server");
var attachCompletionGate =
  require("../lib/project-task-orchestrator-completion").attachCompletionGate;
var archiveCompletedCoopSession =
  require("../lib/project-task-orchestrator-completion").archiveCompletedCoopSession;

function task(taskId, status, extra) {
  return Object.assign({
    taskId: taskId,
    title: taskId,
    status: status,
    updatedAt: 1,
  }, extra || {});
}

function gateHarness(tasks, options) {
  options = options || {};
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
  var sessions = new Map([[session.localId, session]]);
  var descendants = Array.isArray(options.descendants) ? options.descendants : [];
  for (var di = 0; di < descendants.length; di++) sessions.set(descendants[di].localId, descendants[di]);
  var gate = attachCompletionGate({
    sm: {
      saveSessionFile: function () { saves++; },
      broadcastSessionList: function () { broadcasts++; },
      hideSession: function (localId) {
        var target = sessions.get(localId);
        if (!target) return;
        target.hidden = true;
        if (!target.coordinationMode || !Array.isArray(target.orchestrationTasks)) return;
        for (var ti = 0; ti < target.orchestrationTasks.length; ti++) {
          var task = target.orchestrationTasks[ti];
          var descendant = task && sessions.get(task.workerSessionId);
          if (descendant) descendant.hidden = true;
        }
      },
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
    sessions: sessions,
  };
}

test("orchestration MCP exposes lifecycle, provider, and authoritative Coop session query operations", function () {
  var noop = function () {};
  var names = orchestrationMcp.getToolDefs(
    noop, noop, noop, noop, noop, noop, noop, noop, noop
  ).map(function (definition) { return definition.name; });

  assert.ok(names.indexOf("dismiss_task") !== -1);
  assert.ok(names.indexOf("request_task_input") !== -1);
  assert.ok(names.indexOf("steer_project_coordinator") !== -1);
  assert.ok(names.indexOf("switch_session_provider") !== -1);
  assert.ok(names.indexOf("list_coop_sessions") !== -1);
});

test("list_coop_sessions requires exact project references and exposes no hidden-session switch", function () {
  var noop = function () {};
  var definition = orchestrationMcp.getToolDefs(
    noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop
  ).find(function (candidate) { return candidate.name === "list_coop_sessions"; });

  assert.ok(definition);
  assert.ok(definition.inputSchema.coordinatorSessionId);
  assert.ok(definition.inputSchema.projectRefs);
  assert.equal(Object.hasOwn(definition.inputSchema, "includeHidden"), false);
  if (typeof definition.inputSchema.projectRefs.safeParse === "function") {
    assert.equal(definition.inputSchema.projectRefs.safeParse([]).success, false);
    assert.equal(definition.inputSchema.projectRefs.safeParse([
      { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    ]).success, true);
  }
});

test("delegate_task exposes the typed cross-project execution binding", function () {
  var noop = function () {};
  var delegate = orchestrationMcp.getToolDefs(
    noop, noop, noop, noop, noop, noop, noop, noop, noop
  ).find(function (definition) { return definition.name === "delegate_task"; });

  assert.ok(delegate);
  assert.ok(delegate.inputSchema.targetProject);
  assert.ok(delegate.inputSchema.portfolioTaskId);
  assert.ok(delegate.inputSchema.bindingRevision);
  assert.ok(delegate.inputSchema.idempotencyKey);
  assert.ok(delegate.inputSchema.mode);
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

test("only a portfolio project coordinator can emit verified project completion", function () {
  var h = gateHarness([task("worker-evidence", "completed", {
    resolutionReason: "Verified worker completion",
    verification: "worker test passed",
  })]);
  h.session.orchestrationPolicy = {
    portfolioExecution: {
      portfolioTaskId: "portfolio-completion",
      bindingRevision: 4,
      mode: "project_coordinator",
    },
  };
  h.session.history.push({ type: "user_message", text: "Coordinate the project." });
  h.session.history.push({
    type: "delta",
    text: "WORKER_STATUS: completed\nSUMMARY: Worker evidence only.\n" +
      "VERIFICATION: worker test passed\nESCALATION_REQUIRED: no",
  });

  h.gate.handleTurnDone(h.session);
  assert.equal(taskGraph.projectCompletionState(h.session).status, "pending");

  h.session.history.push({ type: "user_message", text: "Finish local integration." });
  h.session.history.push({
    type: "delta",
    text: "PROJECT_COMPLETED: yes\nSUMMARY: Integrated project outcome.\n" +
      "VERIFICATION: node --test project suite passed\n" +
      "INTEGRATION_VERIFIED: yes\nESCALATION_REQUIRED: no",
  });
  h.gate.handleTurnDone(h.session);

  var completion = taskGraph.projectCompletionState(h.session);
  assert.equal(completion.status, "completed");
  assert.equal(completion.portfolioTaskId, "portfolio-completion");
  assert.equal(completion.bindingRevision, 4);
  assert.equal(completion.escalationRequired, "no");
  assert.equal(h.session.orchestrationEvents.at(-1).type, "project_completed");
  assert.equal(h.session.orchestrationEvents.at(-1).data.escalationRequired, "no");

  var workerAttempt = {
    orchestrationParent: { taskId: "worker-evidence" },
    orchestrationTasks: [task("worker-evidence", "completed")],
    orchestrationEvents: [],
  };
  assert.equal(taskGraph.completeProject(workerAttempt, {
    summary: "Worker cannot close the project.", verification: "worker check passed",
    integrationVerification: "yes", integrationVerified: true,
  }).reason, "project_owner_required");
});

test("a portfolio project coordinator can complete after verified direct integration with no child tasks", function () {
  var h = gateHarness([]);
  h.session.orchestrationPolicy = {
    portfolioExecution: {
      portfolioTaskId: "portfolio-direct-integration",
      bindingRevision: 1,
      mode: "project_coordinator",
    },
  };
  h.session.history = [{ type: "user_message", text: "Integrate the project directly." }, {
    type: "delta",
    text: "PROJECT_COMPLETED: yes\nSUMMARY: Direct integration completed.\n" +
      "VERIFICATION: focused project suite passed\nINTEGRATION_VERIFIED: yes\n" +
      "ESCALATION_REQUIRED: no",
  }];

  h.gate.handleTurnDone(h.session);

  var completion = taskGraph.projectCompletionState(h.session);
  assert.equal(completion.status, "completed");
  assert.equal(completion.portfolioTaskId, "portfolio-direct-integration");
  assert.equal(completion.bindingRevision, 1);
  assert.equal(h.session.orchestrationEvents.at(-1).type, "project_completed");
});

test("verified Coop project completion archives the coordinator and descendants", function () {
  var worker = { localId: 2, hidden: false };
  var h = gateHarness([task("done", "completed", { workerSessionId: worker.localId })], {
    descendants: [worker],
  });
  h.session.coopControlledBy = { coopSessionStorageId: "coop-home", since: 1 };
  h.session.orchestrationPolicy = {
    portfolioExecution: {
      portfolioTaskId: "portfolio-auto-archive",
      bindingRevision: 2,
      idempotencyKey: "auto-archive",
      mode: "project_coordinator",
      status: "running",
    },
  };
  h.session.history = [{ type: "user_message", text: "Complete the project." }, {
    type: "delta",
    text: "PROJECT_COMPLETED: yes\nSUMMARY: Project integrated.\n" +
      "VERIFICATION: focused suite passed\nINTEGRATION_VERIFIED: yes\n" +
      "ESCALATION_REQUIRED: no",
  }];

  h.gate.handleTurnDone(h.session);

  assert.equal(h.session.hidden, true);
  assert.equal(worker.hidden, true);
  assert.equal(h.session.orchestrationPolicy.portfolioExecution.status, "completed");
  assert.ok(h.session.orchestrationPolicy.portfolioExecution.completedAt);
  assert.ok(h.session.orchestrationTasks[0].archivedAt);
});

test("owner-created coordinator remains visible after verified project completion", function () {
  var h = gateHarness([]);
  h.session.orchestrationPolicy = {
    portfolioExecution: {
      portfolioTaskId: "portfolio-owner-created",
      bindingRevision: 1,
      idempotencyKey: "owner-created",
      mode: "project_coordinator",
      status: "running",
    },
  };
  h.session.history = [{ type: "user_message", text: "Complete the project." }, {
    type: "delta",
    text: "PROJECT_COMPLETED: yes\nSUMMARY: Project integrated.\n" +
      "VERIFICATION: focused suite passed\nINTEGRATION_VERIFIED: yes\n" +
      "ESCALATION_REQUIRED: no",
  }];

  h.gate.handleTurnDone(h.session);

  assert.equal(h.session.hidden, undefined);
  assert.equal(h.session.orchestrationPolicy.portfolioExecution.status, "completed");
});

test("shared completion archive never hides an owner-created direct session", function () {
  var sessions = new Map();
  var controlled = {
    localId: 1,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationPolicy: { portfolioExecution: { mode: "direct_leaf", status: "completed" } },
  };
  var ownerCreated = {
    localId: 2,
    orchestrationPolicy: { portfolioExecution: { mode: "direct_leaf", status: "completed" } },
  };
  sessions.set(controlled.localId, controlled);
  sessions.set(ownerCreated.localId, ownerCreated);
  var manager = {
    sessions: sessions,
    saveSessionFile: function () {},
    hideSession: function (localId) { sessions.get(localId).hidden = true; },
  };

  assert.equal(archiveCompletedCoopSession(manager, controlled), true);
  assert.equal(controlled.hidden, true);
  assert.equal(archiveCompletedCoopSession(manager, ownerCreated), false);
  assert.equal(ownerCreated.hidden, undefined);
});

test("restart finalizes a persisted Coop completion and hides its descendants", function () {
  var worker = { localId: 2, hidden: false };
  var h = gateHarness([task("done", "completed", { workerSessionId: worker.localId })], {
    descendants: [worker],
  });
  h.session.coopControlledBy = { coopSessionStorageId: "coop-home", since: 1 };
  h.session.orchestrationProjectCompletion = {
    status: "completed",
    completionRevision: 1,
    escalationRequired: "no",
    completedAt: 10,
  };
  h.session.orchestrationPolicy = {
    portfolioExecution: {
      portfolioTaskId: "portfolio-restart-archive",
      bindingRevision: 1,
      idempotencyKey: "restart-archive",
      mode: "project_coordinator",
      status: "running",
    },
  };

  h.gate.restore(h.session);

  assert.equal(h.session.hidden, true);
  assert.equal(worker.hidden, true);
  assert.equal(h.session.orchestrationPolicy.portfolioExecution.status, "completed");
});

test("new or retried work revokes project completion before another attempt", function () {
  var session = {
    orchestrationGraphId: "project-revoke",
    coordinationMode: true,
    orchestrationTasks: [task("stable-task", "completed")],
    orchestrationEvents: [],
  };
  var completed = taskGraph.completeProject(session, {
    summary: "Integrated output.",
    verification: "project suite passed",
    integrationVerification: "yes",
    integrationVerified: true,
    escalationRequired: "no",
    portfolioTaskId: "portfolio-revoke",
    bindingRevision: 2,
  });
  assert.equal(completed.ok, true);

  taskGraph.retryTask(session, session.orchestrationTasks[0]);
  assert.equal(taskGraph.projectCompletionState(session).status, "pending");
  assert.ok(session.orchestrationEvents.some(function (event) {
    return event.type === "project_completion_revoked";
  }));
  assert.equal(session.orchestrationEvents.at(-1).type, "task_retry_requested");
  assert.equal(taskGraph.completeProject(session, {
    summary: "Late worker result.", verification: "late test", integrationVerification: "yes",
    integrationVerified: true, escalationRequired: "no",
  }).reason, "graph_unresolved");
});

test("restart restores an already emitted project completion without duplicating it", function () {
  var h = gateHarness([task("done", "completed")]);
  h.session.orchestrationPolicy = {
    portfolioExecution: {
      portfolioTaskId: "portfolio-restart",
      bindingRevision: 1,
      mode: "project_coordinator",
    },
  };
  h.session.history = [{ type: "user_message", text: "Complete it." }, {
    type: "delta",
    text: "PROJECT_COMPLETED: yes\nSUMMARY: Restart-safe completion.\n" +
      "VERIFICATION: restart suite passed\nINTEGRATION_VERIFIED: yes\n" +
      "ESCALATION_REQUIRED: no",
  }];

  h.gate.restore(h.session);
  delete h.session.orchestrationProjectCompletion;
  h.gate.restore(h.session);
  assert.equal(taskGraph.projectCompletionState(h.session).status, "completed");
  assert.equal(h.session.orchestrationEvents.filter(function (event) {
    return event.type === "project_completed";
  }).length, 1);
  assert.ok(h.saves() >= 2);
});

test("an escalating or incomplete project declaration leaves completion pending", function () {
  var h = gateHarness([task("done", "completed")]);
  h.session.orchestrationPolicy = {
    portfolioExecution: {
      portfolioTaskId: "portfolio-escalated",
      bindingRevision: 1,
      mode: "project_coordinator",
    },
  };
  h.session.history = [{ type: "user_message", text: "Complete it." }, {
    type: "delta",
    text: "PROJECT_COMPLETED: yes\nSUMMARY: Integration has an escalation.\n" +
      "VERIFICATION: suite passed\nINTEGRATION_VERIFIED: yes\n" +
      "ESCALATION_REQUIRED: yes",
  }];

  h.gate.handleTurnDone(h.session);
  assert.equal(taskGraph.projectCompletionState(h.session).status, "pending");
  assert.equal(h.session.orchestrationEvents.some(function (event) {
    return event.type === "project_completed";
  }), false);
  assert.equal(taskGraph.completeProject(h.session, {
    summary: "Missing escalation declaration.", verification: "suite passed",
    integrationVerification: "yes", integrationVerified: true,
  }).reason, "escalation_required");
});
