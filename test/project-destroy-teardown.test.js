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

function createRecoveryEventSink() {
  var events = [];
  return {
    events: events,
    record: function (event) { events.push(event); },
  };
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

test("destroy() stops the project-local self-cleanup runtime", function () {
  var stopCalls = 0;
  var timers = {
    coopSelfCleanupRuntime: { stop: function () { stopCalls++; } },
  };
  var destroy = createProjectDestroy(minimalDestroyCtx({ timers: timers }));

  destroy();

  assert.equal(stopCalls, 1);
  assert.equal(timers.coopSelfCleanupRuntime, null);
});

test("destroy() unregisters the project Live UI route", function () {
  var disposeCalls = 0;
  var destroy = createProjectDestroy(minimalDestroyCtx());

  destroy({ dispose: function () { disposeCalls++; } });

  assert.equal(disposeCalls, 1);
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
  var sink = createRecoveryEventSink();
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
      recordRecoveryEvent: sink.record,
      getProjectContext: function (slug) { return projects.get(slug) || null; },
      // Without an explicit bindingFile the binding store and session ledger
      // resolve to the real ~/.clay/lead files, so a direct run of this file
      // reads live owner state and any reconcile could rewrite it.
      bindingFile: path.join(scratch, "bindings.json"),
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
    assert.deepEqual(sink.events, [{
      kind: "cross_project_dead_letter",
      targetSlug: "lead",
      sessionStorageId: "coop-home",
      reason: "unknown-project",
    }]);
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

test("destroyed recovery managers cannot compete with their replacement or remove other worktrees", async function (t) {
  var runtime = require("../lib/coop-control-runtime");
  runtime.closeExecutionControl();
  var dir = createScratchDir("recovery-unregister");
  t.after(function () {
    runtime.closeExecutionControl();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  var options = { enabled: true, dbPath: path.join(dir, "control.sqlite") };
  var delivery = runtime.getDeliveryControl(options);
  var project = "11111111-1111-5111-8111-111111111111";
  var otherProject = "22222222-2222-5222-8222-222222222222";
  var applied = [];
  function register(projectId, storageId, name) {
    var manager = { sessions: new Map([[1, { localId: 1, storageId: storageId }]]) };
    runtime.registerRecoveryTarget({ projectRef: { projectId: projectId }, sessionManager: manager,
      recoveryHandlers: {
        applyEffect: function (effect) { applied.push(name); return { receiptId: "receipt-" + effect.effectId }; },
        send: function () { return { accepted: true }; },
      },
    });
    return manager;
  }
  var old = register(project, "canonical", "destroyed");
  register(project, "worktree", "worktree");
  register(otherProject, "other", "other");
  await createProjectDestroy(minimalDestroyCtx({ sm: old }))();
  register(project, "canonical", "replacement");
  [[project, "canonical"], [project, "worktree"], [otherProject, "other"]].forEach(function (item, index) {
    var target = { projectId: item[0], sessionStorageId: item[1] };
    delivery.receive({ messageId: "manager-effect-" + index,
      sender: { projectId: "system-lead", sessionStorageId: "coop" }, recipient: target,
      kind: "rehydration", referenceId: "checkpoint-" + index, payloadDigest: "a".repeat(64),
    }, { kind: "rehydrate", target: target });
  });
  var recovered = await runtime.recoverStartup(options);
  assert.equal(recovered.reconciledEffects, 3);
  assert.deepEqual(applied.sort(), ["other", "replacement", "worktree"]);
  assert.equal(delivery.listPendingEffects().length, 0);
  assert.equal(runtime.unregisterRecoveryTarget(old), false, "teardown already removed this manager");
});
