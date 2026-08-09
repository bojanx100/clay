var test = require("node:test");
var assert = require("node:assert/strict");
var topicState = require("../lib/coop-topic-state");

// Exactly three owner-facing states, derived from canonical linked work:
// Working, Needs input, Done. A topic with no linked work gets none. The label
// this replaces was `status === "open"` -- true of every topic that reaches the
// client -- so it could never be false and said nothing.

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

test("a topic with no linked work gets no state at all", function () {
  // Evidence or nothing. Defaulting to Working made all 41 real topics declare
  // the same unsupported state -- a label that cannot be false, which is the
  // exact failure the generic "Active" had. Silence is correct here because
  // there is genuinely nothing to report.
  assert.equal(stateOf([]), "");
  assert.equal(stateOf(null), "");
  // Work linked to a DIFFERENT topic must not leak into this one.
  assert.equal(stateOf([{ taskId: "x", status: "needs_input", coopTopicRef: OTHER }]), "");
  // A task with no link at all is not attributable and must not be guessed at.
  assert.equal(stateOf([{ taskId: "y", status: "needs_input", coopTopicRef: null }]), "");
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
  // And nothing at all yields nothing at all.
  assert.equal(stateOf([]), "");
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
  // A fourth topic with nothing linked stays silent rather than borrowing one.
  assert.equal(topicState.coopTopicState({ topicId: "fourth" }, { tasks: tasks }).state, "");
});

test("state is never inferred from existence, messages, timestamps or recency", function () {
  // The only inputs are linked work and foreground processing. A topic record
  // rich in every other signal still yields nothing.
  var derived = topicState.coopTopicState(TOPIC, {
    tasks: [],
    topic: { status: "open", updatedAt: Date.now(), turnRefs: [{}, {}, {}], eventRefs: [{}] },
  });
  // Rich in every other signal, it still yields nothing.
  assert.equal(derived.state, "");
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
  assert.deepEqual(Object.keys(derived).sort(), ["state", "taskCount"]);
  assert.equal(tasks[0].status, "completed", "derivation must not mutate the task");
});

// --- foreground attribution -------------------------------------------------

test("foreground work counts for the exact lens being addressed", function () {
  assert.equal(stateOf([], { isProcessing: true, topicRef: TOPIC }), "working");
  // ...and only that lens. Background work must not be credited by recency.
  assert.equal(stateOf([], { isProcessing: true, topicRef: OTHER }), "");
  assert.equal(stateOf([], { isProcessing: false, topicRef: TOPIC }), "");
  assert.equal(stateOf([], { isProcessing: true, topicRef: null }), "");
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
  assert.equal(none.workState, "", "no evidence means no claim");
  assert.equal(none.attention, false);
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
