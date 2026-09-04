var test = require("node:test");
var assert = require("node:assert/strict");
var attachProjectStatus = require("../lib/project-status").attachProjectStatus;

var PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";

function session(storageId, extra) {
  return Object.assign({
    localId: 1,
    storageId: storageId,
    history: [],
    isProcessing: true,
  }, extra || {});
}

function binding(storageId, status) {
  return {
    portfolioTaskId: "project-activity-" + storageId,
    bindingRevision: 1,
    targetProject: { projectId: PROJECT_ID },
    mode: "project_coordinator",
    status: status,
    coordinator: { projectId: PROJECT_ID, sessionStorageId: storageId },
  };
}

function execution(storageId, status) {
  return {
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "project-activity-" + storageId,
      bindingRevision: 1,
      idempotencyKey: "project-activity-session-r1",
      mode: "project_coordinator",
      status: status,
    } },
    coordinationRole: "task_coordinator",
    coordinationMode: true,
  };
}

function projectStatus(sessions, bindings) {
  return attachProjectStatus({
    cwd: "/work/project-activity",
    slug: "project-activity",
    project: "project-activity",
    currentVersion: "test",
    clients: new Set(),
    sm: { sessions: new Map(sessions.map(function (item, index) { return [index + 1, item]; })),
      getProjectId: function () { return PROJECT_ID; } },
    getExecutionBindings: function () { return bindings || []; },
    send: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    projectClients: { getOnlineUsers: function () { return []; } },
    getProjectCount: function () { return 1; },
    getProjectList: function () { return []; },
    getProjectOwnerId: function () { return null; },
  });
}

test("project activity excludes terminal, archived, deleted, and stale execution state", function () {
  var terminalStatuses = ["completed", "failed", "cancelled", "dismissed", "superseded", "deleted", "archived"];
  for (var i = 0; i < terminalStatuses.length; i++) {
    var status = terminalStatuses[i];
    var storageId = "terminal-" + status;
    var terminal = session(storageId, execution(storageId, "running"));
    assert.equal(projectStatus([terminal], [binding(storageId, status)]).getStatus().isProcessing, false,
      status + " binding must not keep a stale running session active");
  }

  var archived = session("archived", Object.assign(execution("archived", "running"), { hidden: true, closedAt: 10 }));
  assert.equal(projectStatus([archived], [binding("archived", "active")]).getStatus().isProcessing, false);

  var dismissed = session("dismissed", Object.assign(execution("dismissed", "running"), { hidden: true }));
  assert.equal(projectStatus([dismissed], [binding("dismissed", "active")]).getStatus().isProcessing, false,
    "a dismissed session cannot project its stale execution metadata as working");

  var stale = session("stale", {
    _queryStartTs: 10,
    history: [{ type: "done", _ts: 20 }],
  });
  assert.equal(projectStatus([stale], []).getStatus().isProcessing, false,
    "a completed turn with a stale processing flag is not project activity");
});

test("project activity requires a current binding for typed execution but preserves real work", function () {
  var unbound = session("unbound", execution("unbound", "running"));
  assert.equal(projectStatus([unbound], []).getStatus().isProcessing, false,
    "an unbound typed execution is historical state, not live work");

  var bound = session("bound", Object.assign(execution("bound", "running"), { isProcessing: false }));
  assert.equal(projectStatus([bound], [binding("bound", "active")]).getStatus().isProcessing, true,
    "a visible session with its exact active binding remains active");

  var ordinary = session("ordinary");
  assert.equal(projectStatus([ordinary], []).getStatus().isProcessing, true,
    "a genuinely running ordinary Clay session remains active");

  var coordinator = session("coordinator", {
    isProcessing: false,
    coordinationMode: true,
    orchestrationTasks: [{ taskId: "live-task", status: "running", workerStorageId: "worker" }],
  });
  assert.equal(projectStatus([coordinator], []).getStatus().isProcessing, true,
    "a genuinely running local task remains active while its coordinator is idle");
});
