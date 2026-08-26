// The project activity indicator went dark exactly while a dispatch was landing.
//
// Two independent causes, both in coop-session-lifecycle, and each one alone was
// enough to force "idle":
//
//   projectActivityState tested `binding.status !== "active"`, which is narrower
//   than the rule its own comment states and narrower than this module's ACTIVE
//   set -- which already contains "pending".
//
//   exactBindingForSession required the binding to carry a session ref. reserve()
//   files the work identity with NO ref and commit() is what attaches one, so
//   every pending binding was unmatchable and the caller fell through its
//   `!binding` branch to idle.
//
// The sequence that produced it: reserve() files the binding as pending, the
// target session is given its execution metadata and broadcast, and only the
// dispatching side's later commit() flips the binding to active. Between those two
// the session was demonstrably starting work and read as idle.

var test = require("node:test");
var assert = require("node:assert/strict");

var lifecycle = require("../lib/coop-session-lifecycle");

var PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";

function session(overrides) {
  return Object.assign({
    localId: 4,
    storageId: "worker-session",
    history: [],
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "clay-indicator-2026-08-23",
        bindingRevision: 1,
        idempotencyKey: "clay-indicator-2026-08-23-r1",
        mode: "direct_leaf",
        status: "running",
        targetProject: { projectId: PROJECT },
      },
    },
  }, overrides || {});
}

// Exactly what reserve() writes: the request plus status/timestamps, and no ref.
function pendingBinding(overrides) {
  return Object.assign({
    portfolioTaskId: "clay-indicator-2026-08-23",
    bindingRevision: 1,
    idempotencyKey: "clay-indicator-2026-08-23-r1",
    mode: "direct_leaf",
    targetProject: { projectId: PROJECT },
    status: "pending",
    createdAt: 1000,
    updatedAt: 1000,
  }, overrides || {});
}

// What commit() turns it into.
function committedBinding(overrides) {
  return pendingBinding(Object.assign({
    status: "active",
    worker: { projectId: PROJECT, sessionStorageId: "worker-session" },
  }, overrides || {}));
}

test("a session is not idle during the reserve/commit binding gap", function () {
  var live = session();
  var state = lifecycle.projectActivityState(live, PROJECT, [live], [pendingBinding()]);
  assert.notEqual(state, "idle",
    "a reserved binding whose dispatch is landing must not read as idle");
  assert.equal(lifecycle.projectHasActiveWork([live], PROJECT, [pendingBinding()]), true,
    "and the project indicator must show work");
});

test("the committed binding keeps working, so the gap fix changed nothing after commit", function () {
  var live = session();
  assert.equal(lifecycle.projectHasActiveWork([live], PROJECT, [committedBinding()]), true);
});

test("only pending gained meaning; every other binding status still reads idle", function () {
  var live = session();
  // unrouted/unavailable/needs_input are ATTENTION and the rest are TERMINAL, so
  // none of them are in ACTIVE. A reservation that never starts is moved to
  // unrouted rather than left pending, which is why widening to pending cannot
  // pin the indicator on.
  ["unrouted", "unavailable", "deleted", "completed", "failed", "needs_input",
    "superseded", "cancelled",
  ].forEach(function (status) {
    assert.equal(
      lifecycle.projectHasActiveWork([live], PROJECT, [committedBinding({ status: status })]),
      false, status + " must still read idle");
  });
});

test("a pending binding is never claimed by a session it does not name", function () {
  // The safety boundary on the ref-less match. A binding that HAS a ref naming
  // another session must not be adopted by this one just because the work
  // identity lines up -- that would attribute one project's execution to the
  // wrong session.
  var live = session();
  assert.equal(lifecycle.projectHasActiveWork([live], PROJECT,
    [pendingBinding({ worker: { projectId: PROJECT, sessionStorageId: "someone-else" } })]),
    false, "a ref that names a different session still excludes this one");

  // And identity is still required: a pending binding for different work, or for
  // another project, must not match either.
  assert.equal(lifecycle.projectHasActiveWork([live], PROJECT,
    [pendingBinding({ portfolioTaskId: "clay-something-else" })]), false,
    "a different portfolio task must not match");
  assert.equal(lifecycle.projectHasActiveWork([live], PROJECT,
    [pendingBinding({ bindingRevision: 2 })]), false,
    "a different revision must not match");
  assert.equal(lifecycle.projectHasActiveWork([live], PROJECT,
    [pendingBinding({ mode: "project_coordinator" })]), false,
    "a different mode must not match");
  assert.equal(lifecycle.projectHasActiveWork([live], PROJECT,
    [pendingBinding({ targetProject: { projectId: "other-project" } })]), false,
    "another project's binding must not light up this project");
});

test("a session with no binding at all is still idle", function () {
  var live = session();
  assert.equal(lifecycle.projectHasActiveWork([live], PROJECT, []), false,
    "execution metadata alone never counts as live work");
  assert.equal(lifecycle.projectActivityState(
    session({ hidden: true }), PROJECT, [live], [pendingBinding()]), "idle",
    "and a hidden session is idle whatever its binding says");
});

test("a legacy running task does not keep the project active after its worker is terminal", function () {
  var root = {
    storageId: "legacy-project-root",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    orchestrationTasks: [{
      taskId: "stale-restart-task",
      workerStorageId: "failed-task-coordinator",
      status: "running",
    }],
  };
  var worker = {
    storageId: "failed-task-coordinator",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    hidden: true,
    closedAt: 200,
    orchestrationPolicy: {
      portfolioExecution: {
        mode: "project_coordinator",
        status: "failed",
        reason: "restart_recovery",
      },
    },
  };

  assert.equal(lifecycle.projectActivityState(root, PROJECT, [root, worker], []), "idle",
    "a stale parent task must not be mistaken for active project work");
  assert.equal(lifecycle.projectHasActiveWork([root, worker], PROJECT, []), false);
});

test("terminal outcomes retain the persisted execution reason and terminal timestamp", function () {
  var outcome = lifecycle.terminalOutcome("failed", "task_coordinator", {
    execution: {
      status: "failed",
      reason: "restart_recovery",
      terminalAt: 1234,
    },
  });

  assert.deepEqual(outcome, {
    status: "failed",
    at: 1234,
    summary: "restart_recovery",
  });
});
