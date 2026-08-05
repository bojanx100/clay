// Gate 4: proves project teardown (1) actually stops the Coop watchdog
// timer via the real createProjectDestroy contract, and (2) that once a
// project's slug is unregistered from the process-wide projects registry
// (mirroring server.js's removeProject, which calls ctx.destroy() BEFORE
// deleting the slug from its projects Map), any cross-project fan-in
// delivery still targeting that slug degrades to a durable dead-letter --
// it never throws and never silently vanishes.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var createProjectDestroy = require("../lib/project-destroy").createProjectDestroy;
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var attachCoopFanIn = require("../lib/coop-fanin-delivery").attachCoopFanIn;

function createScratchDir(name) {
  var base = path.join(__dirname, ".scratch");
  fs.mkdirSync(base, { recursive: true });
  var dir = path.join(base, name + "-" + process.pid + "-" + Date.now() + "-" +
    Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalDestroyCtx(overrides) {
  var timers = {};
  var base = {
    cwd: "/tmp/does-not-matter",
    slug: "clay",
    timers: timers,
    loop: { stopTimer: function () {} },
    email: { destroy: function () {} },
    mateDatastore: null,
    stopFileWatch: function () {},
    stopAllDirWatches: function () {},
    sm: { sessions: new Map() },
    tm: { destroyAll: function () {} },
    clients: new Set(),
    adapters: {},
    sdk: { stopIdleReaper: function () {} },
    getTaskOrchestrator: function () { return null; },
  };
  return Object.assign(base, overrides || {});
}

test("destroy() stops the Coop watchdog timer via getTaskOrchestrator().stopCoopWatchdog()", function () {
  var stopCalls = 0;
  var taskOrchestrator = {
    stopCoopWatchdog: function () { stopCalls++; },
  };
  var destroy = createProjectDestroy(minimalDestroyCtx({
    getTaskOrchestrator: function () { return taskOrchestrator; },
  }));
  destroy();
  assert.equal(stopCalls, 1, "destroy() must stop the watchdog exactly once");
});

test("destroy() does not throw when the watchdog stop function itself throws", function () {
  var taskOrchestrator = {
    stopCoopWatchdog: function () { throw new Error("boom"); },
  };
  var destroy = createProjectDestroy(minimalDestroyCtx({
    getTaskOrchestrator: function () { return taskOrchestrator; },
  }));
  assert.doesNotThrow(function () { destroy(); });
});

test("destroy() tolerates a project with no task orchestrator wired at all", function () {
  var destroy = createProjectDestroy(minimalDestroyCtx({ getTaskOrchestrator: undefined }));
  assert.doesNotThrow(function () { destroy(); });
});

test("removing a project from the registry (post-destroy) makes cross-project delivery dead-letter safely, not crash", function () {
  var scratch = createScratchDir("teardown-cross-project");
  try {
    // Simulate server.js's projects Map: register "lead", then remove it
    // the same way removeProject() does -- ctx.destroy() happens first,
    // then the slug is deleted from the registry.
    var coopSession = { localId: 1, storageId: "coop-home", pendingCoordinatorUpdates: [] };
    var leadSm = { sessions: new Map([[1, coopSession]]) };
    var leadCtx = {
      deliverCoordinatorUpdate: function (sessionStorageId, text) {
        var found = null;
        leadSm.sessions.forEach(function (session) {
          if (!found && session.storageId === sessionStorageId) found = session;
        });
        if (!found) return false;
        found.pendingCoordinatorUpdates.push({ text: text });
        return true;
      },
    };
    var projects = new Map();
    projects.set("lead", leadCtx);
    var crossProject = createCrossProjectRouter({
      getProjectContext: function (slug) { return projects.get(slug) || null; },
    });

    var claySm = { sessions: new Map() };
    var fanIn = attachCoopFanIn({
      sm: claySm,
      slug: "clay",
      crossProject: crossProject,
      now: function () { return 1; },
      queueCoordinatorUpdate: function () {},
      deliveryFile: path.join(scratch, "coop-fanin-delivery.json"),
    });

    // Tear the lead project down: destroy() runs, THEN the registry entry
    // is removed -- exactly server.js's removeProject() ordering.
    var taskOrchestrator = { stopCoopWatchdog: function () {} };
    var destroyLead = createProjectDestroy(minimalDestroyCtx({
      slug: "lead",
      sm: leadSm,
      getTaskOrchestrator: function () { return taskOrchestrator; },
    }));
    destroyLead();
    projects.delete("lead");

    var event = {
      eventId: "post-teardown-event",
      coopSessionStorageId: "coop-home",
      sessionStorageId: "worker-1",
      taskId: "task-1",
      status: "completed",
      occurredAt: 1,
    };
    var result;
    assert.doesNotThrow(function () { result = fanIn.deliverEvent(event); });
    assert.equal(result.ok, false);
    assert.equal(result.delivered, false);
    assert.equal(result.pending, true);
    assert.deepEqual(fanIn.getPendingEventIds(), ["post-teardown-event"]);
    // Never silently lost: it is durably queued for retry.
    var onDisk = JSON.parse(fs.readFileSync(path.join(scratch, "coop-fanin-delivery.json"), "utf8"));
    assert.equal(onDisk.pending.length, 1);

    // Once the project reattaches (re-registered under the same slug), the
    // watchdog's retryPending() successfully delivers the dead-lettered event.
    projects.set("lead", leadCtx);
    var delivered = fanIn.retryPending();
    assert.deepEqual(delivered, ["post-teardown-event"]);
    assert.equal(coopSession.pendingCoordinatorUpdates.length, 1);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
