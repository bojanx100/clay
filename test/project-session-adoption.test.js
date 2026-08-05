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
