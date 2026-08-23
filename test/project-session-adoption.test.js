var test = require("node:test");
var assert = require("node:assert/strict");
var attachSessionAdoption = require("../lib/project-session-adoption").attachSessionAdoption;

function portfolioExecution(mode) {
  return {
    portfolioTaskId: "portfolio-adoption",
    bindingRevision: 1,
    idempotencyKey: "adoption-command",
    mode: mode,
    status: "running",
  };
}

test("direct leaves cannot delegate through adoption while project coordinators retain local ownership", function () {
  var sessions = new Map();
  var queued = [];
  var sm = {
    sessions: sessions,
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  var directLeaf = {
    localId: 1,
    storageId: "direct-leaf",
    title: "Direct leaf",
    history: [],
    orchestrationPolicy: { portfolioExecution: portfolioExecution("direct_leaf") },
  };
  var projectCoordinator = {
    localId: 2,
    storageId: "project-coordinator",
    title: "Project coordinator",
    history: [],
    coordinationMode: true,
    orchestrationPolicy: { portfolioExecution: portfolioExecution("project_coordinator") },
  };
  var ordinary = {
    localId: 3,
    storageId: "ordinary",
    title: "Existing investigation",
    history: [{ type: "user_message", text: "Investigate the project issue." }],
  };
  sessions.set(1, directLeaf);
  sessions.set(2, projectCoordinator);
  sessions.set(3, ordinary);
  var adoption = attachSessionAdoption({
    cwd: process.cwd(),
    sm: sm,
    coordinatorForInput: function () { return projectCoordinator; },
    dispatchTaskMessage: function () {},
    error: function (text) { return { error: text }; },
    queueCoordinatorUpdate: function (session, text) { queued.push({ session: session, text: text }); },
    success: function (text) { return { text: text }; },
    watchWorker: function () {},
  });

  var candidates = adoption.listCoordinators(ordinary);
  assert.equal(candidates.some(function (candidate) { return candidate.storageId === "direct-leaf"; }), false);
  assert.equal(candidates.some(function (candidate) { return candidate.storageId === "project-coordinator"; }), true);
  assert.equal(adoption.propose(directLeaf, projectCoordinator), false);
  assert.equal(adoption.propose(ordinary, directLeaf), false);
  assert.equal(adoption.propose(ordinary, projectCoordinator), true);
  assert.equal(queued.length, 1);
});

// --- adoption is released once its task is over -------------------------------

// orchestrationAdoption is written in four places in project-session-adoption and
// was never cleared anywhere in lib/. sourceCanBeAdopted refuses any source whose
// adoption status is "adopted" or "aliased", so a session became permanently
// unadoptable the first time it was adopted: the owner could finish that work and
// hand the session back for something new, and adopt_session would answer "source
// session is unavailable or already owned" for the rest of the session's life.
//
// orchestrationParent is the second, independent half of the same gate. Only
// closeWorker (coordinator close) and one records handler ever reset it, and
// neither runs on ordinary completion -- finishWorkerTurn and detachWorker both
// leave it in place -- so clearing the adoption alone would not have been enough.

function adoptionHarness() {
  var sessions = new Map();
  var saved = [];
  var sm = {
    sessions: sessions,
    saveSessionFile: function (session) { saved.push(session); },
    broadcastSessionList: function () {},
  };
  var coordinator = {
    localId: 2, storageId: "coordinator", title: "Coordinator",
    history: [], coordinationMode: true, orchestrationTasks: [],
  };
  var ordinary = {
    localId: 3, storageId: "ordinary", title: "Existing investigation",
    history: [{ type: "user_message", text: "Investigate the project issue." }],
  };
  sessions.set(2, coordinator);
  sessions.set(3, ordinary);
  var dispatched = [];
  var watched = [];
  var adoption = attachSessionAdoption({
    cwd: process.cwd(),
    sm: sm,
    coordinatorForInput: function () { return coordinator; },
    dispatchTaskMessage: function (c, task) { dispatched.push(task.taskId); },
    error: function (text) { return { error: text }; },
    queueCoordinatorUpdate: function () {},
    success: function (text) { return { text: text }; },
    watchWorker: function (c, task, worker) { watched.push(worker.storageId); },
  });
  return { adoption: adoption, coordinator: coordinator, ordinary: ordinary,
    dispatched: dispatched, watched: watched, saved: saved };
}

function adoptOnce(h, title) {
  assert.equal(h.adoption.propose(h.ordinary, h.coordinator), true,
    "the session must be offerable");
  return h.adoption.adoptFromTool({
    sourceSessionId: 3, action: "new_task",
    title: title || "Adopted work", objective: "Do the thing",
  });
}

test("a session whose adopted task finished can be adopted again", function () {
  var h = adoptionHarness();

  var first = adoptOnce(h, "First task");
  assert.ok(first.text, JSON.stringify(first));
  assert.equal(h.ordinary.orchestrationAdoption.status, "adopted");
  assert.equal(h.coordinator.orchestrationTasks.length, 1);
  var firstTask = h.coordinator.orchestrationTasks[0];
  assert.equal(firstTask.status, "running");

  // While that task is genuinely live, a second adoption must still be refused.
  // Releasing on "has an adoption record" rather than "the work is over" would
  // let two coordinators own one session.
  var whileRunning = h.adoption.adoptFromTool({
    sourceSessionId: 3, action: "new_task", title: "Racing task", objective: "x",
  });
  assert.equal(whileRunning.error, "source session is unavailable or already owned");

  // The work finishes. finishWorkerTurn leaves BOTH fields in place, so this is
  // exactly the state a real completed adoption is left in.
  firstTask.status = "completed";

  var second = adoptOnce(h, "Second task");
  assert.ok(second.text, JSON.stringify(second));
  assert.equal(h.coordinator.orchestrationTasks.length, 2,
    "the handed-back session takes a genuinely new task");
  assert.equal(h.ordinary.orchestrationAdoption.taskId,
    h.coordinator.orchestrationTasks[1].taskId);
  assert.equal(h.coordinator.orchestrationTasks[1].status, "running");
});

test("re-adoption clears the flags that would otherwise make the new task hang", function () {
  var h = adoptionHarness();
  adoptOnce(h, "First task");
  var firstTask = h.coordinator.orchestrationTasks[0];
  firstTask.status = "completed";

  // The state detachWorker and closeWorker leave behind. Each of these would let
  // the session be adopted and then never complete: _orchestrationTaskClosed makes
  // finishWorkerTurn return immediately, _orchestrationWatcherAttached makes
  // watchWorker decline to attach, and taskStopRequested aborts the new turn.
  var unsubscribed = 0;
  h.ordinary._orchestrationTaskClosed = true;
  h.ordinary._orchestrationWatcherAttached = true;
  h.ordinary._orchestrationUnsubscribe = function () { unsubscribed++; };
  h.ordinary.taskStopRequested = true;
  h.ordinary.orchestrationDetachedAt = 123;

  var again = adoptOnce(h, "Second task");
  assert.ok(again.text, JSON.stringify(again));
  assert.equal(h.ordinary._orchestrationTaskClosed, false);
  assert.equal(h.ordinary._orchestrationWatcherAttached, false);
  assert.equal(h.ordinary._orchestrationUnsubscribe, null);
  assert.equal(h.ordinary.taskStopRequested, false);
  assert.equal(h.ordinary.orchestrationDetachedAt, undefined);
  assert.equal(unsubscribed, 1, "the stale watcher is torn down, not just forgotten");
  assert.equal(h.watched.length, 2, "and the new task really is being watched");
});

test("an adoption is spent when its task is gone, dismissed, or out of retries", function () {
  ["dismissed", "cancelled"].forEach(function (status) {
    var h = adoptionHarness();
    adoptOnce(h);
    h.coordinator.orchestrationTasks[0].status = status;
    assert.equal(h.adoption.releaseSpentAdoption(h.ordinary), true, status);
    assert.equal(h.ordinary.orchestrationAdoption, undefined, status);
    assert.equal(h.ordinary.orchestrationParent, null, status);
  });

  // A failed task still holding a retry is live; one out of attempts is not.
  var live = adoptionHarness();
  adoptOnce(live);
  var liveTask = live.coordinator.orchestrationTasks[0];
  liveTask.status = "failed";
  liveTask.attempt = 1;
  liveTask.maxAttempts = 3;
  assert.equal(live.adoption.releaseSpentAdoption(live.ordinary), false,
    "a retryable failure must keep its worker");
  liveTask.attempt = 3;
  assert.equal(live.adoption.releaseSpentAdoption(live.ordinary), true,
    "an exhausted failure is terminal in everything but its status string");

  // The record whose task no longer exists at all -- the shape a pruned graph or
  // a vanished coordinator leaves behind. It can only ever block, so it is spent.
  var orphan = adoptionHarness();
  adoptOnce(orphan);
  orphan.coordinator.orchestrationTasks.length = 0;
  assert.equal(orphan.adoption.releaseSpentAdoption(orphan.ordinary), true);
  assert.equal(orphan.ordinary.orchestrationAdoption, undefined);
});

test("a live adoption owned by another coordinator is never released", function () {
  var h = adoptionHarness();
  adoptOnce(h);
  // A parent pointing at some OTHER live task is a real ownership claim, not
  // leftover state, so the gate must keep refusing it.
  h.coordinator.orchestrationTasks[0].status = "completed";
  h.ordinary.orchestrationParent = { taskId: "some-other-live-task", sessionId: 9 };
  assert.equal(h.adoption.releaseSpentAdoption(h.ordinary), true,
    "the spent adoption record itself is still cleared");
  assert.deepEqual(h.ordinary.orchestrationParent,
    { taskId: "some-other-live-task", sessionId: 9 },
    "but a parent naming different work is left exactly as it was");
  assert.equal(h.adoption.adoptFromTool({
    sourceSessionId: 3, action: "new_task", title: "x", objective: "y",
  }).error, "source session is unavailable or already owned");
});
