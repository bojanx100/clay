var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var config = require("../lib/config");
var plane = require("../lib/coop-control-plane");
var createManager = require("../lib/sessions").createSessionManager;
var createMaintenance = require("../lib/coop-control-maintenance").createControlMaintenance;
var projection = require("../lib/global-coop-projection").buildGlobalCoopProjection;
var PROJECT = "11111111-1111-5111-8111-111111111111";

function fixture(t) {
  var dir = fs.mkdtempSync(path.join(config.CONFIG_DIR, "control-maintenance-"));
  var projects = new Map();
  function project(slug, projectId, worktree) {
    var cwd = path.join(dir, slug);
    fs.mkdirSync(cwd);
    var options = { cwd: cwd, slug: slug, projectId: projectId, send: function () {} };
    var sm = createManager(options);
    var context = { sm: sm, options: options,
      getProjectId: function () { return context.sm.getProjectId(); },
      getSessionManager: function () { return context.sm; },
      getStatus: function () { return { slug: slug, title: slug, path: cwd, projectId: projectId, isWorktree: !!worktree }; } };
    projects.set(slug, context);
    return context;
  }
  var lead = project("lead", "system-lead");
  var parent = project("project", PROJECT);
  var worktree = project("project-branch", PROJECT, true);
  var home = lead.sm.createSessionRaw({ coopHome: true });
  lead.sm.sendAndRecord(home, { type: "user_message", text: "Discuss the reporting workflow.", coopIngressId: "coop:" + home.storageId + ":1" });
  lead.sm.sendAndRecord(home, { type: "delta", text: "We can keep reports concise." });
  lead.sm.sendAndRecord(home, { type: "done", code: 0 });
  lead.sm.saveSessionFile(home, { durable: true });
  var index = require("../lib/coop-topic-index").createTopicIndex({ file: path.join(dir, "topics.json") });
  var router = require("../lib/server-cross-project").createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"), deliveryFile: path.join(dir, "delivery.json"),
    sessionLedgerFile: path.join(dir, "session-ledger.json"),
  });
  projects.forEach(function (context) { router.registerProjectResolver(context); });
  var ownerRequests = require("../lib/coop-owner-requests").attachCoopOwnerRequests({ file: path.join(dir, "owner-requests.json") });
  var ready = false;
  var enabled = true;
  var tick;
  var scheduled = [];
  var failures = [];
  var published = [];
  var service = createMaintenance({ projects: function () { return projects; },
    crossProject: router, topicIndex: index, ownerRequests: ownerRequests,
    isReady: function () { return ready; }, isLeadModeEnabled: function () { return enabled; },
    recordFailure: function (reason) { failures.push(reason); },
    onUpdated: function (result) { published.push(result); },
    setTimeout: function (fn) { scheduled.push(fn); return { unref: function () {} }; },
    clearTimeout: function () { scheduled = []; },
    setInterval: function (fn) { tick = fn; return { unref: function () {} }; },
    clearInterval: function () { tick = null; },
  });
  t.after(function () { service.stop(); router.stopDeliveryRetry(); });
  return { dir: dir, projects: projects, lead: lead, parent: parent, worktree: worktree, home: home,
    index: index, router: router, service: service, failures: failures, ownerRequests: ownerRequests, published: published,
    ready: function (value) { ready = value; }, enabled: function (value) { enabled = value; },
    tick: function () { tick(); }, drain: function () { var callbacks = scheduled; scheduled = []; callbacks.forEach(function (fn) { fn(); }); } };
}

test("daemon maintenance waits for startup and converges with zero viewers using one coordinator per project", function (t) {
  var h = fixture(t);
  h.service.start();
  h.drain();
  assert.equal(plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT }), null);
  h.ready(true);
  h.tick();
  var root = plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT });
  assert.ok(root);
  assert.ok(h.router.sessionLedger.get({ projectId: "system-lead", sessionStorageId: root.storageId }),
    "maintenance reconciles actual registered managers into the durable session ledger");
  assert.ok(h.index.load().canonicalSessionStorageId || Object.keys(h.index.load().topics).length);
  var refs = Array.from(h.lead.sm.sessions.values()).filter(function (session) {
    return plane.projectCoordinatorPolicy(session);
  });
  assert.equal(refs.length, 1);
  h.tick();
  assert.equal(plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT }), root);
  assert.equal(h.failures.length, 0);
  var publications = h.published.length;
  h.lead.sm.sendAndRecord(h.home, { type: "user_message", text: "Discuss our next priority." });
  h.lead.sm.sendAndRecord(h.home, { type: "delta", text: "Prioritize the next delivery." });
  h.lead.sm.sendAndRecord(h.home, { type: "done", code: 0 });
  assert.equal(h.service.run("canonical_turn").ok, true);
  assert.equal(h.published.length, publications, "the terminal-event caller publishes its own refresh once");
});

test("owner and restricted dashboard reads cannot create roles, migrate topics, or hide archived workers", function (t) {
  var h = fixture(t);
  var attempted = 0;
  var ensureRetro = h.index.ensureRetro;
  h.index.ensureRetro = function () { attempted++; return ensureRetro.apply(h.index, arguments); };
  function read(actor) {
    return projection({ projects: h.projects, coopTopicIndex: h.index, actor: actor,
      canAccessProject: function (viewer, project) { return viewer === "owner" || project === h.lead; },
      ensureControlPlane: function (input) { attempted++; return plane.ensureControlPlane(input.leadManager, input.projects); },
      reconcileDismissedSession: function () { attempted++; },
    });
  }
  read("owner"); read("restricted"); read("owner");
  assert.equal(attempted, 0);
  assert.equal(plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT }), null);
  h.ready(true);
  assert.equal(h.service.run("startup").ok, true);
  var snapshot = fs.readFileSync(path.join(h.dir, "topics.json"), "utf8");
  attempted = 0;
  read("restricted"); read("owner");
  assert.equal(attempted, 0);
  assert.equal(fs.readFileSync(path.join(h.dir, "topics.json"), "utf8"), snapshot);
});

test("explicit archive maintenance uses the worktree's manager despite colliding local session IDs", function (t) {
  var h = fixture(t);
  h.ready(true);
  assert.equal(h.service.run().ok, true);
  var root = plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT });
  var rootRef = { projectId: "system-lead", sessionStorageId: root.storageId };
  var unrelated = h.parent.sm.createSessionRaw();
  var child = h.worktree.sm.createSessionRaw({ coopControlledBy: { coopSessionStorageId: root.storageId, since: 1 } });
  assert.equal(child.localId, unrelated.localId);
  child.coordinationRole = "task_coordinator";
  child.coordinationMode = true;
  child.projectCoordinatorRef = rootRef;
  var worker = h.worktree.sm.createSessionRaw();
  worker.orchestrationParent = { sessionId: child.localId, sessionStorageId: child.storageId, taskId: "worker-task" };
  child.orchestrationTasks = [{ taskId: "worker-task", status: "completed", workerSessionId: worker.localId, workerStorageId: worker.storageId }];
  root.orchestrationTasks = [{ taskId: "archive-task", status: "dismissed", archivedAt: 10,
    externalTaskCoordinator: true, workerSessionRef: { projectId: PROJECT, sessionStorageId: child.storageId } }];
  var ordinaryDismissed = h.worktree.sm.createSessionRaw({ coopControlledBy: { coopSessionStorageId: root.storageId, since: 1 } });
  ordinaryDismissed.coordinationRole = "task_coordinator";
  ordinaryDismissed.projectCoordinatorRef = rootRef;
  root.orchestrationTasks.push({ taskId: "dismiss-only", status: "dismissed", externalTaskCoordinator: true,
    workerSessionRef: { projectId: PROJECT, sessionStorageId: ordinaryDismissed.storageId } });
  h.service.run("archive");
  assert.equal(child.hidden, true);
  assert.equal(worker.hidden, true);
  assert.notEqual(unrelated.hidden, true);
  assert.notEqual(ordinaryDismissed.hidden, true);
  var reloaded = createManager(h.worktree.options);
  var archived = Array.from(reloaded.sessions.values()).find(function (session) { return session.storageId === child.storageId; });
  assert.equal(archived.hidden, true);
});

test("failed role persistence retries the same identity and survives reload", function (t) {
  var h = fixture(t);
  h.ready(true);
  var save = h.lead.sm.saveSessionFile;
  h.lead.sm.saveSessionFile = function (session) {
    if (plane.projectCoordinatorPolicy(session)) return false;
    return save.apply(h.lead.sm, arguments);
  };
  assert.equal(h.service.run().ok, false);
  var pending = plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT });
  assert.ok(pending);
  h.lead.sm.saveSessionFile = save;
  assert.equal(h.service.run("retry").ok, true);
  assert.equal(plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT }), pending);
  var reloaded = createManager(h.lead.options);
  assert.equal(plane.projectCoordinatorFor(reloaded, { projectId: PROJECT }).storageId, pending.storageId);
});

test("Lead OFF maintains owner evidence without creating supervisory roles; ON schedules maintenance", function (t) {
  var h = fixture(t);
  h.ready(true); h.enabled(false);
  h.service.start(); h.drain();
  assert.equal(plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT }), null);
  var leadMode = require("../lib/lead-mode");
  var unsubscribe = leadMode.subscribe(function () { h.service.request("lead_mode"); });
  t.after(unsubscribe);
  h.enabled(true);
  leadMode.broadcast({ type: "lead_mode_changed", leadMode: true });
  h.drain();
  assert.ok(plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT }));
  h.service.stop();
  leadMode.broadcast({ type: "lead_mode_changed", leadMode: true });
  h.drain();
  assert.equal(h.failures.length, 0);
});

test("multiple topic claims and their legacy hierarchy migrate together on the first maintenance pass", function (t) {
  var h = fixture(t);
  var legacy = h.worktree.sm.createSessionRaw({ coopControlledBy: { coopSessionStorageId: h.home.storageId, since: 1 } });
  legacy.coordinationRole = "project_coordinator";
  var from = { projectId: PROJECT, sessionStorageId: legacy.storageId };
  var child = h.worktree.sm.createSessionRaw();
  child.coordinationRole = "task_coordinator";
  child.orchestrationParent = { sessionId: legacy.localId, sessionStorageId: legacy.storageId, taskId: "legacy-task" };
  legacy.orchestrationTasks = [{ taskId: "legacy-task", status: "running", externalTaskCoordinator: true,
    workerStorageId: child.storageId }];
  ["planning-a", "planning-b"].forEach(function (topic) {
    assert.equal(h.ownerRequests.claimCoordinator({ topicRef: { topicId: topic },
      projectRef: { projectId: PROJECT }, coordinator: from }).ok, true);
  });
  h.ready(true);
  assert.equal(h.service.run("startup").ok, true);
  var root = plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT });
  assert.deepEqual(child.projectCoordinatorRef, { projectId: "system-lead", sessionStorageId: root.storageId });
  assert.equal(h.ownerRequests.listCoordinators().length, 2);
  h.ownerRequests.listCoordinators().forEach(function (claim) {
    assert.deepEqual(claim.coordinator, child.projectCoordinatorRef);
  });
});

test("idle and in-flight ticks do not hydrate old transcripts, and changed completed history advances once", function (t) {
  var h = fixture(t);
  var continuation = require("../lib/project-session-compaction").attachSessionCompaction({
    cwd: h.lead.options.cwd, sm: h.lead.sm, sdk: { startQuery: function () {} }, sendToSession: function () {},
  }).compactAndContinue(h.home, { reason: "manual" });
  continuation.isProcessing = false;
  h.lead.sm.saveSessionFile(continuation, { durable: true });
  h.lead.sm = createManager(h.lead.options);
  var current = plane.canonicalCoop(h.lead.sm);
  var old = Array.from(h.lead.sm.sessions.values()).find(function (session) { return session.storageId === h.home.storageId; });
  var historyStore = require("../lib/sessions-history-store");
  historyStore.release(old); historyStore.release(current);
  var reads = 0;
  var descriptor = Object.getOwnPropertyDescriptor(old, "history");
  Object.defineProperty(old, "history", Object.assign({}, descriptor, {
    get: function () { reads++; return descriptor.get.call(old); },
  }));
  h.ready(true);
  assert.equal(h.service.run("startup").ok, true);
  assert.ok(reads > 0);
  assert.equal(historyStore.isResident(old), false);
  reads = 0;
  h.service.run("retry"); h.service.run("processing"); h.service.run("retry");
  assert.equal(reads, 0, "unchanged ticks use metadata without rebuilding the lineage");
  h.lead.sm.sendAndRecord(current, { type: "user_message", text: "Now discuss pricing." });
  current.isProcessing = true;
  h.service.run("processing");
  assert.equal(reads, 0, "unfinished turns wait for completion before historical indexing");
  h.lead.sm.sendAndRecord(current, { type: "delta", text: "Pricing needs a decision." });
  h.lead.sm.sendAndRecord(current, { type: "done", code: 0 });
  current.isProcessing = false;
  assert.equal(h.service.run("retry").ok, true);
  assert.ok(reads > 0);
  assert.equal(historyStore.isResident(old), false);
  reads = 0;
  h.service.run("retry");
  assert.equal(reads, 0);
});

test("the actual retry clock performs maintenance after readiness opens without a dashboard or another event", async function (t) {
  var h = fixture(t);
  var ready = false;
  var clock = createMaintenance({ projects: function () { return h.projects; }, crossProject: h.router,
    topicIndex: h.index, ownerRequests: h.ownerRequests, intervalMs: 10,
    isReady: function () { return ready; }, isLeadModeEnabled: function () { return true; },
  });
  t.after(clock.stop);
  clock.start();
  await new Promise(function (resolve) { setTimeout(resolve, 70); });
  assert.equal(plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT }), null);
  ready = true;
  var deadline = Date.now() + 1500;
  while (!plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT }) && Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, 10); });
  }
  assert.ok(plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT }));
});

test("the server owns maintenance lifecycle and dashboard readers cannot fall back to writes", function () {
  var source = fs.readFileSync(path.join(__dirname, "../lib/server.js"), "utf8");
  assert.match(source, /createControlMaintenance\(/);
  assert.match(source, /coopMaintenance\.start\(\)/);
  assert.match(source, /coopMaintenance\.stop\(\)/);
  assert.match(source, /coopMaintenance\.request\("project_registered"\)/);
  assert.match(source, /leadMode\.subscribe\(/);
  var reader = source.slice(source.indexOf("  function globalCoopProjectionFor("), source.indexOf("  function refreshCanonicalCoopTopics("));
  assert.doesNotMatch(reader, /reconcileSessionLedger|ensureControlPlane|hideDismissedSession|coopMaintenance\.(run|request)/);
  var bindings = source.slice(source.indexOf("  function ledgerTopicBindings("), source.indexOf("  function archiveCompletedCoopTopicSessions("));
  assert.doesNotMatch(bindings, /crossProject\.topicSessionEvidence\(/);
});


test("maintenance reconciles a verified task after its failed worker finishes stopping", function (t) {
  var h = fixture(t);
  h.ready(true);
  assert.equal(h.service.run("startup").ok, true);
  var root = plane.projectCoordinatorFor(h.lead.sm, { projectId: PROJECT });
  var source = { projectId: "system-lead", sessionStorageId: root.storageId };
  var request = { portfolioTaskId: "verified-after-stop", bindingRevision: 1, idempotencyKey: "verified-after-stop-r1",
    mode: "project_coordinator", targetProject: { projectId: PROJECT }, source: source };
  var worker = h.parent.sm.createSessionRaw({ coordinationMode: true });
  worker.coordinationRole = "task_coordinator";
  worker.projectCoordinatorRef = source;
  worker.orchestrationPolicy = { portfolioExecution: Object.assign({}, request, { status: "failed" }) };
  worker.isProcessing = true;
  var workerRef = { projectId: PROJECT, sessionStorageId: worker.storageId };
  assert.equal(h.router.bindingStore.reserve(request).ok, true);
  assert.equal(h.router.bindingStore.commit(request.portfolioTaskId, 1, workerRef, { projectCoordinatorRef: source }).ok, true);
  assert.equal(h.router.bindingStore.complete(request.portfolioTaskId, 1,
    { eventId: "worker-stopping", terminalStatus: "failed", failureCode: "activation_pending" }).ok, true);
  var task = plane.prepareTask(h.lead.sm, root, request, { title: "Verify activation", objective: "Normal launch observed" });
  plane.bindTask(h.lead.sm, root, task, workerRef);
  Object.assign(task, { status: "completed", resolvedByCoordinator: true, resolvedAt: Date.now(),
    resultSummary: "Normal launch observed.", verification: "Verified the actual scheduler dispatch receipt." });
  h.lead.sm.saveSessionFile(root, { durable: true });
  assert.equal(h.router.resolveProjectCoordinatorTask({ source: source, taskId: task.taskId }).reason, "worker_not_settled");
  assert.equal(h.service.run("worker_stopping").ok, true);
  assert.equal(h.router.getExecutionBinding(request.portfolioTaskId, 1).status, "failed");
  worker.isProcessing = false;
  assert.equal(h.service.run("worker_stopped").ok, true);
  assert.equal(h.router.getExecutionBinding(request.portfolioTaskId, 1).status, "completed");
  assert.equal(h.router.sessionLedger.get(workerRef).workState, "done");
  assert.deepEqual(h.failures, []);
});
