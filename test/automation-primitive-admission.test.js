var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var fixture = require("./fixtures/webapp-primitive-adoption.json");
var bindingsModule = require("../lib/portfolio-execution-bindings");
var candidateModule = require("../lib/project-automation-candidates");
var evidenceModule = require("../lib/project-primitive-launch-evidence");
var policyModule = require("../lib/project-automation-policy");
var repair = require("../lib/project-automation-primitive-reconsideration");
var authorization = require("../lib/project-automation-execution-authorization");
var projectRef = fixture.candidates.candidates[0].projectRef;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function manager(projectId) {
  var sessions = new Map();
  return { sessions: sessions, getProjectId: function () { return projectId; },
    createSessionRaw: function (options) {
      var session = Object.assign({ localId: sessions.size + 100, history: [], orchestrationPolicy: {} }, options);
      sessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function () { return true; }, appendToSessionFile: function () {},
    broadcastSessionList: function () {},
  };
}

function harness() {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-actual-admission-"));
  var tasks = path.join(cwd, ".clay/tasks");
  fs.mkdirSync(tasks, { recursive: true });
  write(path.join(tasks, "config.json"), fixture.config);
  fixture.recipes.forEach(function (recipe) { write(path.join(tasks, recipe.id + ".json"), recipe); });
  write(path.join(tasks, "automation-candidates.json"), fixture.candidates);
  var bindingFile = path.join(cwd, "bindings.json");
  write(bindingFile, fixture.bindings);
  var candidates = candidateModule.createCandidateStore({ cwd: cwd });
  var evidence = evidenceModule.createLaunchEvidenceStore({ cwd: cwd });
  fixture.launchRecords.forEach(function (record) { assert.equal(evidence.retain(record).ok, true); });
  var recipe = fixture.recipes.find(function (r) { return r.id === "assigned-to-me"; });
  var loaded = policyModule.loadProjectAutomationPolicy({ cwd: cwd, projectRef: projectRef });
  assert.equal(loaded.ok, true);
  var target = manager(projectRef.projectId);
  var lead = manager("system-lead");
  lead.sessions.set("coop", { coopHome: true, storageId: "new-coop" });
  fixture.sessions.forEach(function (session, i) {
    target.sessions.set(i + 1, Object.assign({ localId: i + 1, history: [] }, clone(session)));
  });
  var primitives = Array.from(target.sessions.values());
  var items = fixture.launchRecords.map(function (record) {
    var item = record.qualificationReceipt.item;
    return { number: item.number, title: "Regression " + item.number, state: "OPEN",
      url: "https://github.com/" + item.repo + "/issues/" + item.number,
      labels: [], assignedToOwner: true, assignees: [{ login: "owner" }],
      projectItems: item.boardItems.map(function (board) {
        return { id: board.id, projectId: board.projectId,
          status: { name: board.status, fieldId: board.statusFieldId } };
      }),
    };
  });
  var auto;
  var delivered = [];
  var leadContext = { getProjectId: function () { return "system-lead"; },
    getSessionManager: function () { return lead; },
    deliverCrossProjectEnvelope: function () { return { ok: true }; } };
  var beforeValidation = function () {};
  var targetContext = { getProjectId: function () { return projectRef.projectId; },
    getSessionManager: function () { return target; },
    validateAutomationAuthorization: function (input) { beforeValidation(input); return auto.validateAutomationAuthorization(input); },
    deliverCrossProjectEnvelope: function (input) { delivered.push(input); return { ok: false }; } };
  var router = require("../lib/server-cross-project").createCrossProjectRouter({
    allowLeadSourcedExecution: true, requireOwnerImplementationDecision: true, bindingFile: bindingFile,
    automationThreadIndex: { ensureAutomationThread: function (input) {
      return { ok: true, topicRef: { topicId: input.authorization.threadRef.threadId },
        threadRef: input.authorization.threadRef };
    } }, onThreadHandedOff: function () { return { ok: true }; },
    ownerRequests: { claimCoordinator: function (input) { this.claimed = input.coordinator; return { ok: true }; },
      canonicalCoordinator: function () { return this.claimed || null; } },
    getProjectContextById: function (id) { return id === "system-lead" ? leadContext :
      id === projectRef.projectId ? targetContext : null; },
  });
  var launcher = require("../lib/project-task-launcher").attachTaskLauncher({
    cwd: cwd, sm: target, sdk: { startQuery: function () { assert.fail("must never launch a provider"); } },
    usersModule: { isMultiUser: function () { return false; } },
    ensureProjectAccessForSession: function () { return true; }, onProcessingChanged: function () {},
  });
  auto = require("../lib/project-auto-launch").attachAutoLaunch({
    cwd: cwd, slug: "webapp", sm: target, getTaskLauncher: function () { return launcher; },
    getLeadMode: function () { return true; }, crossProject: router,
    fetchItems: function () { return items; },
  });
  function packet(session) {
    var verified = evidence.verify({ session: session, projectRef: projectRef,
      itemKey: session.taskLauncher.itemKey, policy: loaded.policy, recipe: recipe, now: Date.now() });
    assert.equal(verified.ok, true, verified.reason);
    return { request: { schema: repair.REQUEST_SCHEMA, version: 1,
      ownerRequestRefs: ["owner-request-122", "owner-request-125"], requestedAt: fixture.requestedAt,
      currentQualificationRequired: true, primitiveSessionRef: verified.proof.sessionRef,
      sessionSnapshot: { projectRef: projectRef, sessions: Array.from(target.sessions.values()) } },
    options: { primitiveLaunchProof: verified.proof, projectSlug: "webapp",
      bindingSnapshot: router.getExecutionBindings() } };
  }
  function prepare(session, change) {
    var value = packet(session);
    if (change) change(value);
    return candidates.requestReconsideration(projectRef, "launch:" + session.taskLauncher.itemKey,
      value.request, value.options);
  }
  return { cwd: cwd, candidates: candidates, packet: packet, prepare: prepare, primitives: primitives,
    router: router, evidence: evidence, target: target, items: items, delivered: delivered,
    intercept: function (fn) { beforeValidation = fn; },
    drain: function () { return auto.drainLegacyAutomation(); },
    scan: function () { return auto.launchScheduled("assigned-to-me"); },
    close: function () { fs.rmSync(cwd, { recursive: true, force: true }); },
  };
}

test("actual failed and superseded histories adopt the two exact primitives once", async function () {
  var h = harness();
  try {
    var before = h.router.getExecutionBindings();
    h.primitives.forEach(function (session) {
      var result = h.prepare(session);
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.candidate.qualificationReceipt, null, "reconsideration cannot mint current authority");
      var original = fixture.candidates.candidates.find(function (c) { return c.itemKey === session.taskLauncher.itemKey; });
      var scope = { portfolioTaskId: "test-relaunch", bindingRevision: 1,
        idempotencyKey: "test-relaunch-r1", mode: "project_coordinator" };
      assert.equal(authorization.createAuthorization(Object.assign({}, original, {
        reconsideration: result.candidate.reconsideration,
      }), scope), null, "a primitive-only receipt cannot authorize a provider launch");
      assert.equal(h.prepare(session).changed, false, "preparation is idempotent");
    });
    await h.scan();
    var after = h.router.getExecutionBindings();
    assert.equal(after.length, before.length + 2, JSON.stringify(h.candidates.list().map(function (c) {
      return { key: c.itemKey, attention: c.attention, receipt: c.qualificationReceipt };
    })));
    before.forEach(function (binding) {
      assert.deepEqual(after.find(function (b) { return b.portfolioTaskId === binding.portfolioTaskId &&
        b.bindingRevision === binding.bindingRevision; }), binding, "every prior record and acceptance stays exact");
    });
    h.primitives.forEach(function (session) {
      var found = after.filter(function (b) { return b.coordinator && b.coordinator.sessionStorageId === session.storageId; });
      assert.equal(found.length, 1);
      assert.equal(found[0].status, "active");
      assert.ok(session.coopControlledBy);
      assert.equal(found[0].bindingRevision, session.taskLauncher.itemNumber === 2725 ? 3 : 1);
      assert.equal(h.candidates.get(projectRef, "launch:" + session.taskLauncher.itemKey).status, "admitted");
    });
    assert.equal(h.delivered.length, 0);
    assert.equal(h.target.sessions.size, 2);
    await h.scan();
    assert.deepEqual(h.router.getExecutionBindings(), after, "a repeated scan creates no reservation or provider");
  } finally { h.close(); }
});

[
  ["missing owner references", function (p) { p.request.ownerRequestRefs = []; }],
  ["forged serialized launch proof", function (p) { p.options.primitiveLaunchProof = clone(p.options.primitiveLaunchProof); }],
  ["wrong project", function (p) { p.request.primitiveSessionRef = { projectId: "other", sessionStorageId: p.request.primitiveSessionRef.sessionStorageId }; }],
  ["wrong session", function (p) { p.request.primitiveSessionRef.sessionStorageId = "other"; }],
  ["missing history", function (p) { p.options.bindingSnapshot = []; }],
  ["active duplicate", function (p) { p.options.bindingSnapshot.forEach(function (b) { b.status = "active"; }); }],
  ["request predates completed work", function (p) { p.request.requestedAt = 1; }],
  ["extra live session", function (p) { var s = clone(p.request.sessionSnapshot.sessions[0]); s.storageId = "duplicate"; p.request.sessionSnapshot.sessions.push(s); }],
].forEach(function (entry) {
  test("primitive reconsideration rejects " + entry[0], function () {
    var h = harness();
    try {
      var before = h.candidates.list();
      assert.equal(h.prepare(h.primitives[0], entry[1]).ok, false);
      assert.deepEqual(h.candidates.list(), before);
    } finally { h.close(); }
  });
});

[
  ["without owner reconsideration", function () {}, false],
  ["closed current issues", function (h) { h.items.forEach(function (i) { i.state = "CLOSED"; }); }, true],
  ["lost assignment", function (h) { h.items.forEach(function (i) { i.assignedToOwner = false; i.assignees = []; }); }, true],
  ["removed immutable launch evidence", function (h) { h.intercept(function (input) {
    var launch = input.authorization.reconsideration.primitiveLaunch;
    var file = h.evidence.fileFor(launch.sessionRef);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }); }, true],
  ["changed primitive at admission", function (h) { h.intercept(function () { h.primitives.forEach(function (s) { s.hidden = true; }); }); }, true],
  ["forged historical digest", function (h) { h.primitives.forEach(function (session) {
    var candidate = h.candidates.get(projectRef, "launch:" + session.taskLauncher.itemKey);
    candidate.reconsideration.priorBindings.forEach(function (b) { b.digest = "0".repeat(64); });
    var state = JSON.parse(fs.readFileSync(path.join(h.cwd, ".clay/tasks/automation-candidates.json")));
    state.candidates = state.candidates.map(function (c) { return c.itemKey === candidate.itemKey ? candidate : c; });
    write(path.join(h.cwd, ".clay/tasks/automation-candidates.json"), state);
  }); }, true],
].forEach(function (entry) {
  test("real router denies adoption " + entry[0], async function () {
    var h = harness();
    try {
      if (entry[2]) h.primitives.forEach(function (s) { assert.equal(h.prepare(s).ok, true); });
      entry[1](h);
      await h.scan();
      assert.equal(h.router.getExecutionBindings().filter(function (b) { return b.status === "active"; }).length, 0);
      assert.equal(h.delivered.length, 0);
      h.primitives.forEach(function (s) { assert.equal(s.coopControlledBy, undefined); });
      await h.scan();
      assert.equal(h.target.sessions.size, 2, "repeated failed recovery cannot create a replacement");
    } finally { h.close(); }
  });
});

[false, true].forEach(function (alreadyDrained) {
  test("startup preserves exact adoption retries after legacy drain=" + alreadyDrained, async function () {
    var h = harness();
    try {
      var before = h.router.getExecutionBindings();
      if (alreadyDrained) {
        assert.equal(h.drain().ok, true);
        h.primitives.forEach(function (session) {
          assert.equal(h.candidates.get(projectRef, "launch:" + session.taskLauncher.itemKey).status,
            "legacy_running");
        });
      }
      h.primitives.forEach(function (session) {
        var result = h.prepare(session);
        assert.equal(result.ok, true, result.reason);
        assert.equal(result.candidate.status, "pending");
        assert.equal(result.candidate.qualificationReceipt, null);
      });
      var prepared = h.candidates.list();
      assert.equal(h.drain().ok, true);
      assert.equal(h.drain().ok, true);
      assert.deepEqual(h.candidates.list(), prepared, "repeated startup leaves prepared evidence byte-exact");
      await h.scan();
      var after = h.router.getExecutionBindings();
      assert.equal(after.length, before.length + 2);
      before.forEach(function (binding) {
        assert.deepEqual(after.find(function (b) { return b.portfolioTaskId === binding.portfolioTaskId &&
          b.bindingRevision === binding.bindingRevision; }), binding);
      });
      h.primitives.forEach(function (session) {
        assert.equal(h.candidates.get(projectRef, "launch:" + session.taskLauncher.itemKey).status, "admitted");
        assert.equal(after.filter(function (b) { return b.coordinator &&
          b.coordinator.sessionStorageId === session.storageId; }).length, 1);
      });
      await h.scan();
      assert.deepEqual(h.router.getExecutionBindings(), after);
      assert.equal(h.target.sessions.size, 2);
    } finally { h.close(); }
  });
});

test("a drained legacy candidate still requires original verified launch evidence", function () {
  var h = harness();
  try {
    assert.equal(h.drain().ok, true);
    var before = h.candidates.list();
    var result = h.prepare(h.primitives[0], function (p) {
      p.options.primitiveLaunchProof = clone(p.options.primitiveLaunchProof);
    });
    assert.equal(result.ok, false);
    assert.deepEqual(h.candidates.list(), before);
    result = h.prepare(h.primitives[0], function (p) {
      p.request.primitiveSessionRef.sessionStorageId = h.primitives[1].storageId;
    });
    assert.equal(result.ok, false);
    assert.deepEqual(h.candidates.list(), before);
  } finally { h.close(); }
});
