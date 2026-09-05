var test = require("node:test");
var assert = require("node:assert/strict");
var projectTasks = require("../lib/workspace-task-projection").projectTasks;

function binding(id, revision, status, extra) {
  return Object.assign({ portfolioTaskId: id, bindingRevision: revision, status: status,
    updatedAt: revision * 10, targetProject: { projectId: "project-a" } }, extra || {});
}

test("Workspace tasks keep only the current binding revision for one logical task", function () {
  var rows = projectTasks({ projectId: "project-a", bindings: [
    binding("deploy", 1, "failed"), binding("deploy", 2, "completed"),
  ], sessions: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].group, "completed");
  assert.equal(rows[0].bindingRevision, 2);
});

test("Workspace tasks merge a coordinator title and session link into its portfolio binding", function () {
  var rows = projectTasks({ projectId: "project-a", bindings: [binding("deploy", 2, "needs_input")], sessions: [{
    storageId: "coordinator", projectTitle: "Clay", orchestrationTasks: [{ taskId: "deploy",
      clientRef: "portfolio:deploy:2", title: "Deploy the preview", status: "running",
      workerSessionId: 27, updatedAt: 100 }],
  }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Deploy the preview");
  assert.equal(rows[0].sessionId, 27);
  assert.equal(rows[0].status, "needs_input", "durable execution status wins over stale worker state");
  assert.equal(rows[0].group, "started");
});

test("Workspace tasks retain unstarted backlog and truthful blocked/failed execution states", function () {
  var rows = projectTasks({ projectId: "project-a", bindings: [
    binding("later", 1, "pending"), binding("blocked", 1, "blocked"), binding("broken", 1, "failed"),
    binding("other-project", 1, "pending", { targetProject: { projectId: "project-b" } }),
  ], sessions: [] });
  assert.deepEqual(rows.map(function (row) { return [row.key, row.group, row.status]; }).sort(), [
    ["blocked", "started", "blocked"], ["broken", "started", "failed"], ["later", "waiting", "pending"],
  ]);
});
