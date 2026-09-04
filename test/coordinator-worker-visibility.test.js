var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var buildGlobalCoopProjection = require("../lib/global-coop-projection").buildGlobalCoopProjection;

function worker(id, status, lastActivity, active) {
  return {
    id: id,
    active: !!active,
    lastActivity: lastActivity,
    orchestrationParent: { taskStatus: status }
  };
}

test("collapsed coordinator workers show at most three current workers", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "running", 10),
    worker(2, "ready", 20),
    worker(3, "queued", 30),
    worker(4, "running", 40),
    worker(5, "completed", 50)
  ], 99, false);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [4, 3, 2]);
  assert.equal(display.hiddenActive, 1);
  assert.equal(display.hiddenResolved, 1);
});

test("collapsed coordinator workers show recent resolved work when none are current", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "completed", 10),
    worker(2, "dismissed", 20),
    worker(3, "completed", 30),
    worker(4, "completed", 40),
    worker(5, "completed", 50)
  ], 100, false);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [5, 4, 3]);
  assert.equal(display.hiddenActive, 0);
  assert.equal(display.hiddenResolved, 2);
});

test("a selected resolved session does not outrank current work", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "completed", 50, true),
    worker(2, "running", 10)
  ], 103, false);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [2]);
  assert.equal(display.hiddenResolved, 1);
});

test("attention states appear before ordinary active work", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "running", 50),
    worker(2, "needs_input", 10),
    worker(3, "blocked", 20)
  ], 101, false);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [3, 2, 1]);
});

test("forced expansion returns active and resolved workers", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "completed", 30),
    worker(2, "running", 20),
    worker(3, "dismissed", 10)
  ], 102, true);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [2, 1, 3]);
  assert.equal(display.expanded, true);
  assert.equal(display.hiddenCount, 0);
});

function projectionContext(status, sessions) {
  var sessionMap = new Map(sessions.map(function (session) { return [session.localId, session]; }));
  return {
    projectId: status.projectId,
    slug: status.slug,
    getStatus: function () { return status; },
    getSessionManager: function () {
      return {
        sessions: sessionMap,
        createSessionRaw: function (options) {
          var created = Object.assign({
            localId: sessionMap.size + 100,
            title: "Project channel",
            lastActivity: 0,
          }, options);
          sessionMap.set(created.localId, created);
          return created;
        },
      };
    },
  };
}

test("global projection excludes legacy Lead rows and pending migration artifacts", function () {
  var targetId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var target = projectionContext({ projectId: targetId, slug: "clay", title: "Clay" }, []);
  var coop = {
    localId: 1,
    storageId: "coop-home",
    coopHome: true,
    orchestrationTasks: [{ taskId: "legacy-done", status: "completed" }],
  };
  var historical = {
    localId: 2,
    storageId: "legacy-worker",
    title: "Legacy terminal worker",
    hidden: true,
    history: [{ type: "delta", text: "must not be projected" }],
    orchestrationParent: { taskId: "legacy-done", sessionStorageId: "coop-home" },
  };
  var lead = projectionContext({ projectId: "system-lead", slug: "lead", title: "Coop" }, [
    coop, historical,
  ]);
  var projection = buildGlobalCoopProjection({
    projects: [target, lead],
    bindings: [{
      portfolioTaskId: "portfolio-attention",
      bindingRevision: 1,
      idempotencyKey: "migration-attention",
      mode: "direct_leaf",
      status: "pending",
      statusReason: "project_unavailable",
      attentionAt: 10,
      targetProject: { projectId: targetId },
      createdAt: 1,
      updatedAt: 10,
    }, {
      portfolioTaskId: "portfolio-missing-project",
      bindingRevision: 1,
      idempotencyKey: "missing-project-attention",
      mode: "project_coordinator",
      status: "pending",
      statusReason: "project_unavailable",
      attentionAt: 11,
      targetProject: { projectId: "system-missing-project" },
      createdAt: 1,
      updatedAt: 11,
    }],
    canAccessSession: function () { return true; },
  });

  assert.deepEqual(projection.projects.map(function (group) { return group.title; }), ["Clay"]);
  assert.deepEqual(projection.coop.sessionRef, {
    projectId: "system-lead", sessionStorageId: "coop-home",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(projection.coop, "history"), false);
  assert.deepEqual(projection.projects[0].projectRef, { projectId: targetId });
  assert.equal(projection.projects[0].channel.sessionRef.projectId, "system-lead");
  assert.equal(projection.projects[0].summary.freshness.stale, true);
  assert.equal(Object.prototype.hasOwnProperty.call(projection.projects[0], "directLeaves"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(projection.projects[0], "coordinators"), false);
  assert.equal(JSON.stringify(projection).includes("must not be projected"), false);
  assert.equal(JSON.stringify(projection).includes("Legacy terminal worker"), false);
  assert.equal(JSON.stringify(projection).includes("project_unavailable"), false);
});
