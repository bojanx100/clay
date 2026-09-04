var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

require("./helpers/isolated-clay-home");

var runtimeModule = require("../lib/coop-self-cleanup-runtime");
var deletionModule = require("../lib/sessions-deletion");
var sessionsIoModule = require("../lib/sessions-io");
var config = require("../lib/config");
var createBindings = require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;

if (path.resolve(config.CONFIG_DIR) === path.resolve(path.join(os.homedir(), ".clay"))) {
  throw new Error("coop-self-cleanup-runtime tests refuse to use the live Clay home");
}

var NOW = 1_000_000;
var THRESHOLDS = {
  workerArchiveAgeMs: 100,
  predecessorPruneAgeMs: 100,
  channelCompactAgeMs: 100,
  channelCompactMessageCount: 10,
  channelRotateDepth: 3,
};

function controlledBy() {
  return { coopSessionStorageId: "coop-home", since: 1 };
}

function worker(id, overrides) {
  return Object.assign({
    localId: id,
    storageId: "worker-" + id,
    orchestrationParent: { taskId: "task-" + id, taskStatus: "completed" },
    resolvedAt: NOW - 100,
    coopControlledBy: controlledBy(),
  }, overrides || {});
}

function makeHarness(sessions, overrides) {
  var map = new Map();
  for (var i = 0; i < sessions.length; i++) map.set(sessions[i].localId, sessions[i]);
  var events = [];
  var hides = [];
  var timers = [];
  var clears = [];
  var options = overrides || {};
  var sm = {
    sessions: map,
    getActiveSession: function () { return options.activeSession || null; },
    hideSession: function (localId) {
      var session = map.get(localId);
      if (session) {
        session.hidden = true;
        hides.push(session);
      }
    },
  };
  var persistence = {
    load: function () { return events; },
    append: function (event) { events.push(event); },
  };
  var runtime = runtimeModule.attachCoopSelfCleanupRuntime(Object.assign({
    sm: sm,
    projectSlug: options.projectSlug || "test-project",
    now: function () { return NOW; },
    getLeadMode: function () { return options.leadMode === true; },
    thresholds: THRESHOLDS,
    persistence: persistence,
    setInterval: function (fn) { timers.push(fn); return fn; },
    clearInterval: function (id) { clears.push(id); },
  }, options.runtime || {}));
  return { runtime: runtime, sessions: map, events: events, hides: hides, timers: timers, clears: clears };
}

test("Lead mode off records a typed skip and performs no cleanup mutation", function () {
  var harness = makeHarness([worker(1)]);

  var result = harness.runtime.tick();

  assert.equal(result.leadMode, false);
  assert.equal(harness.hides.length, 0);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].type, runtimeModule.AUDIT_TYPE);
  assert.equal(harness.events[0].reasonCode, "lead_mode_off");
});

test("a non-lead project starts its local runtime and cleans a controlled worker", function () {
  var harness = makeHarness([worker(9)], { leadMode: true, projectSlug: "webapp" });

  harness.runtime.start();
  harness.timers[0]();

  assert.deepEqual(harness.hides.map(function (session) { return session.localId; }), [9]);
  assert.equal(harness.events[0].projectSlug, "webapp");
  assert.match(harness.events[1].actionKey, /^webapp\|/);
  harness.runtime.stop();
});

test("runtime archives only aged Coop-controlled projections and protects direct owners and unread state", function () {
  var sessions = [
    worker(1),
    worker(2, { ownerId: "owner-1", coopControlledBy: null }),
    worker(3, { unread: 1 }),
    worker(4, { attention: true }),
    worker(5, { resolvedAt: NOW - 99 }),
  ];
  var harness = makeHarness(sessions, { leadMode: true });

  harness.runtime.tick();

  assert.deepEqual(harness.hides.map(function (session) { return session.localId; }), [1]);
  assert.equal(sessions[1].hidden, undefined);
  assert.equal(sessions[2].hidden, undefined);
  assert.equal(sessions[3].hidden, undefined);
  assert.equal(sessions[4].hidden, undefined);
});

test("projection pruning hides only the predecessor and never deletes its transcript", function () {
  var files = { "predecessor-1": "canonical transcript" };
  var predecessor = {
    localId: 1,
    storageId: "predecessor-1",
    compactedIntoLocalId: 2,
    compactedAt: NOW - 100,
    compactionDepth: 0,
  };
  var home = {
    localId: 2,
    storageId: "coop-home",
    coopHome: true,
    compactionDepth: 1,
    createdAt: NOW,
  };
  var harness = makeHarness([predecessor, home], { leadMode: true });
  var deleteCalls = 0;
  harness.runtime = runtimeModule.attachCoopSelfCleanupRuntime({
    sm: harness.runtime ? {
      sessions: harness.sessions,
      getActiveSession: function () { return null; },
      hideSession: function (id) { harness.sessions.get(id).hidden = true; },
    } : null,
    now: function () { return NOW; },
    getLeadMode: function () { return true; },
    thresholds: THRESHOLDS,
    persistence: { load: function () { return []; }, append: function () {} },
    mutations: {
      pruneProjection: function (session) {
        session.hidden = true;
        return { ok: true };
      },
      deleteSession: function () { deleteCalls++; return { ok: true }; },
    },
  });

  harness.runtime.tick();

  assert.equal(predecessor.hidden, true);
  assert.equal(files["predecessor-1"], "canonical transcript");
  assert.equal(deleteCalls, 0);
});

test("due compaction and rotation dispatch through the existing path", function () {
  var calls = [];
  var home = {
    localId: 1,
    storageId: "coop-home",
    coopHome: true,
    createdAt: NOW - 100,
    messageCount: 10,
    compactionDepth: 0,
  };
  var rotation = {
    localId: 2,
    storageId: "coop-channel",
    coopChannel: { projectSlug: "webapp" },
    createdAt: NOW,
    messageCount: 0,
    compactionDepth: 3,
  };
  var harness = makeHarness([home, rotation], {
    leadMode: true,
    runtime: {
      compactAndContinue: function (session, options) {
        calls.push({ session: session, options: options });
        return { localId: session.localId + 10 };
      },
    },
  });

  harness.runtime.tick();

  assert.deepEqual(calls.map(function (call) { return call.session.localId; }), [1, 2]);
  assert.equal(calls[0].options.rotation, false);
  assert.equal(calls[1].options.rotation, true);
  assert.equal(calls[0].options.reason, "coop_cleanup_compaction");
  assert.equal(calls[1].options.reason, "coop_cleanup_rotation");
});

test("due maintenance compacts an idle active Coop home", function () {
  var calls = [];
  var home = {
    localId: 1,
    storageId: "coop-home",
    coopHome: true,
    createdAt: NOW - 100,
    messageCount: 10,
    compactionDepth: 0,
  };
  var harness = makeHarness([home], {
    leadMode: true,
    activeSession: home,
    runtime: {
      compactAndContinue: function (session) {
        calls.push(session);
        return { localId: 2 };
      },
    },
  });

  harness.runtime.tick();

  assert.deepEqual(calls, [home]);
  assert.ok(harness.events.some(function (event) {
    return event.operation === "request_compaction" && event.outcome === "applied";
  }));
});

test("active Coop maintenance still defers while processing or unsafe", function () {
  var cases = [
    { name: "processing", state: { isProcessing: true } },
    { name: "unread", state: { unread: true } },
    { name: "attention", state: { needsAttention: true } },
    { name: "binding", state: { activeBinding: true } },
    { name: "work", state: { orchestrationTasks: [{ status: "running" }] } },
  ];

  for (var i = 0; i < cases.length; i++) {
    var item = cases[i];
    var calls = 0;
    var home = Object.assign({
      localId: i + 1,
      storageId: "coop-home-" + i,
      coopHome: true,
      createdAt: NOW - 100,
      messageCount: 10,
      compactionDepth: 0,
    }, item.state);
    var harness = makeHarness([home], {
      leadMode: true,
      activeSession: home,
      runtime: {
        compactAndContinue: function () { calls++; return { localId: 100 }; },
      },
    });

    var result = harness.runtime.tick();

    assert.equal(calls, 0, item.name);
    assert.equal(result.maintenanceRequests.length, 0, item.name);
    assert.equal(result.channelDecisions[0].operation, "defer_maintenance", item.name);
    assert.equal(result.channelDecisions[0].reasonCode, "channel_not_idle", item.name);
  }
});

test("a continuously busy Coop home compacts at its first completed-turn boundary", function () {
  var calls = [];
  var immediates = [];
  var home = {
    localId: 1,
    storageId: "weeks-busy-coop-home",
    coopHome: true,
    createdAt: NOW - (21 * 24 * 60 * 60 * 1000),
    messageCount: 300000,
    isProcessing: true,
    history: [],
  };
  var harness = makeHarness([home], {
    leadMode: true,
    activeSession: home,
    runtime: {
      setImmediate: function (fn) { immediates.push(fn); },
      compactAndContinue: function (session) {
        calls.push(session);
        return { localId: 2 };
      },
    },
  });
  harness.runtime.start();

  harness.runtime.tick();
  harness.runtime.tick();
  assert.equal(calls.length, 0);
  assert.ok(home._coopMaintenanceDoneListener);
  assert.equal(home._subscribers.size, 1, "repeated busy ticks arm only one retry");

  var io = sessionsIoModule.attachSessionIo({
    send: function () {},
    appendToSessionFile: function () {},
    isMeaninglessUnknownError: function () { return false; },
    getActiveSessionId: function () { return home.localId; },
    getSingleUserUnread: function () { return {}; },
    onSessionDone: function () {},
  });
  io.sendAndRecord(home, { type: "done", code: 0 });
  assert.equal(calls.length, 0, "compaction waits until the provider stack unwinds");
  assert.equal(immediates.length, 1);

  immediates[0]();
  assert.deepEqual(calls, [home]);
  assert.equal(home._coopMaintenanceDoneListener, undefined);
  harness.runtime.stop();
});

test("repeated ticks and restart replay do not repeat applied actions", function () {
  var harness = makeHarness([worker(1)], { leadMode: true });

  harness.runtime.tick();
  harness.runtime.tick();
  var firstHideCount = harness.hides.length;
  var replay = makeHarness([worker(1)], {
    leadMode: true,
    runtime: {},
  });
  replay.events.push.apply(replay.events, harness.events);
  replay.runtime = runtimeModule.attachCoopSelfCleanupRuntime({
    sm: {
      sessions: replay.sessions,
      getActiveSession: function () { return null; },
      hideSession: function (id) {
        replay.sessions.get(id).hidden = true;
        replay.hides.push(replay.sessions.get(id));
      },
    },
    projectSlug: "test-project",
    now: function () { return NOW; },
    getLeadMode: function () { return true; },
    thresholds: THRESHOLDS,
    persistence: { load: function () { return replay.events; }, append: function (event) { replay.events.push(event); } },
  });
  replay.runtime.tick();

  assert.equal(firstHideCount, 1);
  assert.equal(replay.hides.length, 0);
  assert.ok(harness.events.some(function (event) { return event.outcome === "applied"; }));
});

test("restart replay namespaces equal worker ids and timestamps by project slug", function () {
  var events = [];
  var hides = {};

  function makeProject(slug) {
    var session = worker(1);
    var map = new Map([[1, session]]);
    hides[slug] = 0;
    return runtimeModule.attachCoopSelfCleanupRuntime({
      sm: {
        sessions: map,
        getActiveSession: function () { return null; },
        hideSession: function () { hides[slug]++; session.hidden = true; },
      },
      projectSlug: slug,
      now: function () { return NOW; },
      getLeadMode: function () { return true; },
      thresholds: THRESHOLDS,
      persistence: {
        load: function () { return events; },
        append: function (event) { events.push(event); },
      },
    });
  }

  makeProject("clay").tick();
  makeProject("webapp").tick();

  assert.equal(hides.clay, 1);
  assert.equal(hides.webapp, 1);
  assert.deepEqual(events.filter(function (event) {
    return event.operation === "tick";
  }).map(function (event) { return event.projectSlug; }), ["clay", "webapp"]);
});

test("start and stop tear down the runtime timer", function () {
  var harness = makeHarness([], { leadMode: false });

  harness.runtime.start();
  assert.equal(harness.runtime.isRunning(), true);
  harness.runtime.stop();
  assert.equal(harness.runtime.isRunning(), false);
  assert.equal(harness.clears.length, 1);
});

test("an immediate Lead runtime tick wakes idle Coop when admitted work exists", function () {
  var scheduled = [];
  var home = { localId: 1, storageId: "coop-home", coopHome: true };
  var wake = runtimeModule.createLeadWakeHandler({
    projectSlug: "lead",
    sm: { sessions: new Map([[1, home]]) },
    hasPendingWork: function () { return true; },
    scheduleMessage: function (session, text, at, prompt, label, opts) {
      scheduled.push({ session: session, text: text, at: at, prompt: prompt, label: label, opts: opts });
    },
    now: function () { return NOW; },
  });
  var harness = makeHarness([home], {
    leadMode: true,
    projectSlug: "lead",
    runtime: { onTick: wake },
  });

  harness.runtime.start(true);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].session, home);
  assert.equal(scheduled[0].label, "↻ Lead tick");
  assert.equal(scheduled[0].opts.autoAction, true);
  assert.match(scheduled[0].prompt, /Lead tick/);
});

test("Lead wake discovers real state-defaulted backlog and typed binding work", function (t) {
  var leadDir = path.join(config.CONFIG_DIR, "lead");
  var itemsFile = path.join(leadDir, "items.json");
  var bindingsFile = path.join(leadDir, "portfolio-execution-bindings.json");
  fs.mkdirSync(leadDir, { recursive: true });
  t.after(function () { fs.rmSync(leadDir, { recursive: true, force: true }); });

  var scheduled = 0;
  var home = { localId: 1, storageId: "coop-home", coopHome: true };
  var wake = runtimeModule.createLeadWakeHandler({
    projectSlug: "lead",
    sm: { sessions: new Map([[1, home]]) },
    scheduleMessage: function () { scheduled++; },
    now: function () { return NOW; },
  });

  // The canonical backlog normalizer treats a missing state as open. The old
  // wake predicate read the raw state and silently missed exactly this item.
  fs.writeFileSync(itemsFile, JSON.stringify([{ id: "admitted-work", title: "Admitted work" }]));
  assert.equal(wake({ leadMode: true }), true);
  assert.equal(scheduled, 1);

  fs.writeFileSync(itemsFile, "[]");
  var bindings = createBindings({ file: bindingsFile, now: function () { return NOW; } });
  assert.equal(bindings.reserve({
    portfolioTaskId: "typed-work",
    mode: "direct_leaf",
    targetProject: { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04" },
    bindingRevision: 1,
    idempotencyKey: "typed-work-1",
  }).ok, true);
  assert.equal(bindings.commit("typed-work", 1, {
    projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "typed-worker",
  }).ok, true);
  assert.equal(wake({ leadMode: true }), true);
  assert.equal(scheduled, 2);
});

test("Lead wake does not retry history whose exact typed binding is durably missing", function (t) {
  var leadDir = path.join(config.CONFIG_DIR, "lead");
  fs.mkdirSync(leadDir, { recursive: true });
  t.after(function () { fs.rmSync(leadDir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(leadDir, "items.json"), "[]");
  fs.writeFileSync(path.join(leadDir, "portfolio-execution-bindings.json"), JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 2,
    bindings: [],
  }));
  fs.writeFileSync(path.join(leadDir, "coop-session-ledger.json"), JSON.stringify({
    entries: [{
      projectRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
      sessionStorageId: "351d16db-6975-403e-8765-24fcf7822682",
      lifecycleState: "needs_input",
      workState: "needs_input",
      portfolioBinding: {
        portfolioTaskId: "clay-open-session-reconciliation-audit-2026-08-24",
        bindingRevision: 1,
        mode: "project_coordinator",
        status: "needs_input",
      },
    }],
  }));

  var scheduled = 0;
  var home = { localId: 1, storageId: "coop-home", coopHome: true };
  var wake = runtimeModule.createLeadWakeHandler({
    projectSlug: "lead",
    sm: { sessions: new Map([[1, home]]) },
    scheduleMessage: function () { scheduled++; },
    now: function () { return NOW; },
  });

  assert.equal(wake({ leadMode: true }), false);
  assert.equal(scheduled, 0);
});

test("Lead wake leases the daily standup tick instead of retrying it every interval", function (t) {
  var leadDir = path.join(config.CONFIG_DIR, "lead");
  fs.rmSync(leadDir, { recursive: true, force: true });
  t.after(function () { fs.rmSync(leadDir, { recursive: true, force: true }); });
  var scheduled = 0;
  var nowValue = 24 * 60 * 60 * 1000 + 1;
  var home = { localId: 1, storageId: "coop-home", coopHome: true };
  var wake = runtimeModule.createLeadWakeHandler({
    projectSlug: "lead",
    sm: { sessions: new Map([[1, home]]) },
    scheduleMessage: function () { scheduled++; },
    now: function () { return nowValue; },
  });

  assert.equal(wake({ leadMode: true }), true);
  assert.equal(wake({ leadMode: true }), false);
  assert.equal(scheduled, 1);

  nowValue += 24 * 60 * 60 * 1000 + 1;
  assert.equal(wake({ leadMode: true }), true);
  assert.equal(scheduled, 2);
});

test("Lead wake skips non-Lead, disabled, busy, already-scheduled, and empty states", function () {
  var schedules = 0;
  var home = { localId: 1, storageId: "coop-home", coopHome: true };
  function attempt(overrides, tick) {
    var state = Object.assign({
      projectSlug: "lead",
      sm: { sessions: new Map([[1, home]]) },
      hasPendingWork: function () { return true; },
      scheduleMessage: function () { schedules++; },
      now: function () { return NOW; },
    }, overrides || {});
    runtimeModule.createLeadWakeHandler(state)(tick || { leadMode: true });
  }

  attempt({ projectSlug: "clay" });
  attempt(null, { leadMode: false });
  home.isProcessing = true;
  attempt();
  delete home.isProcessing;
  home.scheduledMessage = { text: "continue" };
  attempt();
  delete home.scheduledMessage;
  attempt({ hasPendingWork: function () { return false; } });

  assert.equal(schedules, 0);
});

test("forced idle resume discovers safe work but never overtakes pending owner ingress", function () {
  var schedules = 0;
  var home = { localId: 1, storageId: "coop-home", coopHome: true };
  var wake = runtimeModule.createLeadWakeHandler({
    projectSlug: "lead",
    sm: { sessions: new Map([[1, home]]) },
    hasPendingWork: function () { return false; },
    scheduleMessage: function () { schedules++; },
    now: function () { return NOW; },
  });

  assert.equal(wake({ leadMode: true }, { force: true }), true);
  home.pendingCoopIngress = [{ ingressId: "coop:coop-home:4" }];
  assert.equal(wake({ leadMode: true }, { force: true }), false);
  assert.equal(schedules, 1);
});

test("projection-only hiding does not cascade or delete through session deletion", function () {
  var sessions = new Map([
    [1, { localId: 1, storageId: "coordinator" }],
    [2, { localId: 2, storageId: "child" }],
  ]);
  sessions.get(1).coordinationMode = true;
  sessions.get(1).orchestrationTasks = [{ workerSessionId: 2, workerStorageId: "child" }];
  var saved = [];
  var deleted = false;
  var api = deletionModule.attachSessionDeletion({
    sessions: sessions,
    send: function () {},
    sendTo: function () {},
    sendEach: null,
    getSingleUserUnread: function () { return {}; },
    getSessionStorageId: function (session) { return session.storageId; },
    sessionFilePath: function () { return "/never-used"; },
    saveSessionFile: function (session) { saved.push(session); },
    getActiveSessionId: function () { return null; },
    setActiveSessionId: function () {},
    switchSession: function () {},
    createSession: function () {},
    broadcastSessionList: function () {},
    mostRecentVisibleSessionForWs: function () { return null; },
  });
  var originalUnlink = require("fs").unlinkSync;
  require("fs").unlinkSync = function () { deleted = true; };
  try {
    api.hideSession(1, null, { projectionOnly: true });
  } finally {
    require("fs").unlinkSync = originalUnlink;
  }

  assert.equal(sessions.get(1).hidden, true);
  assert.equal(sessions.get(2).hidden, undefined);
  assert.equal(deleted, false);
  assert.equal(saved.length, 1);
});
