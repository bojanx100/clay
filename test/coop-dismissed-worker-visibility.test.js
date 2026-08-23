// Dismissed workers leaked into the sidebar and the mobile Projects picker.
//
// coop-session-visibility.hideDismissedSession hides an archived, dismissed Coop
// task coordinator with { projectionOnly: true }. In sessions-deletion, both
// hideSession and hideSessionForActiveClients called hideCoordinatorWorkers only
// when NOT projectionOnly, so the coordinator got `hidden` and its workers never
// did. Both session_list producers filter on `hidden` --
// sessions.getVisibleSessions and project-connection-state.visibleSessions -- so a
// worker that never got the flag stayed in every client's list, under a
// coordinator the owner had already dismissed.
//
// Driven through the REAL sessions-deletion module rather than a stubbed
// hideSession, because the defect was in that module: a test that stubs the thing
// under test would pass either way. The existing coop-session-visibility test
// stubs it, which is exactly why it could not see this.
//
// Note for anyone extending this: the client-side sessionsForOrdinaryProjectSidebar
// does NOT check session.hidden, but that is not the leak. Hidden sessions never
// reach the client at all, because both producers filter them server-side. The
// server flag is the whole fix.

var test = require("node:test");
var assert = require("node:assert/strict");

var attachSessionDeletion = require("../lib/sessions-deletion").attachSessionDeletion;
var visibility = require("../lib/coop-session-visibility");

function harness() {
  var sessions = new Map();
  var saved = [];
  var coordinator = {
    localId: 7,
    storageId: "task-coordinator",
    hidden: false,
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "canonical-coop", since: 1 },
    orchestrationTasks: [
      { taskId: "task-a", workerSessionId: 8, workerStorageId: "worker-a" },
      { taskId: "task-b", workerSessionId: 9, workerStorageId: "worker-b" },
    ],
  };
  var workerA = { localId: 8, storageId: "worker-a", hidden: false };
  var workerB = { localId: 9, storageId: "worker-b", hidden: false };
  var unrelated = { localId: 10, storageId: "unrelated", hidden: false };
  sessions.set(7, coordinator);
  sessions.set(8, workerA);
  sessions.set(9, workerB);
  sessions.set(10, unrelated);

  var deletion = attachSessionDeletion({
    cwd: process.cwd(),
    sessions: sessions,
    send: function () {},
    sendTo: function () {},
    // Present but with no active clients, which is the shape a background
    // projection cleanup runs under and the path hideDismissedSession takes.
    sendEach: function () {},
    getSingleUserUnread: function () { return {}; },
    getSessionStorageId: function (s) { return s && s.storageId; },
    sessionFilePath: function () { return null; },
    saveSessionFile: function (s) { saved.push(s.localId); },
    getActiveSessionId: function () { return null; },
    setActiveSessionId: function () {},
    switchSession: function () {},
    createSession: function () {},
    broadcastSessionList: function () {},
    mostRecentVisibleSessionForWs: function () { return null; },
  });
  return { deletion: deletion, coordinator: coordinator, workerA: workerA,
    workerB: workerB, unrelated: unrelated, saved: saved };
}

test("hiding a dismissed coordinator's projection hides its workers too", function () {
  var h = harness();
  var manager = {
    hideSession: h.deletion.hideSession,
    hideSessionForActiveClients: h.deletion.hideSessionForActiveClients,
  };

  var hidden = visibility.hideDismissedSession({ sm: manager }, h.coordinator,
    { taskId: "dismissed", status: "dismissed", archivedAt: 1 });

  assert.equal(hidden, true);
  assert.equal(h.coordinator.hidden, true, "the coordinator is hidden");
  assert.equal(h.workerA.hidden, true,
    "and so is its worker, which used to leak into the sidebar");
  assert.equal(h.workerB.hidden, true, "every worker, not just the first");
  assert.equal(h.unrelated.hidden, false, "an unrelated session is untouched");
  assert.ok(h.saved.indexOf(8) !== -1 && h.saved.indexOf(9) !== -1,
    "the workers' hidden flag is persisted, not only set in memory");
});

// stopSessionRuntime is internal to sessions-deletion, so these observe its real
// effects (taskStopRequested / isProcessing) rather than a stub that the module
// would ignore.
test("a plain projection-only hide still does NOT cascade to workers", function () {
  // The invariant that makes the cascade opt-in rather than the default, and the
  // one a blanket ungating breaks. coop-self-cleanup-runtime evaluates each
  // session on its own (category guards, not_coop_controlled) and then hides
  // exactly that projection; cascading there would hide workers it never judged
  // and which may still be running. Guarded by "projection-only hiding does not
  // cascade or delete through session deletion" in coop-self-cleanup-runtime.
  var h = harness();
  h.coordinator.isProcessing = true;
  h.deletion.hideSession(7, null, { projectionOnly: true });
  assert.equal(h.coordinator.hidden, true);
  assert.equal(h.workerA.hidden, false,
    "without cascadeWorkers the workers are left for their own judgment");
  assert.notEqual(h.coordinator.taskStopRequested, true,
    "and projectionOnly must not request a stop");
  assert.equal(h.coordinator.isProcessing, true, "nor tear down a running turn");
});

test("an opted-in projection hide cascades without stopping any runtime", function () {
  // The cascade must not smuggle a runtime teardown in with it: projectionOnly
  // exists to skip stopSessionRuntime, and hiding workers touches no runtime.
  var h = harness();
  h.coordinator.isProcessing = true;
  h.deletion.hideSession(7, null, { projectionOnly: true, cascadeWorkers: true });
  assert.equal(h.coordinator.hidden, true);
  assert.equal(h.workerA.hidden, true, "the workers are hidden");
  assert.notEqual(h.coordinator.taskStopRequested, true,
    "but still no stop is requested");
  assert.equal(h.coordinator.isProcessing, true);
});

test("an ordinary hide still stops the runtime and hides the workers", function () {
  var h = harness();
  h.coordinator.isProcessing = true;
  h.deletion.hideSession(7, null, null);
  assert.equal(h.coordinator.hidden, true);
  assert.equal(h.workerA.hidden, true);
  assert.equal(h.coordinator.taskStopRequested, true,
    "the non-projection path is unchanged and still tears the runtime down");
  assert.equal(h.coordinator.isProcessing, false);
});

test("a session with no worker tasks hides cleanly", function () {
  var h = harness();
  h.coordinator.orchestrationTasks = [];
  h.deletion.hideSession(7, null, { projectionOnly: true, cascadeWorkers: true });
  assert.equal(h.coordinator.hidden, true);
  assert.equal(h.workerA.hidden, false, "nothing is hidden that was not claimed");
});

test("a non-coordinator hide never reaches for workers", function () {
  var h = harness();
  h.coordinator.coordinationMode = false;
  h.deletion.hideSession(7, null, { projectionOnly: true, cascadeWorkers: true });
  assert.equal(h.coordinator.hidden, true);
  assert.equal(h.workerA.hidden, false,
    "hideCoordinatorWorkers stays guarded on coordinationMode");
});
