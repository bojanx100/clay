// Proves gate 1: a Coop-controlled coordinator/worker living in a DIFFERENT
// project (e.g. Clay, Webapp, Urban Stay) than the canonical Coop session
// (which only ever lives in the "lead" project) can still deliver terminal/
// needs-attention fan-in events to it. This uses the REAL cross-project
// router (lib/server-cross-project.js) wired the same way server.js wires
// it -- a shared `projects` Map keyed by slug, resolved via
// getProjectContext -- so this is not a same-process shortcut: it proves
// delivery across two distinct session-manager instances that only share
// the router, mirroring the daemon's actual topology.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

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

// Builds a minimal fake "lead" project ctx exposing exactly the
// deliverCoordinatorUpdate contract server-cross-project.js relies on,
// backed by its own independent session manager (a distinct Map instance,
// standing in for a distinct session-manager instance in a distinct
// project process scope).
function makeFakeLeadProjectCtx(leadSm) {
  return {
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
}

test("a worker fan-in event in a non-lead project is delivered cross-project to the real Coop session", function () {
  var scratch = createScratchDir("cross-project-fanin");
  var sink = createRecoveryEventSink();
  try {
    var coopSession = { localId: 1, storageId: "coop-home", pendingCoordinatorUpdates: [] };
    var leadSm = { sessions: new Map([[1, coopSession]]) };
    var leadProjectCtx = makeFakeLeadProjectCtx(leadSm);

    var projects = new Map();
    projects.set("lead", leadProjectCtx);

    var crossProject = createCrossProjectRouter({
      recordRecoveryEvent: sink.record,
      getProjectContext: function (slug) { return projects.get(slug) || null; },
      // Without an explicit bindingFile the binding store and session ledger
      // resolve to the real ~/.clay/lead files, so a direct run of this file
      // reads live owner state and any reconcile could rewrite it.
      bindingFile: path.join(scratch, "bindings.json"),
    });

    // The controlled worker lives in a totally separate project ("clay")
    // with its OWN session manager instance -- it never sees leadSm.
    var claySm = { sessions: new Map() };
    var fanIn = attachCoopFanIn({
      sm: claySm,
      slug: "clay",
      crossProject: crossProject,
      now: function () { return 1000; },
      queueCoordinatorUpdate: function () {
        assert.fail("non-lead project must never queue locally; must route cross-project");
      },
      deliveryFile: path.join(scratch, "coop-fanin-delivery.json"),
    });

    var event = {
      eventId: "cross-event-1",
      coopSessionStorageId: "coop-home",
      sessionStorageId: "worker-in-clay-project",
      taskId: "task-1",
      status: "completed",
      summary: "Cross-project worker finished",
      occurredAt: 999,
      schemaVersion: 1,
      type: "coop_task_transition",
    };

    var result = fanIn.deliverEvent(event);
    assert.deepEqual(result, { ok: true, delivered: true });
    assert.equal(fanIn.hasDelivered("cross-event-1"), true);
    assert.equal(coopSession.pendingCoordinatorUpdates.length, 1);
    assert.match(coopSession.pendingCoordinatorUpdates[0].text, /coop_fanin_event/);
    assert.match(coopSession.pendingCoordinatorUpdates[0].text, /worker-in-clay-project/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("fan-in uses a durable typed envelope when project identities are available", function () {
  var scratch = createScratchDir("typed-cross-project-fanin");
  try {
    var received = [];
    var projects = new Map([["system-lead", {
      deliverCrossProjectEnvelope: function (envelope) {
        received.push(envelope);
        return { ok: true };
      },
    }]]);
    var crossProject = createCrossProjectRouter({
      deliveryFile: path.join(scratch, "transport.json"),
      getProjectContext: function () { return null; },
      getProjectContextById: function (projectId) { return projects.get(projectId) || null; },
      bindingFile: path.join(scratch, "bindings.json"),
    });
    var fanIn = attachCoopFanIn({
      sm: { sessions: new Map(), getProjectId: function () { return "system-source"; } },
      slug: "renamed-source-project",
      crossProject: crossProject,
      now: function () { return 1000; },
      queueCoordinatorUpdate: function () { assert.fail("typed cross-project delivery must not queue locally"); },
      deliveryFile: path.join(scratch, "fan-in.json"),
    });
    var result = fanIn.deliverEvent({
      eventId: "typed-fanin-event",
      coopSessionStorageId: "coop-home",
      sessionStorageId: "source-worker",
      taskId: "task-1",
      status: "completed",
      occurredAt: 999,
    });

    assert.deepEqual(result, { ok: true, delivered: true });
    assert.equal(received.length, 1);
    assert.equal(received[0].destination.projectId, "system-lead");
    assert.equal(received[0].source.projectId, "system-source");
    assert.equal(received[0].sourceSeq, 1);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("cross-project delivery to a not-yet-registered lead project stays durably pending, never lost", function () {
  var scratch = createScratchDir("cross-project-fanin-pending");
  var sink = createRecoveryEventSink();
  try {
    var projects = new Map(); // "lead" is NOT registered yet
    var crossProject = createCrossProjectRouter({
      recordRecoveryEvent: sink.record,
      getProjectContext: function (slug) { return projects.get(slug) || null; },
      bindingFile: path.join(scratch, "bindings.json"),
    });
    var claySm = { sessions: new Map() };
    var deliveryFile = path.join(scratch, "coop-fanin-delivery.json");
    var fanIn = attachCoopFanIn({
      sm: claySm,
      slug: "clay",
      crossProject: crossProject,
      now: function () { return 1000; },
      queueCoordinatorUpdate: function () {},
      deliveryFile: deliveryFile,
    });

    var event = {
      eventId: "cross-event-pending",
      coopSessionStorageId: "coop-home",
      sessionStorageId: "worker-1",
      taskId: "task-1",
      status: "failed",
      occurredAt: 999,
    };

    var result = fanIn.deliverEvent(event);
    assert.equal(result.ok, false);
    assert.equal(result.delivered, false);
    assert.equal(result.pending, true);
    assert.equal(fanIn.hasDelivered("cross-event-pending"), false);
    assert.deepEqual(fanIn.getPendingEventIds(), ["cross-event-pending"]);

    var onDisk = JSON.parse(fs.readFileSync(deliveryFile, "utf8"));
    assert.equal(onDisk.pending.length, 1);
    assert.equal(onDisk.pending[0].eventId, "cross-event-pending");
    assert.equal(onDisk.delivered.length, 0);
    assert.deepEqual(sink.events, [{
      kind: "cross_project_dead_letter",
      targetSlug: "lead",
      sessionStorageId: "coop-home",
      reason: "unknown-project",
    }]);

    // Now the lead project attaches (as it would once the daemon finishes
    // registering it) and the watchdog's retryPending() runs.
    var coopSession = { localId: 1, storageId: "coop-home", pendingCoordinatorUpdates: [] };
    var leadSm = { sessions: new Map([[1, coopSession]]) };
    projects.set("lead", makeFakeLeadProjectCtx(leadSm));

    var delivered = fanIn.retryPending();
    assert.deepEqual(delivered, ["cross-event-pending"]);
    assert.equal(fanIn.hasDelivered("cross-event-pending"), true);
    assert.deepEqual(fanIn.getPendingEventIds(), []);
    assert.equal(coopSession.pendingCoordinatorUpdates.length, 1);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a pending cross-project event survives a restart (fresh module instance reloads and retries it)", function () {
  var scratch = createScratchDir("cross-project-fanin-restart");
  var deliveryFile = path.join(scratch, "coop-fanin-delivery.json");
  var sink = createRecoveryEventSink();
  try {
    var emptyProjects = new Map();
    var crossProjectDown = createCrossProjectRouter({
      recordRecoveryEvent: sink.record,
      getProjectContext: function (slug) { return emptyProjects.get(slug) || null; },
      bindingFile: path.join(scratch, "bindings.json"),
    });
    var claySm = { sessions: new Map() };
    var fanInBeforeRestart = attachCoopFanIn({
      sm: claySm,
      slug: "clay",
      crossProject: crossProjectDown,
      now: function () { return 500; },
      queueCoordinatorUpdate: function () {},
      deliveryFile: deliveryFile,
    });
    var event = {
      eventId: "restart-event-1",
      coopSessionStorageId: "coop-home",
      sessionStorageId: "worker-1",
      taskId: "task-1",
      status: "needs_input",
      occurredAt: 500,
    };
    fanInBeforeRestart.deliverEvent(event);
    assert.equal(fanInBeforeRestart.hasDelivered("restart-event-1"), false);

    // Simulate a full daemon restart: a brand-new attachCoopFanIn instance
    // (fresh in-memory state) that only shares the on-disk outbox file, now
    // with the lead project registered and reachable.
    var coopSession = { localId: 1, storageId: "coop-home", pendingCoordinatorUpdates: [] };
    var leadSm = { sessions: new Map([[1, coopSession]]) };
    var projectsAfterRestart = new Map([["lead", makeFakeLeadProjectCtx(leadSm)]]);
    var crossProjectAfterRestart = createCrossProjectRouter({
      recordRecoveryEvent: sink.record,
      getProjectContext: function (slug) { return projectsAfterRestart.get(slug) || null; },
      // Same scratch file as before the simulated restart: the durable store is
      // exactly what a restart is meant to share.
      bindingFile: path.join(scratch, "bindings.json"),
    });
    var fanInAfterRestart = attachCoopFanIn({
      sm: { sessions: new Map() },
      slug: "clay",
      crossProject: crossProjectAfterRestart,
      now: function () { return 600; },
      queueCoordinatorUpdate: function () {},
      deliveryFile: deliveryFile,
    });
    assert.deepEqual(fanInAfterRestart.getPendingEventIds(), ["restart-event-1"]);
    var delivered = fanInAfterRestart.retryPending();
    assert.deepEqual(delivered, ["restart-event-1"]);
    assert.equal(coopSession.pendingCoordinatorUpdates.length, 1);
    assert.deepEqual(sink.events, [{
      kind: "cross_project_dead_letter",
      targetSlug: "lead",
      sessionStorageId: "coop-home",
      reason: "unknown-project",
    }]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("each project's outbox is scoped by slug and does not clobber another project's persisted state", function () {
  // Regression coverage for a real bug an earlier revision of this diff
  // had: attachCoopFanIn defaulted every project to the SAME shared
  // delivery file, so project "webapp"'s saveState() would overwrite
  // project "clay"'s already-persisted pending/delivered entries (last
  // writer wins), silently losing state in the exact multi-project
  // topology this feature exists for. Uses a real CLAY_HOME so the
  // default (non-test-injected) deliveryFile path is exercised.
  var clayHome = createScratchDir("coop-fanin-slug-scoping");
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = clayHome;
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/coop-fanin-delivery")];
  try {
    var freshAttach = require("../lib/coop-fanin-delivery").attachCoopFanIn;
    var noopRouter = { deliver: function () { return { ok: false, reason: "unknown-project" }; } };

    var clayFanIn = freshAttach({
      sm: { sessions: new Map() },
      slug: "clay",
      crossProject: noopRouter,
      now: function () { return 1; },
      queueCoordinatorUpdate: function () {},
    });
    var webappFanIn = freshAttach({
      sm: { sessions: new Map() },
      slug: "webapp",
      crossProject: noopRouter,
      now: function () { return 2; },
      queueCoordinatorUpdate: function () {},
    });

    clayFanIn.deliverEvent({
      eventId: "clay-event-1", coopSessionStorageId: "coop-home",
      sessionStorageId: "w1", taskId: "t1", status: "completed", occurredAt: 1,
    });
    webappFanIn.deliverEvent({
      eventId: "webapp-event-1", coopSessionStorageId: "coop-home",
      sessionStorageId: "w2", taskId: "t2", status: "completed", occurredAt: 2,
    });

    // Both are independently pending (the noop router never delivers) --
    // reload each project's outbox fresh from disk and confirm neither
    // clobbered the other's file.
    delete require.cache[require.resolve("../lib/coop-fanin-delivery")];
    var reloadAttach = require("../lib/coop-fanin-delivery").attachCoopFanIn;
    var clayReloaded = reloadAttach({
      sm: { sessions: new Map() }, slug: "clay", crossProject: noopRouter,
      now: function () { return 3; }, queueCoordinatorUpdate: function () {},
    });
    var webappReloaded = reloadAttach({
      sm: { sessions: new Map() }, slug: "webapp", crossProject: noopRouter,
      now: function () { return 3; }, queueCoordinatorUpdate: function () {},
    });
    assert.deepEqual(clayReloaded.getPendingEventIds(), ["clay-event-1"]);
    assert.deepEqual(webappReloaded.getPendingEventIds(), ["webapp-event-1"]);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/coop-fanin-delivery")];
    fs.rmSync(clayHome, { recursive: true, force: true });
  }
});
