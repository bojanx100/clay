var test = require("node:test");
var assert = require("node:assert");

var handlersModule = require("../lib/orchestration-tool-handlers");
var taskGraph = require("../lib/orchestration-task-graph");

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

function result(ok, text) {
  return { isError: !ok, content: [{ type: "text", text: text }] };
}

function harness(options) {
  var opts = options || {};
  var parent = {
    coopHome: true,
    storageId: "canonical-coop",
    orchestrationTasks: [],
    orchestrationEvents: [],
  };
  var scheduled = 0;
  var saved = 0;
  var handlers = handlersModule.createToolHandlers({
    coordinatorForInput: function () { return parent; },
    ensureCoordinatorForInput: function () { return parent; },
    coordinatorOwningTask: function () { return null; },
    dismissTask: function (session, task, reason) {
      taskGraph.transition(session, task, "dismissed", {
        currentActivity: reason,
        resolutionReason: reason,
      });
      return true;
    },
    error: function (text) { return result(false, text); },
    getExecutionBinding: opts.getExecutionBinding,
    success: function (text) { return result(true, text); },
    schedule: function () { scheduled++; },
    updateTask: function (session, taskId, updates) {
      var task = taskGraph.findTask(session, taskId);
      if (!task) return null;
      taskGraph.transition(session, task, updates.status || task.status, updates);
      saved++;
      return task;
    },
    requestTaskInput: function () { throw new Error("ordinary task path was not expected"); },
  });
  return {
    handlers: handlers,
    parent: parent,
    scheduled: function () { return scheduled; },
    saved: function () { return saved; },
  };
}

function scope(taskId, revision, projectId) {
  return {
    portfolioTaskId: taskId,
    bindingRevision: revision,
    targetProject: { projectId: projectId },
  };
}

test("request_task_input stages an exact plural approval set without scheduling work", function () {
  var h = harness();
  var answer = h.handlers.requestInput({
    coordinatorSessionId: "canonical-coop",
    approvalScopes: [
      scope("clay-approval-stage-one", 2, CLAY),
      scope("webapp-approval-stage-two", 7, WEBAPP),
    ],
    reason: "These two implementation revisions require the owner's approval.",
  });

  assert.equal(answer.isError, false, answer.content[0].text);
  assert.equal(h.parent.orchestrationTasks.length, 2);
  assert.equal(h.saved(), 2, "each staged placeholder is durably transitioned to waiting_user");
  assert.equal(h.scheduled(), 0, "approval placeholders never enter worker scheduling");

  var first = h.parent.orchestrationTasks[0];
  var second = h.parent.orchestrationTasks[1];
  assert.equal(first.status, "waiting_user");
  assert.equal(second.status, "waiting_user");
  assert.equal(first.clientRef, "portfolio:clay-approval-stage-one:2");
  assert.equal(second.clientRef, "portfolio:webapp-approval-stage-two:7");
  assert.equal(first.approvalSet.setId, second.approvalSet.setId);
  assert.deepEqual(first.approvalSet.scopes, second.approvalSet.scopes);
  assert.match(first.userQuestion, /clay-approval-stage-one revision 2/);
  assert.match(first.userQuestion, /webapp-approval-stage-two revision 7/);
  assert.match(answer.content[0].text, /Ask exactly:/);
  assert.match(answer.content[0].text, /clay-approval-stage-one revision 2/);
});

test("approval staging is idempotent and rejects mixed or unscoped input", function () {
  var h = harness();
  var input = {
    coordinatorSessionId: "canonical-coop",
    approvalScopes: [scope("clay-approval-stage-one", 2, CLAY)],
    reason: "Owner approval is required.",
  };
  assert.equal(h.handlers.requestInput(input).isError, false);
  assert.equal(h.handlers.requestInput(input).isError, false);
  assert.equal(h.parent.orchestrationTasks.length, 1, "the same open set is reused");

  assert.equal(h.handlers.requestInput(Object.assign({}, input, {
    taskIds: [h.parent.orchestrationTasks[0].taskId],
  })).isError, true, "one call cannot blur an owned-task question with an approval set");
  assert.equal(h.handlers.requestInput({
    coordinatorSessionId: "canonical-coop",
    approvalScopes: [{ portfolioTaskId: "clay-approval-stage-one", bindingRevision: 2 }],
    reason: "Missing target scope.",
  }).isError, true);
});

test("approval staging refuses an exact revision that already has a binding", function () {
  var h = harness({
    getExecutionBinding: function (taskId, revision) {
      if (taskId !== "clay-already-completed" || revision !== 3) return null;
      return {
        portfolioTaskId: taskId,
        bindingRevision: revision,
        targetProject: { projectId: CLAY },
        status: "completed",
      };
    },
  });
  var answer = h.handlers.requestInput({
    coordinatorSessionId: "canonical-coop",
    approvalScopes: [scope("clay-already-completed", 3, CLAY)],
    reason: "A stale coordinator tried to ask for approval again.",
  });

  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /approval_scope_already_bound:completed/);
  assert.equal(h.parent.orchestrationTasks.length, 0,
    "an existing binding must never gain a new approval placeholder");
});

test("re-staging clears an existing placeholder after the exact binding appears", function () {
  var binding = null;
  var h = harness({
    getExecutionBinding: function () { return binding; },
  });
  var input = {
    coordinatorSessionId: "canonical-coop",
    approvalScopes: [scope("clay-late-binding", 4, CLAY)],
    reason: "Owner approval is required before execution.",
  };
  assert.equal(h.handlers.requestInput(input).isError, false);
  assert.equal(h.parent.orchestrationTasks[0].status, "waiting_user");

  binding = {
    portfolioTaskId: "clay-late-binding",
    bindingRevision: 4,
    targetProject: { projectId: CLAY },
    status: "completed",
  };
  var healed = h.handlers.requestInput(input);

  assert.equal(healed.isError, false);
  assert.match(healed.content[0].text, /Cleared the stale staged approval/);
  assert.equal(h.parent.orchestrationTasks[0].status, "dismissed");
  assert.match(h.parent.orchestrationTasks[0].resolutionReason, /already bound with status completed/);
});
