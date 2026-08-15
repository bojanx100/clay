var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var lifecycle = require("../lib/coop-thread-lifecycle");
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;

var PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var TOPIC = { topicId: "auto-a7daa4cc660639337d144d93" };
var INGRESS = "coop:canonical-coop:7";

test("ordinary discussion and project mentions do not admit typed execution", function () {
  assert.equal(lifecycle.explicitImplementationDecision("What is happening with the Clay sidebar?"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Discuss the approach for the Clay project"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Could this be a useful follow-up?"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Let's discuss whether to implement this in Clay"), null);
  assert.equal(lifecycle.explicitImplementationDecision("I think we should fix this in Clay"), null);
  assert.equal(lifecycle.explicitImplementationDecision("The fix is on the way"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Should we set it to implement?"), null);
});

test("explicit owner implementation decisions are recognized separately from theme classification", function () {
  assert.deepEqual(lifecycle.explicitImplementationDecision("Build this in Clay"), {
    intent: "build", projectName: "Clay",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("Please fix this in webapp"), {
    intent: "fix", projectName: "webapp",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("Hand this to the Clay project"), {
    intent: "hand_off", projectName: "Clay",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("Can you fix this in Clay?"), {
    intent: "fix", projectName: "Clay",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("ok set it to implement..."), {
    intent: "implement", projectName: "",
  });
});

function executionRouter(entries, delivered, handedOff, options) {
  options = options || {};
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-thread-admission-"));
  var claimed = null;
  var classifications = 0;
  var leadSessions = new Map([[1, { coopHome: true, storageId: "canonical-coop",
    history: options.history || [] }]]);
  var leadManager = {
    sessions: leadSessions,
    createSessionRaw: function (input) {
      var session = Object.assign({ localId: leadSessions.size + 1, history: [] }, input || {});
      leadSessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function () {},
  };
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    ownerRequests: {
      forTopic: function () { return entries; },
      classify: function (ingressId, input) {
        classifications++;
        var entry = entries.find(function (candidate) {
          return candidate.ingressId === ingressId;
        });
        if (!entry) return null;
        entry.implementationDecision = input.implementationDecision;
        entry.expectsExecution = true;
        return entry;
      },
      claimCoordinator: function (input) { claimed = input.coordinator; return { ok: true }; },
      canonicalCoordinator: function () { return claimed; },
      canonicalProjectCoordinator: function () { return null; },
    },
    requireOwnerImplementationDecision: true,
    onThreadHandedOff: function (input) {
      handedOff.push(input);
      return handedOff.fail ? { ok: false, code: "persistence_failed" } : { ok: true };
    },
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    getSessionManager: function () { return leadManager; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return PROJECT; },
    deliverCrossProjectEnvelope: function (envelope) {
      delivered.push(envelope);
      return { ok: true, created: true,
        sessionRef: { projectId: PROJECT, sessionStorageId: "thread-worker" },
        projectCoordinatorRef: envelope.payload.targetProjectCoordinator };
    },
  });
  return { router: router, dir: dir,
    classificationCount: function () { return classifications; } };
}

function execute(router, source) {
  return router.createProjectExecution({
    source: source || { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    portfolioTaskId: "thread-admission-task", bindingRevision: 1,
    idempotencyKey: "thread-admission-task-r1", mode: "project_coordinator",
    targetProject: { projectId: PROJECT }, coopTopicRef: TOPIC,
    coopIngressId: INGRESS, objective: "Implement the approved change.",
  });
}

test("typed project execution fails closed until the current owner ingress has an explicit decision", function () {
  var delivered = [];
  var handedOff = [];
  var discussion = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: false,
    implementationDecision: null }], delivered, handedOff);
  try {
    assert.deepEqual(execute(discussion.router), {
      ok: false, reason: "owner_implementation_decision_required",
    });
    assert.equal(delivered.length, 0);
    assert.equal(handedOff.length, 0);
  } finally { fs.rmSync(discussion.dir, { recursive: true, force: true }); }
});

test("production admission rejects direct project leaves instead of falling back around the coordinator", function () {
  var delivered = [];
  var handedOff = [];
  var approved = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    var result = approved.router.createProjectExecution({
      source: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
      portfolioTaskId: "no-direct-leaf", bindingRevision: 1,
      idempotencyKey: "no-direct-leaf-r1", mode: "direct_leaf",
      targetProject: { projectId: PROJECT }, coopTopicRef: TOPIC,
      coopIngressId: INGRESS, objective: "Do not bypass the project coordinator.",
    });
    assert.deepEqual(result, { ok: false, reason: "persistent_project_coordinator_required" });
    assert.equal(delivered.length, 0);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("owner text approval is replayed from the exact canonical event and persisted once", function () {
  var delivered = [];
  var handedOff = [];
  var entries = [{ ingressId: INGRESS, topicRef: TOPIC, projectRefs: [],
    expectsExecution: false, implementationDecision: null,
    classification: { kind: "conversational", source: "ingress_route" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 } }];
  var approved = executionRouter(entries, delivered, handedOff, { history: [{
    type: "user_message", text: "ok set it to implement...", coopIngressId: INGRESS,
    coopTopicRef: TOPIC, _ts: 1786779753167,
  }] });
  try {
    var result = execute(approved.router);
    assert.equal(result.ok, true);
    assert.equal(approved.classificationCount(), 1);
    assert.deepEqual(entries[0].implementationDecision, {
      intent: "implement", projectName: "",
      source: "explicit_owner_turn", at: 1786779753167,
    });
    assert.equal(delivered.length, 1);

    var replay = execute(approved.router);
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(approved.classificationCount(), 1,
      "a replay must reuse the persisted decision instead of recording it again");
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("a generic explicit decision admits the next typed ProjectRef but an explicit mismatch does not", function () {
  var delivered = [];
  var handedOff = [];
  var generic = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    assert.equal(execute(generic.router).ok, true);
  } finally { fs.rmSync(generic.dir, { recursive: true, force: true }); }

  var mismatch = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" }],
    expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }], [], []);
  try {
    assert.deepEqual(execute(mismatch.router), {
      ok: false, reason: "owner_implementation_project_mismatch",
    });
  } finally { fs.rmSync(mismatch.dir, { recursive: true, force: true }); }
});

test("an explicit decision creates typed ProjectRef execution and marks the Thread handed off", function () {
  var delivered = [];
  var handedOff = [];
  var approved = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    var result = execute(approved.router);
    assert.equal(result.ok, true);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].source.projectId, "system-lead");
    assert.notEqual(delivered[0].source.sessionStorageId, "canonical-coop",
      "Coop dispatch must target the ProjectRef-bound coordinator, never the project session");
    assert.deepEqual(delivered[0].payload.targetProjectCoordinator, delivered[0].source);
    assert.match(delivered[0].payload.controlPlaneTaskId, /^task-/);
    assert.deepEqual(result.binding.targetProject, { projectId: PROJECT });
    assert.deepEqual(result.binding.coopTopicRef, TOPIC);
    assert.deepEqual(result.binding.projectCoordinator, delivered[0].source);
    assert.deepEqual(result.binding.coordinator,
      { projectId: PROJECT, sessionStorageId: "thread-worker" });
    assert.equal(handedOff.length, 1);
    assert.deepEqual(handedOff[0].topicRef, TOPIC);
    assert.deepEqual(handedOff[0].projectRef, { projectId: PROJECT });
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("a failed durable handoff link retries against the same coordinator", function () {
  var delivered = [];
  var handedOff = [];
  handedOff.fail = true;
  var approved = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    var failed = execute(approved.router);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "thread_handoff_link_failed");
    assert.equal(failed.retryable, true);
    assert.equal(delivered.length, 1);
    handedOff.fail = false;
    var retried = execute(approved.router);
    assert.equal(retried.ok, true);
    assert.equal(retried.reused, true);
    assert.equal(delivered.length, 1);
    assert.equal(handedOff.length, 2);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("an owner-direct Lead session cannot adopt the canonical Thread handoff", function () {
  var delivered = [];
  var handedOff = [];
  var approved = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    assert.deepEqual(execute(approved.router,
      { projectId: "system-lead", sessionStorageId: "owner-direct" }), {
      ok: false, reason: "canonical_coop_required",
    });
    assert.equal(delivered.length, 0);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});
