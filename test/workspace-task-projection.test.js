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

test("Workspace tasks replace bare assent titles with the linked objective", function () {
  var rows = projectTasks({ projectId: "project-a", bindings: [binding("audit", 1, "active")], sessions: [{
    storageId: "coordinator", orchestrationTasks: [{ taskId: "audit",
      clientRef: "portfolio:audit:1", title: "do it", objective: "Audit the Workspace task projection",
      status: "running", updatedAt: 100 }],
  }] });
  assert.equal(rows[0].title, "Audit the Workspace task projection");
  assert.doesNotMatch(rows[0].title, /^(?:do it|yes now|continue)$/i);
});

test("Workspace tasks disclose missing context instead of inventing a task from assent", function () {
  var rows = projectTasks({ projectId: "project-a", bindings: [], sessions: [{
    storageId: "coordinator", orchestrationTasks: [{ taskId: "unknown",
      title: "yes now", objective: "continue", context: "", status: "pending", updatedAt: 100 }],
  }] });
  assert.equal(rows[0].title, "Unresolved task context for unknown");
});

test("Workspace tasks do not attach an older execution revision to the current binding", function () {
  var rows = projectTasks({ projectId: "project-a", bindings: [binding("deploy", 2, "active")], sessions: [{
    storageId: "coordinator", orchestrationTasks: [{ taskId: "old-deploy",
      clientRef: "portfolio:deploy:1", title: "Old revision title", status: "completed",
      workerSessionId: 37, updatedAt: 100 }],
  }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Task deploy");
  assert.equal(rows[0].sessionId, null);
  assert.equal(rows[0].status, "active");
});

test("Workspace tasks reject composite assent and use its concrete objective", function () {
  var rows = projectTasks({ projectId: "project-a", bindings: [], sessions: [{
    storageId: "coordinator", orchestrationTasks: [{ taskId: "ship",
      title: "Yes, proceed", objective: "Ship the task panel", status: "pending", updatedAt: 100 }],
  }] });
  assert.equal(rows[0].title, "Ship the task panel");
});

test("Lead uses the latest target-project execution instead of stale resident task badges", function () {
  var resident = { storageId: "resident", orchestrationTasks: [
    { taskId: "old", clientRef: "portfolio:deploy:1", title: "Old deployment", status: "running" },
    { taskId: "current", clientRef: "portfolio:deploy:2", title: "Deploy Tasks", status: "running" },
  ] };
  var rows = projectTasks({ projectId: "system-lead", sessions: [resident], bindings: [
    binding("deploy", 1, "failed", { projectCoordinator: { projectId: "system-lead", sessionStorageId: "resident" } }),
    binding("deploy", 2, "completed", { projectCoordinator: { projectId: "system-lead", sessionStorageId: "resident" } }),
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].group, "completed");
  assert.equal(rows[0].title, "Deploy Tasks");
  assert.equal(rows[0].bindingRevision, 2);
  assert.equal(resident.orchestrationTasks[1].status, "running", "projection does not rewrite historical records");
});

test("Lead does not import unrelated global bindings or claim unverified historical work is running", function () {
  var rows = projectTasks({ projectId: "system-lead", sessions: [{
    storageId: "resident", orchestrationTasks: [
      { taskId: "legacy", clientRef: "portfolio:legacy:1", title: "Recover the old runtime", status: "running" },
      { taskId: "mismatch", clientRef: "portfolio:mismatch:1", title: "Check project state", status: "running" },
      { taskId: "done", clientRef: "portfolio:done:1", title: "Completed audit", status: "completed" },
    ],
  }], bindings: [
    binding("hidden", 1, "active"),
    binding("mismatch", 1, "completed", { source: { projectId: "system-lead", sessionStorageId: "another-owner" } }),
  ] });
  assert.equal(rows.length, 3);
  assert.equal(rows.find(function (row) { return row.key === "legacy"; }).status, "unavailable");
  assert.equal(rows.find(function (row) { return row.key === "mismatch"; }).status, "unavailable");
  assert.equal(rows.find(function (row) { return row.key === "done"; }).status, "completed");
  assert.equal(rows.some(function (row) { return row.key === "hidden"; }), false);
});

test("ordinary project views cannot use another project's execution as their status source", function () {
  var rows = projectTasks({ projectId: "project-b", sessions: [{
    storageId: "resident", orchestrationTasks: [{ taskId: "task", clientRef: "portfolio:deploy:1", title: "Local deployment", status: "pending" }],
  }], bindings: [binding("deploy", 1, "completed", { source: { projectId: "system-lead", sessionStorageId: "resident" } })] });
  assert.equal(rows[0].status, "pending");
});

test("Lead reconciles older visible task references against their exact target project", function () {
  var rows = projectTasks({ projectId: "system-lead", sessions: [{ storageId: "resident", orchestrationTasks: [
    { taskId: "task", clientRef: "portfolio:deploy:1", title: "Deploy the preview", status: "running", coopProjectRef: { projectId: "project-a" } },
    { taskId: "other", clientRef: "portfolio:other:1", title: "Another deployment", status: "running", coopProjectRef: { projectId: "project-b" } },
  ] }], bindings: [binding("deploy", 1, "failed"), binding("other", 1, "completed")] });
  assert.equal(rows.find(function (row) { return row.key === "deploy"; }).status, "failed");
  assert.equal(rows.find(function (row) { return row.key === "other"; }).status, "unavailable");
});

test("Lead only calls an unbound local worker running with live processing evidence", function () {
  var rows = projectTasks({ projectId: "system-lead", bindings: [], sessions: [
    { storageId: "resident", orchestrationTasks: [
      { taskId: "live", title: "Run the build", status: "running", workerStorageId: "live-worker" },
      { taskId: "idle", title: "Review the build", status: "running", workerSessionId: 44 },
      { taskId: "gone", title: "Check the previous build", status: "running", workerStorageId: "missing" },
    ] },
    { storageId: "live-worker", isProcessing: true },
    { localId: 44, storageId: "idle-worker", isProcessing: false },
  ] });
  assert.equal(rows.find(function (row) { return row.taskId === "live"; }).status, "running");
  assert.equal(rows.find(function (row) { return row.taskId === "idle"; }).status, "unavailable");
  assert.equal(rows.find(function (row) { return row.taskId === "gone"; }).status, "unavailable");
});

test("a stale session copy cannot mask an authoritative binding discovered later", function () {
  var rows = projectTasks({ projectId: "system-lead", sessions: [
    { storageId: "historical-copy", orchestrationTasks: [
      { taskId: "old", clientRef: "portfolio:deploy:1", title: "Old deployment", status: "running", updatedAt: 1000 },
    ] },
    { storageId: "resident", orchestrationTasks: [
      { taskId: "current", clientRef: "portfolio:deploy:2", title: "Current deployment", status: "running", coopProjectRef: { projectId: "project-a" } },
    ] },
  ], bindings: [binding("deploy", 2, "failed")] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].title, "Current deployment");
  assert.equal(rows[0].bindingRevision, 2);
});
