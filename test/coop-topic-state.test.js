var test = require("node:test");
var assert = require("node:assert/strict");
var topicState = require("../lib/coop-topic-state");

// Exactly three owner-facing states: Working, Needs input, Done. Task
// evidence, foreground work, an explicit close and a durable owner-disposition
// record are the only inputs; a projected topic is NEVER blank -- an unproven
// historical topic is Needs input with stateSource "unlinked_default", because
// the owner has to decide what it is. Working still requires live execution
// evidence and Done still requires durable owner acceptance evidence.

var TOPIC = { topicId: "coop-conversation-architecture" };
var OTHER = { topicId: "queued-message-recovery" };

function task(status, extra) {
  return Object.assign({ taskId: "t-" + status, status: status, coopTopicRef: TOPIC }, extra || {});
}

function stateOf(tasks, foreground) {
  return topicState.coopTopicState(TOPIC, { tasks: tasks, foreground: foreground }).state;
}

function accepted() {
  return { status: "accepted", acceptedAt: 1, withdrawnAt: null };
}

// --- no linked work means no label ------------------------------------------

test("a topic with no linked work is Needs input, never blank and never Working", function () {
  // A blank row failed the owner outright: it said nothing about whether the
  // work was resolved. But the state is not fabricated either -- no evidence
  // of execution means the owner has to decide, which IS Needs input, and the
  // provenance says exactly why.
  assert.equal(stateOf([]), "needs_input");
  assert.equal(stateOf(null), "needs_input");
  // Work linked to a DIFFERENT topic must not leak into this one.
  assert.equal(stateOf([{ taskId: "x", status: "running", coopTopicRef: OTHER }]), "needs_input");
  // A task with no link at all is not attributable and must not be guessed at.
  assert.equal(stateOf([{ taskId: "y", status: "running", coopTopicRef: null }]), "needs_input");
  var derived = topicState.coopTopicState(TOPIC, { tasks: [] });
  assert.equal(derived.stateSource, "unlinked_default");
});

test("each state requires its own exact linked evidence", function () {
  // The three states are claims: Working about active work, Needs input about
  // the owner, Done about completion AND acceptance. None may be produced
  // without the evidence that makes it true.
  assert.equal(stateOf([task("running")]), "working");
  assert.equal(stateOf([task("needs_input")]), "needs_input");
  assert.equal(stateOf([Object.assign(task("completed"), { ownerAcceptance: accepted() })]), "done");
  // Completed but unaccepted is NOT Done -- it is still the owner's move.
  assert.equal(stateOf([task("completed")]), "needs_input");
  // And no evidence at all is the owner's move too, with its provenance named.
  assert.equal(stateOf([]), "needs_input");
});

test("one task list yields differentiated states across topics", function () {
  // The owner-visible requirement: when evidence exists the rows must NOT all
  // read the same. Three topics, one task list, three different truths.
  var tasks = [
    { taskId: "a", status: "running", coopTopicRef: TOPIC },
    { taskId: "b", status: "needs_input", coopTopicRef: OTHER },
    { taskId: "c", status: "completed", coopTopicRef: { topicId: "third" },
      ownerAcceptance: accepted() },
  ];
  assert.equal(topicState.coopTopicState(TOPIC, { tasks: tasks }).state, "working");
  assert.equal(topicState.coopTopicState(OTHER, { tasks: tasks }).state, "needs_input");
  assert.equal(topicState.coopTopicState({ topicId: "third" }, { tasks: tasks }).state, "done");
  // A fourth topic with nothing linked is Needs input rather than borrowing a
  // state -- and its provenance says it is the unlinked default, not evidence.
  var fourth = topicState.coopTopicState({ topicId: "fourth" }, { tasks: tasks });
  assert.equal(fourth.state, "needs_input");
  assert.equal(fourth.stateSource, "unlinked_default");
});

test("state is never inferred from existence, messages, timestamps or recency", function () {
  // A topic record rich in every non-evidence signal -- open, recent, full of
  // turns -- is still not Working. It is the unlinked default: the owner's call.
  var derived = topicState.coopTopicState(TOPIC, {
    tasks: [],
    metadata: { status: "open", updatedAt: Date.now(), turnCount: 3, eventCount: 1 },
  });
  assert.equal(derived.state, "needs_input");
  assert.equal(derived.stateSource, "unlinked_default");
  assert.equal(derived.taskCount, 0);
});

// --- the required transition sequence ---------------------------------------

test("Working to Needs input to Working to Done", function () {
  // Working: linked work is running.
  assert.equal(stateOf([task("running")]), "working");

  // Needs input: the worker asks the owner to decide.
  assert.equal(stateOf([task("needs_input")]), "needs_input");
  assert.equal(stateOf([task("waiting_user")]), "needs_input");
  assert.equal(stateOf([task("blocked")]), "needs_input");
  assert.equal(stateOf([task("failed")]), "needs_input");

  // Working again: the owner answered and work resumed.
  assert.equal(stateOf([task("running")]), "working");

  // Completed but NOT accepted is still the owner's turn, not Done.
  assert.equal(stateOf([task("completed")]), "needs_input");

  // Done only once the owner accepted it.
  assert.equal(stateOf([task("completed", { ownerAcceptance: accepted() })]), "done");
});

test("owner attention outranks work still moving", function () {
  // Mixed linked work: one running, one needing the owner. The owner being the
  // blocker is the more important thing to surface.
  assert.equal(stateOf([task("running"), task("needs_input")]), "needs_input");
  assert.equal(stateOf([task("completed", { ownerAcceptance: accepted() }), task("blocked")]), "needs_input");
});

test("work still moving outranks completion", function () {
  assert.equal(stateOf([task("completed", { ownerAcceptance: accepted() }), task("running")]), "working");
  assert.equal(stateOf([task("queued")]), "working");
  assert.equal(stateOf([task("ready")]), "working");
  assert.equal(stateOf([task("reviewing")]), "working");
});

// --- a terminal implementation session is not Done --------------------------

test("a terminal worker state without owner acceptance is Needs input", function () {
  // The rule: a commit, a draft PR, or a worker returning completed is an
  // implementation milestone, not the owner agreeing the work is done.
  assert.equal(stateOf([task("completed")]), "needs_input");
  var derived = topicState.coopTopicState(TOPIC, { tasks: [task("completed")] });
  assert.equal(derived.awaitingAcceptance, true);
});

test("partial acceptance is not acceptance", function () {
  var one = task("completed", { ownerAcceptance: accepted() });
  var two = Object.assign(task("completed"), { taskId: "t-second" });
  assert.equal(stateOf([one, two]), "needs_input");
});

test("a withdrawn acceptance is a revocation, not a weaker acceptance", function () {
  var withdrawn = task("completed", {
    ownerAcceptance: { status: "accepted", acceptedAt: 1, withdrawnAt: 2 },
  });
  assert.equal(stateOf([withdrawn]), "needs_input");
  assert.ok(!topicState.isAccepted(withdrawn));
});

test("only an explicit acceptance counts", function () {
  assert.ok(!topicState.isAccepted(task("completed")));
  assert.ok(!topicState.isAccepted(task("completed", { ownerAcceptance: {} })));
  assert.ok(!topicState.isAccepted(task("completed", { ownerAcceptance: { status: "pending" } })));
  assert.ok(topicState.isAccepted(task("completed", { ownerAcceptance: accepted() })));
});

// --- Done is revocable ------------------------------------------------------

test("Done returns to Working when new work is linked", function () {
  var done = [task("completed", { ownerAcceptance: accepted() })];
  assert.equal(stateOf(done), "done");
  var reopened = done.concat([Object.assign(task("running"), { taskId: "t-followup" })]);
  assert.equal(stateOf(reopened), "working");
});

test("Done returns to Needs input when acceptance is withdrawn", function () {
  var one = task("completed", { ownerAcceptance: accepted() });
  assert.equal(stateOf([one]), "done");
  one.ownerAcceptance.withdrawnAt = 5;
  assert.equal(stateOf([one]), "needs_input");
});

test("Done returns to Needs input when new work needs the owner", function () {
  var done = [task("completed", { ownerAcceptance: accepted() })];
  var escalated = done.concat([Object.assign(task("needs_input"), { taskId: "t-escalation" })]);
  assert.equal(stateOf(escalated), "needs_input");
});

// --- Done never closes ------------------------------------------------------

test("Done is a label, never a lifecycle change", function () {
  // The derivation is pure: it returns a state and touches nothing. Closed
  // stays a separate explicit owner action with its own visibility contract, so
  // a topic can be Done and still open -- which is the normal case.
  var tasks = [task("completed", { ownerAcceptance: accepted() })];
  var derived = topicState.coopTopicState(TOPIC, { tasks: tasks });
  assert.equal(derived.state, "done");
  assert.deepEqual(Object.keys(derived).sort(), ["state", "stateSource", "taskCount"]);
  assert.equal(derived.stateSource, "task_accepted");
  assert.equal(tasks[0].status, "completed", "derivation must not mutate the task");
});

// --- foreground attribution -------------------------------------------------

test("foreground work counts for the exact lens being addressed", function () {
  assert.equal(stateOf([], { isProcessing: true, topicRef: TOPIC }), "working");
  // ...and only that lens. Background work must not be credited by recency:
  // without evidence the topic falls to the unlinked default, not to Working.
  assert.equal(stateOf([], { isProcessing: true, topicRef: OTHER }), "needs_input");
  assert.equal(stateOf([], { isProcessing: false, topicRef: TOPIC }), "needs_input");
  assert.equal(stateOf([], { isProcessing: true, topicRef: null }), "needs_input");
});

test("foreground work does not override the owner needing to decide", function () {
  var foreground = { isProcessing: true, topicRef: TOPIC };
  assert.equal(stateOf([task("needs_input")], foreground), "needs_input");
});

test("foreground work reopens a Done topic", function () {
  var done = [task("completed", { ownerAcceptance: accepted() })];
  assert.equal(stateOf(done), "done");
  assert.equal(stateOf(done, { isProcessing: true, topicRef: TOPIC }), "working");
});

// --- the projection shape ---------------------------------------------------

test("the projected shape lights attention only for Needs input", function () {
  var needs = topicState.projectedTopicState(TOPIC, { tasks: [task("needs_input")] });
  assert.equal(needs.workState, "needs_input");
  assert.equal(needs.attention, true);

  var working = topicState.projectedTopicState(TOPIC, { tasks: [task("running")] });
  assert.equal(working.workState, "working");
  assert.equal(working.attention, false);

  var done = topicState.projectedTopicState(TOPIC, {
    tasks: [task("completed", { ownerAcceptance: accepted() })],
  });
  assert.equal(done.workState, "done");
  assert.equal(done.attention, false);

  var none = topicState.projectedTopicState(TOPIC, { tasks: [] });
  assert.equal(none.workState, "needs_input", "no evidence is the owner's decision to make");
  assert.equal(none.attention, true);
  assert.equal(none.stateSource, "unlinked_default");
});

test("awaiting acceptance is reported so the owner can be told why", function () {
  var awaiting = topicState.projectedTopicState(TOPIC, { tasks: [task("completed")] });
  assert.equal(awaiting.workState, "needs_input");
  assert.equal(awaiting.awaitingAcceptance, true);

  var asked = topicState.projectedTopicState(TOPIC, { tasks: [task("needs_input")] });
  assert.equal(asked.awaitingAcceptance, false);
});

test("terminal-for-the-scheduler is not the same set as completed", function () {
  // orchestration-task-graph's TERMINAL_STATUSES folds in waiting_user and
  // failed; that set answers "should the scheduler stop", not "is this done".
  assert.ok(!topicState.COMPLETED_STATUSES.waiting_user);
  assert.ok(!topicState.COMPLETED_STATUSES.failed);
  assert.ok(topicState.ATTENTION_STATUSES.waiting_user);
  assert.ok(topicState.ATTENTION_STATUSES.failed);
});

// --- durable disposition and close evidence ----------------------------------

test("an explicit close is durable Done evidence with provenance", function () {
  var derived = topicState.coopTopicState(TOPIC, { tasks: [], metadata: { status: "closed" } });
  assert.equal(derived.state, "done");
  assert.equal(derived.stateSource, "topic_closed");
});

test("an owner disposition carries the state and names its author", function () {
  var done = topicState.coopTopicState(TOPIC, {
    tasks: [],
    metadata: { ownerDisposition: { status: "done", source: "owner_accept_done", at: 5 } },
  });
  assert.equal(done.state, "done");
  assert.equal(done.stateSource, "owner_disposition:owner_accept_done");

  var waiting = topicState.coopTopicState(TOPIC, {
    tasks: [],
    metadata: { ownerDisposition: { status: "needs_input", source: "unlinked_historical", at: 5 } },
  });
  assert.equal(waiting.state, "needs_input");
  assert.equal(waiting.stateSource, "owner_disposition:unlinked_historical");
});

test("live task evidence outranks any disposition", function () {
  // The owner accepted this topic done, then new linked work started running:
  // the topic is Working again. A disposition is a record, not a mute button.
  var metadata = { ownerDisposition: { status: "done", source: "owner_accept_done", at: 5 } };
  assert.equal(topicState.coopTopicState(TOPIC, {
    tasks: [task("running")], metadata: metadata,
  }).state, "working");
  assert.equal(topicState.coopTopicState(TOPIC, {
    tasks: [task("needs_input")], metadata: metadata,
  }).state, "needs_input");
});

test("a malformed disposition is ignored, not trusted", function () {
  var derived = topicState.coopTopicState(TOPIC, {
    tasks: [],
    metadata: { ownerDisposition: { status: "working", source: "bogus" } },
  });
  // "working" is not a recordable disposition -- Working requires execution
  // evidence -- so the record is ignored and the unlinked default applies.
  assert.equal(derived.state, "needs_input");
  assert.equal(derived.stateSource, "unlinked_default");
});

test("foreground work outranks close and disposition alike", function () {
  var foreground = { isProcessing: true, topicRef: TOPIC };
  assert.equal(topicState.coopTopicState(TOPIC, {
    tasks: [], foreground: foreground, metadata: { status: "closed" },
  }).state, "working");
});

test("linked tasks with no recognisable status prove nothing and fall to Needs input", function () {
  var derived = topicState.coopTopicState(TOPIC, { tasks: [task("some_future_status")] });
  assert.equal(derived.state, "needs_input");
  assert.equal(derived.stateSource, "task_indeterminate");
});
