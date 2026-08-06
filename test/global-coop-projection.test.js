var test = require("node:test");
var assert = require("node:assert/strict");
var buildGlobalCoopProjection = require("../lib/global-coop-projection").buildGlobalCoopProjection;

function session(id, value) {
  return Object.assign({
    localId: id,
    storageId: "session-" + id,
    title: "Session " + id,
    lastActivity: 10,
  }, value || {});
}

function project(projectId, slug, sessions, extra) {
  var manager = {
    sessions: new Map(sessions.map(function (item) { return [item.localId, item]; })),
    saveSessionFile: function () {},
    createSessionRaw: function (options) {
      var created = session(this.sessions.size + 100, options);
      this.sessions.set(created.localId, created);
      return created;
    },
  };
  return Object.assign({
    projectId: projectId,
    slug: slug,
    title: slug,
    sm: manager,
  }, extra || {});
}

test("Coop projects each accessible configured project into a main-lane lens with canonical nested sessions", function () {
  var home = session(1, { storageId: "coop-home", coopHome: true });
  var lead = project("system-lead", "lead", [home], { isLead: true });
  var task = {
    taskId: "active-work",
    title: "Fix project switch",
    objective: "Keep project navigation isolated",
    status: "running",
    currentActivity: "Adding target-keyed cache",
    updatedAt: 20,
  };
  var coordinator = session(10, {
    coordinationMode: true,
    orchestrationTasks: [task],
    orchestrationProjectCompletion: {
      status: "completed",
      summary: "Earlier verified release",
      completedAt: 15,
    },
  });
  var directOwnerSession = session(11, { title: "Owner direct conversation" });
  var worker = session(12, {
    title: "Canonical worker",
    orchestrationParent: { sessionStorageId: coordinator.storageId, taskId: task.taskId },
  });
  var clay = project("11111111-1111-5111-8111-111111111111", "clay", [coordinator, directOwnerSession, worker], { title: "Clay" });
  var worktree = project("22222222-2222-5222-8222-222222222222", "clay--feature", [], { isWorktree: true });
  var mate = project("33333333-3333-5333-8333-333333333333", "mate-ada", [], { isMate: true });

  var projection = buildGlobalCoopProjection({ projects: [lead, clay, worktree, mate] });

  assert.equal(projection.coop.sessionRef.projectId, "system-lead");
  assert.equal(projection.projects.length, 1);
  var channel = projection.projects[0];
  assert.deepEqual(channel.projectRef, { projectId: clay.projectId });
  assert.equal(channel.channel.sessionRef.projectId, "system-lead");
  assert.equal(channel.channel.sessionRef.sessionStorageId, "coop-home");
  assert.equal(channel.channel.isLens, true);
  assert.equal(channel.summary.goals[0], "Keep project navigation isolated");
  assert.equal(channel.summary.activeWork[0].title, "Fix project switch");
  assert.equal(channel.summary.outcomes[0].summary, "Earlier verified release");
  assert.match(channel.summary.nextAction, /active delegated work/);
  assert.equal(Object.hasOwn(channel, "coordinators"), false);
  assert.equal(Object.hasOwn(channel, "directLeaves"), false);
  assert.equal(JSON.stringify(channel).includes("Owner direct conversation"), false);
  assert.equal(channel.summary.metrics.activeCoordinators, 1);
  assert.equal(channel.summary.metrics.activeWorkers, 1);
  assert.equal(channel.summary.coordinatorTree[0].sessionRef.projectId, clay.projectId);
  assert.equal(channel.summary.coordinatorTree[0].children[0].sessionRef.sessionStorageId, worker.storageId);

  var second = buildGlobalCoopProjection({ projects: [lead, clay] });
  assert.equal(second.projects[0].channel.sessionRef.sessionStorageId,
    channel.channel.sessionRef.sessionStorageId);
});

test("Coop summary applies project ACLs and summarizes attention without exposing attempts", function () {
  var lead = project("system-lead", "lead", [session(1, { storageId: "coop-home", coopHome: true })], { isLead: true });
  var blocked = session(2, {
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "needs-owner",
      title: "Choose owner",
      status: "needs_input",
      userQuestion: "Which owner should approve this?",
      workerStorageId: "hidden-worker",
      attempt: 3,
    }],
  });
  var visible = project("44444444-4444-5444-8444-444444444444", "visible", [blocked]);
  var denied = project("55555555-5555-5555-8555-555555555555", "denied", []);
  var projection = buildGlobalCoopProjection({
    projects: [lead, visible, denied],
    canAccessProject: function (_, item) { return item !== denied; },
  });

  assert.deepEqual(projection.projects.map(function (item) { return item.slug; }), ["visible"]);
  assert.equal(projection.projects[0].summary.attention[0].title, "Choose owner");
  assert.match(projection.projects[0].summary.nextAction, /resolve attention/);
  assert.equal(JSON.stringify(projection.projects[0]).includes("hidden-worker"), false);
  assert.equal(JSON.stringify(projection.projects[0]).includes("attempt"), false);
});
