var test = require("node:test");
var assert = require("node:assert/strict");
var hierarchy = require("../lib/project-coordinator-hierarchy");
var buildFanInEvent = require("../lib/coop-fanin-events").buildFanInEvent;

function manager(existing) {
  var sessions = existing || new Map();
  var next = 10;
  return {
    sessions: sessions,
    createSessionRaw: function (options) {
      var session = Object.assign({
        localId: next,
        history: [],
        createdAt: next,
      }, options || {});
      if (!session.storageId) session.storageId = "session-" + next;
      next += 1;
      sessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
}

function request(id, revision) {
  return {
    portfolioTaskId: id,
    bindingRevision: revision,
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    coopTopicRef: { topicId: "topic-" + id },
  };
}

function brief(title) {
  return { title: title, objective: title, context: "", acceptanceCriteria: "Done",
    ownedPaths: "lib/", provider: "codex", model: "gpt-5.6-terra" };
}

test("an archived legacy coordinator becomes the reusable project root", function () {
  var sessions = new Map();
  var legacy = {
    localId: 1,
    storageId: "legacy-project-root",
    hidden: true,
    closedAt: 10,
    coordinationMode: true,
    orchestrationTasks: [],
    orchestrationEvents: [],
    orchestrationPolicy: { portfolioExecution: { mode: "project_coordinator", status: "completed" } },
    history: [],
  };
  sessions.set(1, legacy);
  var sm = manager(sessions);
  var root = hierarchy.ensureProjectCoordinator(sm,
    "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
    { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "legacy-project-root" },
    { sessionStorageId: "coop" });

  assert.equal(root, legacy);
  assert.equal(root.hidden, false);
  assert.equal(root.closedAt, null);
  assert.equal(root.coordinationRole, "project_coordinator");
  assert.equal(root.title, "Project coordinator");
  assert.equal(root.orchestrationPolicy.portfolioExecution, undefined);
  assert.equal(sessions.size, 1);
});

test("a new project root is born with a durable storage identity", function () {
  var createdOptions = null;
  var sm = manager();
  var create = sm.createSessionRaw;
  sm.createSessionRaw = function (options) {
    createdOptions = options;
    return create(options);
  };
  var root = hierarchy.ensureProjectCoordinator(sm,
    "5332aafc-31e7-5cb1-ba96-c8d90e78260e", null,
    { sessionStorageId: "coop" });

  assert.match(createdOptions.storageId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(root.storageId, createdOptions.storageId);
});

test("one project root owns multiple concurrent task coordinators and their rollups", function () {
  var sm = manager();
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var root = hierarchy.ensureProjectCoordinator(sm, projectId, null,
    { sessionStorageId: "coop" });
  var first = sm.createSessionRaw({ coordinationMode: true });
  var second = sm.createSessionRaw({ coordinationMode: true });

  hierarchy.linkTaskCoordinator(sm, root, first, {
    request: request("one", 1), brief: brief("First task coordinator"),
  });
  hierarchy.linkTaskCoordinator(sm, root, second, {
    request: request("two", 1), brief: brief("Second task coordinator"),
  });

  assert.equal(root.orchestrationTasks.length, 2);
  assert.equal(first.coordinationRole, "task_coordinator");
  assert.equal(second.coordinationRole, "task_coordinator");
  assert.equal(first.orchestrationParent.sessionStorageId, root.storageId);
  assert.equal(second.orchestrationParent.sessionStorageId, root.storageId);
  assert.equal(root.orchestrationTasks.every(function (task) {
    return task.externalTaskCoordinator && task.status === "running";
  }), true);

  assert.equal(hierarchy.rollUpTaskCoordinator(sm, first, "completed", "Verified."), true);
  assert.equal(root.orchestrationTasks[0].status, "completed");
  assert.equal(root.orchestrationTasks[0].resultSummary, "Verified.");
  assert.equal(hierarchy.rollUpTaskCoordinator(sm, second, "needs_input", "Owner decision."), true);
  assert.equal(root.orchestrationTasks[1].status, "needs_input");
  assert.equal(hierarchy.markTaskCoordinatorRunning(sm, second), true);
  assert.equal(root.orchestrationTasks[1].status, "running");

  var recovered = hierarchy.ensureProjectCoordinator(sm, projectId, null,
    { sessionStorageId: "coop" });
  assert.equal(recovered, root);
  assert.equal(Array.from(sm.sessions.values()).filter(function (session) {
    return session.coordinationRole === "project_coordinator";
  }).length, 1);
});

test("a restored terminal task rollup does not restamp or replay fan-in", function () {
  var sm = manager();
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var root = hierarchy.ensureProjectCoordinator(sm, projectId, null,
    { sessionStorageId: "coop" });
  var child = sm.createSessionRaw({ coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: "coop", since: 1 } });
  hierarchy.linkTaskCoordinator(sm, root, child, {
    request: request("restart-dedupe", 1), brief: brief("Restart dedupe"),
  });

  assert.equal(hierarchy.rollUpTaskCoordinator(sm, child, "completed", "Verified."), true);
  var task = root.orchestrationTasks[0];
  var updatedAt = task.updatedAt;
  var eventCount = root.orchestrationEvents.length;
  var beforeRestart = buildFanInEvent(child, task, { status: task.status,
    occurredAt: task.updatedAt, summary: task.resultSummary });

  assert.equal(hierarchy.rollUpTaskCoordinator(sm, child, "completed", "Verified."), false);
  var afterRestart = buildFanInEvent(child, task, { status: task.status,
    occurredAt: task.updatedAt, summary: task.resultSummary });
  assert.equal(task.updatedAt, updatedAt);
  assert.equal(root.orchestrationEvents.length, eventCount);
  assert.equal(afterRestart.eventId, beforeRestart.eventId);
});

test("a failed child start removes only its project-root reference", function () {
  var sm = manager();
  var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var root = hierarchy.ensureProjectCoordinator(sm, projectId, null,
    { sessionStorageId: "coop" });
  var child = sm.createSessionRaw({ coordinationMode: true });
  hierarchy.linkTaskCoordinator(sm, root, child, {
    request: request("rollback", 1), brief: brief("Rollback"),
  });
  assert.equal(root.orchestrationTasks.length, 1);
  assert.equal(hierarchy.unlinkTaskCoordinator(sm, root, child), true);
  assert.equal(root.orchestrationTasks.length, 0);
  assert.equal(root.coordinationRole, "project_coordinator");
});
