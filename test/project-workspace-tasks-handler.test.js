var test = require("node:test");
var assert = require("node:assert/strict");
var attachWorkspace = require("../lib/project-workspace").attachWorkspace;

function harness() {
  var session = { localId: 27, storageId: "workspace-coordinator", orchestrationTasks: [] };
  var sent = [];
  var api = attachWorkspace({
    cwd: process.cwd(),
    slug: "workspace-task-handler-test",
    send: function () {},
    sendTo: function (ws, message) { sent.push(message); },
    getSessionForWs: function () { return session; },
    hydrateImageRefs: function (value) { return value; },
    tm: {},
    worktreeMeta: null,
    getOsUserInfoForWs: function () { return null; },
    usersModule: null,
    osUsers: null,
    persistSession: function () {},
    sm: { sessions: { forEach: function (callback) { callback(session); } } },
    getProjectId: function () { return "project-a"; },
    getExecutionBindings: function () {
      return [{ portfolioTaskId: "backlog-item", bindingRevision: 1, status: "pending", updatedAt: 1,
        targetProject: { projectId: "project-a" } }];
    },
    getProjectList: function () { return []; },
  });
  return { api: api, sent: sent };
}

test("Workspace task refresh identifies the session that owns the projection", function () {
  var h = harness();
  h.api.handleWorkspaceMessage({}, { type: "workspace_tasks_get", requestId: 5 });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, "workspace_tasks_state");
  assert.equal(h.sent[0].sessionId, 27);
  assert.equal(h.sent[0].requestId, 5);
  assert.equal(h.sent[0].tasks[0].key, "backlog-item");
});
