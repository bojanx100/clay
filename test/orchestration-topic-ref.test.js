// Phase 2: an OPTIONAL, forward-only, reference-only coopTopicRef threaded
// through delegation. The bug these tests pin: delegate() built its createTask
// payload field by field and never forwarded coopTopicRef, so an explicit
// attribution claim was silently dropped and inference always won.
var test = require("node:test");
var assert = require("node:assert/strict");
var handlers = require("../lib/orchestration-tool-handlers");
var taskGraph = require("../lib/orchestration-task-graph");
var mcpServer = require("../lib/orchestration-mcp-server");

function coordinator() {
  return { localId: 1, coopHome: false, orchestrationTasks: [], orchestrationEvents: [] };
}

function makeHandlers(parent, overrides) {
  var deps = {
    error: function (message) { return { isError: true, message: message }; },
    success: function (message) { return { isError: false, message: message }; },
    ensureCoordinatorForInput: function () { return parent; },
    schedule: function () {},
  };
  return handlers.createToolHandlers(Object.assign(deps, overrides || {}));
}

function delegation(extra) {
  return Object.assign({
    coordinatorSessionId: 1,
    title: "t",
    objective: "o",
    context: "c",
    acceptanceCriteria: "a",
    ownedPaths: "lib/",
  }, extra || {});
}

test("delegate_task forwards an explicit coopTopicRef onto the created task", function () {
  var parent = coordinator();
  var api = makeHandlers(parent);
  var result = api.delegate(delegation({ coopTopicRef: { topicId: "topic-alpha" } }));
  assert.equal(result.isError, false);
  assert.equal(parent.orchestrationTasks.length, 1);
  assert.deepEqual(parent.orchestrationTasks[0].coopTopicRef, { topicId: "topic-alpha" });
});

test("an omitted coopTopicRef leaves inference behaviour unchanged", function () {
  // A plain coordinator has no canonical route to infer from, so it stays
  // unlinked -- exactly as before this change.
  var parent = coordinator();
  makeHandlers(parent).delegate(delegation());
  assert.equal(parent.orchestrationTasks[0].coopTopicRef, null);

  // The canonical Coop session still infers from its own last routed message.
  var coop = coordinator();
  coop.coopHome = true;
  coop.history = [{ type: "user_message", coopTopicRef: { topicId: "topic-inferred" } }];
  makeHandlers(coop).delegate(delegation());
  assert.deepEqual(coop.orchestrationTasks[0].coopTopicRef, { topicId: "topic-inferred" });
});

test("an explicit coopTopicRef outranks inference", function () {
  var coop = coordinator();
  coop.coopHome = true;
  coop.history = [{ type: "user_message", coopTopicRef: { topicId: "topic-inferred" } }];
  makeHandlers(coop).delegate(delegation({ coopTopicRef: { topicId: "topic-explicit" } }));
  assert.deepEqual(coop.orchestrationTasks[0].coopTopicRef, { topicId: "topic-explicit" });
});

test("a supplied but unusable coopTopicRef fails closed instead of falling back", function () {
  var parent = coordinator();
  var malformed = makeHandlers(parent).delegate(delegation({ coopTopicRef: { topicId: "   " } }));
  assert.equal(malformed.isError, true);
  assert.match(malformed.message, /coopTopicRef/);
  assert.equal(parent.orchestrationTasks.length, 0);

  var rejected = makeHandlers(parent, {
    resolveCoopTopicRef: function () { return { ok: false, reason: "topic_merged" }; },
  }).delegate(delegation({ coopTopicRef: { topicId: "topic-gone" } }));
  assert.equal(rejected.isError, true);
  assert.match(rejected.message, /topic_merged/);
  assert.equal(parent.orchestrationTasks.length, 0);
});

test("a resolver is optional and an accepted ref is threaded through", function () {
  var parent = coordinator();
  var seen = [];
  var api = makeHandlers(parent, {
    resolveCoopTopicRef: function (ref) {
      seen.push(ref);
      return { ok: true, topicRef: { topicId: "topic-canonical" } };
    },
  });
  assert.equal(api.delegate(delegation({ coopTopicRef: { topicId: "topic-alias" } })).isError, false);
  assert.deepEqual(seen, [{ topicId: "topic-alias" }]);
  assert.deepEqual(parent.orchestrationTasks[0].coopTopicRef, { topicId: "topic-canonical" });

  // No resolver wired: the normalized ref passes through unchanged rather than
  // becoming a new hard dependency.
  var plain = coordinator();
  makeHandlers(plain).delegate(delegation({ coopTopicRef: { topicId: "topic-plain" } }));
  assert.deepEqual(plain.orchestrationTasks[0].coopTopicRef, { topicId: "topic-plain" });
});

test("project execution delegation carries the normalized ref to the router", function () {
  var parent = coordinator();
  var captured = null;
  var api = makeHandlers(parent, {
    isProjectExecutionInput: function () { return true; },
    coordinateExternalTask: function (input) { captured = input; return { ok: true }; },
  });
  var result = api.delegate(delegation({
    portfolioTaskId: "portfolio-task",
    bindingRevision: 1,
    idempotencyKey: "command-1",
    mode: "direct_leaf",
    coopTopicRef: { topicId: "topic-alpha" },
  }));
  assert.equal(result.isError, false);
  assert.deepEqual(captured.coopTopicRef, { topicId: "topic-alpha" });
  // Routed work is not a local task; nothing was created in the graph.
  assert.equal(parent.orchestrationTasks.length, 0);
});

test("plan_task_graph forwards per-task refs and rejects a bad one atomically", function () {
  var parent = coordinator();
  var planned = makeHandlers(parent).plan({
    coordinatorSessionId: 1,
    tasks: [
      { title: "one", objective: "o1", coopTopicRef: { topicId: "topic-one" } },
      { title: "two", objective: "o2" },
    ],
  });
  assert.equal(planned.isError, false);
  assert.deepEqual(parent.orchestrationTasks[0].coopTopicRef, { topicId: "topic-one" });
  assert.equal(parent.orchestrationTasks[1].coopTopicRef, null);

  // A bad ref on a later task must not leave earlier tasks behind.
  var fresh = coordinator();
  var failed = makeHandlers(fresh).plan({
    coordinatorSessionId: 1,
    tasks: [
      { title: "one", objective: "o1" },
      { title: "two", objective: "o2", coopTopicRef: { nope: "x" } },
    ],
  });
  assert.equal(failed.isError, true);
  assert.equal(fresh.orchestrationTasks.length, 0);
});

test("the shared normalizer is exported and reference-only", function () {
  assert.equal(typeof taskGraph.normalizeTopicRefInput, "function");
  assert.deepEqual(taskGraph.normalizeTopicRefInput({ topicId: " topic-x " }), { topicId: "topic-x" });
  assert.deepEqual(
    taskGraph.normalizeTopicRefInput({ topicId: "topic-x", title: "leaked content" }),
    { topicId: "topic-x" });
  assert.equal(taskGraph.normalizeTopicRefInput({ topicId: "" }), null);
  assert.equal(taskGraph.normalizeTopicRefInput(null), null);
});

test("delegate_task and plan_task_graph advertise an optional reference-only topic ref", function () {
  var noop = function () { return {}; };
  var defs = mcpServer.getToolDefs(noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
  var delegateDef = defs.filter(function (d) { return d.name === "delegate_task"; })[0];
  var planDef = defs.filter(function (d) { return d.name === "plan_task_graph"; })[0];
  assert.ok(delegateDef.inputSchema.coopTopicRef);
  var field = delegateDef.inputSchema.coopTopicRef;
  if (typeof field.safeParse === "function") {
    // Optional: omission stays valid, so existing callers are untouched.
    assert.equal(field.safeParse(undefined).success, true);
    assert.equal(field.safeParse({ topicId: "topic-a" }).success, true);
    assert.equal(field.safeParse({ topicId: 12 }).success, false);
    var tasks = planDef.inputSchema.tasks;
    assert.equal(tasks.safeParse([{ title: "t", objective: "o" }]).success, true);
    assert.equal(tasks.safeParse([
      { title: "t", objective: "o", coopTopicRef: { topicId: "topic-a" } },
    ]).success, true);
    assert.equal(tasks.safeParse([
      { title: "t", objective: "o", coopTopicRef: { topicId: 12 } },
    ]).success, false);
  }
});
